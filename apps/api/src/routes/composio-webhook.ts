import { verifyComposioRequest } from "@dafthunk/runtime/utils/composio-signature";
import type { ComposioEvent, Workflow, WorkflowTrigger } from "@dafthunk/types";
import {
  COMPOSIO_EVENT_ACCOUNT_EXPIRED,
  COMPOSIO_EVENT_TRIGGER_MESSAGE,
} from "@dafthunk/types";
import { Hono } from "hono";

import type { ApiContext } from "../context";
import {
  createDatabase,
  getComposioTriggersByInstanceId,
  getOrganizationBillingInfo,
  resolveOrganizationBillingOptions,
} from "../db";
import { getAgentByName } from "../durable-objects/agent-utils";
import { createWorkerRuntime } from "../runtime/cloudflare-worker-runtime";
import { WorkflowStore } from "../stores/workflow-store";
import { isCreditExhausted } from "../utils/credits";
import { markComposioAccountExpired } from "./composio-connect";

/**
 * Composio trigger deliveries.
 *
 * Unauthenticated like the other provider webhooks: the delivery is proven by
 * an HMAC-SHA256 signature over `{webhook-id}.{webhook-timestamp}.{rawBody}`,
 * verified with `verifyComposioRequest` from `@dafthunk/runtime`. Read the raw
 * body — re-serialising parsed JSON changes bytes and breaks the signature.
 */
const composioWebhook = new Hono<ApiContext>();

/** Every V3 envelope type is namespaced; anything else is not ours. */
const COMPOSIO_EVENT_PREFIX = "composio.";

/**
 * How long a delivered event id is remembered.
 *
 * Composio's retry schedule is measured in hours, so the window has to outlive
 * it; a day costs one small KV entry per delivery and closes the whole schedule.
 */
const DELIVERY_TTL_SECONDS = 86_400;

const DELIVERY_KEY_PREFIX = "composio:delivery:";

/**
 * Where each normalised field may appear on the wire.
 *
 * Composio has shipped three envelope generations and the legacy deliveries are
 * camelCase while the REST API is snake_case, so a field is looked up by trying
 * every spelling in turn rather than by pinning one shape. Order is
 * significance, not preference: the V3 spelling comes first because it is what
 * a current subscription actually sends.
 */
const INSTANCE_ID_KEYS = [
  "trigger_id",
  "triggerId",
  "trigger_nano_id",
  "triggerNanoId",
  "nanoId",
  "nano_id",
] as const;

const TRIGGER_SLUG_KEYS = [
  "trigger_slug",
  "triggerSlug",
  "triggerName",
  "trigger_name",
] as const;

const TOOLKIT_SLUG_KEYS = [
  "toolkit_slug",
  "toolkitSlug",
  "appName",
  "app_name",
] as const;

const CONNECTED_ACCOUNT_KEYS = [
  "connected_account_id",
  "connectedAccountId",
  "connectedAccountNanoId",
  "connection_nano_id",
  "connectionNanoId",
] as const;

const USER_ID_KEYS = [
  "user_id",
  "userId",
  "clientUniqueUserId",
  "client_unique_user_id",
] as const;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function pickString(
  sources: readonly (UnknownRecord | null)[],
  keys: readonly string[]
): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Normalises a delivered body into a {@link ComposioEvent}, or null if it is not
 * one we can route.
 *
 * Pure so the whole shape-tolerance story is testable: the test-pool D1 has no
 * schema, so the full request path cannot be exercised and every decision worth
 * asserting has to live in a function that takes data and returns a verdict.
 *
 * Only `eventId`, `type` and `triggerInstanceId` are load-bearing — the first
 * de-duplicates, the second dispatches, the third routes. The rest are
 * best-effort because they are display data for the trigger node.
 */
/**
 * Reads a `composio.connected_account.expired` delivery.
 *
 * The account object sits on `data` and matches `GET /connected_accounts/{id}`,
 * so the org is `data.user_id` — Dafthunk sets Composio's user id to the
 * organization id when it creates the connection. Pure so it can be tested
 * without a request, like the trigger parser below.
 */
export function parseAccountExpiredEvent(
  body: unknown
): { organizationId: string; connectedAccountId: string } | null {
  const data = asRecord(asRecord(body)?.data);
  if (!data) return null;

  const connectedAccountId = data.id;
  const organizationId = data.user_id;
  if (
    typeof connectedAccountId !== "string" ||
    connectedAccountId.length === 0
  ) {
    return null;
  }
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    return null;
  }
  return { organizationId, connectedAccountId };
}

