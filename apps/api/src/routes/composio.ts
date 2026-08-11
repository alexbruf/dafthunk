import { Hono } from "hono";

import type { ApiContext } from "../context";

/**
 * Composio catalog browsing for the editor.
 *
 * The palette only synthesises important tools of connected toolkits — 45,000+
 * tools cannot ship in `/types`. Everything else is reachable through search
 * here, mirroring how the Cloudflare model picker is backed by
 * `/cloudflare-ai/models` rather than the node palette.
 */
const composioRoutes = new Hono<ApiContext>();

composioRoutes.get("/tools", (c) => {
  // Implemented by the catalog work item.
  return c.json({ error: "Not implemented" }, 501);
});

composioRoutes.get("/triggers", (c) => {
  // Implemented by the catalog work item.
  return c.json({ error: "Not implemented" }, 501);
});

export default composioRoutes;
