/**
 * Env-bound wrapper over `runGenerationPipeline`.
 *
 * The Durable Object is one shell over the pipeline; this is a second, for
 * callers that have no socket and no DO — the HTTP route and the MCP server.
 * The three dependencies the DO injects (`callLLM`, `save`, `run`) turn out to
 * be free functions over `env` with no DO state, which is what makes a second
 * shell cheap. They are lifted here verbatim and the DO delegates to them, so
 * there is exactly one copy of each.
 *
 * Everything worth asserting lives here rather than in the route: the route
 * cannot be driven through real D1 in a test, so logic that leaks into it
 * becomes untestable by construction.
 *
 * All six exports are implemented: the three lifted free functions
 * (`callModel`, `saveWorkflow`, `runOnce`) plus `checkGeneratorPreconditions`,
 * `generateWorkflow` and `listNodeTypes`. The signatures are the fixed
 * contract the route and MCP layers mock against.
 */

import { calculateTokenUsage } from "@dafthunk/runtime/utils/usage";
import type {
  GenerationErrorCode,
  GenerationValidationIssue,
  GeneratorServerMessage,
  NodeType,
  Workflow,
  WorkflowExecution,
} from "@dafthunk/types";

import type { Bindings } from "../../context";
import {
  createDatabase,
  getIntegrations,
  getOrganizationBillingInfo,
  resolveOrganizationBillingOptions,
  resolveOrganizationPlan,
  stampOnboardingStage,
} from "../../db";
import { callAgentLLM } from "../../durable-objects/agent-llm";
import { CloudflareNodeRegistry } from "../../runtime/cloudflare-node-registry";
import type { WorkflowExecutorParameters } from "../../services/workflow-executor";
import { WorkflowExecutor } from "../../services/workflow-executor";
import { WorkflowStore } from "../../stores/workflow-store";
import { isCreditExhausted } from "../../utils/credits";
import {
  GENERATOR_MODEL,
  GENERATOR_PRICING,
  GENERATOR_PROVIDER,
} from "./config";
import type { Ineligible } from "./eligibility";
import type { GenerateCall, GenerateResult } from "./pipeline";
import { runGenerationPipeline, selectCandidates } from "./pipeline";
import { DRAFT_SCHEMA } from "./prompts";

/** The billing row the pipeline needs; shaped by the query, not by us. */
export type GeneratorBillingInfo = NonNullable<
  Awaited<ReturnType<typeof getOrganizationBillingInfo>>
>;

export interface GeneratorContext {
  env: Bindings;
  organizationId: string;
  userId: string;
  apiHost?: string;
}

/**
 * Preconditions that must hold before any model call is made.
 *
 * Returned rather than thrown or emitted: the DO turns these into error frames,
 * the route into status codes, and MCP into tool errors, and a discriminated
 * union lets all three map the same codes onto their own shapes. It also makes
 * them assertable without a Durable Object.
 */
export type GeneratorPrecondition =
  | {
      ok: true;
      plan: "pro" | "trial";
      billingInfo: GeneratorBillingInfo;
      connectedProviders: ReadonlySet<string>;
    }
  | {
      ok: false;
      code: "CREDITS_EXHAUSTED" | "MISCONFIGURED" | "ORG_NOT_FOUND";
      message: string;
    };

export interface GenerateWorkflowResult {
  outcome: "ok" | "partial" | "failed";
  workflowId: string | null;
  executionId: string | null;
  workflow: Workflow | null;
  /** Repair rounds the pipeline needed; 0 when the first draft validated. */
  repairAttempts: number;
  /** Findings from the final validation round, fatal or otherwise. */
  issues: GenerationValidationIssue[];
  /** Node types left out of the catalog, and why. */
  withheld: Ineligible[];
  usage: { inputTokens: number; outputTokens: number; credits: number };
  /** Every frame the pipeline emitted, in order. */
  frames: GeneratorServerMessage[];
}

