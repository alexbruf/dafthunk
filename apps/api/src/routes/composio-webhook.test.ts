import type { ComposioEvent } from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import composioWebhook, {
  type ComposioTriggerCandidate,
  claimDelivery,
  dispatchTargets,
  parseAccountExpiredEvent,
  parseComposioEvent,
  selectTriggerTargets,
} from "./composio-webhook";

/**
 * The test-pool D1 has no schema (see `http-triggers.test.ts`), so the request
 * path is only exercised as far as signature verification — which is exactly
 * where it must be exercised, since everything past it is gated on it. The
 * routing, normalisation, de-duplication and fan-out decisions live in pure
 * functions and are asserted directly.
 */

const SECRET = "whsec_test_secret";

async function sign(
  webhookId: string,
  timestamp: string,
  rawBody: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${webhookId}.${timestamp}.${rawBody}`)
  );
  const bytes = new Uint8Array(mac);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return `v1,${btoa(binary)}`;
}

/** A KV double: only `get` and `put` are used, and nothing may hit the network. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

const v3Envelope = (overrides: Record<string, unknown> = {}) => ({
  id: "evt_01",
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "composio.trigger.message",
  metadata: {
    log_id: "log_01",
    trigger_slug: "GITHUB_STAR_ADDED_EVENT",
    trigger_id: "ti_abc",
    connected_account_id: "ca_abc",
    auth_config_id: "ac_abc",
    user_id: "org_1",
  },
  data: { repository: "dafthunk/dafthunk", stars: 2 },
  ...overrides,
});

interface RequestOptions {
  body?: string;
  secret?: string;
  envSecret?: string | undefined;
  timestamp?: string;
  webhookId?: string;
  signature?: string;
  omitHeaders?: boolean;
}

async function post(options: RequestOptions = {}) {
  const body = options.body ?? JSON.stringify(v3Envelope());
  const webhookId = options.webhookId ?? "msg_01";
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ??
    (await sign(webhookId, timestamp, body, options.secret ?? SECRET));

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!options.omitHeaders) {
    headers["webhook-id"] = webhookId;
    headers["webhook-timestamp"] = timestamp;
    headers["webhook-signature"] = signature;
  }

  const env = {
    COMPOSIO_WEBHOOK_SECRET:
      "envSecret" in options ? options.envSecret : SECRET,
    // Reporting every event id as already claimed stops the deferred dispatch
    // at its first check, so an accepted delivery proves the handler reached
    // dispatch without the background work touching the schemaless test D1.
    KV: {
      get: async () => "1",
      put: async () => {},
    } as unknown as KVNamespace,
  };

  return composioWebhook.request(
    "/webhook",
    { method: "POST", headers, body },
    env,
    // The dispatch is deferred, so a no-op executionCtx keeps the request path
    // clear of D1 while still proving the handler got that far.
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
  );
}

describe("POST /composio/webhook signature handling", () => {
  it("accepts a correctly signed delivery", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a tampered body with 401", async () => {
    const body = JSON.stringify(v3Envelope());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign("msg_01", timestamp, body, SECRET);
    const response = await post({
      body: JSON.stringify(v3Envelope({ id: "evt_tampered" })),
      timestamp,
      signature,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a signature made with the wrong secret with 401", async () => {
    const response = await post({ secret: "whsec_wrong" });
    expect(response.status).toBe(401);
  });

  it("rejects a stale timestamp with 401", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await post({ timestamp: stale });
    expect(response.status).toBe(401);
  });

  it("rejects a future timestamp outside tolerance with 401", async () => {
    const ahead = String(Math.floor(Date.now() / 1000) + 3600);
    const response = await post({ timestamp: ahead });
    expect(response.status).toBe(401);
  });

  it("rejects a delivery with no signature headers with 401", async () => {
    const response = await post({ omitHeaders: true });
    expect(response.status).toBe(401);
  });

  it("rejects a signature list with no v1 entry with 401", async () => {
    const response = await post({ signature: "v2,abcdef" });
    expect(response.status).toBe(401);
  });

  it("accepts a rotated secret list where only one entry matches", async () => {
    const body = JSON.stringify(v3Envelope());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const good = await sign("msg_01", timestamp, body, SECRET);
    const stale = await sign("msg_01", timestamp, body, "whsec_old");
    const response = await post({
      body,
      timestamp,
      signature: `${stale} ${good}`,
    });
    expect(response.status).toBe(200);
  });

  it("fails closed when no secret is configured", async () => {
    const response = await post({ envSecret: undefined });
    // Never 200: an unconfigured secret must not become an open endpoint.
    expect(response.status).toBe(500);
  });
});

describe("POST /composio/webhook body handling", () => {
  it("returns 400 for malformed JSON", async () => {
    const response = await post({ body: "{not json" });
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-Composio envelope", async () => {
    const response = await post({
      body: JSON.stringify({ id: "x", type: "slack.message" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for a trigger message with no trigger instance id", async () => {
    const response = await post({
      body: JSON.stringify(v3Envelope({ metadata: {}, data: {} })),
    });
    expect(response.status).toBe(400);
  });

  it("acknowledges other composio.* events without running anything", async () => {
    const response = await post({
      body: JSON.stringify(
        v3Envelope({ type: "composio.connected_account.expired" })
      ),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: "composio.connected_account.expired",
    });
  });
});

describe("parseComposioEvent", () => {
  it("normalises a V3 envelope", () => {
    expect(parseComposioEvent(v3Envelope())).toEqual({
      eventId: "evt_01",
      type: "composio.trigger.message",
      timestamp: "2026-01-01T00:00:00.000Z",
      triggerInstanceId: "ti_abc",
      triggerSlug: "GITHUB_STAR_ADDED_EVENT",
      toolkitSlug: "GITHUB",
      connectedAccountId: "ca_abc",
      userId: "org_1",
      payload: { repository: "dafthunk/dafthunk", stars: 2 },
    });
  });

  it("reads legacy camelCase field names", () => {
    const event = parseComposioEvent({
      id: "evt_02",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "composio.trigger.message",
      appName: "github",
      metadata: {
        nanoId: "ti_legacy",
        triggerName: "GITHUB_STAR_ADDED_EVENT",
        connection: {
          connectedAccountNanoId: "ca_legacy",
          clientUniqueUserId: "org_2",
        },
      },
      payload: { action: "created" },
    });

    expect(event).toEqual({
      eventId: "evt_02",
      type: "composio.trigger.message",
      timestamp: "2026-01-01T00:00:00.000Z",
      triggerInstanceId: "ti_legacy",
      triggerSlug: "GITHUB_STAR_ADDED_EVENT",
      toolkitSlug: "github",
      connectedAccountId: "ca_legacy",
      userId: "org_2",
      payload: { action: "created" },
    });
  });

  it("reads snake_case field names carried on data", () => {
    const event = parseComposioEvent({
      id: "evt_03",
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "composio.trigger.message",
      metadata: {},
      data: {
        trigger_nano_id: "ti_data",
        connection_nano_id: "ca_data",
        user_id: "org_3",
        trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
        subject: "hello",
      },
    });

    expect(event?.triggerInstanceId).toBe("ti_data");
    expect(event?.connectedAccountId).toBe("ca_data");
    expect(event?.userId).toBe("org_3");
    expect(event?.toolkitSlug).toBe("GMAIL");
  });

  it("prefers Composio's metadata over a same-named provider payload field", () => {
    const event = parseComposioEvent(
      v3Envelope({ data: { user_id: "attacker", body: "x" } })
    );
    expect(event?.userId).toBe("org_1");
  });

  it("returns null when the trigger instance id is missing", () => {
    expect(
      parseComposioEvent(v3Envelope({ metadata: {}, data: {} }))
    ).toBeNull();
  });

  it("returns null for a non-composio. type", () => {
    expect(
      parseComposioEvent(v3Envelope({ type: "trigger.message" }))
    ).toBeNull();
  });

  it("returns null when the envelope id is missing", () => {
    const { id: _id, ...withoutId } = v3Envelope();
    expect(parseComposioEvent(withoutId)).toBeNull();
  });

  it("returns null for values that are not envelopes", () => {
    expect(parseComposioEvent(null)).toBeNull();
    expect(parseComposioEvent("{}")).toBeNull();
    expect(parseComposioEvent([v3Envelope()])).toBeNull();
    expect(parseComposioEvent(undefined)).toBeNull();
  });
});

const candidate = (
  overrides: Partial<ComposioTriggerCandidate["composioTrigger"]> = {},
  workflowId = "wf_1"
): ComposioTriggerCandidate => ({
  composioTrigger: {
    workflowId,
    instanceId: "ti_abc",
    active: true,
    ...overrides,
  },
  workflow: {
    id: workflowId,
    name: "Star watcher",
    trigger: "composio_event",
    organizationId: "org_1",
  },
});

const event = (overrides: Partial<ComposioEvent> = {}): ComposioEvent => ({
  eventId: "evt_01",
  type: "composio.trigger.message",
  timestamp: "2026-01-01T00:00:00.000Z",
  triggerInstanceId: "ti_abc",
  triggerSlug: "GITHUB_STAR_ADDED_EVENT",
  toolkitSlug: "GITHUB",
  payload: {},
  ...overrides,
});

describe("selectTriggerTargets", () => {
  it("routes a delivery to the workflow owning the trigger instance", () => {
    const rows = [candidate({}, "wf_1")];
    expect(selectTriggerTargets(rows, event())).toEqual(rows);
  });

  it("returns nothing for an unknown trigger instance id", () => {
    const rows = [candidate({ instanceId: "ti_other" })];
    expect(selectTriggerTargets(rows, event())).toEqual([]);
  });

  it("skips inactive rows", () => {
    const rows = [candidate({ active: false })];
    expect(selectTriggerTargets(rows, event())).toEqual([]);
  });

  it("skips rows whose subscription has not been created yet", () => {
    const rows = [candidate({ instanceId: null })];
    expect(selectTriggerTargets(rows, event())).toEqual([]);
  });

  it("never returns two rows for one trigger instance id", () => {
    const rows = [candidate({}, "wf_1"), candidate({}, "wf_2")];
    const selected = selectTriggerTargets(rows, event());
    expect(selected).toHaveLength(1);
    expect(selected[0].workflow.id).toBe("wf_1");
  });

  it("returns nothing for an empty candidate set", () => {
    expect(selectTriggerTargets([], event())).toEqual([]);
  });
});

describe("claimDelivery", () => {
  it("runs a workflow once when the same envelope id arrives twice", async () => {
    const { kv } = fakeKv();
    const runs: string[] = [];

    for (let i = 0; i < 2; i++) {
      if (await claimDelivery(kv, "evt_01")) runs.push("evt_01");
    }

    expect(runs).toEqual(["evt_01"]);
  });

  it("does not confuse distinct deliveries", async () => {
    const { kv } = fakeKv();
    expect(await claimDelivery(kv, "evt_01")).toBe(true);
    expect(await claimDelivery(kv, "evt_02")).toBe(true);
    expect(await claimDelivery(kv, "evt_01")).toBe(false);
  });

  it("namespaces the key so it cannot collide with other KV users", async () => {
    const { kv, store } = fakeKv();
    await claimDelivery(kv, "evt_01");
    expect([...store.keys()]).toEqual(["composio:delivery:evt_01"]);
  });
});

describe("dispatchTargets", () => {
  it("keeps going when one workflow fails", async () => {
    const ran: string[] = [];
    const targets = [
      candidate({}, "wf_1"),
      candidate({}, "wf_2"),
      candidate({}, "wf_3"),
    ];

    await dispatchTargets(targets, async (target) => {
      if (target.workflow.id === "wf_2") throw new Error("boom");
      ran.push(target.workflow.id);
    });

    expect(ran).toEqual(["wf_1", "wf_3"]);
  });

  it("never rejects, so it is safe inside waitUntil", async () => {
    await expect(
      dispatchTargets([candidate()], async () => {
        throw new Error("boom");
      })
    ).resolves.toBeUndefined();
  });
});

describe("parseAccountExpiredEvent", () => {
  const expiredEnvelope = (data: Record<string, unknown>) => ({
    id: "evt_expired_1",
    type: "composio.connected_account.expired",
    timestamp: "2026-08-11T00:00:00.000Z",
    metadata: {},
    data,
  });

  it("reads the org and account from a real expiry delivery", () => {
    // `data` mirrors GET /connected_accounts/{id}; Dafthunk sets Composio's
    // user_id to the organization id when creating the connection.
    expect(
      parseAccountExpiredEvent(
        expiredEnvelope({
          id: "ca_abc123",
          user_id: "org_42",
          status: "EXPIRED",
          toolkit: { slug: "gmail" },
        })
      )
    ).toEqual({ organizationId: "org_42", connectedAccountId: "ca_abc123" });
  });

  it("returns null when the account id is missing", () => {
    expect(
      parseAccountExpiredEvent(expiredEnvelope({ user_id: "org_42" }))
    ).toBeNull();
  });

  it("returns null when the org is missing", () => {
    // Without an org there is nothing to scope the update to, and guessing
    // would risk expiring another tenant's connection.
    expect(
      parseAccountExpiredEvent(expiredEnvelope({ id: "ca_abc123" }))
    ).toBeNull();
  });

  it("returns null for an empty-string org", () => {
    expect(
      parseAccountExpiredEvent(
        expiredEnvelope({ id: "ca_abc123", user_id: "" })
      )
    ).toBeNull();
  });

  it("returns null when there is no data object at all", () => {
    expect(parseAccountExpiredEvent({ id: "evt", type: "x" })).toBeNull();
    expect(parseAccountExpiredEvent(null)).toBeNull();
  });
});
