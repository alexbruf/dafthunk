import { describe, expect, it } from "vitest";

import {
  buildComposioCallbackUrl,
  ComposioConnectError,
  type ComposioConnectedAccount,
  type ComposioConnectState,
  mapComposioConnectionStatus,
  requireComposioApiKey,
  resolveComposioCallback,
  signComposioState,
  toolkitLabel,
  uniqueIntegrationName,
  verifyComposioState,
} from "./composio-connect";

/**
 * The connect flow's decisions live in pure functions so they can be tested at
 * all: the vitest-pool-workers D1 has no schema (see `http-triggers.test.ts`),
 * so the request path itself cannot be exercised here. Nothing below touches
 * the network — the Composio responses are the literal shapes returned by
 * `GET /connected_accounts/{id}`, transcribed from a live call.
 */

const SECRET = "test-jwt-secret-for-composio-state";
const ORG = "org_11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "org_22222222-2222-2222-2222-222222222222";

const state = (
  overrides: Partial<ComposioConnectState> = {}
): ComposioConnectState => ({
  organizationId: ORG,
  toolkit: "gmail",
  authConfigId: "ac_vhfZaZ0kLo",
  timestamp: Date.now(),
  nonce: "11111111-2222-3333-4444-555555555555",
  ...overrides,
});

const account = (
  overrides: Partial<ComposioConnectedAccount> = {}
): ComposioConnectedAccount => ({
  id: "ca_kvAuMrBpD5KD",
  status: "ACTIVE",
  userId: ORG,
  toolkitSlug: "gmail",
  authConfigId: "ac_vhfZaZ0kLo",
  ...overrides,
});

describe("mapComposioConnectionStatus", () => {
  it("maps an authorised account to active", () => {
    expect(mapComposioConnectionStatus("ACTIVE")).toBe("active");
  });

  it("maps an aged-out account to expired", () => {
    expect(mapComposioConnectionStatus("EXPIRED")).toBe("expired");
  });

  it("maps a failed authorisation to revoked", () => {
    expect(mapComposioConnectionStatus("FAILED")).toBe("revoked");
  });

  it("maps a disabled account to revoked", () => {
    expect(mapComposioConnectionStatus("INACTIVE")).toBe("revoked");
  });

  it("maps an incomplete handshake to revoked", () => {
    // INITIATED / INITIALIZING mean the user never finished at the provider.
    expect(mapComposioConnectionStatus("INITIATED")).toBe("revoked");
    expect(mapComposioConnectionStatus("INITIALIZING")).toBe("revoked");
  });

  it("fails closed on a status Composio has not shipped yet", () => {
    expect(mapComposioConnectionStatus("SOMETHING_NEW")).toBe("revoked");
    expect(mapComposioConnectionStatus("")).toBe("revoked");
  });

  it("is case-insensitive", () => {
    expect(mapComposioConnectionStatus("active")).toBe("active");
    expect(mapComposioConnectionStatus("Expired")).toBe("expired");
  });
});

describe("toolkitLabel", () => {
  it("title-cases a single-word slug", () => {
    expect(toolkitLabel("gmail")).toBe("Gmail");
  });

  it("splits underscored and hyphenated slugs into words", () => {
    expect(toolkitLabel("google_drive")).toBe("Google Drive");
    expect(toolkitLabel("google-super-docs")).toBe("Google Super Docs");
  });

  it("falls back to the provider name when the slug is empty", () => {
    expect(toolkitLabel("")).toBe("Composio");
  });
});

describe("uniqueIntegrationName", () => {
  it("uses the bare label when nothing owns it", () => {
    expect(uniqueIntegrationName("Gmail", [])).toBe("Gmail");
  });

  it("suffixes past a taken name", () => {
    expect(uniqueIntegrationName("Gmail", ["Gmail"])).toBe("Gmail 2");
    expect(uniqueIntegrationName("Gmail", ["Gmail", "Gmail 2"])).toBe(
      "Gmail 3"
    );
  });

  it("ignores unrelated names", () => {
    expect(uniqueIntegrationName("Gmail", ["Slack", "GitHub"])).toBe("Gmail");
  });
});