export interface GenerateWorkflowOptions {
  /** Runs the saved workflow once. Callers that relay untrusted text pass false. */
  execute?: boolean;
  /** Live progress. HTTP ignores it; MCP maps it to progress notifications. */
  onFrame?: (frame: GeneratorServerMessage) => void;
  signal?: AbortSignal;
}

export async function checkGeneratorPreconditions(
  ctx: GeneratorContext
): Promise<GeneratorPrecondition> {
  const db = createDatabase(ctx.env.DB);

  // Independent reads on the same key; from inside a DO each is a
  // cross-service hop, so overlapping them saves a round trip.
  const [billingInfo, integrations] = await Promise.all([
    getOrganizationBillingInfo(db, ctx.organizationId),
    getIntegrations(db, ctx.organizationId),
  ]);

  if (!billingInfo) {
    return {
      ok: false,
      code: "ORG_NOT_FOUND",
      message: "Organization not found.",
    };
  }

  if (isCreditExhausted(billingInfo, ctx.env.CLOUDFLARE_ENV)) {
    return {
      ok: false,
      code: "CREDITS_EXHAUSTED",
      message: "Not enough compute credits to generate a workflow.",
    };
  }

  // The AI Gateway helpers silently degrade to an unusable client when any of
  // these is missing, producing a confusing 404 deep in the SDK.
  if (
    !ctx.env.CLOUDFLARE_ACCOUNT_ID ||
    !ctx.env.CLOUDFLARE_AI_GATEWAY_ID ||
    !ctx.env.CLOUDFLARE_API_TOKEN
  ) {
    return {
      ok: false,
      code: "MISCONFIGURED",
      message:
        "Workflow generation is not configured on this deployment (missing AI Gateway settings).",
    };
  }

  const connectedProviders = new Set(
    integrations.map((integration) => integration.provider)
  );

  // Resolved the same way the runtime's subscription gate resolves it, env
  // included, so the catalog offered never contains a node the executor
  // would then refuse. Note this returns "pro" outside production, so tests
  // must pin the plan rather than derive it.
  const plan =
    resolveOrganizationPlan(billingInfo, ctx.env.CLOUDFLARE_ENV) === "pro"
      ? "pro"
      : "trial";

  return {
    ok: true,
    plan,
    billingInfo,
    connectedProviders,
  };
}

export async function callModel(
  env: Bindings,
  call: GenerateCall
): Promise<GenerateResult> {
  const response = await callAgentLLM(env, {
    provider: GENERATOR_PROVIDER,
    model: GENERATOR_MODEL,
    instructions: call.system,
    messages: call.messages,
    tools: [],
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
  });

  return {
    content: response.content ?? "",
    inputTokens: response.inputTokens ?? 0,
    outputTokens: response.outputTokens ?? 0,
  };
}

export async function saveWorkflow(
  ctx: GeneratorContext,
  workflow: Workflow
): Promise<string> {
  const workflowId = crypto.randomUUID();
  const store = new WorkflowStore(ctx.env);

  await store.save({
    id: workflowId,
    name: workflow.name || "Generated Workflow",
    description: workflow.description,
    trigger: workflow.trigger,
    runtime: "workflow",
    organizationId: ctx.organizationId,
    nodes: workflow.nodes,
    edges: workflow.edges,
    apiHost: ctx.apiHost,
  });

  const db = createDatabase(ctx.env.DB);
  try {
    await stampOnboardingStage(db, ctx.userId, "workflowCreated");
  } catch (error) {
    console.error("Failed to stamp workflowCreated:", error);
  }

  return workflowId;
}

/**
 * Runs the generated workflow once, synchronously.
 *
 * `runtime: "worker"` is deliberate and differs from what was saved: it
 * returns the finished execution inline (no polling, no second socket) and
 * stamps `workflowExecutedOk` itself. The cost is a 30s ceiling, which the
 * caller surfaces as a partial result rather than a failure.
 */
