import {
  type CloudflareJsonSchema,
  mapCloudflareSchema,
} from "@dafthunk/runtime/utils/cloudflare-schema";
import {
  ComposioClient,
  type ComposioPage,
  type ComposioTool,
  type ComposioTriggerType,
} from "@dafthunk/runtime/utils/composio-client";
import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_LOCKED_KEY,
  COMPOSIO_META_KEY,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
  type ComposioMeta,
  type NodeType,
  type Parameter,
} from "@dafthunk/types";

import type { Bindings, DeferredWorkContext } from "../context";
import { createDatabase, getIntegrations } from "../db";

/**
 * Synthesises Dafthunk `NodeType`s from the Composio catalog, so every tool and
 * trigger type is a first-class palette entry without one registered runtime
 * implementation per tool. Same shape as `cloudflare-model-catalog.ts`: many
 * synthesised ids, one runtime node type behind them, per-POP cached bundles,
 * and degradation to nothing at all when the upstream is unavailable.
 *
 * The two catalogs are bounded very differently on purpose:
 *  - Actions: only `important` tools of toolkits the organization has actually
 *    connected. GitHub publishes 893 tools and flags 66 as important; shipping
 *    the unbounded set would put megabytes into every `/types` response.
 *  - Triggers: the whole catalog (362 types). Triggers are what a user goes
 *    looking for *before* connecting anything, so they must be discoverable
 *    with no connection in place.
 *
 * Everything Composio publishes beyond those bounds stays reachable through
 * `routes/composio.ts`, which searches the live catalog on demand.
 */

/** Palette id prefixes. The runtime node type is shared; the id is not. */
const ACTION_ID_PREFIX = "composio:";
const TRIGGER_ID_PREFIX = "composio-trigger:";

/** Synthetic host used as the Cache API key namespace. */
const CACHE_HOST = "https://cache.dafthunk.internal";

/** Cache TTLs (seconds). Upper bounds — the Workers cache may evict earlier. */
const TRIGGER_BUNDLE_TTL = 6 * 60 * 60; // 6h — the trigger catalog barely moves
const ACTION_BUNDLE_TTL = 60 * 60; // 1h — new tools ship more often

const PAGE_SIZE = 100;

/** Pagination stop-loss, so an upstream cursor bug can't spin a request. */
const MAX_PAGES = 50;

/**
 * Inputs the synthesised node owns. A tool parameter that collides with one of
 * these would silently overwrite the pin that gives the node its identity.
 */
const RESERVED_INPUT_NAMES = new Set<string>([
  "integrationId",
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  COMPOSIO_TRIGGER_SLUG_INPUT,
]);

/**
 * Composio wraps every tool result in `{ data, error, successful }`. `data` is
 * the output people wire; the other two are diagnostics that would otherwise
 * clutter every node.
 */
const ACTION_ENVELOPE_OUTPUTS = new Set(["error", "successful"]);

/** Envelope fields the webhook delivers alongside a trigger's own payload. */
const TRIGGER_ENVELOPE_OUTPUTS: Parameter[] = [
  {
    name: "triggerSlug",
    type: "string",
    description: "Trigger that fired",
    hidden: true,
  },
  {
    name: "toolkitSlug",
    type: "string",
    description: "Toolkit the event came from",
    hidden: true,
  },
  {
    name: "eventId",
    type: "string",
    description: "Composio event id, unique per delivery",
    hidden: true,
  },
];

// --------------------------- Composio JSON Schema ---------------------------

/**
 * Composio's JSON Schema dialect: ordinary JSON Schema plus the vendor fields
 * this module reads. `default` widens to `unknown` because Composio publishes
 * container defaults (`"default": []`) that must never reach a Dafthunk
 * `Parameter.default`, which holds a primitive.
 */
interface ComposioJsonSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  required?: string[];
  properties?: Record<string, ComposioJsonSchema>;
  items?: ComposioJsonSchema;
  anyOf?: ComposioJsonSchema[];
  oneOf?: ComposioJsonSchema[];
  allOf?: ComposioJsonSchema[];
  /** Reader-friendly label, present on roughly two thirds of parameters. */
  human_parameter_name?: string;
  /** Marks Composio's S3-backed file upload shape. */
  file_uploadable?: boolean;
}

const asSchema = (
  raw: Record<string, unknown> | undefined
): ComposioJsonSchema => (raw ?? {}) as ComposioJsonSchema;

function primitiveDefault(
  value: unknown
): string | number | boolean | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? value
    : undefined;
}

