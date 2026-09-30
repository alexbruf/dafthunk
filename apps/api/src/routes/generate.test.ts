import { env } from "cloudflare:test";
import type { Context } from "hono";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerateWorkflowResult,
  GeneratorBillingInfo,
} from "../agents/workflow-generator/generator-service";
import {
  checkGeneratorPreconditions,
  generateWorkflow,
} from "../agents/workflow-generator/generator-service";
import { checkGenerationRateLimit } from "../agents/workflow-generator/rate-limit";
import type { ApiContext, Bindings } from "../context";
import generateRoutes from "./generate";

/**
 * The route can't be driven through the real auth middleware in a test — the
 * test-pool D1 has no schema, so `verifyApiKey` would throw (http-triggers'
 * comment states the same constraint). So the auth module is mocked to a thin
 * stand-in that replicates its contract: a `Bearer` token is accepted and the
 * organization is taken from the URL, anything else is a 401.
 *
 * The service module and the KV-backed rate limiter are mocked too. That keeps
 * the test asserting the route's *mapping* responsibilities — status codes,
 * field selection, and forwarding the URL org — while leaving all DB-backed
 * logic to the service layer, which is where it is testable.
 */
vi.mock("../auth", () => ({
  // Unused by this test's POST path, but the WS sibling route imports it, so
  // the module has to expose it or the import graph fails to load.
  jwtMiddleware: async (_c: Context<ApiContext>, next: () => Promise<void>) => {
    await next();
  },
  apiKeyOrJwtMiddleware: async (
    c: Context<ApiContext>,
    next: () => Promise<void>
  ) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "API key is required" }, 401);
    }
    c.set("organizationId", c.req.param("organizationId") ?? "org-test");
    await next();
  },
}));

vi.mock("../agents/workflow-generator/generator-service", () => ({
  checkGeneratorPreconditions: vi.fn(),
  generateWorkflow: vi.fn(),
}));

vi.mock("../agents/workflow-generator/rate-limit", () => ({
  checkGenerationRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 10,
    retryAfterSeconds: 0,
  })),
}));

const ORG = "org-url-1";

// The route reads `c.env` (KV for the rate limiter, then the service ctx). A
// bare `app.request` leaves `c.env` undefined, so pass the test bindings in.
const testEnv = env as Bindings;

const billingInfo: GeneratorBillingInfo = {
  computeCredits: 100,
  subscriptionStatus: "active",
  currentPeriodEnd: new Date(),
  overageLimit: null,
  unlimitedUsage: false,
  creditsExhausted: false,
};

function okPrecondition() {
  return {
    ok: true,
    plan: "pro",
    billingInfo,
    connectedProviders: new Set<string>(),
  } as const;
}

function okResult(): GenerateWorkflowResult {
  return {
    outcome: "ok",
    workflowId: "wf-1",
    executionId: "exec-1",
    workflow: {
      id: "wf-1",
      name: "Echo",
      trigger: "manual",
      nodes: [],
      edges: [],
    },
    repairAttempts: 1,
    issues: [],
    withheld: [],
    usage: { inputTokens: 100, outputTokens: 50, credits: 10 },
    frames: [],
  };
}

