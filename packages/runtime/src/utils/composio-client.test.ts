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

describe("ComposioClient connections", () => {
  it("lists toolkits with a search term", async () => {
    const { impl, calls } = stubFetch([
      {
        status: 200,
        body: {
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              no_auth: false,
              composio_managed_auth_schemes: ["OAUTH2"],
              meta: { description: "Email", logo: "https://logo" },
            },
          ],
        },
      },
    ]);
    const toolkits = await client(impl).listToolkits({
      search: "mail",
      limit: 50,
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toContain("/toolkits");
    expect(url.searchParams.get("search")).toBe("mail");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(toolkits[0]).toMatchObject({
      slug: "gmail",
      name: "Gmail",
      managedAuthSchemes: ["OAUTH2"],
    });
  });

  it("finds an existing auth config for a toolkit", async () => {
    const { impl, calls } = stubFetch([
      {
        status: 200,
        body: {
          items: [
            { id: "ac_1", status: "ENABLED", toolkit: { slug: "gmail" } },
          ],
        },
      },
    ]);
    const id = await client(impl).findAuthConfig("gmail");

    expect(new URL(calls[0].url).searchParams.get("toolkit_slug")).toBe(
      "gmail"
    );
    expect(id).toBe("ac_1");
  });

  it("returns null when a toolkit has no auth config yet", async () => {
    const { impl } = stubFetch([{ status: 200, body: { items: [] } }]);
    expect(await client(impl).findAuthConfig("gmail")).toBeNull();
  });

  // Verified against the live API: `toolkit_slug` filters correctly for a known
  // slug, but an UNRECOGNISED one is silently dropped and every auth config is
  // returned. Trusting the first row would connect the user to another service.
  it("refuses a config belonging to a different toolkit", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: { items: [{ id: "ac_gmail", toolkit: { slug: "gmail" } }] },
      },
    ]);
    expect(await client(impl).findAuthConfig("zzz-not-a-toolkit")).toBeNull();
  });

  it("picks the matching toolkit out of an unfiltered list", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          items: [
            { id: "ac_gmail", toolkit: { slug: "gmail" } },
            { id: "ac_slack", toolkit: { slug: "slack" } },
          ],
        },
      },
    ]);
    expect(await client(impl).findAuthConfig("slack")).toBe("ac_slack");
  });

  it("trusts a lone result stating no toolkit, but never a list", async () => {
    const single = stubFetch([
      { status: 200, body: { items: [{ id: "ac_1" }] } },
    ]);
    expect(await client(single.impl).findAuthConfig("gmail")).toBe("ac_1");

    const many = stubFetch([
      { status: 200, body: { items: [{ id: "ac_1" }, { id: "ac_2" }] } },
    ]);
    expect(await client(many.impl).findAuthConfig("gmail")).toBeNull();
  });

  it("creates a Composio-managed auth config", async () => {
    const { impl, calls } = stubFetch([
      { status: 200, body: { auth_config: { id: "ac_new" } } },
    ]);
    const id = await client(impl).createAuthConfig("gmail", "dafthunk-gmail");

    expect(calls[0].init.method).toBe("POST");
    const sent = JSON.parse(String(calls[0].init.body));
    // Composio-managed auth is what makes this possible at all: Dafthunk holds
    // no client credentials for the toolkits Composio brokers.
    expect(sent.auth_config.type).toBe("use_composio_managed_auth");
    expect(sent.toolkit.slug).toBe("gmail");
    expect(id).toBe("ac_new");
  });

  it("creates an auth link session carrying the callback url", async () => {
    const { impl, calls } = stubFetch([
      {
        status: 200,
        body: {
          redirect_url: "https://auth.composio/x",
          connected_account_id: "ca_1",
        },
      },
    ]);
    const link = await client(impl).createConnectedAccountLink({
      authConfigId: "ac_1",
      userId: "org_42",
      callbackUrl: "https://dafthunk.test/composio/callback",
    });

    expect(calls[0].url).toContain("/connected_accounts/link");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({
      auth_config_id: "ac_1",
      user_id: "org_42",
      callback_url: "https://dafthunk.test/composio/callback",
    });
    expect(link.redirectUrl).toBe("https://auth.composio/x");
    expect(link.connectedAccountId).toBe("ca_1");
  });

  it("reads the fields the cross-tenant guard depends on", async () => {
    const { impl } = stubFetch([
      {
        status: 200,
        body: {
          id: "ca_1",
          status: "ACTIVE",
          user_id: "org_42",
          toolkit: { slug: "gmail" },
          auth_config: { id: "ac_1" },
        },
      },
    ]);
    const account = await client(impl).getConnectedAccount("ca_1");

    // userId is what proves the callback belongs to the org that started it.
    expect(account).toEqual({
      id: "ca_1",
      status: "ACTIVE",
      userId: "org_42",
      toolkitSlug: "gmail",
      authConfigId: "ac_1",
    });
  });

  it("surfaces a missing connected account as a typed error", async () => {
    const { impl } = stubFetch([
      { status: 404, body: { error: { message: "not found", status: 404 } } },
    ]);
    const err = await client(impl)
      .getConnectedAccount("ca_missing")
      .catch((e) => e);

    expect(err).toBeInstanceOf(ComposioApiError);
    expect(err.status).toBe(404);
  });
});

