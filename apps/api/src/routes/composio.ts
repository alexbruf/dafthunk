import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { jwtMiddleware } from "../auth";
import type { ApiContext } from "../context";
import {
  type ComposioSearchResult,
  searchComposioActionNodeTypes,
  searchComposioTriggerNodeTypes,
} from "../runtime/composio-catalog";

/**
 * Composio catalog browsing for the editor.
 *
 * The palette only synthesises important tools of connected toolkits — 45,000+
 * tools cannot ship in `/types`. Everything else is reachable through search
 * here, mirroring how the Cloudflare model picker is backed by
 * `/cloudflare-ai/models` rather than the node palette.
 *
 * Both endpoints return ready-to-drop `NodeType`s rather than raw Composio
 * records, so a search result and a palette entry are the same thing to the
 * editor.
 */
const composioRoutes = new Hono<ApiContext>();

composioRoutes.use("*", jwtMiddleware);

const searchQuery = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  toolkit: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]+$/, "toolkit must be a Composio toolkit slug")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

composioRoutes.get("/tools", zValidator("query", searchQuery), async (c) => {
  const apiKey = c.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Composio is not configured" }, 503);
  }

  const { query, toolkit, limit, cursor } = c.req.valid("query");
  try {
    const result = await searchComposioActionNodeTypes(apiKey, {
      query,
      toolkit,
      limit,
      cursor,
    });
    return c.json(result satisfies ComposioSearchResult);
  } catch (error) {
    console.error("Error searching Composio tools:", error);
    return c.json({ error: "Failed to search Composio tools" }, 502);
  }
});

composioRoutes.get("/triggers", zValidator("query", searchQuery), async (c) => {
  const apiKey = c.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Composio is not configured" }, 503);
  }

  const { query, limit } = c.req.valid("query");
  try {
    // Composio's `/triggers_types` has no query parameter, so this filters the
    // same cached bundle `/types` already builds rather than re-listing 362
    // types per keystroke.
    const result = await searchComposioTriggerNodeTypes(
      apiKey,
      c.executionCtx,
      {
        query,
        limit,
      }
    );
    return c.json(result satisfies ComposioSearchResult);
  } catch (error) {
    console.error("Error searching Composio triggers:", error);
    return c.json({ error: "Failed to search Composio triggers" }, 502);
  }
});

export default composioRoutes;
