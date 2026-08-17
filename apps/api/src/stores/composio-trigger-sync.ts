import type { Node } from "@dafthunk/types";
import {
  COMPOSIO_TRIGGER_NODE_TYPE,
  COMPOSIO_TRIGGER_SLUG_INPUT,
} from "@dafthunk/types";

/** What a saved graph says about the subscription it wants. */
export interface ComposioTriggerIntent {
  triggerSlug: string;
  /** Null while the author has not picked a connection yet. */
  integrationId: string | null;
  /** The trigger type's own config, e.g. `{ owner, repo }`. */
  config: Record<string, unknown>;
}

/** Inputs the node uses itself; everything else is trigger config. */
const RESERVED = new Set<string>([
  COMPOSIO_TRIGGER_SLUG_INPUT,
  "integrationId",
]);

/**
 * Reads the Composio trigger out of a saved graph.
 *
 * Kept pure and separate from the store so it can be tested — the test-pool D1
 * has no schema, so anything that wrote to the database inline would be
 * unassertable.
 */
export function extractComposioTrigger(
  nodes: Node[]
): ComposioTriggerIntent | null {
  // First only: the table is keyed by workflow id, so one workflow is one
  // subscription. Picking among several would be a guess.
  const node = nodes.find((n) => n.type === COMPOSIO_TRIGGER_NODE_TYPE);
  if (!node) return null;

  const inputs = node.inputs ?? [];
  const slug = inputs.find(
    (i) => i.name === COMPOSIO_TRIGGER_SLUG_INPUT
  )?.value;
  if (typeof slug !== "string" || slug.length === 0) {
    // Without a slug there is nothing to subscribe to, and a row would only
    // make the reconciler fail on every pass.
    return null;
  }

  const integration = inputs.find((i) => i.name === "integrationId")?.value;

  const config: Record<string, unknown> = {};
  for (const input of inputs) {
    if (RESERVED.has(input.name)) continue;
    // An input the author never filled in must not be sent: Composio would
    // validate a field nobody set.
    if (input.value === undefined || input.value === null) continue;
    config[input.name] = input.value;
  }

  return {
    triggerSlug: slug,
    integrationId:
      typeof integration === "string" && integration ? integration : null,
    config,
  };
}
