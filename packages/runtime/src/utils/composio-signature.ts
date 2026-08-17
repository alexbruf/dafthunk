/**
 * Composio webhook signature verification — Workers-native, zero dependencies.
 *
 * Semantics are pinned against @composio/core@0.16.0 (src/models/Triggers.ts):
 *  - signing string is `{webhook-id}.{webhook-timestamp}.{rawBody}`
 *  - HMAC-SHA256 keyed with the secret as raw UTF-8 (NOT base64-decoded, which
 *    is where Svix-derived implementations get it wrong)
 *  - the `webhook-signature` header is a SPACE-separated list of `v1,<base64>`
 *    entries; a delivery is valid if ANY entry matches (this is what makes
 *    secret rotation non-breaking)
 *  - timestamp tolerance is symmetric: |now - ts| > tolerance rejects, so a
 *    clock-skewed future timestamp is rejected too
 *
 * Returns a discriminated result instead of throwing: a webhook handler needs
 * to branch on the reason (401 vs 400) and log it, not unwind a stack.
 */

export type VerifyFailure =
  | "missing-id"
  | "missing-timestamp"
  | "missing-signature"
  | "malformed-timestamp"
  | "stale-timestamp"
  | "no-v1-signature"
  | "signature-mismatch";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailure; detail?: string };

export interface VerifyInput {
  webhookId: string | null | undefined;
  webhookTimestamp: string | null | undefined;
  webhookSignature: string | null | undefined;
  /** The exact bytes as received. Re-serialising parsed JSON breaks the HMAC. */
  rawBody: string;
  secret: string;
  /** Seconds. 0 disables the check. Composio's default is 300. */
  tolerance?: number;
  /** Injected for deterministic tests. */
  now?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Base64(
  secret: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toBase64(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  );
}

export async function verifyComposioSignature(
  input: VerifyInput
): Promise<VerifyResult> {
  const {
    webhookId,
    webhookTimestamp,
    webhookSignature,
    rawBody,
    secret,
    tolerance = DEFAULT_TOLERANCE_SECONDS,
    now = Date.now(),
  } = input;

  if (!webhookId) return { ok: false, reason: "missing-id" };
  if (!webhookTimestamp) return { ok: false, reason: "missing-timestamp" };
  if (!webhookSignature) return { ok: false, reason: "missing-signature" };

  if (tolerance > 0) {
    const seconds = Number.parseInt(webhookTimestamp, 10);
    if (Number.isNaN(seconds)) {
      return {
        ok: false,
        reason: "malformed-timestamp",
        detail: webhookTimestamp,
      };
    }
    const driftMs = Math.abs(now - seconds * 1000);
    if (driftMs > tolerance * 1000) {
      return {
        ok: false,
        reason: "stale-timestamp",
        detail: `${Math.round(driftMs / 1000)}s drift, max ${tolerance}s`,
      };
    }
  }

  const candidates: string[] = [];
  for (const entry of webhookSignature.split(" ")) {
    const [version, value] = entry.split(",");
    if (version === "v1" && value) candidates.push(value);
  }
  if (candidates.length === 0) return { ok: false, reason: "no-v1-signature" };

  const expected = await hmacSha256Base64(
    secret,
    `${webhookId}.${webhookTimestamp}.${rawBody}`
  );

  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature-mismatch" };
}

/** Convenience for Hono: reads the three headers case-insensitively. */
export async function verifyComposioRequest(
  headers: Headers,
  rawBody: string,
  secret: string,
  opts?: { tolerance?: number; now?: number }
): Promise<VerifyResult> {
  return verifyComposioSignature({
    webhookId: headers.get("webhook-id"),
    webhookTimestamp: headers.get("webhook-timestamp"),
    webhookSignature: headers.get("webhook-signature"),
    rawBody,
    secret,
    ...opts,
  });
}
