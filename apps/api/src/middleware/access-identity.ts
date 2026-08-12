/**
 * Cloudflare Access identity middleware.
 *
 * Access issues *opaque* OAuth tokens and resolves them backend-side,
 * forwarding a signed assertion (a JWT) to the origin in the
 * `Cf-Access-Jwt-Assertion` header. This middleware never sees an OAuth token;
 * it:
 *
 * 1. reads the assertion header,
 * 2. verifies the signature against the Access public keys at
 *    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, caching the
 *    JWKS in KV so key rotation is a single refetch,
 * 3. validates `aud` (and `iss`) — accepting a token minted for a different
 *    Access application is the most common MCP auth defect, so this is not
 *    optional,
 * 4. resolves `email → users.id`, then `memberships → organizationId`,
 * 5. sets `jwtPayload` and `organizationId` on the context, exactly the shape
 *    `jwtMiddleware` produces, so downstream code is unchanged.
 *
 * Two schema realities are handled explicitly:
 * - `users.email` is nullable. An empty/undefined assertion email never issues
 *   a lookup — a NULL email must not be matched by one.
 * - A user may belong to several organizations via `memberships`. We never
 *   silently fall back to `users.organizationId`; an explicit organization id
 *   (URL param `:organizationId` or `?organization_id=`) is required to
 *   disambiguate, and an org the user does not belong to is rejected.
 */
import type {
  AuthProvider,
  JWTTokenPayload,
  OrganizationRoleType,
} from "@dafthunk/types";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  type JSONWebKeySet,
  type JWTPayload,
  jwtVerify,
} from "jose";

import type { ApiContext } from "../context";
import { createDatabase, type Database } from "../db";
import { memberships, organizations, users } from "../db/schema";

export const ACCESS_JWKS_KV_KEY = "access:jwks";
/** How long a fetched JWKS may be served from KV before being revalidated. */
export const JWKS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

/** Failure messages are part of the observable contract; keep them stable. */
export const ACCESS_IDENTITY_ERRORS = {
  UNCONFIGURED: "Access identity is not configured on this deployment",
  MISSING_ASSERTION: "Missing Cf-Access-Jwt-Assertion header",
  INVALID_ASSERTION: "Invalid or expired access assertion",
  CERTS_FETCH_FAILED: "Unable to fetch Cloudflare Access certificates",
  LOGIN_REQUIRED: "Log in through the browser once before using the API",
  MULTIPLE_ORGS:
    "This account belongs to multiple organizations; pass an organization id",
  NOT_A_MEMBER: "You are not a member of the requested organization",
} as const;

interface CachedAccessJwks {
  keys: JSONWebKeySet["keys"];
  fetchedAt: number;
}

/** Injections for tests: the real defaults all come from `c.env` per request. */
export interface AccessIdentityDependencies {
  /** Replaces the certs fetch (unit tests never hit the real endpoint). */
  certsFetch?: (url: string) => Promise<JSONWebKeySet>;
  kv?: KVNamespace;
  db?: Database;
}

/** An upstream certs failure is a deployment problem, not a caller problem. */
class AccessCertsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccessCertsError";
  }
}

const defaultCertsFetch = async (url: string): Promise<JSONWebKeySet> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AccessCertsError(
      `Access certs endpoint returned ${response.status}`
    );
  }
  return (await response.json()) as JSONWebKeySet;
};

const NO_MATCHING_KEY = "NO_MATCHING_KEY" as const;
type VerifyResult = JWTPayload | typeof NO_MATCHING_KEY;

/**
 * Verifies the assertion, reporting an unknown `kid` instead of failing.
 *
 * The candidate key is resolved to a concrete `CryptoKey` *before* calling
 * `jwtVerify`. Passing the keyset resolver function itself into jose would
 * reject from inside its own async chain on an unknown kid — and workerd's
 * unhandled-rejection tracking reports those as unhandled even when the await
 * chain handles them. Resolving first keeps the unknown-kid outcome plain data.
 */
async function verifyAssertionWithKeys(
  assertion: string,
  keys: JSONWebKeySet["keys"],
  audience: string,
  issuer: string
): Promise<VerifyResult> {
  // Throws JWSInvalid on a malformed token; the caller maps that to 401.
  const header = decodeProtectedHeader(assertion);
  const kid = header.kid;
  const candidate = kid ? keys.find((jwk) => jwk.kid === kid) : undefined;
  if (!candidate) {
    return NO_MATCHING_KEY;
  }
  const key = await importJWK(
    { ...candidate, alg: header.alg, use: "sig" },
    header.alg
  );
  const { payload } = await jwtVerify(assertion, key, { audience, issuer });
  return payload;
}

export type ResolveOrganization =
  | {
      ok: true;
      organizationId: string;
      organizationName: string;
      role: OrganizationRoleType;
    }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Pick the organization for an authenticated principal. This is the sharp edge
 * of cross-tenant safety: memberships are the sole source of truth, and an
 * ambiguous or out-of-scope org must fail loudly rather than silently default.
 */
export function chooseOrganization(
  memberships: Array<{
    organizationId: string;
    name: string;
    role: OrganizationRoleType;
  }>,
  explicitOrganizationId: string | undefined
): ResolveOrganization {
  if (explicitOrganizationId) {
    const membership = memberships.find(
      (candidate) => candidate.organizationId === explicitOrganizationId
    );
    if (!membership) {
      return {
        ok: false,
        status: 403,
        message: ACCESS_IDENTITY_ERRORS.NOT_A_MEMBER,
      };
    }
    return {
      ok: true,
      organizationId: membership.organizationId,
      organizationName: membership.name,
      role: membership.role,
    };
  }

  if (memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      message: ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED,
    };
  }

  if (memberships.length > 1) {
    return {
      ok: false,
      status: 400,
      message: ACCESS_IDENTITY_ERRORS.MULTIPLE_ORGS,
    };
  }

  const [only] = memberships;
  return {
    ok: true,
    organizationId: only.organizationId,
    organizationName: only.name,
    role: only.role,
  };
}

