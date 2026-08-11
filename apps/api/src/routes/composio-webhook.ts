import { Hono } from "hono";

import type { ApiContext } from "../context";

/**
 * Composio trigger deliveries.
 *
 * Unauthenticated like the other provider webhooks: the delivery is proven by
 * an HMAC-SHA256 signature over `{webhook-id}.{webhook-timestamp}.{rawBody}`,
 * verified with `verifyComposioRequest` from `@dafthunk/runtime`. Read the raw
 * body — re-serialising parsed JSON changes bytes and breaks the signature.
 */
const composioWebhook = new Hono<ApiContext>();

composioWebhook.post("/webhook", (c) => {
  // Implemented by the webhook work item.
  return c.json({ error: "Not implemented" }, 501);
});

export default composioWebhook;