export function parseComposioEvent(body: unknown): ComposioEvent | null {
  const envelope = asRecord(body);
  if (!envelope) return null;

  const type = envelope.type;
  if (typeof type !== "string" || !type.startsWith(COMPOSIO_EVENT_PREFIX)) {
    return null;
  }

  const eventId = envelope.id;
  if (typeof eventId !== "string" || eventId.length === 0) return null;

  const metadata = asRecord(envelope.metadata);
  const data = asRecord(envelope.data);
  // Legacy deliveries nest the account under metadata; V3 flattens it.
  const connection =
    asRecord(metadata?.connection) ?? asRecord(metadata?.connectedAccount);
  // Metadata precedes data so a provider payload field named `user_id` cannot
  // shadow Composio's own routing metadata.
  const sources = [metadata, data, connection, envelope] as const;

  const triggerInstanceId = pickString(sources, INSTANCE_ID_KEYS);
  if (!triggerInstanceId) return null;

  const triggerSlug = pickString(sources, TRIGGER_SLUG_KEYS) ?? "";

  return {
    eventId,
    type,
    timestamp: typeof envelope.timestamp === "string" ? envelope.timestamp : "",
    triggerInstanceId,
    triggerSlug,
    // V3 stopped sending the toolkit; the vendor SDK recovers it from the slug
    // prefix, which is how trigger slugs are constructed upstream.
    toolkitSlug:
      pickString(sources, TOOLKIT_SLUG_KEYS) ?? triggerSlug.split("_")[0] ?? "",
    connectedAccountId: pickString(sources, CONNECTED_ACCOUNT_KEYS),
    userId: pickString(sources, USER_ID_KEYS),
    payload: data ?? asRecord(envelope.payload) ?? {},
  };
}

/**
 * The minimum a candidate row must carry to be routed. The D1 row is wider;
 * depending on the narrow shape keeps {@link selectTriggerTargets} testable
 * without a schema.
 */
export interface ComposioTriggerCandidate {
  composioTrigger: {
    workflowId: string;
    instanceId: string | null;
    active: boolean;
  };
  workflow: {
    id: string;
    name: string;
    trigger: string;
    organizationId: string;
  };
}

/**
 * Decides which workflows a delivery runs.
 *
 * The query returns candidates; every routing decision lives here so there is
 * one place to test and one place to change.
 */
export function selectTriggerTargets<T extends ComposioTriggerCandidate>(
  rows: readonly T[],
  event: ComposioEvent
): T[] {
  const byInstance = new Map<string, T>();
  for (const row of rows) {
    const { instanceId, active } = row.composioTrigger;
    if (!active || instanceId !== event.triggerInstanceId) continue;
    // The unique index on instance_id already forbids a second row. Keeping
    // only the first is belt-and-braces: a duplicate reaching this point would
    // run one upstream event twice, which is the failure the index exists for.
    if (!byInstance.has(instanceId)) byInstance.set(instanceId, row);
  }
  return [...byInstance.values()];
}

/**
 * Records an event id and reports whether this delivery is the first one.
 *
 * Composio retries, and a retry carries the same envelope id, so without this a
 * redelivery runs the workflow again. KV has no compare-and-set, so two
 * genuinely simultaneous retries can both win — a far narrower window than the
 * retry schedule this closes, and the alternative (a D1 write on the hot path)
 * costs more than it saves.
 */
export async function claimDelivery(
  kv: KVNamespace,
  eventId: string
): Promise<boolean> {
  const key = `${DELIVERY_KEY_PREFIX}${eventId}`;
  if ((await kv.get(key)) !== null) return false;
  await kv.put(key, "1", { expirationTtl: DELIVERY_TTL_SECONDS });
  return true;
}

/**
 * Runs every target, containing failures.
 *
 * A workflow that cannot load, or whose organization is out of credits, must
 * not swallow the delivery for the others.
 */