export async function runOnce(
  ctx: GeneratorContext,
  billingInfo: GeneratorBillingInfo,
  workflow: Workflow,
  workflowId: string,
  parameters: WorkflowExecutorParameters
): Promise<WorkflowExecution> {
  const { execution } = await WorkflowExecutor.execute({
    workflow: {
      id: workflowId,
      name: workflow.name,
      trigger: workflow.trigger,
      runtime: "worker",
      nodes: workflow.nodes,
      edges: workflow.edges,
    },
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    ...resolveOrganizationBillingOptions(billingInfo, ctx.env.CLOUDFLARE_ENV),
    parameters,
    env: ctx.env,
  });

  return execution;
}

/** Node types offered to the model, for callers that want the catalog. */
export function listNodeTypes(env: Bindings): NodeType[] {
  return new CloudflareNodeRegistry(env, false).getNodeTypes();
}

/** An execution the caller opted out of, kept honest by a null executionId. */
function skippedExecution(workflowId: string): WorkflowExecution {
  return {
    id: "",
    workflowId,
    status: "completed",
    nodeExecutions: [],
  };
}

/**
 * Assembles `PipelineDependencies` and runs, collecting frames instead of
 * streaming them.
 *
 * `withheld` is recomputed here via `selectCandidates` rather than read back
 * out of the emitted log. `selectCandidates` is pure and involves no model
 * call, so a second call yields exactly what the pipeline used, and parsing it
 * out of human-readable warning text would break the first time that text is
 * reworded.
 */
export async function generateWorkflow(
  ctx: GeneratorContext,
  prompt: string,
  opts: GenerateWorkflowOptions = {}
): Promise<GenerateWorkflowResult> {
  const execute = opts.execute ?? false;
  const frames: GeneratorServerMessage[] = [];
  const emit = (frame: GeneratorServerMessage) => {
    frames.push(frame);
    opts.onFrame?.(frame);
  };

  const precondition = await checkGeneratorPreconditions(ctx);
  if (!precondition.ok) {
    // ORG_NOT_FOUND is not a wire-level code; the DO has always surfaced it
    // as INTERNAL, and this keeps route and MCP on the same shape.
    const code: GenerationErrorCode =
      precondition.code === "ORG_NOT_FOUND" ? "INTERNAL" : precondition.code;
    const frame: GeneratorServerMessage = {
      type: "error",
      code,
      message: precondition.message,
      recoverable: false,
    };
    emit(frame);
    return {
      outcome: "failed",
      workflowId: null,
      executionId: null,
      workflow: null,
      repairAttempts: 0,
      issues: [],
      withheld: [],
      usage: { inputTokens: 0, outputTokens: 0, credits: 0 },
      frames,
    };
  }

  const nodeTypes = listNodeTypes(ctx.env);
  const { withheld } = selectCandidates(
    prompt,
    nodeTypes,
    precondition.plan,
    precondition.connectedProviders
  );

  const result = await runGenerationPipeline({
    prompt,
    nodeTypes,
    plan: precondition.plan,
    connectedProviders: precondition.connectedProviders,
    apiHost: ctx.apiHost,
    isCancelled: opts.signal ? () => opts.signal?.aborted ?? false : undefined,
    emit,
    callLLM: (call) => callModel(ctx.env, call),
    save: (workflow) => saveWorkflow(ctx, workflow),
    run: execute
      ? (workflow, workflowId, parameters) =>
          runOnce(
            ctx,
            precondition.billingInfo,
            workflow,
            workflowId,
            parameters
          )
      : (_workflow, workflowId) =>
          Promise.resolve(skippedExecution(workflowId)),
  });

  // `issues` and `repairAttempts` come from the final validation round; a run
  // that crashed before validating (e.g. a malformed draft) has neither.
  const validations = frames.filter((f) => f.type === "validation");
  const finalValidation = validations[validations.length - 1];

  return {
    outcome: result.outcome,
    workflowId: result.workflowId ?? null,
    executionId: execute ? (result.executionId ?? null) : null,
    workflow: result.workflow ?? null,
    repairAttempts: finalValidation ? finalValidation.attempt : 0,
    issues: finalValidation ? finalValidation.issues : [],
    withheld,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      credits: calculateTokenUsage(
        result.inputTokens,
        result.outputTokens,
        GENERATOR_PRICING
      ),
    },
    frames,
  };
}
