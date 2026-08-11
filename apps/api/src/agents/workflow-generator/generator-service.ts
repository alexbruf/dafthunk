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
 * NOTE: the function signatures below are `declare`d — this file is currently
 * the agreed contract, not the implementation. It exists ahead of the bodies so
 * the route and MCP layers can be built and mocked against a fixed shape. The
 * `declare` keywords come off as each body lands; until then this module has no
 * runtime exports and may only be imported for its types or behind `vi.mock`.
 */

import type {
  GenerationValidationIssue,
  GeneratorServerMessage,
  NodeType,
  Workflow,
  WorkflowExecution,
} from "@dafthunk/types";

import type { Bindings } from "../../context";
import type { getOrganizationBillingInfo } from "../../db";
import type { WorkflowExecutorParameters } from "../../services/workflow-executor";
import type { Ineligible } from "./eligibility";
import type { GenerateCall, GenerateResult } from "./pipeline";

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

export declare function checkGeneratorPreconditions(
  ctx: GeneratorContext
): Promise<GeneratorPrecondition>;

export declare function callModel(
  env: Bindings,
  call: GenerateCall
): Promise<GenerateResult>;

export declare function saveWorkflow(
  ctx: GeneratorContext,
  workflow: Workflow
): Promise<string>;

export declare function runOnce(
  ctx: GeneratorContext,
  billingInfo: GeneratorBillingInfo,
  workflow: Workflow,
  workflowId: string,
  parameters: WorkflowExecutorParameters
): Promise<WorkflowExecution>;

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
export declare function generateWorkflow(
  ctx: GeneratorContext,
  prompt: string,
  opts?: GenerateWorkflowOptions
): Promise<GenerateWorkflowResult>;

/** Node types offered to the model, for callers that want the catalog. */
export declare function listNodeTypes(env: Bindings): NodeType[];
