import type { ComposioConnectedAccount } from "@dafthunk/runtime/utils/composio-client";
import { ComposioClient } from "@dafthunk/runtime/utils/composio-client";

export type { ComposioConnectedAccount };

import type { ListComposioToolkitsResponse } from "@dafthunk/types";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { jwtMiddleware } from "../auth";
import type { ApiContext, Bindings } from "../context";
import {
  createDatabase,
  createIntegration,
  getAllIntegrationsWithTokens,
  memberships,
  updateIntegration,
} from "../db";
import type { IntegrationStatusType } from "../db/schema";
import { decryptSecret } from "../utils/encryption";

/**
 * Connecting a Composio account.
 *
 * Deliberately not an `OAuthProvider` subclass: Dafthunk does not hold client
 * credentials for the toolkits Composio brokers. The flow is Composio's hosted
 * auth link — `POST /connected_accounts/link` returns a redirect URL, and the
 * callback carries `status` and `connected_account_id`.
 *
 * Everything that makes a decision lives in an exported pure function below,
 * because the vitest-pool-workers D1 has no schema and the request path itself
 * cannot be covered by a test.
 */
const composioConnect = new Hono<ApiContext>();

/** How long a signed connect state stays acceptable, matching the OAuth flow. */
const STATE_TTL_MS = 15 * 60 * 1000;

export type ComposioConnectErrorCode =
  | "composio_not_configured"
  | "composio_auth_failed"
  | "composio_invalid_callback"
  | "composio_link_failed"
  | "invalid_state"
  | "expired_state"
  | "organization_mismatch";

/** Mirrors `OAuthError`: the code is what the app's toast map keys off. */
export class ComposioConnectError extends Error {
  constructor(
    public readonly redirectError: ComposioConnectErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ComposioConnectError";
  }
}

// ============================================================================
// Status mapping
// ============================================================================

/**
 * Composio reports `ACTIVE | INITIATED | INITIALIZING | FAILED | EXPIRED |
 * INACTIVE`; Dafthunk has three statuses.
 *
 * Only EXPIRED maps to `expired`, because `expired` is the one status whose UI
 * affordance means "this worked and re-authorising will fix it". Everything
 * that is not ACTIVE and not EXPIRED maps to `revoked` — including statuses
 * Composio has not shipped yet. Failing closed matters here: the alternative
 * is storing an unusable connection as `active` and discovering it when a
 * workflow run fails in production.
 */
export function mapComposioConnectionStatus(
  status: string
): IntegrationStatusType {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "EXPIRED":
      return "expired";
    default:
      return "revoked";
  }
}

// ============================================================================
// Naming
// ============================================================================

/** `google_drive` reads as "Google Drive" in the integrations table. */
export function toolkitLabel(slug: string): string {
  const words = slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(" ") : "Composio";
}

/**
 * Integrations are unique per (organization, name, provider), so reconnecting
 * the same toolkit would otherwise collide with the previous connection.
 */
export function uniqueIntegrationName(
  label: string,
  existingNames: string[]
): string {
  const taken = new Set(existingNames);
  if (!taken.has(label)) return label;

  let suffix = 2;
  while (taken.has(`${label} ${suffix}`)) suffix++;
  return `${label} ${suffix}`;
}

// ============================================================================
// Signed state
// ============================================================================