export async function dispatchTargets<T extends { workflow: { id: string } }>(
  targets: readonly T[],
  run: (target: T) => Promise<void>
): Promise<void> {
  for (const target of targets) {
    try {
      await run(target);
    } catch (error) {
      console.error(
        `[ComposioWebhook] Failed to trigger workflow ${target.workflow.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

composioWebhook.post("/webhook", async (c) => {
  const secret = c.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) {
    // Failing closed: without the secret nothing can be proven about a caller,
    // and this endpoint starts workflows.
    console.error(
      "[ComposioWebhook] COMPOSIO_WEBHOOK_SECRET is not configured, rejecting delivery"
    );
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const rawBody = await c.req.text();
  const verification = await verifyComposioRequest(
    c.req.raw.headers,
    rawBody,
    secret
  );
  if (!verification.ok) {
    console.error(
      `[ComposioWebhook] Rejected delivery: ${verification.reason}${
        verification.detail ? ` (${verification.detail})` : ""
      }`
    );
    return c.json({ error: "Invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Malformed JSON body" }, 400);
  }

  const envelopeType = asRecord(body)?.type;
  if (
    typeof envelopeType !== "string" ||
    !envelopeType.startsWith(COMPOSIO_EVENT_PREFIX)
  ) {
    return c.json({ error: "Not a Composio event" }, 400);
  }

  if (envelopeType === COMPOSIO_EVENT_ACCOUNT_EXPIRED) {
    // Composio noticed the upstream credential died before we tried to use it.
    // Recording that turns the next failed run into a visible "reconnect this"
    // in the integrations list instead of a confusing mid-workflow error.
    const expiry = parseAccountExpiredEvent(body);
    if (!expiry) {
      console.error("[ComposioWebhook] Unroutable account-expiry delivery");
      return c.json({ ok: true, ignored: envelopeType });
    }
    const env = c.env;
    c.executionCtx.waitUntil(
      markComposioAccountExpired(
        env,
        expiry.organizationId,
        expiry.connectedAccountId
      ).catch((error: unknown) => {
        console.error(
          "[ComposioWebhook] Failed to mark connection expired:",
          error instanceof Error ? error.message : String(error)
        );
      })
    );
    return c.json({ ok: true, handled: envelopeType });
  }

  if (envelopeType !== COMPOSIO_EVENT_TRIGGER_MESSAGE) {
    // A subscription may deliver other composio.* events. Acknowledging stops
    // Composio retrying something no workflow will ever act on.
    return c.json({ ok: true, ignored: envelopeType });
  }

  const event = parseComposioEvent(body);
  if (!event) {
    console.error("[ComposioWebhook] Unroutable trigger delivery");
    return c.json({ error: "Malformed Composio event" }, 400);
  }

  // Acknowledge before doing any work: Composio treats a slow response as a
  // failed delivery and retries it.
  const env = c.env;
  c.executionCtx.waitUntil(dispatchComposioEvent(env, event));
  return c.json({ ok: true });
});

async function dispatchComposioEvent(
  env: ApiContext["Bindings"],
  event: ComposioEvent
): Promise<void> {
  if (!(await claimDelivery(env.KV, event.eventId))) {
    console.log(
      `[ComposioWebhook] Ignoring redelivery of event ${event.eventId}`
    );
    return;
  }

  const db = createDatabase(env.DB);
  const rows = await getComposioTriggersByInstanceId(
    db,
    event.triggerInstanceId
  );
  const targets = selectTriggerTargets(rows, event);
  if (targets.length === 0) {
    console.log(
      `[ComposioWebhook] No active workflow for trigger instance ${event.triggerInstanceId}`
    );
    return;
  }

  const workflowStore = new WorkflowStore(env);
  await dispatchTargets(targets, (target) =>
    executeWorkflow(env, target.workflow, event, workflowStore)
  );
}

async function executeWorkflow(
  env: ApiContext["Bindings"],
  workflow: {
    id: string;
    name: string;
    trigger: string;
    organizationId: string;
  },
  event: ComposioEvent,
  workflowStore: WorkflowStore
): Promise<void> {
  const db = createDatabase(env.DB);
  const organizationId = workflow.organizationId;

  let workflowData: Workflow;

  try {
    const workflowWithData = await workflowStore.getWithData(
      workflow.id,
      organizationId
    );
    if (!workflowWithData?.data) {
      console.error(
        `[ComposioWebhook] Failed to load workflow data for ${workflow.id}`
      );
      return;
    }
    workflowData = workflowWithData.data;
  } catch (error) {
    console.error(
      `[ComposioWebhook] Failed to load workflow ${workflow.id}:`,
      error
    );
    return;
  }

  if (!workflowData.nodes || workflowData.nodes.length === 0) {
    console.error(
      `[ComposioWebhook] Workflow ${workflow.id} has no nodes, skipping`
    );
    return;
  }

  const billingInfo = await getOrganizationBillingInfo(db, organizationId);
  if (billingInfo === undefined) {
    console.error("[ComposioWebhook] Organization not found");
    return;
  }

  if (isCreditExhausted(billingInfo, env.CLOUDFLARE_ENV)) {
    console.log(
      `[ComposioWebhook] Skipping workflow ${workflow.id}: credits exhausted`
    );
    return;
  }

  const billingOptions = resolveOrganizationBillingOptions(
    billingInfo,
    env.CLOUDFLARE_ENV
  );

  const executionParams = {
    userId: "composio_trigger",
    organizationId,
    ...billingOptions,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      trigger: workflow.trigger as WorkflowTrigger,
      runtime: workflowData.runtime,
      nodes: workflowData.nodes,
      edges: workflowData.edges,
    },
    composioEvent: event,
  };

  if (workflowData.runtime === "worker") {
    const workerRuntime = createWorkerRuntime(env);
    const execution = await workerRuntime.execute(executionParams);
    console.log(
      `[Execution] ${execution.id} workflow=${workflow.id} runtime=worker trigger=composio status=${execution.status} error=${execution.error ?? "none"}`
    );
  } else {
    const agent = await getAgentByName(env.WORKFLOW_AGENT, workflow.id);
    const executionId = await agent.executeWorkflow(executionParams);
    console.log(
      `[Execution] ${executionId} workflow=${workflow.id} runtime=workflow trigger=composio`
    );
  }
}

export default composioWebhook;
