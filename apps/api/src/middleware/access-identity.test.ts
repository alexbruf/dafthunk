/**
 * Tests for `accessIdentityMiddleware`.
 *
 * A locally-generated keypair + hand-minted JWTs stand in for Cloudflare
 * Access's opaque-token resolution. The JWKS `fetch` is stubbed so this suite
 * never hits the real `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
 * endpoint. The KV binding is the real, isolated test KV, so the JWKS caching
 * path is exercised for real rather than mocked away.
 */
import { env } from "cloudflare:test";
import type { OrganizationRoleType } from "@dafthunk/types";
import type { Context } from "hono";
import { Hono } from "hono";
import type { JSONWebKeySet } from "jose";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiContext, Bindings } from "../context";
import type { Database } from "../db";
import { users } from "../db/schema";
import {
  ACCESS_IDENTITY_ERRORS,
  ACCESS_JWKS_KV_KEY,
  type AccessIdentityDependencies,
  chooseOrganization,
  createAccessIdentityMiddleware,
} from "./access-identity";

const TEST_TEAM_DOMAIN = "dafthunk-test.cloudflareaccess.com";
const TEST_ISSUER = `https://${TEST_TEAM_DOMAIN}`;
const TEST_AUD = "test-access-app-aud";
const TEST_KID = "test-signing-key";

const CERT_URL = `https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`;

// ---------------------------------------------------------------------------
// Crypto helpers: a locally-generated keypair and hand-minted JWTs.
// ---------------------------------------------------------------------------

interface TestKeys {
  publicJwk: JSONWebKeySet["keys"][number] & { kid: string; alg: string };
  // `importJWK` is typed as possibly returning a symmetric key; an RSA JWK
  // always yields a CryptoKey at runtime.
  signKey: CryptoKey;
}

let testKeysPromise: Promise<TestKeys> | undefined;

async function getTestKeys(): Promise<TestKeys> {
  testKeysPromise ??= (async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = {
      ...(await exportJWK(publicKey)),
      kid: TEST_KID,
      alg: "RS256",
      use: "sig",
    };
    const signKey = (await importJWK(
      {
        ...(await exportJWK(privateKey)),
        kid: TEST_KID,
        alg: "RS256",
        use: "sig",
      },
      "RS256"
    )) as CryptoKey;
    return { publicJwk: publicJwk as TestKeys["publicJwk"], signKey };
  })();
  return testKeysPromise;
}

/** Mint a compact JWS signed with the primary (good) key by default. */
async function mintAssertion(
  payload: Record<string, unknown>,
  options: {
    aud?: string;
    iss?: string;
    exp?: number;
    kid?: string;
    signKey?: CryptoKey;
  } = {}
): Promise<string> {
  const keys = await getTestKeys();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? TEST_KID })
    .setIssuedAt()
    .setExpirationTime(options.exp ?? now + 300)
    .setIssuer(options.iss ?? TEST_ISSUER)
    .setAudience(options.aud ?? TEST_AUD)
    .sign(options.signKey ?? keys.signKey);
}

// ---------------------------------------------------------------------------
// DB / harness helpers. The D1 test binding has no schema, so the middleware's
// two lookups are driven by an intentionally small fake drizzle database.
// ---------------------------------------------------------------------------

interface FakeUserRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  developerMode: boolean;
  avatarUrl: string | null;
}

interface FakeMembershipRow {
  organizationId: string;
  name: string;
  role: OrganizationRoleType;
}

function makeFakeDb(options: {
  users?: FakeUserRow[];
  memberships?: FakeMembershipRow[];
  queries?: string[];
}): Database {
  const userRows = options.users ?? [];
  const membershipRows = options.memberships ?? [];
  const queries = options.queries;
  const rowsFor = (table: unknown) =>
    table === users ? userRows : membershipRows;
  const where = (table: unknown) => ({
    then: (resolve: (rows: unknown) => unknown) => {
      queries?.push(table === users ? "users" : "memberships");
      resolve(rowsFor(table));
    },
  });
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => where(table),
        innerJoin: () => ({ where: () => where(table) }),
      }),
    }),
  } as unknown as Database;
}