describe("ComposioClient default fetch binding", () => {
  /**
   * The client keeps its fetch implementation as a property and calls it as
   * `this.fetchImpl(...)`, which invokes the function with `this` set to the
   * client. workerd rejects that with "Illegal invocation" while Node and bun
   * tolerate it, so an unbound default fetch fails ONLY once deployed — it
   * broke catalog synthesis, the action node, the connect flow and the
   * reconciler simultaneously, and no fixture test noticed because they all
   * inject their own fetch.
   *
   * Asserting on the receiver rather than on a runtime's error message makes
   * this deterministic: the workerd test pool installs a fetch that is not
   * `this`-sensitive, so reproducing the symptom there is not possible.
   */
  it("calls the global fetch with globalThis as its receiver", async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(
        new Response(
          JSON.stringify({ items: [], next_cursor: null, total_pages: 0 }),
          { status: 200 }
        )
      );
    } as unknown as typeof fetch;

    try {
      // Constructed after the stub is installed: the binding is captured here.
      const client = new ComposioClient({ apiKey: "ak_test" });
      await client.listTools({ toolkitSlug: "github" });
    } finally {
      globalThis.fetch = original;
    }

    expect(receivers).toHaveLength(1);
    expect(receivers[0] === globalThis || receivers[0] === undefined).toBe(
      true
    );
    expect(receivers[0]).not.toBeInstanceOf(ComposioClient);
  });
});

describe("ComposioClient rate limiting", () => {
  /**
   * 429 was the single largest cause of failed runs in production: Composio
   * returns "Too many requests. Try again shortly." and the client treated it
   * like any other 4xx — a decision, not a hiccup — so it threw immediately and
   * the whole workflow died. It is the one 4xx that is worth waiting out.
   */
  const withSleep = (fetchImpl: typeof fetch, retries = 3) => {
    const waits: number[] = [];
    const client = new ComposioClient({
      apiKey: "ak_test",
      fetch: fetchImpl,
      retries,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });
    return { client, waits };
  };

  const rateLimited = (headers?: Record<string, string>) => ({
    status: 429,
    body: {
      error: { message: "Too many requests. Try again shortly.", status: 429 },
    },
    headers,
  });

  it("retries a 429 and succeeds", async () => {
    const { impl, calls } = stubFetch([
      rateLimited(),
      { status: 200, body: TOOL },
    ]);
    const { client } = withSleep(impl);

    const tool = await client.getTool("GITHUB_CREATE_AN_ISSUE");
    expect(calls).toHaveLength(2);
    expect(tool.slug).toBe("GITHUB_CREATE_AN_ISSUE");
  });

  it("waits the number of seconds Retry-After asks for", async () => {
    const { impl } = stubFetch([
      rateLimited({ "retry-after": "2" }),
      { status: 200, body: TOOL },
    ]);
    const { client, waits } = withSleep(impl);

    await client.getTool("X");
    expect(waits).toEqual([2000]);
  });

  it("understands an HTTP-date Retry-After", async () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const { impl } = stubFetch([
      rateLimited({ "retry-after": when }),
      { status: 200, body: TOOL },
    ]);
    const { client, waits } = withSleep(impl);

    await client.getTool("X");
    // Second granularity in the header, so allow a wide band.
    expect(waits[0]).toBeGreaterThan(1000);
    expect(waits[0]).toBeLessThanOrEqual(4000);
  });

  it("backs off progressively when no Retry-After is given", async () => {
    const { impl } = stubFetch([
      rateLimited(),
      rateLimited(),
      { status: 200, body: TOOL },
    ]);
    const { client, waits } = withSleep(impl);

    await client.getTool("X");
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it("never waits longer than the cap, however large Retry-After is", async () => {
    // A Worker cannot sit for a minute waiting; failing sooner beats being killed.
    const { impl } = stubFetch([
      rateLimited({ "retry-after": "600" }),
      { status: 200, body: TOOL },
    ]);
    const { client, waits } = withSleep(impl);

    await client.getTool("X");
    expect(waits[0]).toBeLessThanOrEqual(10_000);
  });

  it("gives up after the retry budget and reports 429", async () => {
    const { impl, calls } = stubFetch([
      rateLimited(),
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ]);
    const { client } = withSleep(impl, 3);

    const err = await client.getTool("X").catch((e) => e);
    expect(calls).toHaveLength(4);
    expect(err).toBeInstanceOf(ComposioApiError);
    expect(err.status).toBe(429);
  });

  it("still refuses to retry an ordinary 4xx", async () => {
    const { impl, calls } = stubFetch([
      { status: 404, body: { error: { message: "nope", status: 404 } } },
    ]);
    const { client } = withSleep(impl);

    await client.getTool("X").catch(() => undefined);
    expect(calls).toHaveLength(1);
  });
});