export function createAccessIdentityMiddleware(
  deps: AccessIdentityDependencies = {}
): MiddlewareHandler<ApiContext> {
  return async (c, next) => {
    // Team domain and AUD tag come from the environment, never hardcoded. A
    // deployment without them cannot authenticate anyone, so fail closed.
    const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud } = c.env;
    if (!teamDomain || !aud) {
      return c.json({ error: ACCESS_IDENTITY_ERRORS.UNCONFIGURED }, 500);
    }

    const assertion = c.req.header("Cf-Access-Jwt-Assertion");
    if (!assertion) {
      return c.json({ error: ACCESS_IDENTITY_ERRORS.MISSING_ASSERTION }, 401);
    }

    const kv = deps.kv ?? c.env.KV;
    const db = deps.db ?? createDatabase(c.env.DB);
    const certsFetch = deps.certsFetch ?? defaultCertsFetch;

    const certsUrl = `https://${teamDomain}${ACCESS_CERTS_PATH}`;
    const issuer = `https://${teamDomain}`;

    const fetchAndCache = async (): Promise<JSONWebKeySet["keys"]> => {
      let jwks: JSONWebKeySet;
      try {
        jwks = await certsFetch(certsUrl);
      } catch (error) {
        throw new AccessCertsError("Access certs fetch failed", {
          cause: error,
        });
      }
      const fetchedKeys = Array.isArray(jwks?.keys) ? jwks.keys : [];
      if (fetchedKeys.length === 0) {
        throw new AccessCertsError("Access certs returned no signing keys");
      }
      await kv.put(
        ACCESS_JWKS_KV_KEY,
        JSON.stringify({
          keys: fetchedKeys,
          fetchedAt: Date.now(),
        } satisfies CachedAccessJwks),
        { expirationTtl: JWKS_CACHE_TTL_SECONDS }
      );
      return fetchedKeys;
    };

    const cached = await kv.get<CachedAccessJwks>(ACCESS_JWKS_KV_KEY, "json");
    let keys =
      Array.isArray(cached?.keys) && cached.keys.length > 0 ? cached.keys : [];

    let result: VerifyResult;
    try {
      if (keys.length === 0) {
        keys = await fetchAndCache();
      }
      result = await verifyAssertionWithKeys(assertion, keys, aud, issuer);
      if (result === NO_MATCHING_KEY) {
        // Key rotation: the cached set predates this token's kid. Refetch once.
        keys = await fetchAndCache();
        result = await verifyAssertionWithKeys(assertion, keys, aud, issuer);
      }
    } catch (error) {
      if (error instanceof AccessCertsError) {
        return c.json(
          { error: ACCESS_IDENTITY_ERRORS.CERTS_FETCH_FAILED },
          503
        );
      }
      // A signature failure, an `aud` mismatch and an `iss` mismatch are one
      // indistinguishable 401 to the caller, and this catch is the only place
      // the reason exists. Without it, diagnosing a rejected assertion means
      // guessing. Claims are decoded *unverified* and used for nothing but this
      // line; the token and its signature are never logged.
      let presented: JWTPayload | undefined;
      try {
        presented = decodeJwt(assertion);
      } catch {
        // Malformed token — the reason below still says so.
      }
      console.error("[access-identity] assertion rejected", {
        reason: error instanceof Error ? error.message : String(error),
        code:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : undefined,
        presentedIss: presented?.iss,
        presentedAud: presented?.aud,
        expectedIss: issuer,
        expectedAud: aud,
      });
      return c.json({ error: ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION }, 401);
    }

    if (result === NO_MATCHING_KEY) {
      return c.json({ error: ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION }, 401);
    }

    const email = result.email;
    // Never run a lookup with an empty/undefined email: a user row whose email
    // is NULL must not be matchable through one.
    if (typeof email !== "string" || email.length === 0) {
      return c.json({ error: ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED }, 403);
    }

    const userRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        developerMode: users.developerMode,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.email, email));
    const user = userRows[0];

    if (!user) {
      return c.json({ error: ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED }, 403);
    }

    const membershipRows = await db
      .select({
        organizationId: memberships.organizationId,
        name: organizations.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(
        organizations,
        eq(memberships.organizationId, organizations.id)
      )
      .where(eq(memberships.userId, user.id));

    const explicitOrganizationId =
      c.req.param("organizationId") ?? c.req.query("organization_id");

    const resolved = chooseOrganization(membershipRows, explicitOrganizationId);
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, resolved.status);
    }

    // Same shape jwtMiddleware produces: `sub` is the userId (`getAuthContext`
    // reads `jwtPayload.sub`), and `organizationId` is set explicitly so
    // routes scoped by URL param keep working unchanged.
    const identity: JWTTokenPayload = {
      sub: user.id,
      name: user.name,
      email: user.email ?? undefined,
      avatarUrl: user.avatarUrl ?? undefined,
      role: user.role,
      developerMode: user.developerMode,
      organization: {
        id: resolved.organizationId,
        name: resolved.organizationName,
        role: resolved.role,
      },
      // The closed AuthProvider union predates this path; an Access principal
      // has no OAuth provider, so this is asserted rather than widened.
      provider: "access" as AuthProvider,
    };

    c.set("jwtPayload", identity);
    c.set("organizationId", resolved.organizationId);
    await next();
  };
}

export const accessIdentityMiddleware = createAccessIdentityMiddleware();