export interface ComposioConnectState {
  organizationId: string;
  toolkit: string;
  authConfigId: string;
  timestamp: number;
  nonce: string;
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function signComposioState(
  state: ComposioConnectState,
  secret: string
): Promise<string> {
  const payload = btoa(JSON.stringify(state));
  return `${payload}.${await hmacSign(payload, secret)}`;
}

/**
 * @throws ComposioConnectError when the state is forged, malformed or stale.
 */
export async function verifyComposioState(
  token: string,
  secret: string
): Promise<ComposioConnectState> {
  const separator = token.lastIndexOf(".");
  if (separator === -1) {
    throw new ComposioConnectError("invalid_state", "State is malformed");
  }

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (signature !== (await hmacSign(payload, secret))) {
    throw new ComposioConnectError(
      "invalid_state",
      "State signature verification failed"
    );
  }

  let state: ComposioConnectState;
  try {
    state = JSON.parse(atob(payload));
  } catch {
    throw new ComposioConnectError("invalid_state", "State is not readable");
  }

  if (
    !state.organizationId ||
    !state.toolkit ||
    !state.authConfigId ||
    !state.timestamp ||
    !state.nonce
  ) {
    throw new ComposioConnectError(
      "invalid_state",
      "State is missing required fields"
    );
  }

  if (Date.now() - state.timestamp > STATE_TTL_MS) {
    throw new ComposioConnectError("expired_state", "Connect session expired");
  }

  return state;
}

// ============================================================================
// Callback decision
// ============================================================================

export interface ComposioIntegrationRecord {
  organizationId: string;
  name: string;
  provider: "composio";
  /**
   * The Composio connected account id. It authorises calls on the user's
   * behalf, so it is stored through the same encrypted column as any OAuth
   * access token rather than in plaintext metadata.
   */
  token: string;
  status: IntegrationStatusType;
  /** JSON `{toolkit, authConfigId, composioUserId}`. */
  metadata: string;
}

export type ComposioCallbackOutcome =
  | { kind: "persist"; record: ComposioIntegrationRecord }
  | { kind: "reject"; error: ComposioConnectErrorCode };

export interface ComposioCallbackInput {
  status: string | null;
  connectedAccountId: string | null;
  state: ComposioConnectState;
  account: ComposioConnectedAccount | null;
  /** Names already used by this organization's integrations. */
  existingNames: string[];
}

/**
 * Decides what a hosted-auth callback should write, if anything.
 *
 * The organization is taken from the HMAC-signed state rather than from the
 * callback's own parameters, and the connected account's Composio `user_id`
 * must agree with it — that pairing is what stops one tenant's callback from
 * attaching another tenant's connection.
 */
export function resolveComposioCallback(
  input: ComposioCallbackInput
): ComposioCallbackOutcome {
  if (input.status !== "success") {
    return { kind: "reject", error: "composio_auth_failed" };
  }

  const { connectedAccountId, account, state } = input;
  if (!connectedAccountId || !account || account.id !== connectedAccountId) {
    return { kind: "reject", error: "composio_invalid_callback" };
  }

  if (account.userId !== state.organizationId) {
    return { kind: "reject", error: "organization_mismatch" };
  }

  if (account.toolkitSlug && account.toolkitSlug !== state.toolkit) {
    return { kind: "reject", error: "composio_invalid_callback" };
  }

  return {
    kind: "persist",
    record: {
      organizationId: state.organizationId,
      name: uniqueIntegrationName(
        toolkitLabel(state.toolkit),
        input.existingNames
      ),
      provider: "composio",
      token: connectedAccountId,
      status: mapComposioConnectionStatus(account.status),
      metadata: JSON.stringify({
        toolkit: state.toolkit,
        authConfigId: account.authConfigId ?? state.authConfigId,
        composioUserId: account.userId,
      }),
    },
  };
}

// ============================================================================
// Composio API
// ============================================================================

/**
 * @throws ComposioConnectError when the key is absent, so a misconfigured
 * environment fails at the first step instead of redirecting the user into a
 * Composio session that can never complete.
 */
export function requireComposioApiKey(env: Pick<Bindings, "COMPOSIO_API_KEY">) {
  if (!env.COMPOSIO_API_KEY) {
    throw new ComposioConnectError(
      "composio_not_configured",
      "COMPOSIO_API_KEY is not configured"
    );
  }
  return env.COMPOSIO_API_KEY;
}

/**
 * The connect flow's own Composio calls.
 *
 * `ComposioClient` in `@dafthunk/runtime` covers tools, triggers and webhook
 * subscriptions but not auth configs or connected accounts, and that file is
 * owned elsewhere — so these three requests live here, reusing the client's
 * base URL and error type so failures surface as one recognisable error.
 */
/**
 * Auth configs are per-toolkit and reusable, so the first org to connect a
 * toolkit creates one and every org after reuses it. Composio-managed auth is
 * what makes this possible at all — Dafthunk holds no client credentials.
 */
async function ensureAuthConfig(
  client: ComposioClient,
  toolkit: string
): Promise<string> {
  const existing = await client.findAuthConfig(toolkit);
  if (existing) return existing;
  return client.createAuthConfig(toolkit, `dafthunk-${toolkit}`);
}

async function fetchConnectedAccount(
  client: ComposioClient,
  connectedAccountId: string
): Promise<ComposioConnectedAccount | null> {
  try {
    return await client.getConnectedAccount(connectedAccountId);
  } catch (error) {
    console.error("Composio connected account lookup failed:", error);
    return null;
  }
}

// ============================================================================
// Credential expiry
// ============================================================================

/**
 * Flips the integration backing a Composio connected account to `expired`.
 *
 * Exported for the `composio.connected_account.expired` webhook — that event
 * carries the organization id as Composio's `user_id` and the connected
 * account id, which is exactly this signature. The account id is only readable
 * after decryption, so the lookup scans the organization's Composio
 * integrations rather than filtering in SQL; there are a handful per org.
 *
 * @returns true when an integration was found and updated.
 */
export async function markComposioAccountExpired(
  env: Bindings,
  organizationId: string,
  connectedAccountId: string
): Promise<boolean> {
  const db = createDatabase(env.DB);
  const candidates = (
    await getAllIntegrationsWithTokens(db, organizationId)
  ).filter((integration) => integration.provider === "composio");

  for (const integration of candidates) {
    const token = await decryptSecret(
      integration.encryptedToken,
      env,
      organizationId
    );
    if (token !== connectedAccountId) continue;

    await updateIntegration(
      db,
      integration.id,
      organizationId,
      { status: "expired" },
      env
    );
    return true;
  }

  return false;
}

// ============================================================================
// Routes
// ============================================================================

/**
 * The connect link is opened from the integrations page, which knows the
 * organization the user is looking at — that can differ from the JWT's default
 * organization. `oauth.ts` solves this the same way, but its middleware is
 * private to that module.
 */
const resolveOrgFromQuery = async (
  c: Context<ApiContext>,
  next: () => Promise<void>
) => {
  const organizationIdFromQuery = c.req.query("organizationId");
  if (organizationIdFromQuery) {
    const payload = c.get("jwtPayload");
    if (!payload) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const db = createDatabase(c.env.DB);
    const [membership] = await db
      .select({ organizationId: memberships.organizationId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, payload.sub),
          eq(memberships.organizationId, organizationIdFromQuery)
        )
      );

    if (!membership) {
      return c.json({ error: "Organization not found or access denied" }, 403);
    }

    c.set("organizationId", membership.organizationId);
  }
  await next();
};

