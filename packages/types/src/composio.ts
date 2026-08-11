/**
 * Composio integration types.
 *
 * Composio is a provider *of* providers: one Dafthunk integration record points
 * at one Composio connected account, which belongs to one Composio toolkit
 * (github, gmail, …). That extra dimension is why integration records carry a
 * `toolkit` in their metadata and why the `integration` parameter type accepts
 * an optional toolkit filter — a Gmail action must not offer a Slack connection.
 */

/** Runtime node type shared by every synthesised Composio action. */
export const COMPOSIO_ACTION_NODE_TYPE = "composio-action";

/** Runtime node type shared by every synthesised Composio trigger. */
export const COMPOSIO_TRIGGER_NODE_TYPE = "receive-composio-event";

/**
 * Hidden inputs that pin a synthesised node to one upstream tool.
 *
 * The version is pinned as well as the slug because Composio versions tools
 * with a date stamp and `execute` defaults to "00000000_00" rather than the
 * latest. Without a pin, an upstream tool revision would silently change the
 * schema of workflows that are already saved.
 */
export const COMPOSIO_TOOL_SLUG_INPUT = "toolSlug";
export const COMPOSIO_TOOL_VERSION_INPUT = "toolVersion";
export const COMPOSIO_TRIGGER_SLUG_INPUT = "triggerSlug";

/**
 * Metadata key carrying per-entry display data through the workflow save path,
 * mirroring the Cloudflare model catalog's `_cf_meta`.
 */
export const COMPOSIO_META_KEY = "_composio_meta";

/**
 * Marks a synthesised node whose tool identity is fixed. The editor renders no
 * tool picker for it — switching the tool would change the node's identity and
 * drop wired edges, so users drop a different node from the palette instead.
 */
export const COMPOSIO_LOCKED_KEY = "_composio_locked";

/** V3 webhook event types Dafthunk subscribes to. */
export const COMPOSIO_EVENT_TRIGGER_MESSAGE = "composio.trigger.message";
export const COMPOSIO_EVENT_ACCOUNT_EXPIRED =
  "composio.connected_account.expired";

export interface ComposioMeta {
  toolkitSlug?: string;
  toolkitName?: string;
  description?: string;
}

/**
 * A trigger delivery, normalised from Composio's V3 webhook envelope.
 *
 * `eventId` is the envelope's top-level id and is the de-duplication key: a
 * redelivery carries the same one, and running a workflow twice for a single
 * upstream event is the failure this prevents.
 *
 * `triggerInstanceId` is the routing key — it maps to a row in
 * `composio_triggers` and therefore to exactly one workflow.
 */
export interface ComposioEvent {
  eventId: string;
  type: string;
  timestamp: string;
  triggerInstanceId: string;
  triggerSlug: string;
  toolkitSlug: string;
  connectedAccountId?: string;
  /** Composio's user id, which Dafthunk sets to the organization id. */
  userId?: string;
  /** The upstream provider's event body. */
  payload: Record<string, unknown>;
}