/**
 * True when a parameter accepts a Composio file upload. The flag sits on the
 * schema describing the file, which is either the parameter itself
 * (`GOOGLEDRIVE_UPLOAD_FILE.file_to_upload`) or one branch of an anyOf
 * (`GMAIL_SEND_EMAIL.attachment`). Nested `properties` are deliberately not
 * searched: a file field buried inside an unrelated object is not a parameter
 * the editor ever surfaces.
 */
function acceptsFileUpload(schema: ComposioJsonSchema): boolean {
  if (schema.file_uploadable === true) return true;
  if (schema.items && acceptsFileUpload(schema.items)) return true;
  const branches = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  return branches.some(acceptsFileUpload);
}

function isStringArray(schema: ComposioJsonSchema): boolean {
  return schema.type === "array" && schema.items?.type === "string";
}

/**
 * Display text for one parameter. Composio's `title` is a mechanical
 * title-casing of the key ("Label Ids"), but `human_parameter_name` is written
 * for a reader ("CC recipients' email addresses"), so it leads. The technical
 * description still follows it: that is where the constraints live (required
 * permissions, silent-drop behaviour, formats) and dropping them would make
 * calls fail for reasons the editor never showed.
 */
function displayDescription(schema: ComposioJsonSchema): string | undefined {
  const human = schema.human_parameter_name?.trim();
  const raw = schema.description?.trim() || schema.title?.trim();
  if (!human) return raw;
  if (!raw) return human;
  return raw.startsWith(human) ? raw : `${human} — ${raw}`;
}

/**
 * Strip container defaults before mapping. Doing it here rather than unpicking
 * the mapped `Parameter` afterwards keeps the invalid value from ever existing.
 */
function withPrimitiveDefaults(schema: ComposioJsonSchema): ComposioJsonSchema {
  if (!schema.properties) return schema;

  const properties: Record<string, ComposioJsonSchema> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    if (
      property.default !== undefined &&
      primitiveDefault(property.default) === undefined
    ) {
      const { default: _dropped, ...rest } = property;
      properties[name] = rest;
      continue;
    }
    properties[name] = property;
  }
  return { ...schema, properties };
}

/**
 * Map a Composio input/output schema pair with the shared Cloudflare mapper,
 * then apply the two refinements Composio's dialect makes possible. This wraps
 * the mapper rather than forking it: one mapper measured against two catalogs
 * is the whole reason it handles the awkward shapes correctly.
 */
function mapComposioSchema(
  input: ComposioJsonSchema,
  output: ComposioJsonSchema
): { inputs: Parameter[]; outputs: Parameter[] } {
  const cleaned = withPrimitiveDefaults(input);
  const mapped = mapCloudflareSchema({
    input: cleaned as CloudflareJsonSchema,
    output: output as CloudflareJsonSchema,
  });
  const properties = cleaned.properties ?? {};
  return {
    inputs: mapped.inputs.map((parameter) =>
      refineInput(parameter, properties[parameter.name])
    ),
    outputs: mapped.outputs,
  };
}

function refineInput(
  parameter: Parameter,
  schema: ComposioJsonSchema | undefined
): Parameter {
  if (!schema) return parameter;

  const description = displayDescription(schema) ?? parameter.description;

  if (!isStringArray(schema)) {
    return description
      ? ({ ...parameter, description } as Parameter)
      : parameter;
  }

  // Dafthunk supports repeated inputs, and array<string> — `labels`, `cc`,
  // `assignees` — is the most common array shape in the catalog. Left as json
  // the user would have to hand-write `["a","b"]` into a code editor for what
  // is really a list of connections or plain values.
  return {
    name: parameter.name,
    type: "string",
    repeated: true,
    ...(description ? { description } : {}),
    ...(parameter.required !== undefined
      ? { required: parameter.required }
      : {}),
    ...(parameter.hidden !== undefined ? { hidden: parameter.hidden } : {}),
  };
}

// ------------------------------- Presentation -------------------------------

