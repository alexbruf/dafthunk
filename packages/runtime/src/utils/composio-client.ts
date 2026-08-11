import { z } from "zod";

/**
 * Minimal typed client for the Composio Platform API.
 *
 * Deliberately not the `@composio/core` SDK: every third-party integration in
 * this repo talks to its provider with `fetch`, the SDK would add bundle weight
 * to a Worker that already stubs several packages out of its test environment,
 * and the only part with real subtlety — webhook signature verification — is
 * implemented and differentially tested separately in `composio-signature.ts`.
 *
 * Responses are validated at this boundary so that an upstream schema change
 * surfaces here, named, instead of as `undefined` several layers downstream.
 */

/** Pinned API version. Composio ships breaking changes behind the path. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

/** The only webhook envelope this integration parses. */
export const COMPOSIO_WEBHOOK_VERSION = "V3" as const;

export const COMPOSIO_EVENT_TRIGGER_MESSAGE = "composio.trigger.message";
export const COMPOSIO_EVENT_ACCOUNT_EXPIRED =
  "composio.connected_account.expired";

export class ComposioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly slug?: string,
    public readonly code?: number,
    public readonly suggestedFix?: string
  ) {
    super(message);
    this.name = "ComposioApiError";
  }
}

/**
 * Composio's error envelope. Every field beyond `message` is advisory — older
 * endpoints return a bare string — so only `message` is required.
 */
const errorEnvelopeSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      code: z.number().optional(),
      slug: z.string().optional(),
      status: z.number().optional(),
      suggested_fix: z.string().optional(),
    }),
  ]),
});

/**
 * Tool and trigger schemas are `Record<string, unknown>` on purpose: they are
 * raw JSON Schema documents, mapped to Dafthunk `Parameter`s by the catalog,
 * and pinning their internals here would reject valid upstream additions.
 */
const jsonSchemaLike = z.record(z.string(), z.unknown());

export const composioToolSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  toolkit: z.object({
    slug: z.string(),
    name: z.string().optional(),
    logo: z.string().optional(),
  }),
  input_parameters: jsonSchemaLike,
  output_parameters: jsonSchemaLike.optional(),
  no_auth: z.boolean().default(false),
  version: z.string().optional(),
  available_versions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  is_deprecated: z.boolean().default(false),
});
export type ComposioTool = z.infer<typeof composioToolSchema>;

export const composioTriggerTypeSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  instructions: z.string().default(""),
  type: z.enum(["webhook", "poll"]).optional(),
  toolkit: z.object({
    slug: z.string(),
    name: z.string().optional(),
    logo: z.string().optional(),
  }),
  config: jsonSchemaLike.default({}),
  payload: jsonSchemaLike.default({}),
  version: z.string().optional(),
  requires_webhook_endpoint_setup: z.boolean().default(false),
});
export type ComposioTriggerType = z.infer<typeof composioTriggerTypeSchema>;

const activeTriggerInstanceSchema = z.object({
  id: z.string(),
  connected_account_id: z.string(),
  trigger_name: z.string(),
  user_id: z.string().optional(),
  trigger_config: z.record(z.string(), z.unknown()).default({}),
  disabled_at: z.string().nullable().default(null),
});
export type ComposioTriggerInstance = z.infer<
  typeof activeTriggerInstanceSchema
>;

const executeResponseSchema = z.object({
  data: z.unknown().optional(),
  successful: z.boolean(),
  error: z.string().nullable().default(null),
  log_id: z.string().optional(),
});

const webhookSubscriptionSchema = z.object({
  id: z.string(),
  webhook_url: z.string(),
  version: z.string(),
  enabled_events: z.array(z.string()).default([]),
  secret: z.string(),
});

/**
 * Connection-side schemas. These back the connect flow: Dafthunk holds no
 * client credentials for the toolkits Composio brokers, so an auth config is
 * created once per toolkit using Composio-managed auth and reused thereafter.
 */
const toolkitListSchema = z.object({
  items: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      no_auth: z.boolean().default(false),
      composio_managed_auth_schemes: z.array(z.string()).default([]),
      meta: z
        .object({
          description: z.string().default(""),
          logo: z.string().default(""),
        })
        .partial()
        .default({}),
    })
  ),
});

const authConfigListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string().optional(),
      toolkit: z.object({ slug: z.string() }).optional(),
    })
  ),
});

const authConfigCreatedSchema = z.object({
  auth_config: z.object({ id: z.string() }),
});

const connectedAccountLinkSchema = z.object({
  redirect_url: z.string(),
  connected_account_id: z.string().optional(),
});

const connectedAccountSchema = z.object({
  id: z.string(),
  status: z.string(),
  user_id: z.string().optional(),
  toolkit: z.object({ slug: z.string() }).optional(),
  auth_config: z.object({ id: z.string() }).optional(),
});

export interface ComposioToolkitSummary {
  slug: string;
  name: string;
  description: string;
  logo: string;
  noAuth: boolean;
  managedAuthSchemes: string[];
}

/** The subset of `GET /connected_accounts/{id}` the connect flow depends on. */
export interface ComposioConnectedAccount {
  id: string;
  status: string;
  /** Composio's `user_id`, which Dafthunk sets to the organization id. */
  userId?: string;
  toolkitSlug?: string;
  authConfigId?: string;
}

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    next_cursor: z.string().nullish(),
    total_pages: z.number().optional(),
  });

export interface ComposioPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ComposioClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Extra attempts after a 5xx. Default 1 — one retry, then fail. */
  retries?: number;
}

export interface ListToolsOptions {
  toolkitSlug?: string;
  /** Composio's own "featured" flag. The palette relies on it to stay bounded. */
  important?: boolean;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface ExecuteToolOptions {
  connectedAccountId?: string;
  userId?: string;
  arguments: Record<string, unknown>;
  /**
   * Composio defaults to "00000000_00" rather than latest, so a caller that
   * cares about schema stability must pass the version it was built against.
   */
  version?: string;
}

export interface ComposioExecuteResult {
  data: unknown;
  successful: boolean;
  error: string | null;
  logId?: string;
}

export class ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;

  /**
   * Remaining requests in the current rate-limit window, as reported by the
   * last response. Composio allows 2000/60s; a full catalog sync should read
   * this and back off rather than discovering the limit by being throttled.
   */
  public rateLimitRemaining: number | null = null;

  constructor(options: ComposioClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? COMPOSIO_API_BASE;
    // Bound to globalThis on purpose. Stored as a property and called as
    // `this.fetchImpl(...)`, an unbound `fetch` is invoked with `this` set to
    // this client, which workerd rejects with "Illegal invocation" while Node
    // and bun tolerate it — so it fails only once deployed.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.retries = options.retries ?? 1;
  }

  async listTools(
    options: ListToolsOptions = {}
  ): Promise<ComposioPage<ComposioTool>> {
    const query = new URLSearchParams();
    if (options.toolkitSlug) query.set("toolkit_slug", options.toolkitSlug);
    if (options.important !== undefined)
      query.set("important", String(options.important));
    if (options.query) query.set("query", options.query);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);

