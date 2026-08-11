import { env } from "cloudflare:test";
import { validateWorkflow } from "@dafthunk/runtime";
import type { NodeType, Workflow } from "@dafthunk/types";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../../context";
import { callAgentLLM } from "../../durable-objects/agent-llm";
import { CloudflareNodeRegistry } from "../../runtime/cloudflare-node-registry";
import { findStructuralProblems } from "../../templates/template-test-utils";
import type { BenchmarkCase } from "./benchmark-cases";
import { BENCHMARK_CASES } from "./benchmark-cases";
import { GENERATOR_MODEL, GENERATOR_PROVIDER } from "./config";
import type { GenerateCall } from "./pipeline";
import { runGenerationPipeline } from "./pipeline";
import { DRAFT_SCHEMA } from "./prompts";

/**
 * Quality gauge for the generator, measured against the 23 shipped templates.
 *
 * This makes real, billed model calls, which is why it lives in the integration
 * tier and is not run by CI. It reports a pass rate rather than asserting
 * 23/23 — the number is the thing to optimize, and it is also how the choice of
 * model gets settled: run it on two tiers and compare rate against cost.
 *
 *   pnpm --filter '@dafthunk/api' benchmark:generate
 */

interface CaseResult {
  templateId: string;
  validFirstTry: boolean;
  validAfterRepair: boolean;
  triggerCorrect: boolean;
  repairs: number;
  error?: string;
}

const bindings = env as unknown as Bindings;

/**
 * Benchmark-only knobs, read straight off the test env rather than added to
 * `Bindings`: they configure the measurement, not the application.
 */
interface BenchmarkEnv {
  BENCHMARK_LLM?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
}

const benchmarkEnv = env as unknown as BenchmarkEnv;