function toolkitLabel(toolkit: { slug: string; name?: string }): string {
  const raw = toolkit.name?.trim() || toolkit.slug;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * "Create an issue" collides with Jira, Linear and half a dozen other toolkits
 * in a flat palette, so the toolkit leads unless the name already carries it.
 */
function qualifiedName(label: string, name: string): string {
  return name.toLowerCase().startsWith(label.toLowerCase())
    ? name
    : `${label}: ${name}`;
}

function composioMetadata(
  toolkit: { slug: string; name?: string },
  description: string
): Record<string, string> {
  const meta: ComposioMeta = {
    toolkitSlug: toolkit.slug,
    toolkitName: toolkitLabel(toolkit),
    description,
  };
  return {
    [COMPOSIO_META_KEY]: JSON.stringify(meta),
    [COMPOSIO_LOCKED_KEY]: "true",
  };
}

function integrationInput(toolkitSlug: string, purpose: string): Parameter {
  return {
    name: "integrationId",
    type: "integration",
    provider: "composio",
    // One Composio integration record is one connected account of one toolkit.
    // Without this a Gmail action would offer the user's Slack connection.
    toolkit: toolkitSlug,
    description: purpose,
    hidden: true,
    required: true,
  };
}

// --------------------------------- Actions ---------------------------------

export type ComposioActionSynthesis =
  | { ok: true; nodeType: NodeType }
  | { ok: false; reason: string };

/**
 * Build the palette entry for one Composio tool, or explain why it has none.
 */
export function buildComposioActionNodeType(
  tool: ComposioTool
): ComposioActionSynthesis {
  const input = asSchema(tool.input_parameters);
  const properties = input.properties ?? {};
  const required = new Set(input.required ?? []);

  const fileParameters = Object.keys(properties).filter((name) =>
    acceptsFileUpload(properties[name])
  );
  const blocking = fileParameters.filter((name) => required.has(name));
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `${tool.slug} requires the file upload parameter(s) ${blocking.join(", ")}; Dafthunk has no input type for Composio's S3-backed file uploads yet.`,
    };
  }

  // An *optional* file parameter only costs the tool that one input. Rejecting
  // the whole tool would drop GMAIL_SEND_EMAIL and three of Gmail's other
  // headline tools, every one of which works fine without an attachment.
  const droppedInputs = new Set(fileParameters);

  const { inputs: mapped, outputs: mappedOutputs } = mapComposioSchema(
    input,
    asSchema(tool.output_parameters)
  );

  const label = toolkitLabel(tool.toolkit);
  // Composio versions tools with a date stamp and `execute` defaults to
  // "00000000_00" rather than latest, so the version is pinned alongside the
  // slug: without it an upstream revision changes the schema of workflows that
  // are already saved.
  const version =
    tool.version ?? tool.available_versions[tool.available_versions.length - 1];

  const inputs: Parameter[] = [
    integrationInput(tool.toolkit.slug, `${label} connection to run this as`),
    {
      name: COMPOSIO_TOOL_SLUG_INPUT,
      type: "string",
      description: "Composio tool this node runs",
      hidden: true,
      required: true,
      value: tool.slug,
    },
    {
      name: COMPOSIO_TOOL_VERSION_INPUT,
      type: "string",
      description: "Composio tool version this node's schema was built from",
      hidden: true,
      required: false,
      ...(version ? { value: version } : {}),
    },
    ...mapped.filter(
      (parameter) =>
        !RESERVED_INPUT_NAMES.has(parameter.name) &&
        !droppedInputs.has(parameter.name)
    ),
  ];

  const outputs: Parameter[] = mappedOutputs
    .filter((output) => output.name !== "logId")
    .map((output) =>
      ACTION_ENVELOPE_OUTPUTS.has(output.name)
        ? ({ ...output, hidden: true } as Parameter)
        : output
    );
  outputs.push({
    name: "logId",
    type: "string",
    description: "Composio execution log id, for support and debugging",
    hidden: true,
  });

  return {
    ok: true,
    nodeType: {
      id: `${ACTION_ID_PREFIX}${tool.slug}`,
      name: qualifiedName(label, tool.name),
      type: COMPOSIO_ACTION_NODE_TYPE,
      description: tool.description,
      tags: ["Composio", label],
      icon: "plug",
      usage: 10,
      subscription: true,
      asTool: true,
      inlinable: false,
      inputs,
      outputs,
      metadata: composioMetadata(tool.toolkit, tool.description),
    },
  };
}

// --------------------------------- Triggers ---------------------------------

