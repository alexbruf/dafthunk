import type { NodeExecution, NodeType } from "@dafthunk/types";
import {
  COMPOSIO_ACTION_NODE_TYPE,
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
} from "@dafthunk/types";
import { z } from "zod";

import { ExecutableNode, type NodeContext } from "../../node-types";
import { ComposioApiError, ComposioClient } from "../../utils/composio-client";
import { zodErrorMessage } from "../../utils/zod";

/** Composio error slugs worth translating into an instruction the author can follow. */
const CONNECTED_ACCOUNT_NOT_FOUND = "ActionExecute_ConnectedAccountNotFound";
const TOOL_NOT_FOUND = "Tool_ToolNotFound";

const INTEGRATION_ID_ERROR =
  "Integration ID is required. Please select a Composio connection.";
const TOOL_SLUG_ERROR =
  "Composio tool slug is required. Drop this action from the palette so its tool is pinned.";

/**
 * Inputs the node consumes itself. Everything else on the context is one of the
 * pinned tool's own parameters, because a synthesised palette entry replaces the
 * generic `arguments` port with the tool's typed inputs.
 */
const RESERVED_INPUTS = new Set<string>([
  "integrationId",
  COMPOSIO_TOOL_SLUG_INPUT,
  COMPOSIO_TOOL_VERSION_INPUT,
  "arguments",
]);

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
  private static readonly inputSchema = z.object({
    integrationId: z
      .string({ error: INTEGRATION_ID_ERROR })
      .min(1, { error: INTEGRATION_ID_ERROR }),
    [COMPOSIO_TOOL_SLUG_INPUT]: z
      .string({ error: TOOL_SLUG_ERROR })
      .trim()
      .min(1, { error: TOOL_SLUG_ERROR }),
    [COMPOSIO_TOOL_VERSION_INPUT]: z.string().optional(),
    arguments: z
      .record(z.string(), z.unknown(), {
        error: "Arguments must be an object of tool parameters",
      })
      .optional(),
  });

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

  public async execute(context: NodeContext): Promise<NodeExecution> {
    const parsed = ComposioActionNode.inputSchema.safeParse(context.inputs);
    if (!parsed.success) {
      return this.createErrorResult(zodErrorMessage(parsed.error));
    }

    const {
      integrationId,
      [COMPOSIO_TOOL_SLUG_INPUT]: toolSlug,
      [COMPOSIO_TOOL_VERSION_INPUT]: toolVersion,
      arguments: explicitArguments,
    } = parsed.data;

    const apiKey = context.env.COMPOSIO_API_KEY;
    if (!apiKey) {
      return this.createErrorResult(
        "COMPOSIO_API_KEY environment variable is not configured"
      );
    }

    try {
      const integration = await context.getIntegration(integrationId);

      // For Composio the integration's token is the connected account id, not a
      // bearer token: the project API key authenticates, the account identifies.
      const connectedAccountId = integration.token;

      const mismatch = ComposioActionNode.toolkitMismatch(
        integration.metadata?.toolkit,
        toolSlug
      );
      if (mismatch) {
        return this.createErrorResult(mismatch);
      }

      const result = await new ComposioClient({ apiKey }).executeTool(
        toolSlug,
        {
          connectedAccountId,
          userId: context.organizationId,
          arguments: ComposioActionNode.collectArguments(
            context.inputs,
            explicitArguments
          ),
          version: toolVersion,
        }
      );

      // A refused call is a 200 with `successful: false`, so this is a normal
      // outcome to report rather than an exception to raise.
      if (!result.successful) {
        return this.createErrorResult(
          `Composio could not complete ${toolSlug}: ${
            result.error ?? "the tool reported a failure without a message"
          }`
        );
      }

      return this.createSuccessResult({
        data: result.data ?? null,
        successful: result.successful,
        logId: result.logId,
      });
    } catch (error) {
      if (error instanceof ComposioApiError) {
        return this.createErrorResult(
          ComposioActionNode.describeApiError(error, toolSlug)
        );
      }
      // Naming the slug is the point: the runtime would otherwise show a bare
      // "fetch failed" with no clue which step of the workflow broke.
      return this.createErrorResult(
        `Failed to run Composio tool ${toolSlug}: ${
          error instanceof Error ? error.message : "unknown error"
        }`
      );
    }
  }

  /**
   * Composio names every tool `<TOOLKIT>_<ACTION>`, so a connection's toolkit
   * must prefix the slug. Punctuation is stripped from both sides because a
   * toolkit slug is not guaranteed to be spelled the same way as the prefix
   * ("google-calendar" vs `GOOGLECALENDAR_…`). The comparison is deliberately a
   * prefix rather than an identity: it exists to catch a plainly wrong pairing
   * (a Gmail connection running a Slack tool), and a false accept simply falls
   * through to Composio's own rejection, while a false reject would block a
   * workflow that actually works.
   */
  private static toolkitMismatch(
    toolkit: unknown,
    toolSlug: string
  ): string | null {
    if (typeof toolkit !== "string" || toolkit.length === 0) return null;

    const normalize = (value: string) =>
      value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalize(toolSlug).startsWith(normalize(toolkit))) return null;

    return `This connection belongs to the ${toolkit} toolkit and cannot run ${toolSlug}. Select a connection for the toolkit this action belongs to.`;
  }

  private static collectArguments(
    inputs: Record<string, unknown>,
    explicitArguments?: Record<string, unknown>
  ): Record<string, unknown> {
    // The generic port comes first so a typed input from a synthesised entry
    // wins: it is the more specific statement of what the tool should receive.
    const args: Record<string, unknown> = { ...explicitArguments };
    for (const [key, value] of Object.entries(inputs)) {
      if (RESERVED_INPUTS.has(key)) continue;
      // An optional port that was never wired arrives as undefined; forwarding
      // it would make Composio validate a field the author never touched.
      if (value === undefined) continue;
      args[key] = value;
    }
    return args;
  }

  private static describeApiError(
    error: ComposioApiError,
    toolSlug: string
  ): string {
    if (error.slug === CONNECTED_ACCOUNT_NOT_FOUND) {
      return "This Composio connection is no longer available upstream. Reconnect it from Integrations, then run the workflow again.";
    }
    if (error.slug === TOOL_NOT_FOUND) {
      return `Composio no longer offers the tool ${toolSlug}; it was renamed or removed upstream. Drop a fresh copy of this action from the palette.`;
    }
    const fix = error.suggestedFix ? ` ${error.suggestedFix}` : "";
    return `Composio failed to run ${toolSlug} (HTTP ${error.status}): ${error.message}${fix}`;
  }
}
