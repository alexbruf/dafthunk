import type { Node } from "@dafthunk/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationInfo, NodeContext } from "../../node-types";
import { ComposioActionNode } from "./composio-action-node";

/**
 * The node builds its own ComposioClient, which reads `globalThis.fetch` at
 * construction time, so stubbing the global is enough to keep every case off
 * the network while still asserting on the exact request that was built.
 */
const calls: Array<{ url: string; init: RequestInit }> = [];
let queued: Array<{ status: number; body: unknown }> = [];
let transportFailure: Error | null = null;

const queueResponse = (status: number, body: unknown) =>
  queued.push({ status, body });

beforeEach(() => {
  calls.length = 0;
  queued = [];
  transportFailure = null;
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (transportFailure) throw transportFailure;
    const next = queued.shift();
    if (!next) throw new Error("composio test: no response queued");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

const GMAIL_CONNECTION: IntegrationInfo = {
  id: "int_gmail",
  name: "Gmail (work)",
  provider: "composio",
  token: "ca_gmail_123",
  metadata: { toolkit: "gmail" },
};

const createContext = (
  inputs: Record<string, unknown>,
  options: {
    env?: Record<string, string>;
    integration?: IntegrationInfo;
    integrationError?: Error;
  } = {}
): NodeContext =>
  ({
    nodeId: "composio-action",
    workflowId: "wf_1",
    organizationId: "org_1",
    inputs,
    env: options.env ?? { COMPOSIO_API_KEY: "ak_test" },
    getIntegration: vi.fn(async () => {
      if (options.integrationError) throw options.integrationError;
      return options.integration ?? GMAIL_CONNECTION;
    }),
  }) as unknown as NodeContext;

const createNode = () =>
  new ComposioActionNode({ id: "composio-action" } as unknown as Node);

const SUCCESS_ENVELOPE = {
  data: { id: 42, thread: "t_1" },
  successful: true,
  error: null,
  log_id: "log_abc123",
};

const requestBody = (index = 0): Record<string, unknown> =>
  JSON.parse(String(calls[index].init.body));

describe("ComposioActionNode", () => {
  describe("successful execution", () => {
    it("returns the tool payload, the success flag and the log id", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
          toolVersion: "20260113_00",
          recipient_email: "someone@example.com",
        })
      );

      expect(result.status).toBe("completed");
      expect(result.outputs?.data).toEqual({ id: 42, thread: "t_1" });
      expect(result.outputs?.successful).toBe(true);
      expect(result.outputs?.logId).toBe("log_abc123");
    });

    it("forwards the pinned version, so an upstream revision cannot change a saved workflow", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
          toolVersion: "20260113_00",
          recipient_email: "someone@example.com",
        })
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/tools/execute/GMAIL_SEND_EMAIL");
      expect(requestBody().version).toBe("20260113_00");
    });

    it("executes as the integration's connected account and the caller's organization", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
        })
      );

      expect(requestBody().connected_account_id).toBe("ca_gmail_123");
      expect(requestBody().user_id).toBe("org_1");
    });

    it("sends the synthesised entry's own inputs as the tool arguments", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
          toolVersion: "20260113_00",
          recipient_email: "someone@example.com",
          subject: "Hello",
        })
      );

      expect(requestBody().arguments).toEqual({
        recipient_email: "someone@example.com",
        subject: "Hello",
      });
    });

    it("merges the generic arguments object with named inputs, named inputs winning", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
          arguments: { cc: "cc@example.com", subject: "From arguments" },
          subject: "From a named input",
        })
      );

      expect(requestBody().arguments).toEqual({
        cc: "cc@example.com",
        subject: "From a named input",
      });
    });

    it("omits inputs that were never wired rather than sending them as undefined", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
          recipient_email: "someone@example.com",
          subject: undefined,
        })
      );

      expect(requestBody().arguments).toEqual({
        recipient_email: "someone@example.com",
      });
    });
  });

  describe("input validation", () => {
    it("names integrationId when it is missing", async () => {
      const result = await createNode().execute(
        createContext({ toolSlug: "GMAIL_SEND_EMAIL" })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("Integration");
      expect(calls).toHaveLength(0);
    });

    it("rejects a missing tool slug", async () => {
      const result = await createNode().execute(
        createContext({ integrationId: "int_gmail" })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("tool slug");
      expect(calls).toHaveLength(0);
    });

    it("rejects a blank tool slug", async () => {
      const result = await createNode().execute(
        createContext({ integrationId: "int_gmail", toolSlug: "  " })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("tool slug");
      expect(calls).toHaveLength(0);
    });

    it("reports the missing project key rather than failing at the network", async () => {
      const result = await createNode().execute(
        createContext(
          { integrationId: "int_gmail", toolSlug: "GMAIL_SEND_EMAIL" },
          { env: {} }
        )
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("COMPOSIO_API_KEY");
      expect(calls).toHaveLength(0);
    });
  });

  describe("toolkit guard", () => {
    it("refuses to run a Slack tool through a Gmail connection", async () => {
      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "SLACK_SEND_MESSAGE",
        })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("gmail");
      expect(result.error).toContain("SLACK_SEND_MESSAGE");
      expect(calls).toHaveLength(0);
    });

    it("accepts a toolkit slug whose punctuation differs from the tool prefix", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      const result = await createNode().execute(
        createContext(
          {
            integrationId: "int_cal",
            toolSlug: "GOOGLECALENDAR_CREATE_EVENT",
          },
          {
            integration: {
              id: "int_cal",
              name: "Calendar",
              provider: "composio",
              token: "ca_cal_1",
              metadata: { toolkit: "google-calendar" },
            },
          }
        )
      );

      expect(result.status).toBe("completed");
    });

    it("runs the tool when the connection records no toolkit at all", async () => {
      queueResponse(200, SUCCESS_ENVELOPE);

      const result = await createNode().execute(
        createContext(
          { integrationId: "int_x", toolSlug: "SLACK_SEND_MESSAGE" },
          {
            integration: {
              id: "int_x",
              name: "Untagged",
              provider: "composio",
              token: "ca_x",
            },
          }
        )
      );

      expect(result.status).toBe("completed");
    });
  });

  describe("failures", () => {
    it("surfaces a tool that reports failure instead of throwing", async () => {
      queueResponse(200, {
        data: {},
        successful: false,
        error: "Recipient address rejected",
        log_id: "log_fail",
      });

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
        })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("Recipient address rejected");
      expect(result.error).toContain("GMAIL_SEND_EMAIL");
    });

    it("turns a missing connected account into a reconnect instruction", async () => {
      queueResponse(404, {
        error: {
          message: "No connected account found for user ID X for toolkit gmail",
          code: 1810,
          slug: "ActionExecute_ConnectedAccountNotFound",
          status: 404,
          suggested_fix: "Create a connected account first.",
        },
      });

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
        })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("Reconnect");
      // The raw envelope is support noise, not something a workflow author can act on.
      expect(result.error).not.toContain(
        "ActionExecute_ConnectedAccountNotFound"
      );
      expect(result.error).not.toContain("1810");
    });

    it("tells the author to re-add the action when the tool no longer exists", async () => {
      queueResponse(404, {
        error: {
          message: "Tool GMAIL_NOT_A_REAL_TOOL not found",
          code: 2401,
          slug: "Tool_ToolNotFound",
          status: 404,
          suggested_fix: "Check your input.",
        },
      });

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_NOT_A_REAL_TOOL",
        })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("GMAIL_NOT_A_REAL_TOOL");
      expect(result.error).toContain("palette");
      expect(result.error).not.toContain("Tool_ToolNotFound");
    });

    it("reports an upstream 500 with its status and message", async () => {
      // Four attempts: the node asks for three retries so a rate-limited burst
      // can ride out Composio's window, and 5xx shares that budget.
      for (let i = 0; i < 4; i++) {
        queueResponse(500, { error: { message: "internal error" } });
      }

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
        })
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("500");
      expect(result.error).toContain("internal error");
      expect(calls).toHaveLength(4);
    });

    it("never throws when the transport itself fails", async () => {
      transportFailure = new TypeError("fetch failed");

      const result = await createNode().execute(
        createContext({
          integrationId: "int_gmail",
          toolSlug: "GMAIL_SEND_EMAIL",
        })
      );

      expect(result.status).toBe("error");
      // A bare "fetch failed" gives no clue which step broke, so the slug is named.
      expect(result.error).toContain("GMAIL_SEND_EMAIL");
      expect(result.error).toContain("fetch failed");
    });

    it("never throws when the integration cannot be resolved", async () => {
      const result = await createNode().execute(
        createContext(
          { integrationId: "int_missing", toolSlug: "GMAIL_SEND_EMAIL" },
          { integrationError: new Error("Integration not found") }
        )
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("Integration not found");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("ComposioActionNode rate limiting", () => {
  it("rides out a 429 instead of failing the workflow", async () => {
    // 429 was the largest single cause of failed runs: a burst of Notion
    // comments trips Composio's limit and each one died on a condition that
    // clears in seconds.
    queueResponse(429, {
      error: { message: "Too many requests. Try again shortly.", status: 429 },
    });
    queueResponse(200, {
      data: { ok: true },
      successful: true,
      error: null,
      log_id: "log_1",
    });

    const result = await createNode().execute(
      createContext({
        integrationId: "int_gmail",
        toolSlug: "GMAIL_SEND_EMAIL",
      })
    );

    expect(calls).toHaveLength(2);
    expect(result.status).toBe("completed");
  });

  it("gives up after the budget rather than hanging", async () => {
    for (let i = 0; i < 4; i++) {
      queueResponse(429, {
        error: { message: "Too many requests.", status: 429 },
      });
    }

    const result = await createNode().execute(
      createContext({
        integrationId: "int_gmail",
        toolSlug: "GMAIL_SEND_EMAIL",
      })
    );

    expect(calls).toHaveLength(4);
    expect(result.status).toBe("error");
    expect(result.error).toContain("429");
  });
});