/** Build the palette entry for one Composio trigger type. */
export function buildComposioTriggerNodeType(
  triggerType: ComposioTriggerType
): NodeType {
  const config = asSchema(triggerType.config);
  const payload = asSchema(triggerType.payload);
  const { inputs: mapped, outputs: mappedOutputs } = mapComposioSchema(
    config,
    payload
  );

  const label = toolkitLabel(triggerType.toolkit);

  const inputs: Parameter[] = [
    integrationInput(
      triggerType.toolkit.slug,
      `${label} connection to subscribe with`
    ),
    {
      name: COMPOSIO_TRIGGER_SLUG_INPUT,
      type: "string",
      description: "Composio trigger this node subscribes to",
      hidden: true,
      required: true,
      value: triggerType.slug,
    },
    ...mapped.filter((parameter) => !RESERVED_INPUT_NAMES.has(parameter.name)),
  ];

  // Two of the 362 trigger types publish an empty payload schema. A node with
  // no outputs cannot be wired to anything, so those get the raw event body.
  const hasPayloadSchema = Object.keys(payload.properties ?? {}).length > 0;
  const payloadOutputs: Parameter[] = hasPayloadSchema
    ? mappedOutputs
    : [
        {
          name: "payload",
          type: "json",
          description: "The upstream provider's event body",
        },
      ];

  const declared = new Set(payloadOutputs.map((output) => output.name));
  const outputs = [
    ...payloadOutputs,
    ...TRIGGER_ENVELOPE_OUTPUTS.filter((output) => !declared.has(output.name)),
  ];

  return {
    id: `${TRIGGER_ID_PREFIX}${triggerType.slug}`,
    name: qualifiedName(label, triggerType.name),
    type: COMPOSIO_TRIGGER_NODE_TYPE,
    description: triggerType.description,
    tags: ["Composio", label, "Trigger"],
    icon: "plug-zap",
    trigger: true,
    inlinable: true,
    usage: 0,
    subscription: true,
    asTool: false,
    inputs,
    outputs,
    metadata: composioMetadata(triggerType.toolkit, triggerType.description),
  };
}

// -------------------------------- Fetching ---------------------------------

async function collectPages<T>(
  fetchPage: (cursor?: string) => Promise<ComposioPage<T>>
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  console.warn(
    `[composio] Stopped paginating after ${MAX_PAGES} pages; the catalog may be truncated.`
  );
  return items;
}

/**
 * Cache a synthesised bundle in the per-POP Workers cache, refusing to persist
 * an empty one: emptiness is nearly always transient (upstream outage, rate
 * limit) and caching it would blank the palette for the whole TTL.
 */