    const body = await this.request("/tools", { query });
    return this.toPage(body, composioToolSchema, "/tools");
  }

  async getTool(
    slug: string,
    options: { version?: string } = {}
  ): Promise<ComposioTool> {
    const query = new URLSearchParams();
    if (options.version) query.set("version", options.version);
    const body = await this.request(`/tools/${encodeURIComponent(slug)}`, {
      query,
    });
    return this.parse(composioToolSchema, body, `/tools/${slug}`);
  }

  async executeTool(
    slug: string,
    options: ExecuteToolOptions
  ): Promise<ComposioExecuteResult> {
    const payload: Record<string, unknown> = { arguments: options.arguments };
    if (options.connectedAccountId)
      payload.connected_account_id = options.connectedAccountId;
    if (options.userId) payload.user_id = options.userId;
    if (options.version) payload.version = options.version;

    const body = await this.request(
      `/tools/execute/${encodeURIComponent(slug)}`,
      {
        method: "POST",
        body: payload,
      }
    );
    const parsed = this.parse(
      executeResponseSchema,
      body,
      `/tools/execute/${slug}`
    );
    return {
      data: parsed.data,
      successful: parsed.successful,
      error: parsed.error,
      logId: parsed.log_id,
    };
  }

  async listTriggerTypes(
    options: { limit?: number; cursor?: string } = {}
  ): Promise<ComposioPage<ComposioTriggerType>> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);

    const body = await this.request("/triggers_types", { query });
    return this.toPage(body, composioTriggerTypeSchema, "/triggers_types");
  }

  async upsertTriggerInstance(
    slug: string,
    options: {
      connectedAccountId?: string;
      userId?: string;
      triggerConfig?: Record<string, unknown>;
    }
  ): Promise<string> {
    const payload: Record<string, unknown> = {};
    if (options.connectedAccountId)
      payload.connected_account_id = options.connectedAccountId;
    if (options.userId) payload.user_id = options.userId;
    if (options.triggerConfig) payload.trigger_config = options.triggerConfig;

    const body = await this.request(
      `/trigger_instances/${encodeURIComponent(slug)}/upsert`,
      { method: "POST", body: payload }
    );
    const parsed = this.parse(
      z.object({ trigger_id: z.string() }),
      body,
      `/trigger_instances/${slug}/upsert`
    );
    return parsed.trigger_id;
  }

  async listActiveTriggerInstances(
    options: { limit?: number; cursor?: string } = {}
  ): Promise<ComposioPage<ComposioTriggerInstance>> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);

    const body = await this.request("/trigger_instances/active", { query });
    return this.toPage(
      body,
      activeTriggerInstanceSchema,
      "/trigger_instances/active"
    );
  }

  async deleteTriggerInstance(triggerId: string): Promise<void> {
    await this.request(
      `/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      {
        method: "DELETE",
      }
    );
  }

  async setTriggerInstanceStatus(
    triggerId: string,
    status: "enable" | "disable"
  ): Promise<void> {
    await this.request(
      `/trigger_instances/manage/${encodeURIComponent(triggerId)}`,
      {
        method: "PATCH",
        body: { status },
      }
    );
  }

  async createWebhookSubscription(options: {
    webhookUrl: string;
    enabledEvents: string[];
  }): Promise<{ id: string; secret: string; webhookUrl: string }> {
    const body = await this.request("/webhook_subscriptions", {
      method: "POST",
      body: {
        webhook_url: options.webhookUrl,
        enabled_events: options.enabledEvents,
        version: COMPOSIO_WEBHOOK_VERSION,
      },
    });
    const parsed = this.parse(
      webhookSubscriptionSchema,
      body,
      "/webhook_subscriptions"
    );
    return {
      id: parsed.id,
      secret: parsed.secret,
      webhookUrl: parsed.webhook_url,
    };
  }

  async listToolkits(
    options: { search?: string; limit?: number } = {}
  ): Promise<ComposioToolkitSummary[]> {
    const query = new URLSearchParams();
    if (options.search) query.set("search", options.search);
    if (options.limit !== undefined) query.set("limit", String(options.limit));

    const body = await this.request("/toolkits", { query });
    const parsed = this.parse(toolkitListSchema, body, "/toolkits");
    return parsed.items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.meta.description ?? "",
      logo: item.meta.logo ?? "",
      noAuth: item.no_auth,
      managedAuthSchemes: item.composio_managed_auth_schemes,
    }));
  }

  /**
   * Auth configs are per-toolkit and reusable, so the first org to connect a
   * toolkit creates one and every org after reuses it.
   *
   * The result is re-checked against the toolkit that was asked for because
   * the upstream filter FAILS OPEN: `toolkit_slug=gmail` filters correctly and
   * an unmatched-but-valid slug returns nothing, but an unrecognised slug (a
   * typo, or a toolkit renamed upstream) is silently ignored and every auth
   * config comes back. Trusting the first row would then hand out some other
   * toolkit's config and connect the user to the wrong service.
   */
  async findAuthConfig(toolkitSlug: string): Promise<string | null> {
    const query = new URLSearchParams({
      toolkit_slug: toolkitSlug,
      limit: "50",
    });
    const body = await this.request("/auth_configs", { query });
    const parsed = this.parse(authConfigListSchema, body, "/auth_configs");

    const wanted = toolkitSlug.toLowerCase();
    const match = parsed.items.find(
      (item) => item.toolkit?.slug?.toLowerCase() === wanted
    );
    if (match) return match.id;

    // No row states its toolkit at all: an older response shape. Only trust a
    // single unambiguous result, never a pick from a list we cannot verify.
    if (parsed.items.length === 1 && !parsed.items[0].toolkit) {
      return parsed.items[0].id;
    }
    return null;
  }

  async createAuthConfig(toolkitSlug: string, name: string): Promise<string> {
    const body = await this.request("/auth_configs", {
      method: "POST",
      body: {
        toolkit: { slug: toolkitSlug },
        auth_config: { type: "use_composio_managed_auth", name },
      },
    });
    const parsed = this.parse(authConfigCreatedSchema, body, "/auth_configs");
    return parsed.auth_config.id;
  }

  async createConnectedAccountLink(options: {
    authConfigId: string;
    userId: string;
    callbackUrl: string;
  }): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
    const body = await this.request("/connected_accounts/link", {
      method: "POST",
      body: {
        auth_config_id: options.authConfigId,
        user_id: options.userId,
        callback_url: options.callbackUrl,
      },
    });
    const parsed = this.parse(
      connectedAccountLinkSchema,
      body,
      "/connected_accounts/link"
    );
    return {
      redirectUrl: parsed.redirect_url,
      connectedAccountId: parsed.connected_account_id,
    };
  }

  async getConnectedAccount(
    connectedAccountId: string
  ): Promise<ComposioConnectedAccount> {
    const path = `/connected_accounts/${encodeURIComponent(connectedAccountId)}`;
    const body = await this.request(path);
    const parsed = this.parse(connectedAccountSchema, body, path);
    return {
      id: parsed.id,
      status: parsed.status,
      userId: parsed.user_id,
      toolkitSlug: parsed.toolkit?.slug,
      authConfigId: parsed.auth_config?.id,
    };
  }

  /**
   * Single place that talks to the network. Retries 5xx (transient), never
   * retries 4xx (deterministic), and converts every failure into a
   * ComposioApiError so callers have one error type to handle.
   */
  private async request(
    path: string,
    options: { method?: string; query?: URLSearchParams; body?: unknown } = {}
  ): Promise<unknown> {
    const query = options.query?.toString();
    const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
    const method = options.method ?? "GET";

    let lastError: ComposioApiError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          "content-type": "application/json",
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });

      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null) {
        const parsed = Number.parseInt(remaining, 10);
        this.rateLimitRemaining = Number.isNaN(parsed) ? null : parsed;
      }

      const text = await response.text();

      if (response.ok) {
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          throw new ComposioApiError(
            `Unexpected response from ${path}: body was not JSON`,
            response.status
          );
        }
      }

      lastError = this.toApiError(text, response.status, path);
      // 4xx is a decision, not a hiccup — retrying only wastes rate-limit budget.
      if (response.status < 500) throw lastError;
    }

    throw lastError ?? new ComposioApiError(`Request to ${path} failed`, 500);
  }

  private toApiError(
    text: string,
    status: number,
    path: string
  ): ComposioApiError {
    try {
      const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        const envelope = parsed.data.error;
        if (typeof envelope === "string") {
          return new ComposioApiError(envelope, status);
        }
        return new ComposioApiError(
          envelope.message,
          envelope.status ?? status,
          envelope.slug,
          envelope.code,
          envelope.suggested_fix
        );
      }
    } catch {
      // fall through to the generic shape below
    }
    return new ComposioApiError(
      `Request to ${path} failed with ${status}`,
      status
    );
  }

  private parse<T extends z.ZodTypeAny>(
    schema: T,
    body: unknown,
    path: string
  ): z.infer<T> {
    const result = schema.safeParse(body);
    if (!result.success) {
      // Named on purpose: this is the upstream-drift alarm. A silent `undefined`
      // here would surface as a broken node three layers away.
      throw new ComposioApiError(
        `Unexpected response from ${path}: ${result.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`
          )
          .join("; ")}`,
        200
      );
    }
    return result.data;
  }

  private toPage<T extends z.ZodTypeAny>(
    body: unknown,
    item: T,
    path: string
  ): ComposioPage<z.infer<T>> {
    const parsed = this.parse(page(item), body, path);
    return { items: parsed.items, nextCursor: parsed.next_cursor ?? null };
  }
}
