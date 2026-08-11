import type { Workflow, WorkflowExecution } from "@dafthunk/types";
import { describe, expect, it, vi } from "vitest";

import type { Bindings } from "../../context";
import { stampOnboardingStage } from "../../db";
import { callModel, runOnce, saveWorkflow } from "./generator-service";

// ── Mocked module seams ──────────────────────────────────────────────────
//
// `generatorService` binds its network dependencies at module level (`callModel`
// → `callAgentLLM`, `saveWorkflow` → `WorkflowStore`, `runOnce` →
// `WorkflowExecutor`), so the harness mocks those modules rather than injecting
// them. The mutable `state` bag is re-seeded by `serviceHarness` before each
// call; the `vi.fn`s themselves are created once and `mockClear`ed per test.

const state = vi.hoisted(() => ({
  billingInfo: undefined as unknown,
  integrations: [] as Array<{ provider: string }>,
  creditExhausted: false,
  nodeTypes: [] as unknown[],
  llmQueue: [] as GenerateResultShape[],
  saved: [] as unknown[],
  runCalls: [] as unknown[],
  runStatus: "completed" as WorkflowExecution["status"],
  callLLM: vi.fn(async () => {
    const next = state.llmQueue.shift();
    if (!next) throw new Error("callLLM called more times than expected");
    return next;
  }),
  save: vi.fn(async (record: unknown) => record),
  execute: vi.fn(async (_options: unknown) => ({
    execution: state.execution(),
  })),
  execution: () =>
    ({
      id: "exec-1",
      workflowId: "wf-1",
      status: state.runStatus,
      nodeExecutions: [],
    }) as WorkflowExecution,
}));

vi.mock("../../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db")>();
  return {
    ...actual,
    createDatabase: vi.fn(() => ({})),
    getOrganizationBillingInfo: vi.fn(async () => state.billingInfo),
    getIntegrations: vi.fn(async () => state.integrations),
    stampOnboardingStage: vi.fn(async () => {}),
  };
});

vi.mock("../../utils/credits", () => ({
  isCreditExhausted: vi.fn(() => state.creditExhausted),
  creditChecksEnabled: vi.fn(() => true),
}));

vi.mock("../../durable-objects/agent-llm", () => ({
  callAgentLLM: state.callLLM,
}));

vi.mock("../../stores/workflow-store", () => ({
  WorkflowStore: class {
    constructor(_env: unknown) {}
    save(record: unknown) {
      return state.save(record);
    }
  },
}));

vi.mock("../../services/workflow-executor", () => ({
  WorkflowExecutor: { execute: state.execute },
}));

vi.mock("../../runtime/cloudflare-node-registry", () => ({
  CloudflareNodeRegistry: class {
    getNodeTypes() {
      return state.nodeTypes;
    }
  },
}));

// ── Shared shapes ────────────────────────────────────────────────────────

interface GenerateResultShape {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** A billing row that passes every precondition gate in production. */
function billingRow(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    computeCredits: 1000,
    subscriptionStatus: "active",
    currentPeriodEnd: null,
    overageLimit: null,
    unlimitedUsage: false,
    creditsExhausted: false,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}): Bindings {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    CLOUDFLARE_AI_GATEWAY_ID: "gateway-1",
    CLOUDFLARE_API_TOKEN: "token-1",
    CLOUDFLARE_ENV: "production",
    ...overrides,
  } as unknown as Bindings;
}

function sampleWorkflow(): Workflow {
  return {
    id: "wf-1",
    name: "Sample",
    description: "A sample workflow",
    trigger: "manual",
    nodes: [
      {
        id: "n1",
        name: "Text",
        type: "text-input",
        position: { x: 0, y: 0 },
        inputs: [{ name: "value", type: "string" }],
        outputs: [{ name: "value", type: "string" }],
      },
    ],
    edges: [],
  };
}

// ── Step 1: unit coverage for the lifted free functions ──────────────────
//
// These three were private methods on the Durable Object and unexercised
// there. Fixing their behaviour now — before the extraction — gives the DO
// repoint a real safety net rather than a structural one.

describe("callModel", () => {
  it("delegates to callAgentLLM with the generator config and maps the result", async () => {
    state.llmQueue = [{ content: "draft", inputTokens: 12, outputTokens: 7 }];
    state.callLLM.mockClear();

    const result = await callModel(makeEnv(), {
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(state.callLLM).toHaveBeenCalledTimes(1);
    expect(state.callLLM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "anthropic",
        instructions: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      })
    );
    expect(result).toEqual({
      content: "draft",
      inputTokens: 12,
      outputTokens: 7,
    });
  });

  it("coerces a sparse model response to zero-valued tokens", async () => {
    state.llmQueue = [{} as GenerateResultShape];

    const result = await callModel(makeEnv(), {
      system: "s",
      messages: [],
    });

    expect(result).toEqual({ content: "", inputTokens: 0, outputTokens: 0 });
  });
});

describe("saveWorkflow", () => {
  it("saves under a fresh id, scoped to the organization, and stamps onboarding", async () => {
    state.save.mockClear();

    const id = await saveWorkflow(
      {
        env: makeEnv(),
        organizationId: "org-1",
        userId: "user-1",
        apiHost: "https://api.example.test",
      },
      sampleWorkflow()
    );

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        name: "Sample",
        runtime: "workflow",
        organizationId: "org-1",
        apiHost: "https://api.example.test",
        nodes: sampleWorkflow().nodes,
        edges: sampleWorkflow().edges,
      })
    );
    expect(stampOnboardingStage).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "workflowCreated"
    );
  });

  it("falls back to a default name when the workflow has none", async () => {
    state.save.mockClear();
    const wf = sampleWorkflow();
    wf.name = "";

    await saveWorkflow(
      { env: makeEnv(), organizationId: "org-2", userId: "user-2" },
      wf
    );

    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Generated Workflow",
        organizationId: "org-2",
        apiHost: undefined,
      })
    );
  });
});

describe("runOnce", () => {
  it("executes with a worker runtime and billing options scoped to the context", async () => {
    state.execute.mockClear();

    const execution = await runOnce(
      { env: makeEnv(), organizationId: "org-1", userId: "user-1" },
      billingRow({ computeCredits: 500 }) as Parameters<typeof runOnce>[1],
      sampleWorkflow(),
      "wf-1",
      {}
    );

    expect(state.execute).toHaveBeenCalledTimes(1);
    const call = state.execute.mock.calls[0][0] as unknown as {
      workflow: { id: string; runtime?: string };
      userId: string;
      organizationId: string;
      computeCredits: number;
      userPlan?: string;
    };
    expect(call.workflow).toMatchObject({ id: "wf-1", runtime: "worker" });
    expect(call.userId).toBe("user-1");
    expect(call.organizationId).toBe("org-1");
    expect(call.computeCredits).toBe(500);
    expect(execution).toMatchObject({ id: "exec-1", workflowId: "wf-1" });
  });
});