interface BenchmarkModel {
  /** Printed with the results — the run is meaningless without knowing this. */
  label: string;
  call: (call: GenerateCall) => Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/**
 * Chooses what the benchmark actually calls.
 *
 * Defaults to the production path: Anthropic through the AI Gateway, which
 * needs a Cloudflare account, gateway and token. `BENCHMARK_LLM=openrouter`
 * goes straight to OpenRouter instead, needing only `OPENROUTER_API_KEY` — far
 * cheaper, and enough for a before/after refactor comparison where only the
 * delta matters.
 *
 * The choice is asserted, never inferred. Asking for OpenRouter without a key
 * throws rather than quietly falling back to the billed production path: a
 * config value that silently falls back is worse than one that errors, because
 * the run still produces a number and you have no idea what it measured.
 */
function resolveBenchmarkModel(): BenchmarkModel {
  const choice = (benchmarkEnv.BENCHMARK_LLM ?? "gateway").trim().toLowerCase();

  if (choice === "gateway") {
    return {
      label: `${GENERATOR_PROVIDER}/${GENERATOR_MODEL} via AI Gateway`,
      call: async (call) => {
        const response = await callAgentLLM(bindings, {
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
      },
    };
  }

  if (choice === "openrouter") {
    const apiKey = benchmarkEnv.OPENROUTER_API_KEY;
    const model = benchmarkEnv.OPENROUTER_MODEL;
    if (!apiKey) {
      throw new Error(
        "BENCHMARK_LLM=openrouter but OPENROUTER_API_KEY is unset. Put it in apps/api/.dev.vars."
      );
    }
    if (!model) {
      throw new Error(
        "BENCHMARK_LLM=openrouter but OPENROUTER_MODEL is unset. Set it to an OpenRouter model id, e.g. anthropic/claude-opus-5."
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 120_000,
    });

    return {
      label: `openrouter/${model}`,
      call: async (call) => {
        // Mirrors the Anthropic path in agent-llm.ts exactly: the schema is
        // appended to the system prompt rather than constraining decoding.
        // Constraining it here would make the generator look better than it is
        // in production, where `parseDraft` has to cope with stray prose.
        const response = await client.chat.completions.create({
          model,
          max_tokens: 4096,
          messages: [
            {
              role: "system",
              content: `${call.system}\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(DRAFT_SCHEMA)}`,
            },
            ...call.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          ],
        });

        return {
          content: response.choices[0]?.message?.content ?? "",
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        };
      },
    };
  }

  throw new Error(
    `Unknown BENCHMARK_LLM="${choice}". Use "gateway" (default) or "openrouter".`
  );
}

let cachedModel: BenchmarkModel | undefined;

/**
 * Resolved on first use, not at import: a top-level throw kills the workers
 * pool outright ("Worker exited unexpectedly") and the reason never reaches
 * you. Deferring it turns a misconfiguration into a readable test failure.
 */
function benchmarkModel(): BenchmarkModel {
  cachedModel ??= resolveBenchmarkModel();
  return cachedModel;
}

// Built once: the registry runs ~476 registrations, and rebuilding it per case
// measures nothing.
const CATALOG: NodeType[] = new CloudflareNodeRegistry(
  bindings,
  false
).getNodeTypes();

async function runCase(
  testCase: BenchmarkCase,
  catalog: NodeType[]
): Promise<CaseResult> {
  let attempts = 0;
  let firstAttemptClean: boolean | null = null;
  let finalWorkflow: Workflow | undefined;

  // Resolved out here, not inside callLLM: the pipeline catches everything its
  // dependencies throw and reports it as a failed generation, so a config error
  // raised in there surfaces as "no graph produced" and the real reason is lost.
  const model = benchmarkModel();

  const result = await runGenerationPipeline({
    prompt: testCase.prompt,
    nodeTypes: catalog,
    // Pinned rather than derived: resolveOrganizationPlan returns "pro"
    // outside production, so deriving it would silently benchmark a catalog
    // that trial users never see.
    plan: "pro",
    connectedProviders: new Set([
      "slack",
      "discord",
      "telegram",
      "whatsapp",
      "google-mail",
      "github",
    ]),
    callLLM: async (call: GenerateCall) => {
      attempts++;
      return model.call(call);
    },
    emit: (frame) => {
      if (frame.type === "validation" && frame.attempt === 0) {
        firstAttemptClean = frame.issues.every((i) => i.severity !== "fatal");
      }
      if (frame.type === "graph") finalWorkflow = frame.workflow;
    },
    // Saving and running are out of scope here: this measures whether a valid
    // graph comes out, not whether Workers AI is up.
    save: async () => "benchmark-workflow",
    run: async () =>
      ({
        id: "benchmark-execution",
        workflowId: "benchmark-workflow",
        status: "completed",
        nodeExecutions: [],
      }) as never,
  });

  const validAfterRepair = result.outcome !== "failed";
  const structural = finalWorkflow
    ? findStructuralProblems(finalWorkflow.nodes, finalWorkflow.edges)
    : ["no graph produced"];
  const validationErrors = finalWorkflow
    ? validateWorkflow(finalWorkflow, catalog)
    : [];

  return {
    templateId: testCase.templateId,
    validFirstTry: firstAttemptClean === true,
    validAfterRepair:
      validAfterRepair &&
      structural.length === 0 &&
      validationErrors.length === 0,
    triggerCorrect: finalWorkflow?.trigger === testCase.expectTrigger,
    repairs: Math.max(0, attempts - 1),
    error: structural[0] ?? validationErrors[0]?.message,
  };
}

describe("workflow generator benchmark", () => {
  const results: CaseResult[] = [];

  for (const testCase of BENCHMARK_CASES) {
    it(`generates a valid workflow for "${testCase.templateId}"`, async () => {
      const result = await runCase(testCase, CATALOG);
      results.push(result);

      // Per-case assertions stop regressions; the aggregate below is the
      // number worth watching.
      expect(
        result.validAfterRepair,
        `${testCase.templateId}: ${result.error ?? "unknown failure"}`
      ).toBe(true);
      expect(
        result.triggerCorrect,
        `${testCase.templateId}: expected trigger ${testCase.expectTrigger}`
      ).toBe(true);
    }, 180_000);
  }

  it("reports the aggregate pass rate", () => {
    const total = results.length;
    if (total === 0) return;

    const firstTry = results.filter((r) => r.validFirstTry).length;
    const afterRepair = results.filter((r) => r.validAfterRepair).length;
    const triggers = results.filter((r) => r.triggerCorrect).length;
    const meanRepairs = results.reduce((sum, r) => sum + r.repairs, 0) / total;

    // The label, not GENERATOR_MODEL: with BENCHMARK_LLM=openrouter those are
    // different, and a result line naming the wrong model is how you end up
    // comparing two runs that never measured the same thing.
    console.log(
      `\n[benchmark] model=${benchmarkModel().label}\n` +
        `  ${firstTry}/${total} valid on first attempt\n` +
        `  ${afterRepair}/${total} valid after repair\n` +
        `  ${triggers}/${total} correct trigger\n` +
        `  ${meanRepairs.toFixed(2)} mean repairs\n`
    );

    for (const result of results.filter((r) => !r.validAfterRepair)) {
      console.log(`  FAILED ${result.templateId}: ${result.error}`);
    }
  });
});