function testBindings(): Bindings {
  return {
    ...(env as unknown as Bindings),
    ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    ACCESS_AUD: TEST_AUD,
  };
}

function makeApp(
  overrides: Partial<AccessIdentityDependencies> = {},
  state: { queries?: string[] } = {}
) {
  const bindings = testBindings();
  const certsFetch = vi.fn(
    async (): Promise<JSONWebKeySet> => ({
      keys: [(await getTestKeys()).publicJwk],
    })
  );
  const queries = state.queries ?? [];
  const db = overrides.db ?? makeFakeDb({ queries });

  const app = new Hono<ApiContext>();
  const middleware = createAccessIdentityMiddleware({
    certsFetch,
    kv: bindings.KV,
    db,
    ...overrides,
  });

  const handle = (c: Context<ApiContext>) =>
    c.json({
      userId: c.get("jwtPayload")?.sub,
      organizationId: c.get("organizationId"),
    });

  // Mounted per-route (as in production) so the URL param is captured for the
  // `/:organizationId/generate` shape; a bare `*` mount sees no params.
  app.use("/mcp", middleware);
  app.use("/generate", middleware);
  app.use("/:organizationId/generate", middleware);
  app.post("/mcp", handle);
  app.post("/generate", handle);
  app.post("/:organizationId/generate", handle);

  return { app, bindings, certsFetch, queries };
}

const post = (
  app: Hono<ApiContext>,
  bindings: Bindings,
  path: string,
  assertion?: string
) =>
  app.request(
    path,
    {
      method: "POST",
      headers: assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {},
    },
    bindings
  );

/** `Response.json()` is typed `unknown`; unwrap just the error message. */
const readError = async (res: Response): Promise<string> =>
  ((await res.json()) as { error?: string }).error ?? "";

describe("accessIdentityMiddleware — organization resolution (written first)", () => {
  describe("email guard — a NULL email must never be matched by an empty lookup", () => {
    it("rejects an assertion with no email claim before any DB query", async () => {
      const { app, bindings, queries, certsFetch } = makeApp({
        db: makeFakeDb({
          users: [
            {
              id: "user-1",
              name: "Ada",
              email: null,
              role: "user",
              developerMode: false,
              avatarUrl: null,
            },
          ],
        }),
      });
      const token = await mintAssertion({});
      const res = await post(app, bindings, "/generate", token);

      expect(res.status).toBe(403);
      expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED);
      // No lookup should ever run against an empty/undefined email.
      expect(queries).toHaveLength(0);
      expect(certsFetch).toHaveBeenCalledTimes(1); // signature was still verified
    });

    it("rejects an empty-string email without querying the database", async () => {
      const { app, bindings, queries } = makeApp({
        db: makeFakeDb({
          users: [
            {
              id: "user-1",
              name: "Ada",
              email: null,
              role: "user",
              developerMode: false,
              avatarUrl: null,
            },
          ],
        }),
      });
      const token = await mintAssertion({ email: "" });
      const res = await post(app, bindings, "/generate", token);

      expect(res.status).toBe(403);
      expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED);
      expect(queries).toHaveLength(0);
    });
  });

  describe("multi-membership — never a silent pick", () => {
    const twoMemberships = {
      users: [
        {
          id: "user-1",
          name: "Ada",
          email: "ada@example.com",
          role: "user",
          developerMode: false,
          avatarUrl: null,
        },
      ],
      memberships: [
        { organizationId: "org-1", name: "Org One", role: "owner" as const },
        { organizationId: "org-2", name: "Org Two", role: "member" as const },
      ],
    };

    it("returns 400 when there are two memberships and no explicit organization", async () => {
      const { app, bindings } = makeApp({ db: makeFakeDb(twoMemberships) });
      const token = await mintAssertion({ email: "ada@example.com" });

      const res = await post(app, bindings, "/generate", token);

      expect(res.status).toBe(400);
      expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.MULTIPLE_ORGS);
    });

    it("resolves the explicit organization via query param when the user belongs to it", async () => {
      const { app, bindings } = makeApp({ db: makeFakeDb(twoMemberships) });
      const token = await mintAssertion({ email: "ada@example.com" });

      const res = await post(
        app,
        bindings,
        "/generate?organization_id=org-2",
        token
      );
      const body = (await res.json()) as { organizationId?: string };

      expect(res.status).toBe(200);
      expect(body.organizationId).toBe("org-2");
    });

    it("resolves the explicit organization via URL param when the user belongs to it", async () => {
      const { app, bindings } = makeApp({ db: makeFakeDb(twoMemberships) });
      const token = await mintAssertion({ email: "ada@example.com" });

      const res = await post(app, bindings, "/org-1/generate", token);
      const body = (await res.json()) as { organizationId?: string };

      expect(res.status).toBe(200);
      expect(body.organizationId).toBe("org-1");
    });

    it("returns 403 when the explicit organization is not a membership", async () => {
      const { app, bindings } = makeApp({ db: makeFakeDb(twoMemberships) });
      const token = await mintAssertion({ email: "ada@example.com" });

      const res = await post(
        app,
        bindings,
        "/generate?organization_id=org-unknown",
        token
      );

      expect(res.status).toBe(403);
      expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.NOT_A_MEMBER);
    });
  });

  describe("no matching users row", () => {
    it("returns 403 with the browser-first message", async () => {
      const { app, bindings } = makeApp({
        db: makeFakeDb({ users: [], memberships: [] }),
      });
      const token = await mintAssertion({ email: "stranger@example.com" });

      const res = await post(app, bindings, "/generate", token);

      expect(res.status).toBe(403);
      expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED);
    });
  });
});