async function cachedBundle(
  cacheKey: string,
  ttlSeconds: number,
  ctx: DeferredWorkContext,
  build: () => Promise<NodeType[]>
): Promise<NodeType[]> {
  const request = new Request(cacheKey);
  const cache = caches.default;

  const hit = await cache.match(request);
  if (hit) return (await hit.json()) as NodeType[];

  const nodeTypes = await build();
  if (nodeTypes.length > 0) {
    const response = new Response(JSON.stringify(nodeTypes), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`,
      },
    });
    ctx.waitUntil(cache.put(request, response));
  }
  return nodeTypes;
}

async function triggerNodeTypes(
  apiKey: string,
  ctx: DeferredWorkContext
): Promise<NodeType[]> {
  return cachedBundle(
    `${CACHE_HOST}/composio/trigger-node-types/v1`,
    TRIGGER_BUNDLE_TTL,
    ctx,
    async () => {
      const client = new ComposioClient({ apiKey });
      const types = await collectPages((cursor) =>
        client.listTriggerTypes({ limit: PAGE_SIZE, cursor })
      );
      const nodeTypes = types.map(buildComposioTriggerNodeType);
      console.log(
        `[composio] Synthesised ${nodeTypes.length} trigger node types`
      );
      return nodeTypes;
    }
  );
}

async function actionNodeTypes(
  apiKey: string,
  ctx: DeferredWorkContext,
  toolkitSlugs: string[]
): Promise<NodeType[]> {
  if (toolkitSlugs.length === 0) return [];

  // Keyed by the toolkit set rather than the organization, so organizations
  // that connected the same apps share one bundle.
  const cacheKey = `${CACHE_HOST}/composio/action-node-types/v1/${toolkitSlugs.join(",")}`;

  return cachedBundle(cacheKey, ACTION_BUNDLE_TTL, ctx, async () => {
    const client = new ComposioClient({ apiKey });
    const settled = await Promise.allSettled(
      toolkitSlugs.map((toolkitSlug) =>
        collectPages((cursor) =>
          client.listTools({
            toolkitSlug,
            important: true,
            limit: PAGE_SIZE,
            cursor,
          })
        )
      )
    );

    const nodeTypes: NodeType[] = [];
    let skipped = 0;
    for (const result of settled) {
      if (result.status === "rejected") {
        // One unreachable toolkit must not cost the user the others.
        console.warn(
          "[composio] Failed to list tools for a toolkit:",
          result.reason
        );
        continue;
      }
      for (const tool of result.value) {
        const synthesis = buildComposioActionNodeType(tool);
        if (synthesis.ok) {
          nodeTypes.push(synthesis.nodeType);
          continue;
        }
        skipped++;
        console.log(`[composio] Skipped tool: ${synthesis.reason}`);
      }
    }
    console.log(
      `[composio] Synthesised ${nodeTypes.length} action node types across ${toolkitSlugs.length} toolkit(s), skipped ${skipped}`
    );
    return nodeTypes;
  });
}

/**
 * Toolkit slugs the organization holds an active Composio connection for. This
 * is what bounds the action palette; without it a single connected account
 * would pull in tens of thousands of tools.
 */
async function connectedToolkits(
  env: Bindings,
  organizationId: string
): Promise<string[]> {
  const db = createDatabase(env.DB);
  const rows = await getIntegrations(db, organizationId);

  const slugs = new Set<string>();
  for (const row of rows) {
    if (row.provider !== "composio" || row.status !== "active") continue;
    const toolkit = toolkitFromMetadata(row.metadata);
    if (toolkit) slugs.add(toolkit);
  }
  return [...slugs].sort();
}

function toolkitFromMetadata(metadata: string | null): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!parsed || typeof parsed !== "object") return undefined;
    const toolkit = (parsed as { toolkit?: unknown }).toolkit;
    return typeof toolkit === "string" && toolkit ? toolkit : undefined;
  } catch {
    // A malformed metadata blob is one broken integration, not a broken
    // /types response.
    return undefined;
  }
}

async function degradeToEmpty(
  what: string,
  build: () => Promise<NodeType[]>
): Promise<NodeType[]> {
  try {
    return await build();
  } catch (error) {
    console.warn(
      `[composio] Skipping ${what} synthesis:`,
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

/**
 * Every Composio palette entry for one request.
 *
 * Without `COMPOSIO_API_KEY` this returns nothing and throws nothing, so
 * `/types` behaves exactly as it did before Composio existed. Without an
 * organization (an unauthenticated `/types`) only triggers are synthesised —
 * actions are bounded by what that organization has connected.
 */
export async function getComposioNodeTypes(
  env: Bindings,
  ctx: DeferredWorkContext,
  organizationId?: string
): Promise<NodeType[]> {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) return [];

  const [actions, triggers] = await Promise.all([
    degradeToEmpty("action", async () =>
      organizationId
        ? actionNodeTypes(
            apiKey,
            ctx,
            await connectedToolkits(env, organizationId)
          )
        : []
    ),
    degradeToEmpty("trigger", () => triggerNodeTypes(apiKey, ctx)),
  ]);

  return [...actions, ...triggers];
}

// --------------------------------- Search ----------------------------------

export interface ComposioSearchResult {
  nodeTypes: NodeType[];
  nextCursor: string | null;
}

export interface ComposioToolSearchOptions {
  query?: string;
  toolkit?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Search the live tool catalog. This is how the ~45,000 tools that `/types`
 * deliberately omits stay reachable: the editor's search dialog pages through
 * them here and drops the synthesised node straight onto the canvas.
 */
export async function searchComposioActionNodeTypes(
  apiKey: string,
  options: ComposioToolSearchOptions
): Promise<ComposioSearchResult> {
  const client = new ComposioClient({ apiKey });
  const page = await client.listTools({
    ...(options.query ? { query: options.query } : {}),
    ...(options.toolkit ? { toolkitSlug: options.toolkit } : {}),
    limit: options.limit ?? 20,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });

  const nodeTypes: NodeType[] = [];
  for (const tool of page.items) {
    const synthesis = buildComposioActionNodeType(tool);
    if (synthesis.ok) nodeTypes.push(synthesis.nodeType);
  }
  return { nodeTypes, nextCursor: page.nextCursor };
}

/**
 * Search trigger types. Composio's `/triggers_types` has no query parameter, so
 * this filters the cached full catalog — which `/types` has already paid for.
 */
export async function searchComposioTriggerNodeTypes(
  apiKey: string,
  ctx: DeferredWorkContext,
  options: { query?: string; limit?: number }
): Promise<ComposioSearchResult> {
  const all = await triggerNodeTypes(apiKey, ctx);
  const query = options.query?.trim().toLowerCase();
  const matches = query
    ? all.filter((nodeType) => matchesQuery(nodeType, query))
    : all;
  return {
    nodeTypes: matches.slice(0, options.limit ?? 20),
    nextCursor: null,
  };
}

function matchesQuery(nodeType: NodeType, query: string): boolean {
  return (
    nodeType.id.toLowerCase().includes(query) ||
    nodeType.name.toLowerCase().includes(query) ||
    (nodeType.description?.toLowerCase().includes(query) ?? false)
  );
}
