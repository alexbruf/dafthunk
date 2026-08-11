import type {
  GeneratorServerMessage,
  Workflow,
  WorkflowExecution,
} from "@dafthunk/types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateWorkflow } from "../agents/workflow-generator/generator-service";
import type { Bindings } from "../context";
import {
  buildMcpServer,
  frameProgressMessage,
  type McpBackends,
  type McpServerContext,
} from "./mcp-server";

// The generator service is a separate agent's work-in-progress (declare-only
// signatures). The MCP layer talks to its contract; unit tests stub it.
vi.mock("../agents/workflow-generator/generator-service", () => ({
  generateWorkflow: vi.fn(),
}));

function execution(status: WorkflowExecution["status"]): WorkflowExecution {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    status,
    nodeExecutions: [],
  } as WorkflowExecution;
}

const MINIMAL_WORKFLOW = {
  id: "wf-1",
  name: "Echo",
  description: "",
  trigger: "manual",
  nodes: [],
  edges: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as Workflow;

const CTX: McpServerContext = {
  env: {} as Bindings,
  organizationId: "org-1",
  userId: "user-1",
};

const BACKENDS: McpBackends = {
  listNodeTypes: () => [],
  runWorkflow: async () => execution("completed"),
  getExecution: async () => execution("completed"),
};

/** Parse an SSE payload into the JSON-RPC messages it carries, in order. */
function parseSse(text: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data: ")) {
        messages.push(JSON.parse(line.slice(6)));
      }
    }
  }
  return messages;
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/**
 * Drive a single JSON-RPC message through a freshly-built server + transport
 * and return every message (notifications and responses) the SSE stream emits.
 */
async function rpc(
  message: Record<string, unknown>,
  backends: Partial<McpBackends> = {}
): Promise<Record<string, unknown>[]> {
  const server = buildMcpServer(CTX, {
    backends: { ...BACKENDS, ...backends },
  });
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  const response = await transport.handleRequest(
    new Request("http://mcp.local/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(message),
    })
  );
  const messages = parseSse(await response.text());
  await transport.close();
  return messages;
}

async function toolResult(
  id: number,
  name: string,
  args: Record<string, unknown> = {},
  meta: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const messages = await rpc({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(Object.keys(meta).length ? { _meta: meta } : {}),
    },
  });
  return messages.find((m) => m.id === id) ?? {};
}

describe("frameProgressMessage", () => {
  it("describes each frame kind", () => {
    const phase: GeneratorServerMessage = {
      type: "phase",
      phase: "generating",
      label: "Writing the graph",
    };
    expect(frameProgressMessage(phase)).toContain("generating");
  });
});

describe("buildMcpServer", () => {
  beforeEach(() => {
    vi.mocked(generateWorkflow).mockReset();
  });

  it("advertises all four tools with valid input schemas", async () => {
    const messages = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const response = messages.find((m) => m.id === 1);
    expect(response?.error).toBeUndefined();

    const tools = (response?.result as { tools: Record<string, unknown>[] })
      .tools;
    const names = tools.map((t) => t.name as string);
    expect(names).toEqual(
      expect.arrayContaining([
        "generate_workflow",
        "list_node_types",
        "run_workflow",
        "get_execution",
      ])
    );

    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string };
      expect(schema?.type).toBe("object");
    }

    const generate = tools.find((t) => t.name === "generate_workflow");
    const properties = (
      generate?.inputSchema as { properties: Record<string, unknown> }
    ).properties;
    expect(properties.prompt).toBeDefined();
    expect(properties.execute).toBeDefined();
  });

  it("maps a generator service error to an MCP tool error, not an empty result", async () => {
    vi.mocked(generateWorkflow).mockRejectedValueOnce(
      new Error("gateway down")
    );

    const result = await toolResult(2, "generate_workflow", {
      prompt: "build an emailer",
    });

    expect(result.error).toBeUndefined();
    expect((result.result as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(result.result);
    expect(text).toContain("gateway down");
    expect(text).toContain("Workflow generation failed");
  });

  it("defaults execute to false and forwards frames as progress notifications in order", async () => {
    const ordered: GeneratorServerMessage[] = [
      { type: "phase", phase: "planning", label: "Planning" },
      {
        type: "graph",
        workflow: MINIMAL_WORKFLOW,
        attempt: 1,
      },
      { type: "phase", phase: "complete", label: "Complete" },
    ];

    vi.mocked(generateWorkflow).mockImplementationOnce(
      async (
        _ctx,
        _prompt,
        opts?: {
          execute?: boolean;
          onFrame?: (f: GeneratorServerMessage) => void;
        }
      ) => {
        // Assert the handler never turns execution on for this path.
        if (opts?.execute) throw new Error("execute must default to false");
        for (const frame of ordered) {
          opts?.onFrame?.(frame);
        }
        return {
          outcome: "ok",
          workflowId: "wf-1",
          executionId: null,
          workflow: null,
          repairAttempts: 1,
          issues: [],
          withheld: [],
          usage: { inputTokens: 10, outputTokens: 20, credits: 3 },
          frames: ordered,
        } as never;
      }
    );

    const messages = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_workflow",
        arguments: { prompt: "build an emailer" },
        _meta: { progressToken: "tok-7" },
      },
    });

    const progress = messages.filter(
      (m) => m.method === "notifications/progress"
    );
    expect(progress).toHaveLength(ordered.length);
    expect(
      progress.map((m) => (m.params as { progress: number }).progress)
    ).toEqual([1, 2, 3]);
    for (const notification of progress) {
      expect(
        (notification.params as { progressToken: string }).progressToken
      ).toBe("tok-7");
    }
    // Frame order is preserved: the first notification is the planning phase.
    expect((progress[0].params as { message: string }).message).toContain(
      "planning"
    );

    // The tool still resolves with the generated workflow.
    const response = messages.find((m) => m.id === 3);
    expect((response?.result as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.stringify(response?.result)).toContain("outcome");
  });

  it("reports an unknown tool name as an MCP error", async () => {
    const messages = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });
    const result = messages.find((m) => m.id === 4)?.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    // SDK 1.29.0 surfaces an unknown tool as a tool error result carrying the
    // JSON-RPC invalid-params code, rather than a top-level error object.
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain("-32602");
    expect(JSON.stringify(result?.content)).toContain("does_not_exist");
  });
});