describe("accessIdentityMiddleware — happy path", () => {
  it("sets userId and organizationId from a valid assertion", async () => {
    const queries: string[] = [];
    const { app, bindings, certsFetch } = makeApp(
      {
        db: makeFakeDb({
          users: [
            {
              id: "user-1",
              name: "Ada",
              email: "ada@example.com",
              role: "user",
              developerMode: false,
              avatarUrl: null,
            },
          ],
          memberships: [
            { organizationId: "org-1", name: "Org One", role: "owner" },
          ],
          queries,
        }),
      },
      { queries }
    );

    const token = await mintAssertion({ email: "ada@example.com" });
    const res = await post(app, bindings, "/generate", token);
    const body = (await res.json()) as {
      userId?: string;
      organizationId?: string;
    };

    expect(res.status).toBe(200);
    expect(body.userId).toBe("user-1");
    expect(body.organizationId).toBe("org-1");

    // Inspectable side-effects: one certs fetch on cache miss, then the JWKS
    // is persisted to the KV cache.
    expect(certsFetch).toHaveBeenCalledTimes(1);
    expect(certsFetch).toHaveBeenCalledWith(CERT_URL);
    expect(queries).toEqual(["users", "memberships"]);
    const cached = await bindings.KV.get(ACCESS_JWKS_KV_KEY, "json");
    expect(cached).not.toBeNull();
  });

  it("reuses the cached JWKS instead of refetching on the next request", async () => {
    const { app, bindings, certsFetch } = makeApp({
      db: makeFakeDb({
        users: [
          {
            id: "user-1",
            name: "Ada",
            email: "ada@example.com",
            role: "user",
            developerMode: false,
            avatarUrl: null,
          },
        ],
        memberships: [
          { organizationId: "org-1", name: "Org One", role: "owner" },
        ],
      }),
    });
    const token = await mintAssertion({ email: "ada@example.com" });

    expect(await post(app, bindings, "/generate", token)).not.toBeNull();
    // Second call: same keys served from KV, no certs fetch.
    const res2 = await post(app, bindings, "/mcp", token);
    expect(res2.status).toBe(200);
    expect(certsFetch).toHaveBeenCalledTimes(1);
  });
});

