import { Hono } from "hono";

import type { ApiContext } from "../context";

/**
 * Connecting a Composio account.
 *
 * Deliberately not an `OAuthProvider` subclass: Dafthunk does not hold client
 * credentials for the toolkits Composio brokers. The flow is Composio's hosted
 * auth link — `POST /connected_accounts/link` returns a redirect URL, and the
 * callback carries `status` and `connected_account_id`.
 */
const composioConnect = new Hono<ApiContext>();

composioConnect.get("/connect", (c) => {
  // Implemented by the connections work item.
  return c.json({ error: "Not implemented" }, 501);
});

composioConnect.get("/callback", (c) => {
  // Implemented by the connections work item.
  return c.json({ error: "Not implemented" }, 501);
});

export default composioConnect;