describe("POST /:organizationId/generate", () => {
  let app: Hono<ApiContext>;

  const authed = (path: string, body?: string) =>
    app.request(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
        body,
      },
      testEnv
    );

  beforeEach(() => {
    // Clear call history (not implementations) so `mock.calls` is per-test.
    vi.clearAllMocks();

    app = new Hono<ApiContext>();
    app.route("/:organizationId/generate", generateRoutes);

    vi.mocked(checkGenerationRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 10,
      retryAfterSeconds: 0,
    });
    vi.mocked(checkGeneratorPreconditions).mockResolvedValue(okPrecondition());
    vi.mocked(generateWorkflow).mockResolvedValue(okResult());
  });

  // 400 ─ invalid bodies ────────────────────────────────────────────────
  it("returns 400 on an empty prompt", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "" })
    );
    expect(res.status).toBe(400);
    expect(generateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 on a prompt over the length cap", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "x".repeat(2001) })
    );
    expect(res.status).toBe(400);
    expect(generateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 400 on a missing body", async () => {
    const res = await authed(`/${ORG}/generate`);
    expect(res.status).toBe(400);
  });

  // 401 ─ auth ──────────────────────────────────────────────────────────
  it("returns 401 with no bearer header", async () => {
    const res = await app.request(
      `/${ORG}/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "echo a message" }),
      },
      testEnv
    );
    expect(res.status).toBe(401);
    expect(generateWorkflow).not.toHaveBeenCalled();
  });

  // 402 / 503 ─ precondition failures ───────────────────────────────────
  it("returns 402 when the service reports CREDITS_EXHAUSTED", async () => {
    vi.mocked(checkGeneratorPreconditions).mockResolvedValueOnce({
      ok: false,
      code: "CREDITS_EXHAUSTED",
      message: "Not enough compute credits.",
    });
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo a message" })
    );
    expect(res.status).toBe(402);
    expect(generateWorkflow).not.toHaveBeenCalled();
  });

  it("returns 503 when the service reports MISCONFIGURED", async () => {
    vi.mocked(checkGeneratorPreconditions).mockResolvedValueOnce({
      ok: false,
      code: "MISCONFIGURED",
      message: "AI Gateway settings missing.",
    });
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo a message" })
    );
    expect(res.status).toBe(503);
    expect(generateWorkflow).not.toHaveBeenCalled();
  });

  // A failed graph is a working system, not a 5xx ──────────────────────
  it("returns 200 with outcome failed when the graph could not be repaired", async () => {
    vi.mocked(generateWorkflow).mockResolvedValueOnce({
      outcome: "failed",
      workflowId: null,
      executionId: null,
      workflow: null,
      repairAttempts: 2,
      issues: [
        {
          code: "TYPE_MISMATCH",
          severity: "fatal",
          nodeId: "src",
          message: "json -> string",
        },
      ],
      withheld: [],
      usage: { inputTokens: 100, outputTokens: 50, credits: 10 },
      frames: [],
    });

    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "never mind" })
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("failed");
    expect(body.workflowId).toBeNull();
    expect(body.issues).toHaveLength(1);
    // The diagnostics are for the caller; the ephemeral frame log is not.
    expect(body).not.toHaveProperty("frames");
  });

  it("returns the result fields minus frames on success", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo a message", execute: true })
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.outcome).toBe("ok");
    expect(body.workflowId).toBe("wf-1");
    expect(body.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(body).not.toHaveProperty("frames");
  });

  // org comes from the URL, never the body ──────────────────────────────
  it("passes the organizationId from the URL, never from the body", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo", organizationId: "body-org" })
    );
    expect(res.status).toBe(200);

    const [ctx] = vi.mocked(generateWorkflow).mock.calls[0] ?? [];
    expect(ctx.organizationId).toBe(ORG);
    // The rate limit is keyed by the same URL org, not by anything in the body.
    expect(vi.mocked(checkGenerationRateLimit).mock.calls[0]?.[1]).toBe(ORG);
  });

  // execute defaults to false ───────────────────────────────────────────
  it("defaults execute to false when the field is absent", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo a message" })
    );
    expect(res.status).toBe(200);

    const opts = vi.mocked(generateWorkflow).mock.calls[0]?.[2];
    expect(opts?.execute).toBe(false);
  });

  it("honours an explicit execute: true", async () => {
    const res = await authed(
      `/${ORG}/generate`,
      JSON.stringify({ prompt: "echo a message", execute: true })
    );
    expect(res.status).toBe(200);

    const opts = vi.mocked(generateWorkflow).mock.calls[0]?.[2];
    expect(opts?.execute).toBe(true);
  });
});