describe("accessIdentityMiddleware — signature and token validation", () => {
  it("returns 401 when the assertion header is missing", async () => {
    const { app, bindings, certsFetch, queries } = makeApp();

    const res = await post(app, bindings, "/generate");

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.MISSING_ASSERTION);
    expect(certsFetch).not.toHaveBeenCalled();
    expect(queries).toHaveLength(0);
  });

  it("rejects a wrong aud even when the signature is valid (load-bearing)", async () => {
    const { app, bindings, certsFetch } = makeApp({
      db: makeFakeDb({
        users: [
          {
            id: "user-1",
            name: "Ada",
            email: "ada@example.com",
            role: "user",
            developerMode: false,
            avatarUrl: null,
          },
        ],
        memberships: [
          { organizationId: "org-1", name: "Org One", role: "owner" },
        ],
      }),
    });
    // Signed by OUR key, but for a different Access application.
    const token = await mintAssertion(
      { email: "ada@example.com" },
      { aud: "other-app-aud" }
    );

    const res = await post(app, bindings, "/generate", token);

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION);
    expect(certsFetch).toHaveBeenCalledTimes(1); // cached nothing, fetched — but still 401
  });

  it("rejects an expired token", async () => {
    const { app, bindings } = makeApp();
    const token = await mintAssertion(
      { email: "ada@example.com" },
      { exp: Math.floor(Date.now() / 1000) - 60 }
    );

    const res = await post(app, bindings, "/generate", token);

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION);
  });

  it("rejects a token signed by an unknown (rotated-away) key", async () => {
    // Seed the cache with the good key so the first attempt is served from KV,
    // then the middleware must refetch (stub returns the same keys) and fail.
    const { app, bindings, certsFetch } = makeApp();
    const keys = await getTestKeys();
    await bindings.KV.put(
      ACCESS_JWKS_KV_KEY,
      JSON.stringify({ keys: [keys.publicJwk], fetchedAt: Date.now() })
    );

    const other = await generateKeyPair("RS256", { extractable: true });
    const otherSignKey = (await importJWK(
      {
        ...(await exportJWK(other.privateKey)),
        kid: "rotated-key",
        alg: "RS256",
        use: "sig",
      },
      "RS256"
    )) as CryptoKey;
    const token = await mintAssertion(
      { email: "ada@example.com" },
      { kid: "rotated-key", signKey: otherSignKey }
    );

    const res = await post(app, bindings, "/generate", token);

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION);
    // It tried the cache, then refetched once because the kid was unknown.
    expect(certsFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed assertion", async () => {
    const { app, bindings } = makeApp();

    const res = await post(app, bindings, "/generate", "not-a-token");

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION);
  });

  it("rejects a token minted for a foreign issuer", async () => {
    const { app, bindings } = makeApp();
    const token = await mintAssertion(
      { email: "ada@example.com" },
      { iss: "https://evil.cloudflareaccess.com" }
    );

    const res = await post(app, bindings, "/generate", token);

    expect(res.status).toBe(401);
    expect(await readError(res)).toBe(ACCESS_IDENTITY_ERRORS.INVALID_ASSERTION);
  });
});

describe("chooseOrganization", () => {
  const memberships = [
    { organizationId: "org-1", name: "One", role: "owner" as const },
    { organizationId: "org-2", name: "Two", role: "member" as const },
  ];

  it("picks the single membership with no explicit org", () => {
    const result = chooseOrganization([memberships[0]], undefined);
    expect(result).toMatchObject({ ok: true, organizationId: "org-1" });
  });

  it("refuses to pick when there are multiple memberships and no explicit org", () => {
    const result = chooseOrganization(memberships, undefined);
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.message).toBe(ACCESS_IDENTITY_ERRORS.MULTIPLE_ORGS);
    }
  });

  it("rejects an explicit org the user does not belong to", () => {
    const result = chooseOrganization(memberships, "org-unknown");
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) {
      expect(result.message).toBe(ACCESS_IDENTITY_ERRORS.NOT_A_MEMBER);
    }
  });

  it("resolves an explicit org the user does belong to", () => {
    const result = chooseOrganization(memberships, "org-2");
    expect(result).toMatchObject({
      ok: true,
      organizationId: "org-2",
      organizationName: "Two",
    });
  });

  it("rejects a user with no memberships", () => {
    const result = chooseOrganization([], undefined);
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) {
      expect(result.message).toBe(ACCESS_IDENTITY_ERRORS.LOGIN_REQUIRED);
    }
  });
});

beforeEach(async () => {
  await (env as unknown as Bindings).KV.delete(ACCESS_JWKS_KV_KEY);
});
