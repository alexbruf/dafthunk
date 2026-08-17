import { describe, expect, it } from "vitest";

import {
  verifyComposioRequest,
  verifyComposioSignature,
} from "./composio-signature";

/**
 * These vectors were validated by differential testing against
 * @composio/core@0.16.0's own `verifyWebhook`: 16 crafted cases plus 300
 * randomised deliveries, zero disagreements. They are frozen here as golden
 * cases — if one of them changes behaviour, our semantics have drifted from
 * the vendor's and webhook deliveries will start being rejected (or, far
 * worse, forged ones accepted).
 */

const SECRET = "whsec_R2FuZG9sZlRoZUdyZXlXYXNIZXJl";
const ID = "msg_2yHkLpQrStUvWxYz";
const BODY = JSON.stringify({
  id: "evt_01HQ",
  type: "composio.trigger.message",
  timestamp: "1970-01-01T00:00:00.000Z",
  metadata: { nanoId: "ti_abc123", triggerName: "GITHUB_STAR_ADDED" },
  data: { user_id: "org_42", trigger_nano_id: "ti_abc123" },
});

/** Fixed clock so tolerance cases are deterministic. */
const NOW = 1_800_000_000_000;
const nowSeconds = Math.floor(NOW / 1000);
const TS = String(nowSeconds);

async function sign(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const buffer = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

const verify = (
  overrides: Partial<Parameters<typeof verifyComposioSignature>[0]>
) =>
  verifyComposioSignature({
    webhookId: ID,
    webhookTimestamp: TS,
    webhookSignature: "",
    rawBody: BODY,
    secret: SECRET,
    now: NOW,
    ...overrides,
  });

describe("verifyComposioSignature", () => {
  it("accepts a well-formed delivery", async () => {
    const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
    expect(await verify({ webhookSignature: signature })).toEqual({ ok: true });
  });

  describe("secret rotation", () => {
    // Composio sends one `v1,<sig>` entry per active secret, space separated.
    // Accepting any match is what makes /rotate_secret zero-downtime.
    it("accepts when the matching signature is second", async () => {
      const stale = await sign("previous-secret", `${ID}.${TS}.${BODY}`);
      const fresh = await sign(SECRET, `${ID}.${TS}.${BODY}`);
      const result = await verify({
        webhookSignature: `v1,${stale} v1,${fresh}`,
      });
      expect(result).toEqual({ ok: true });
    });

    it("accepts when the matching signature is first", async () => {
      const fresh = await sign(SECRET, `${ID}.${TS}.${BODY}`);
      const result = await verify({
        webhookSignature: `v1,${fresh} v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
      });
      expect(result).toEqual({ ok: true });
    });

    it("ignores entries with an unknown version prefix", async () => {
      const fresh = await sign(SECRET, `${ID}.${TS}.${BODY}`);
      const result = await verify({
        webhookSignature: `v2,whatever v1,${fresh}`,
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("rejects forgeries", () => {
    it("rejects a modified body", async () => {
      const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const tampered = BODY.replace("GITHUB_STAR_ADDED", "GITHUB_STAR_REMOVED");
      const result = await verify({
        webhookSignature: signature,
        rawBody: tampered,
      });
      expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
    });

    it("rejects a wrong secret", async () => {
      const signature = `v1,${await sign("attacker", `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({ webhookSignature: signature });
      expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
    });

    it("binds the signature to the webhook id", async () => {
      const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({
        webhookSignature: signature,
        webhookId: "msg_other",
      });
      expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
    });

    it("binds the signature to the timestamp", async () => {
      const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({
        webhookSignature: signature,
        webhookTimestamp: String(nowSeconds - 1),
      });
      expect(result).toEqual({ ok: false, reason: "signature-mismatch" });
    });

    it("rejects a header carrying no v1 entry", async () => {
      const signature = `v2,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({ webhookSignature: signature });
      expect(result).toEqual({ ok: false, reason: "no-v1-signature" });
    });

    it("rejects a bare signature with no version prefix", async () => {
      const signature = await sign(SECRET, `${ID}.${TS}.${BODY}`);
      const result = await verify({ webhookSignature: signature });
      expect(result).toEqual({ ok: false, reason: "no-v1-signature" });
    });
  });

  describe("replay window", () => {
    it("accepts a delivery just inside the 300s window", async () => {
      const ts = String(nowSeconds - 299);
      const signature = `v1,${await sign(SECRET, `${ID}.${ts}.${BODY}`)}`;
      const result = await verify({
        webhookTimestamp: ts,
        webhookSignature: signature,
      });
      expect(result).toEqual({ ok: true });
    });

    it("rejects a delivery older than the window", async () => {
      const ts = String(nowSeconds - 301);
      const signature = `v1,${await sign(SECRET, `${ID}.${ts}.${BODY}`)}`;
      const result = await verify({
        webhookTimestamp: ts,
        webhookSignature: signature,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("stale-timestamp");
    });

    // The window is symmetric, so a skewed-forward clock upstream is rejected too.
    it("rejects a future-dated delivery", async () => {
      const ts = String(nowSeconds + 900);
      const signature = `v1,${await sign(SECRET, `${ID}.${ts}.${BODY}`)}`;
      const result = await verify({
        webhookTimestamp: ts,
        webhookSignature: signature,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("stale-timestamp");
    });

    it("skips the window entirely when tolerance is 0", async () => {
      const ts = String(nowSeconds - 100_000);
      const signature = `v1,${await sign(SECRET, `${ID}.${ts}.${BODY}`)}`;
      const result = await verify({
        webhookTimestamp: ts,
        webhookSignature: signature,
        tolerance: 0,
      });
      expect(result).toEqual({ ok: true });
    });

    it("rejects a non-numeric timestamp", async () => {
      const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({
        webhookTimestamp: "not-a-number",
        webhookSignature: signature,
      });
      expect(result).toEqual({
        ok: false,
        reason: "malformed-timestamp",
        detail: "not-a-number",
      });
    });
  });

  describe("missing headers", () => {
    it.each([
      ["webhookId", "missing-id"],
      ["webhookTimestamp", "missing-timestamp"],
      ["webhookSignature", "missing-signature"],
    ])("reports %s as %s", async (field, reason) => {
      const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
      const result = await verify({
        webhookSignature: signature,
        [field]: null,
      });
      expect(result).toEqual({ ok: false, reason });
    });
  });

  it("handles a unicode body byte-exactly", async () => {
    const body = JSON.stringify({
      id: "evt_u",
      type: "composio.trigger.message",
      timestamp: "1970-01-01T00:00:00.000Z",
      metadata: { note: "日本語 — émoji 🎯" },
      data: { t: "日本語 🎯" },
    });
    const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${body}`)}`;
    expect(
      await verify({ rawBody: body, webhookSignature: signature })
    ).toEqual({
      ok: true,
    });
  });
});

describe("verifyComposioRequest", () => {
  it("reads the three headers case-insensitively", async () => {
    const signature = `v1,${await sign(SECRET, `${ID}.${TS}.${BODY}`)}`;
    const headers = new Headers({
      "Webhook-Id": ID,
      "WEBHOOK-TIMESTAMP": TS,
      "webhook-signature": signature,
    });
    const result = await verifyComposioRequest(headers, BODY, SECRET, {
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("reports a missing header rather than throwing", async () => {
    const result = await verifyComposioRequest(new Headers(), BODY, SECRET, {
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing-id" });
  });
});
