import type { NodeExecution, NodeType } from "@dafthunk/types";
import {
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
} from "@dafthunk/types";

import { ExecutableNode, type NodeContext } from "../../node-types";

/**
 * Starts a workflow from a Composio trigger delivery.
 *
 * As with actions, one implementation backs every synthesised trigger entry in
 * the palette; each entry pins its `triggerSlug` and exposes that trigger type's
 * own config as inputs and its payload as outputs.
 *
 * Unlike actions, the whole trigger catalog is synthesised rather than only the
 * connected toolkits — there are 362 trigger types in total, small enough that
 * users can discover and drop one before connecting anything.
 */
export class ReceiveComposioEventNode extends ExecutableNode {
  public static readonly nodeType: NodeType = {
    id: COMPOSIO_TRIGGER_NODE_TYPE,
    name: "Receive Composio Event",
    type: COMPOSIO_TRIGGER_NODE_TYPE,
    description: "Receive an event from a Composio trigger",
    tags: ["Composio", "Integration", "Trigger"],
    icon: "plug-zap",
    documentation:
      "Backs every Composio trigger in the palette. Drop a specific trigger rather than this node: each palette entry pins the trigger it subscribes to and exposes that trigger's own payload fields.",
    trigger: true,
    inlinable: true,
    usage: 0,
    subscription: true,
    asTool: false,
    inputs: [
      {
        name: "integrationId",
        type: "integration",
        provider: "composio",
        description: "Composio connection to subscribe with",
        hidden: true,
        required: true,
      },
      {
        name: COMPOSIO_TRIGGER_SLUG_INPUT,
        type: "string",
        description: "Composio trigger slug (e.g. GITHUB_STAR_ADDED)",
        hidden: true,
        required: true,
      },
    ],
    outputs: [
      {
        name: "payload",
        type: "json",
        description: "The upstream provider's event body",
      },
      {
        name: "triggerSlug",
        type: "string",
        description: "Trigger that fired",
        hidden: true,
      },
      {
        name: "toolkitSlug",
        type: "string",
        description: "Toolkit the event came from",
        hidden: true,
      },
      {
        name: "eventId",
        type: "string",
        description: "Composio event id, unique per delivery",
        hidden: true,
      },
    ],
  };

  public async execute(context: NodeContext): Promise<NodeExecution> {
    try {
      if (!context.composioEvent) {
        throw new Error(
          "Composio event information is required but not provided in the context."
        );
      }

      const { payload, triggerSlug, toolkitSlug, eventId } =
        context.composioEvent;

      return this.createSuccessResult({
        payload,
        triggerSlug,
        toolkitSlug,
        eventId,
      });
    } catch (error) {
      return this.createErrorResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
