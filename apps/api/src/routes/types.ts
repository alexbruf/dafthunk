import type { GetNodeTypesResponse, NodeType } from "@dafthunk/types";
import { Hono } from "hono";

import { optionalJwtMiddleware } from "../auth";
import type { ApiContext } from "../context";
import { getCloudflareModelNodeTypes } from "../runtime/cloudflare-model-catalog";
import { CloudflareNodeRegistry } from "../runtime/cloudflare-node-registry";
import { getComposioNodeTypes } from "../runtime/composio-catalog";

const typeRoutes = new Hono<ApiContext>();

typeRoutes.get("/", optionalJwtMiddleware, async (c) => {
  try {
    const jwtPayload = c.get("jwtPayload");
    const registry = new CloudflareNodeRegistry(
      c.env,
      jwtPayload?.developerMode ?? false
    );
    const staticNodeTypes = registry.getNodeTypes();

    // Synthesise per-model NodeTypes from the Cloudflare catalog so each
    // Workers AI model surfaces directly in the editor's palette. Failures
    // (missing credentials, upstream outage, or test envs without an
    // ExecutionContext) degrade to the static list — the generic
    // `cloudflare-model` node remains available as a fallback.
    let cloudflareNodeTypes: NodeType[] = [];
    try {
      cloudflareNodeTypes = await getCloudflareModelNodeTypes(
        c.env,
        c.executionCtx
      );
    } catch (error) {
      console.warn(
        "[types] Skipping Cloudflare model synthesis:",
        error instanceof Error ? error.message : error
      );
    }

    // Same idea for Composio: one palette entry per tool and trigger type, all
    // dispatching to two runtime nodes. `getComposioNodeTypes` returns an empty
    // list rather than throwing when there is no COMPOSIO_API_KEY; the try/catch
    // covers the remaining case the Cloudflare block above also guards against —
    // reading `c.executionCtx` throws outright in test envs that have none.
    let composioNodeTypes: NodeType[] = [];
    try {
      composioNodeTypes = await getComposioNodeTypes(
        c.env,
        c.executionCtx,
        c.get("organizationId")
      );
    } catch (error) {
      console.warn(
        "[types] Skipping Composio synthesis:",
        error instanceof Error ? error.message : error
      );
    }

    const nodeTypes = [
      ...staticNodeTypes,
      ...cloudflareNodeTypes,
      ...composioNodeTypes,
    ];
    return c.json({ nodeTypes } as GetNodeTypesResponse);
  } catch (error) {
    console.error("Error getting node types:", error);
    return c.json({ error: "Failed to get node types" }, 500);
  }
});

export default typeRoutes;
