import { describe, expect, it, vi } from "vitest";

import {
  COMPOSIO_API_BASE,
  ComposioApiError,
  ComposioClient,
} from "./composio-client";

/**
 * Builds a fetch stub that replays a queue of responses and records every
 * request it was given, so tests can assert on URL, method, headers and body.
 */
function stubFetch(
  responses: Array<{
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }>
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("stubFetch: no response queued");
    return new Response(
      typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      { status: next.status, headers: next.headers }
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const TOOL = {
  slug: "GITHUB_CREATE_AN_ISSUE",
  name: "Create an issue",
  description: "Creates an issue",
  toolkit: { slug: "github", name: "GitHub", logo: "https://logo" },
  input_parameters: {
    type: "object",
    required: ["owner", "repo", "title"],
    properties: {
      owner: { type: "string", description: "Owner" },
      repo: { type: "string", description: "Repo" },
      title: { type: "string", description: "Title" },
    },
  },
  output_parameters: { type: "object", properties: {} },
  no_auth: false,
  version: "20260113_00",
  available_versions: ["20260113_00"],
  tags: [],
  scopes: [],
  is_deprecated: false,
};

const client = (fetchImpl: typeof fetch, retries?: number) =>
  new ComposioClient({ apiKey: "ak_test", fetch: fetchImpl, retries });

describe("ComposioClient", () => {
  describe("request shape", () => {
    it("targets the pinned API version and sends the project key", async () => {
      const { impl, calls } = stubFetch([
        {
          status: 200,
          body: { items: [TOOL], next_cursor: null, total_pages: 1 },
        },
      ]);
      await client(impl).listTools({ toolkitSlug: "github" });

      expect(calls[0].url.startsWith(COMPOSIO_API_BASE)).toBe(true);
      expect(COMPOSIO_API_BASE).toContain("/api/v3.1");
      const headers = new Headers(calls[0].init.headers);
      expect(headers.get("x-api-key")).toBe("ak_test");
    });

    it("maps list options onto Composio's query parameters", async () => {
      const { impl, calls } = stubFetch([
        { status: 200, body: { items: [], next_cursor: null, total_pages: 0 } },
      ]);
      await client(impl).listTools({
        toolkitSlug: "github",
        important: true,
        limit: 100,
        cursor: "abc",
      });

      const url = new URL(calls[0].url);
      expect(url.searchParams.get("toolkit_slug")).toBe("github");
      expect(url.searchParams.get("important")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("cursor")).toBe("abc");
    });

    it("omits options that were not supplied", async () => {
      const { impl, calls } = stubFetch([
        { status: 200, body: { items: [], next_cursor: null, total_pages: 0 } },
      ]);
      await client(impl).listTools({ toolkitSlug: "github" });

      const url = new URL(calls[0].url);
      expect(url.searchParams.has("important")).toBe(false);
      expect(url.searchParams.has("cursor")).toBe(false);
    });
  });

  describe("responses", () => {
    it("returns parsed tools", async () => {
      const { impl } = stubFetch([
        {
          status: 200,
          body: { items: [TOOL], next_cursor: "next", total_pages: 2 },
        },
      ]);
      const page = await client(impl).listTools({ toolkitSlug: "github" });

      expect(page.items).toHaveLength(1);
      expect(page.items[0].slug).toBe("GITHUB_CREATE_AN_ISSUE");
      expect(page.items[0].version).toBe("20260113_00");
      expect(page.nextCursor).toBe("next");
    });

    it("surfaces the execute envelope verbatim, including failures", async () => {
      const { impl } = stubFetch([
        {
          status: 200,
          body: {
            data: { number: 7 },
            successful: false,
            error: "Not Found",
            log_id: "log_1",
          },
        },
      ]);
      const result = await client(impl).executeTool("GITHUB_CREATE_AN_ISSUE", {
        connectedAccountId: "ca_1",
        arguments: { owner: "o", repo: "r", title: "t" },
      });

      // A tool-level failure is data, not an exception — the node decides how
      // to report it, and still needs `data` and `logId` for diagnostics.
      expect(result.successful).toBe(false);
      expect(result.error).toBe("Not Found");
      expect(result.logId).toBe("log_1");
      expect(result.data).toEqual({ number: 7 });
    });

    it("records the rate-limit budget from response headers", async () => {
      const { impl } = stubFetch([
        {
          status: 200,
          body: { items: [], next_cursor: null, total_pages: 0 },
          headers: { "x-ratelimit-remaining": "1977", "x-ratelimit": "2000" },
        },
      ]);
      const c = client(impl);
      await c.listTools({ toolkitSlug: "github" });

      expect(c.rateLimitRemaining).toBe(1977);
    });
  });

  describe("errors", () => {
    it("unpacks Composio's error envelope into a typed error", async () => {
      const { impl } = stubFetch([
        {
          status: 404,
          body: {
            error: {
              message: "Tool NOT_A_REAL_TOOL not found",
              code: 2401,
              slug: "Tool_ToolNotFound",
              status: 404,
              suggested_fix: "Check your input.",
            },
          },
        },
      ]);

      const err = await client(impl)
        .getTool("NOT_A_REAL_TOOL")
        .catch((e) => e);

      expect(err).toBeInstanceOf(ComposioApiError);
      expect(err.status).toBe(404);
      expect(err.slug).toBe("Tool_ToolNotFound");
      expect(err.code).toBe(2401);
      expect(err.suggestedFix).toBe("Check your input.");
      expect(err.message).toContain("not found");
    });

    it("does not retry a 4xx", async () => {
      const { impl, calls } = stubFetch([
        { status: 404, body: { error: { message: "gone", status: 404 } } },
      ]);
      await client(impl)
        .getTool("X")
        .catch(() => undefined);
      expect(calls).toHaveLength(1);
    });

    it("retries a 5xx once and succeeds", async () => {
      const { impl, calls } = stubFetch([
        {
          status: 502,
          body: { error: { message: "bad gateway", status: 502 } },
        },
        { status: 200, body: TOOL },
      ]);
      const tool = await client(impl).getTool("GITHUB_CREATE_AN_ISSUE");

      expect(calls).toHaveLength(2);
      expect(tool.slug).toBe("GITHUB_CREATE_AN_ISSUE");
    });

    it("gives up after the retry budget", async () => {
      const { impl, calls } = stubFetch([
        { status: 500, body: { error: { message: "boom", status: 500 } } },
        { status: 500, body: { error: { message: "boom", status: 500 } } },
      ]);
      const err = await client(impl)
        .getTool("X")
        .catch((e) => e);

      expect(calls).toHaveLength(2);
      expect(err).toBeInstanceOf(ComposioApiError);
      expect(err.status).toBe(500);
    });

    it("reports a schema drift as a named error rather than yielding undefined", async () => {
      // `items` renamed upstream — the failure must name the endpoint, not
      // surface three layers later as a missing property.
      const { impl } = stubFetch([
        { status: 200, body: { results: [TOOL], next_cursor: null } },
      ]);
      const err = await client(impl)
        .listTools({ toolkitSlug: "github" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ComposioApiError);
      expect(err.message).toContain("/tools");
      expect(err.message.toLowerCase()).toContain("unexpected response");
    });

    it("treats a non-JSON body as a drift error, not a crash", async () => {
      const { impl } = stubFetch([{ status: 200, body: "<html>nope</html>" }]);
      const err = await client(impl)
        .listTools({ toolkitSlug: "github" })
        .catch((e) => e);

      expect(err).toBeInstanceOf(ComposioApiError);
    });
  });

  describe("triggers", () => {
    it("upserts a trigger instance and returns its routing id", async () => {
      const { impl, calls } = stubFetch([
        { status: 200, body: { trigger_id: "ti_abc" } },
      ]);
      const id = await client(impl).upsertTriggerInstance("GITHUB_STAR_ADDED", {
        connectedAccountId: "ca_1",
        triggerConfig: { owner: "o", repo: "r" },
      });

      expect(id).toBe("ti_abc");
      expect(calls[0].url).toContain(
        "/trigger_instances/GITHUB_STAR_ADDED/upsert"
      );
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(String(calls[0].init.body))).toEqual({
        connected_account_id: "ca_1",
        trigger_config: { owner: "o", repo: "r" },
      });
    });

    it("creates a webhook subscription and returns the signing secret", async () => {
      const { impl, calls } = stubFetch([
        {
          status: 200,
          body: {
            id: "ws_1",
            webhook_url: "https://x/webhooks/composio",
            version: "V3",
            enabled_events: ["composio.trigger.message"],
            secret: "whsec_abc",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ]);
      const sub = await client(impl).createWebhookSubscription({
        webhookUrl: "https://x/webhooks/composio",
        enabledEvents: ["composio.trigger.message"],
      });

      expect(sub.secret).toBe("whsec_abc");
      expect(sub.id).toBe("ws_1");
      // V3 is the only envelope this integration parses.
      expect(JSON.parse(String(calls[0].init.body)).version).toBe("V3");
    });

    it("deletes a trigger instance by id", async () => {
      const { impl, calls } = stubFetch([
        { status: 200, body: { trigger_id: "ti_abc" } },
      ]);
      await client(impl).deleteTriggerInstance("ti_abc");

      expect(calls[0].url).toContain("/trigger_instances/manage/ti_abc");
      expect(calls[0].init.method).toBe("DELETE");
    });
  });
});