/**
 * The address Composio should send the user back to.
 *
 * Derived from the request rather than configured: it is by definition the host
 * the browser just reached us on, which is right in local development, in
 * production, and in any self-hosted deployment. This was previously a
 * hardcoded pair of hosts, so every deployment that was neither dafthunk.com
 * nor localhost sent users to localhost after consenting — the connection
 * succeeded upstream and the callback never ran, leaving a live Composio
 * account with no integration row pointing at it.
 *
 * Composio accepts `callback_url` per request, so nothing needs registering in
 * advance for this to work on a new host.
 */
export function buildComposioCallbackUrl(
  requestUrl: string,
  state: string
): string {
  const origin = new URL(requestUrl).origin;
  return `${origin}/composio/callback?state=${encodeURIComponent(state)}`;
}

function appRedirect(
  env: Bindings,
  organizationId: string | undefined,
  params: string
): string {
  const path = organizationId
    ? `/org/${organizationId}/integrations`
    : "/integrations";
  return `${env.WEB_HOST}${path}?${params}`;
}

/**
 * GET /composio/connect/toolkits
 *
 * Only toolkits with Composio-managed auth are offered: those are the ones a
 * connection can be brokered for without Dafthunk owning client credentials.
 */
composioConnect.get(
  "/connect/toolkits",
  jwtMiddleware,
  zValidator(
    "query",
    z.object({
      query: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    })
  ),
  async (c) => {
    try {
      const apiKey = requireComposioApiKey(c.env);
      const { query, limit } = c.req.valid("query");

      const toolkits = await new ComposioClient({ apiKey }).listToolkits({
        search: query,
        limit,
      });

      return c.json({
        toolkits: toolkits
          .filter((item) => !item.noAuth && item.managedAuthSchemes.length > 0)
          .map((item) => ({
            slug: item.slug,
            name: item.name,
            description: item.description,
            logo: item.logo,
          })),
      } satisfies ListComposioToolkitsResponse);
    } catch (error) {
      if (error instanceof ComposioConnectError) {
        return c.json({ error: error.message }, 503);
      }
      console.error("Composio toolkit listing failed:", error);
      return c.json({ error: "Failed to list Composio toolkits" }, 502);
    }
  }
);