describe("resolveComposioCallback", () => {
  it("produces the integration record to write on a successful callback", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account(),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "persist",
      record: {
        organizationId: ORG,
        name: "Gmail",
        provider: "composio",
        token: "ca_kvAuMrBpD5KD",
        status: "active",
        metadata: JSON.stringify({
          toolkit: "gmail",
          authConfigId: "ac_vhfZaZ0kLo",
          composioUserId: ORG,
        }),
      },
    });
  });

  it("carries the toolkit in metadata so a Gmail action cannot pick a Slack connection", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_slack",
      state: state({ toolkit: "slack", authConfigId: "ac_slack" }),
      account: account({
        id: "ca_slack",
        toolkitSlug: "slack",
        authConfigId: "ac_slack",
      }),
      existingNames: [],
    });

    expect(outcome.kind).toBe("persist");
    if (outcome.kind !== "persist") return;
    expect(JSON.parse(outcome.record.metadata)).toEqual({
      toolkit: "slack",
      authConfigId: "ac_slack",
      composioUserId: ORG,
    });
    expect(outcome.record.name).toBe("Slack");
  });

  it("writes nothing when Composio reports the authorisation failed", () => {
    const outcome = resolveComposioCallback({
      status: "failed",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account({ status: "FAILED" }),
      existingNames: [],
    });

    expect(outcome).toEqual({ kind: "reject", error: "composio_auth_failed" });
  });

  it("writes nothing when the callback carries no status at all", () => {
    const outcome = resolveComposioCallback({
      status: null,
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account(),
      existingNames: [],
    });

    expect(outcome).toEqual({ kind: "reject", error: "composio_auth_failed" });
  });

  it("writes nothing when the callback omits the connected account id", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: null,
      state: state(),
      account: account(),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "composio_invalid_callback",
    });
  });

  it("writes nothing when the connected account could not be read back", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: null,
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "composio_invalid_callback",
    });
  });

  it("rejects a callback pointing at a different account than the one read back", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account({ id: "ca_somethingElse" }),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "composio_invalid_callback",
    });
  });

  it("rejects a connection whose Composio user is not the initiating organization", () => {
    // The cross-tenant guard: Composio's user_id is Dafthunk's organization id,
    // so a mismatch means this account belongs to somebody else's tenant.
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state({ organizationId: ORG }),
      account: account({ userId: OTHER_ORG }),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "organization_mismatch",
    });
  });

  it("rejects a connection with no Composio user at all", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account({ userId: undefined }),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "organization_mismatch",
    });
  });

  it("rejects a connection for a different toolkit than the one requested", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state({ toolkit: "gmail" }),
      account: account({ toolkitSlug: "slack" }),
      existingNames: [],
    });

    expect(outcome).toEqual({
      kind: "reject",
      error: "composio_invalid_callback",
    });
  });

  it("persists an already-expired account with the expired status rather than active", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account({ status: "EXPIRED" }),
      existingNames: [],
    });

    expect(outcome.kind).toBe("persist");
    if (outcome.kind !== "persist") return;
    expect(outcome.record.status).toBe("expired");
  });

  it("disambiguates the name against the organization's existing integrations", () => {
    const outcome = resolveComposioCallback({
      status: "success",
      connectedAccountId: "ca_kvAuMrBpD5KD",
      state: state(),
      account: account(),
      existingNames: ["Gmail"],
    });

    expect(outcome.kind).toBe("persist");
    if (outcome.kind !== "persist") return;
    expect(outcome.record.name).toBe("Gmail 2");
  });
});

