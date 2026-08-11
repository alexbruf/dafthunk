import type { NodeExecution, NodeType } from "@dafthunk/types";
import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
} from "@dafthunk/types";

import { ExecutableNode, type NodeContext } from "../../node-types";

/**
 * Executes one Composio tool.
 *
 * There is a single implementation for all 45,000+ Composio tools: the palette
 * shows one synthesised entry per tool, each pinning `toolSlug` and
 * `toolVersion` as hidden inputs, and every one of them resolves to this class.
 * This mirrors how the Cloudflare model catalog backs hundreds of palette
 * entries with one `cloudflare-model` node.
 *
 * The version is pinned as well as the slug because Composio versions tools with
 * a date stamp and `execute` defaults to "00000000_00" rather than the latest —
 * without the pin, an upstream revision would change the schema of workflows
 * that are already saved.
 */
export class ComposioActionNode extends ExecutableNode {
  public static readonly nodeType: NodeType = {
    id: COMPOSIO_ACTION_NODE_TYPE,
    name: "Composio Action",
    type: COMPOSIO_ACTION_NODE_TYPE,
    description: "Run any Composio tool against a connected account",
    tags: ["Composio", "Integration"],
    icon: "plug",
    documentation:
      "Backs every Composio action in the palette. Drop a specific action rather than this node: each palette entry pins the tool it runs and exposes that tool's own inputs.",
    usage: 10,
    subscription: true,
    asTool: true,
    inlinable: false,
    inputs: [
      {
        name: "integrationId",
        type: "integration",
        provider: "composio",
        description: "Composio connection to run this action as",
        hidden: true,
        required: true,
      },
      {
        name: COMPOSIO_TOOL_SLUG_INPUT,
        type: "string",
        description: "Composio tool slug (e.g. GITHUB_CREATE_AN_ISSUE)",
        hidden: true,
        required: true,
      },
      {
        name: COMPOSIO_TOOL_VERSION_INPUT,
        type: "string",
        description: "Pinned Composio tool version",
        hidden: true,
        required: false,
      },
      {
        name: "arguments",
        type: "json",
        description:
          "Arguments for the tool. Synthesised palette entries replace this with the tool's own typed inputs.",
        required: false,
      },
    ],
    outputs: [
      {
        name: "data",
        type: "json",
        description: "Tool result payload",
      },
      {
        name: "successful",
        type: "boolean",
        description: "Whether Composio reported the call as successful",
        hidden: true,
      },
      {
        name: "logId",
        type: "string",
        description: "Composio execution log id, for support and debugging",
        hidden: true,
      },
    ],
  };

  public async execute(_context: NodeContext): Promise<NodeExecution> {
    // Implemented by the action-node work item. Registration is gated on
    // COMPOSIO_API_KEY, so this is unreachable in any configured environment.
    return this.createErrorResult(
      "Composio actions are not enabled in this environment"
    );
  }
}
