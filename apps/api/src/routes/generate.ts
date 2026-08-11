import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { GeneratorContext } from "../agents/workflow-generator/generator-service";
import {
  checkGeneratorPreconditions,
  generateWorkflow,
} from "../agents/workflow-generator/generator-service";
import { checkGenerationRateLimit } from "../agents/workflow-generator/rate-limit";
import { apiKeyOrJwtMiddleware, jwtMiddleware } from "../auth";
import { ApiContext } from "../context";
import { getAgentByName } from "../durable-objects/agent-utils";
import { developerModeMiddleware } from "../middleware/developer";

/**
 * Machine clients authenticate with an API key, which resolves to an org but
 * not a person. The generator stamps every saved workflow with a userId, so
 * keyed traffic shares the sentinel the HTTP trigger routes use.
 */
const API_KEY_USER_ID = "api_key";

/** Upper bound on a generation prompt; mirrors the client-side textarea limit. */
const MAX_PROMPT_LENGTH = 2000;

const generateBodySchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  // Off by default: `execute: true` runs the generated graph, and a prompt is
  // untrusted text. Only callers that deliberately want execution say so.
  execute: z.boolean().optional().default(false),
});

const generateRoutes = new Hono<ApiContext>();

/**
 * WebSocket endpoint for workflow generation.
 *
 * Keyed by a client-generated session id — there is no workflow yet. Unlike the
 * editor socket, the organization has to travel as a header too, because the DO
 * has no workflow record to derive it from.
 */
generateRoutes.get(
  "/:sessionId",
  jwtMiddleware,
  developerModeMiddleware,
  async (c) => {
    const jwtPayload = c.var.jwtPayload;
    const userId = jwtPayload?.sub;
    const organizationId = c.get("organizationId");

    if (!userId || !organizationId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const verdict = await checkGenerationRateLimit(c.env.KV, organizationId);
    if (!verdict.allowed) {
      return c.json(
        {
          error: `Too many generations. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s).`,
        },
        429,
        { "Retry-After": String(verdict.retryAfterSeconds) }
      );
    }

    const sessionId = c.req.param("sessionId")!;

    // getAgentByName initializes the partyserver name before returning the stub
    const stub = await getAgentByName(
      c.env.WORKFLOW_GENERATOR_AGENT,
      sessionId
    );

    const headers = new Headers(c.req.raw.headers);
    headers.set("X-User-Id", userId);
    headers.set("X-Organization-Id", organizationId);
    headers.set(
      "X-Developer-Mode",
      jwtPayload?.developerMode ? "true" : "false"
    );

    return stub.fetch(
      new Request(c.req.url, {
        method: c.req.method,
        headers,
        body: c.req.raw.body,
      })
    );
  }
);

/**
 * HTTP sibling to the WebSocket route, for machine clients.
 *
 * No `developerModeMiddleware` here — the dev gate is exactly what this path
 * exists to remove. Precondition failures map to status codes the way the DO
 * maps them to error frames: credits exhausted is a 402, a broken deployment
 * config is a 503. A graph that cannot be repaired is still a 200 with
 * `outcome: "failed"`; the body carries the diagnostics, and 5xx is reserved
 * for the deployment being broken.
 */
generateRoutes.post(
  "/",
  apiKeyOrJwtMiddleware,
  zValidator("json", generateBodySchema),
  async (c) => {
    const organizationId = c.get("organizationId");
    if (!organizationId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const verdict = await checkGenerationRateLimit(c.env.KV, organizationId);
    if (!verdict.allowed) {
      return c.json(
        {
          error: `Too many generations. Try again in ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s).`,
        },
        429,
        { "Retry-After": String(verdict.retryAfterSeconds) }
      );
    }

    const ctx: GeneratorContext = {
      env: c.env,
      organizationId,
      userId: c.var.jwtPayload?.sub ?? API_KEY_USER_ID,
    };

    const precondition = await checkGeneratorPreconditions(ctx);
    if (!precondition.ok) {
      switch (precondition.code) {
        case "CREDITS_EXHAUSTED":
          return c.json({ error: precondition.message }, 402);
        case "MISCONFIGURED":
          return c.json({ error: precondition.message }, 503);
        default:
          // ORG_NOT_FOUND: auth already scoped the request to a real
          // membership, so only a torn-down org reaches here.
          return c.json({ error: precondition.message }, 404);
      }
    }

    const { prompt, execute } = c.req.valid("json");
    const result = await generateWorkflow(ctx, prompt, { execute });

    // The frame log is live progress for socket clients; machine callers get
    // the outcome and the diagnostics in one shot instead.
    const { frames: _frames, ...responseBody } = result;
    return c.json(responseBody, 200);
  }
);

export default generateRoutes;