describe("composio connect state", () => {
  it("round-trips the organization, toolkit and auth config", async () => {
    const original = state();
    const token = await signComposioState(original, SECRET);

    expect(await verifyComposioState(token, SECRET)).toEqual(original);
  });

  it("rejects a state signed with a different secret", async () => {
    const token = await signComposioState(state(), SECRET);

    await expect(verifyComposioState(token, "other-secret")).rejects.toThrow(
      ComposioConnectError
    );
  });

  it("rejects a state whose organization was swapped after signing", async () => {
    const token = await signComposioState(state(), SECRET);
    const [, signature] = [
      token.slice(0, token.lastIndexOf(".")),
      token.slice(token.lastIndexOf(".") + 1),
    ];
    const forged = `${btoa(JSON.stringify(state({ organizationId: OTHER_ORG })))}.${signature}`;

    await expect(verifyComposioState(forged, SECRET)).rejects.toMatchObject({
      redirectError: "invalid_state",
    });
  });

  it("rejects a state older than the link session can possibly live", async () => {
    const stale = state({ timestamp: Date.now() - 16 * 60 * 1000 });
    const token = await signComposioState(stale, SECRET);

    await expect(verifyComposioState(token, SECRET)).rejects.toMatchObject({
      redirectError: "expired_state",
    });
  });

  it("rejects a malformed state", async () => {
    await expect(verifyComposioState("not-a-state", SECRET)).rejects.toThrow(
      ComposioConnectError
    );
    await expect(verifyComposioState("", SECRET)).rejects.toThrow(
      ComposioConnectError
    );
  });

  it("rejects a correctly signed state that is missing required fields", async () => {
    const token = await signComposioState(state({ nonce: "" }), SECRET);

    await expect(verifyComposioState(token, SECRET)).rejects.toMatchObject({
      redirectError: "invalid_state",
    });
  });
});

describe("requireComposioApiKey", () => {
  it("returns the configured key", () => {
    expect(requireComposioApiKey({ COMPOSIO_API_KEY: "ak_test" })).toBe(
      "ak_test"
    );
  });

  it("fails loudly rather than silently succeeding when the key is absent", () => {
    // A silent success here would redirect the user into a broken Composio
    // session with no explanation, so this must throw, not return undefined.
    expect(() => requireComposioApiKey({})).toThrow(ComposioConnectError);
    expect(() => requireComposioApiKey({})).toThrow(/COMPOSIO_API_KEY/);
    expect(() => requireComposioApiKey({ COMPOSIO_API_KEY: "" })).toThrow(
      expect.objectContaining({ redirectError: "composio_not_configured" })
    );
  });
});

describe("buildComposioCallbackUrl", () => {
  /**
   * The callback host used to be a hardcoded pair — api.dafthunk.com in
   * production, localhost otherwise — so every self-hosted deployment sent
   * users to localhost after consenting. The connection succeeded upstream and
   * the callback never ran, leaving a live Composio account with no integration
   * row pointing at it.
   *
   * Deriving it from the request is what makes this correct anywhere: it is by
   * definition the host the browser just reached us on. Composio accepts
   * `callback_url` per request, so nothing has to be registered in advance.
   */
  it("uses the origin the request actually arrived on", () => {
    expect(
      buildComposioCallbackUrl(
        "https://daft.clanqi.org/composio/connect?toolkit=notion",
        "st8"
      )
    ).toBe("https://daft.clanqi.org/composio/callback?state=st8");
  });

  it("works unchanged for local development", () => {
    expect(
      buildComposioCallbackUrl("http://localhost:3002/composio/connect", "st8")
    ).toBe("http://localhost:3002/composio/callback?state=st8");
  });

  it("keeps a non-default port", () => {
    expect(
      buildComposioCallbackUrl(
        "https://example.test:8787/composio/connect",
        "s"
      )
    ).toBe("https://example.test:8787/composio/callback?state=s");
  });

  it("url-encodes the state so its base64 padding survives", () => {
    // Signed state contains '+', '/' and '=' — unencoded they would be
    // mangled into a different value by the time the callback parses it.
    const state = "abc+def/ghi==.sig+/=";
    const url = new URL(buildComposioCallbackUrl("https://x.test/c", state));
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("ignores any query already on the incoming request", () => {
    expect(
      buildComposioCallbackUrl(
        "https://daft.clanqi.org/composio/connect?toolkit=notion&x=1",
        "s"
      )
    ).toBe("https://daft.clanqi.org/composio/callback?state=s");
  });
});