/**
 * GET /composio/connect?toolkit=gmail
 *
 * Starts a hosted auth-link session and redirects the browser to Composio.
 */
composioConnect.get(
  "/connect",
  jwtMiddleware,
  resolveOrgFromQuery,
  zValidator("query", z.object({ toolkit: z.string().min(1) })),
  async (c) => {
    const organizationId = c.get("organizationId");
    const { toolkit } = c.req.valid("query");

    try {
      const apiKey = requireComposioApiKey(c.env);
      if (!organizationId) {
        throw new ComposioConnectError(
          "organization_mismatch",
          "No organization in context"
        );
      }

      const client = new ComposioClient({ apiKey });
      const authConfigId = await ensureAuthConfig(client, toolkit);
      const state = await signComposioState(
        {
          organizationId,
          toolkit,
          authConfigId,
          timestamp: Date.now(),
          nonce: crypto.randomUUID(),
        },
        c.env.JWT_SECRET
      );

      const link = await client.createConnectedAccountLink({
        authConfigId,
        // Composio's user is Dafthunk's organization: connections, and the
        // trigger instances built on them, stay inside one tenant.
        userId: organizationId,
        callbackUrl: buildComposioCallbackUrl(c.req.url, state),
      });

      return c.redirect(link.redirectUrl);
    } catch (error) {
      const code =
        error instanceof ComposioConnectError
          ? error.redirectError
          : "composio_link_failed";
      if (!(error instanceof ComposioConnectError)) {
        console.error("Composio link creation failed:", error);
      }
      return c.redirect(appRedirect(c.env, organizationId, `error=${code}`));
    }
  }
);

/**
 * GET /composio/callback
 *
 * Composio redirects here after the user finishes at the upstream provider.
 * Unauthenticated on purpose: the browser arrives from Composio's domain, so
 * the signed `state` — not a session cookie — is what proves which
 * organization started this flow.
 */
composioConnect.get("/callback", async (c) => {
  const stateParam = c.req.query("state");
  if (!stateParam) {
    return c.redirect(appRedirect(c.env, undefined, "error=invalid_state"));
  }

  let state: ComposioConnectState;
  try {
    state = await verifyComposioState(stateParam, c.env.JWT_SECRET);
  } catch (error) {
    const code =
      error instanceof ComposioConnectError
        ? error.redirectError
        : "invalid_state";
    return c.redirect(appRedirect(c.env, undefined, `error=${code}`));
  }

  try {
    const apiKey = requireComposioApiKey(c.env);
    const connectedAccountId = c.req.query("connected_account_id") ?? null;
    const account = connectedAccountId
      ? await fetchConnectedAccount(
          new ComposioClient({ apiKey }),
          connectedAccountId
        )
      : null;

    const db = createDatabase(c.env.DB);
    const existing = await getAllIntegrationsWithTokens(
      db,
      state.organizationId
    );

    const outcome = resolveComposioCallback({
      status: c.req.query("status") ?? null,
      connectedAccountId,
      state,
      account,
      existingNames: existing.map((integration) => integration.name),
    });

    if (outcome.kind === "reject") {
      return c.redirect(
        appRedirect(c.env, state.organizationId, `error=${outcome.error}`)
      );
    }

    const { record } = outcome;
    const created = await createIntegration(
      db,
      record.organizationId,
      record.name,
      record.provider,
      record.token,
      undefined,
      undefined,
      record.metadata,
      c.env
    );

    // `createIntegration` always inserts as active; a connection Composio
    // already reports as unusable is corrected rather than advertised as good.
    if (record.status !== "active") {
      await updateIntegration(
        db,
        created.integration.id,
        record.organizationId,
        { status: record.status },
        c.env
      );
    }

    return c.redirect(
      appRedirect(c.env, state.organizationId, "success=composio_connected")
    );
  } catch (error) {
    const code =
      error instanceof ComposioConnectError
        ? error.redirectError
        : "composio_link_failed";
    if (!(error instanceof ComposioConnectError)) {
      console.error("Composio callback failed:", error);
    }
    return c.redirect(
      appRedirect(c.env, state.organizationId, `error=${code}`)
    );
  }
});

export default composioConnect;
