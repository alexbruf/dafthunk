/**
 * MCP server (Streamable HTTP) exposing the same capabilities an interactive
 * user has: generate a workflow, list the node catalog, run a workflow, and
 * fetch an execution.
 *
 * `generate_workflow` is the only tool that talks to the generator service
 * (`generateWorkflow`), called directly — never by posting back into our own
 * Worker. The other three are thin shells over backends supplied by the route
 * layer (mcp.ts), which are the real `CloudflareNodeRegistry` / `WorkflowStore`
 * / `CloudflareExecutionStore` paths already used by the HTTP routes. Injecting
 * them here (rather than importing the heavy registries at module top) keeps
 * this module — and its unit tests — free of the wasm-backed node catalog and
 * D1/R2 stores that must not load in the test entry point.
 *
 * Every tool is scoped by the `organizationId` carried in `McpServerContext`,
 * which the route layer populates from the authenticated request. The model can
 * never pass its own — nothing here reads a tenant id from a tool argument.
 */

import type {
  GeneratorServerMessage,
  NodeType,
  WorkflowExecution,
} from "@dafthunk/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { generateWorkflow } from "../agents/workflow-generator/generator-service";
import type { Bindings } from "../context";

export interface McpServerContext {
  env: Bindings;
  organizationId: string;
  userId: string;
}

/**
 * Backends for the three tools that don't route through the generator service.
 * The route layer wires these to the production stores; tests stub them.
 */
export interface McpBackends {
  listNodeTypes: (ctx: McpServerContext) => NodeType[];
  runWorkflow: (
    ctx: McpServerContext,
    workflowId: string,
    parameters: Record<string, unknown>
  ) => Promise<WorkflowExecution>;
  getExecution: (
    ctx: McpServerContext,
    executionId: string
  ) => Promise<WorkflowExecution | null>;
}

export interface BuildMcpServerOptions {
  backends?: Partial<McpBackends>;
}

/** Thin shells that no-op until the route layer supplies real backends. */
const NOOP_BACKENDS: McpBackends = {
  listNodeTypes: () => [],
  runWorkflow: async () => {
    throw new Error("run_workflow backend is not configured");
  },
  getExecution: async () => null,
};

/**
 * A short human-readable description of a generator frame, used as the progress
 * notification message so the caller can see which phase a graph stage is in.
 */
export function frameProgressMessage(frame: GeneratorServerMessage): string {
  switch (frame.type) {
    case "phase":
      return `phase: ${frame.phase} — ${frame.label}`;
    case "plan":
      return `plan: ${frame.plan.title}`;
    case "graph":
      return `graph (attempt ${frame.attempt}): ${frame.workflow.nodes.length} nodes`;
    case "validation":
      return `validation (attempt ${frame.attempt}): ${frame.issues.length} findings`;
    case "saved":
      return `saved: ${frame.name}`;
    case "run_result":
      return `run result`;
    case "done":
      return `done`;
    case "error":
      return `error: ${frame.message}`;
    case "session":
      return `session`;
    case "log":
      return frame.message;
  }
}

/**
 * Registers the four Dafthunk MCP tools on a fresh `McpServer`.
 *
 * `generate_workflow` forwards each pipeline frame to an MCP `notifications/progress`
 * notification (when the client supplied a progress token) so an interactive
 * agent sees phases and intermediate graphs as they are produced.
 */
export function buildMcpServer(
  ctx: McpServerContext,
  options: BuildMcpServerOptions = {}
): McpServer {
  const backends: McpBackends = { ...NOOP_BACKENDS, ...options.backends };

  const server = new McpServer(
    { name: "dafthunk", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "list_node_types",
    {
      description:
        "List every node type the workflow generator can emit, with their inputs and outputs.",
      inputSchema: {},
    },
    () => ({
      content: [
        { type: "text", text: JSON.stringify(backends.listNodeTypes(ctx)) },
      ],
    })
  );

  server.registerTool(
    "generate_workflow",
    {
      description:
        "Generate a workflow graph from a natural-language prompt. Returns the saved workflow and its validation outcome. Execution is not offered on this path — run the generated workflow afterwards with run_workflow.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe("The workflow you want built, in plain language."),
        execute: z
          .boolean()
          .optional()
          .describe(
            "Accepted for shape compatibility; always treated as false on this path."
          ),
      },
    },
    async ({ prompt }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let frameCount = 0;

      const onFrame = (frame: GeneratorServerMessage): void => {
        if (progressToken === undefined) return;
        // Called synchronously per frame, so enqueue order == frame order.
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: ++frameCount,
            message: frameProgressMessage(frame),
          },
        });
      };

      try {
        // Spec §6 boundary: on the Access/MCP path there is no path from text
        // to execution. `execute` is pinned false here regardless of what the
        // model asks — a human runs the finished workflow deliberately (via
        // `run_workflow`). The schema still advertises `execute` so the tool
        // shape matches the spec table; a future service-token binding would
        // be where a trusted caller lifts the pin.
        const result = await generateWorkflow(ctx, prompt, {
          execute: false,
          onFrame,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Workflow generation failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "Run an existing HTTP-triggered workflow by id, passing optional parameters (url, method, headers, query, body, email fields). Resolves with the resulting execution.",
      inputSchema: {
        workflow_id: z.string().describe("The id of the workflow to run."),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional parameters for the workflow run."),
      },
    },
    async ({ workflow_id, params }, extra) => {
      try {
        const execution = await backends.runWorkflow(
          ctx,
          workflow_id,
          params ?? {}
        );
        return { content: [{ type: "text", text: JSON.stringify(execution) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Workflow run failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_execution",
    {
      description:
        "Fetch a workflow execution by id, including node-by-node status and any error.",
      inputSchema: {
        execution_id: z.string().describe("The id of the execution to fetch."),
      },
    },
    async ({ execution_id }, extra) => {
      const execution = await backends.getExecution(ctx, execution_id);
      if (!execution) {
        return {
          content: [
            { type: "text", text: `Execution not found: ${execution_id}` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(execution) }] };
    }
  );

  return server;
}
