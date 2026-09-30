import { COMPOSIO_TRIGGER_NODE_TYPE } from "@dafthunk/types";
import {
  ALL_TRIGGER_NODE_TYPE_IDS,
  getTriggerNodeTypes,
} from "@dafthunk/utils";
import { describe, expect, it } from "vitest";

/**
 * Composio triggers are the one trigger kind the editor must not auto-add.
 *
 * All 362 synthesised palette entries share the single runtime type
 * `receive-composio-event`, and the editor resolves an auto-added node by that
 * type — which finds the unpinned generic node, since it sorts first in
 * `/types`. Saving that node writes no `composio_triggers` row (no slug to
 * subscribe with), so the workflow looks configured and silently never fires.
 *
 * These two properties have to hold together: nothing is auto-added, and a node
 * dropped from the palette is still recognised as the workflow's trigger. Lose
 * the second and the editor stops treating it as a trigger at all.
 *
 * Tested here rather than in @dafthunk/utils because that package has no test
 * runner, and this app is the consumer whose behaviour depends on it.
 */
describe("composio_event trigger authoring", () => {
  it("auto-adds no node, because no generic Composio trigger can be valid", () => {
    expect(getTriggerNodeTypes("composio_event")).toEqual([]);
  });

  it("still recognises a palette-dropped Composio trigger as a trigger node", () => {
    expect(ALL_TRIGGER_NODE_TYPE_IDS.has(COMPOSIO_TRIGGER_NODE_TYPE)).toBe(
      true
    );
  });

  it("leaves the other triggers auto-adding as before", () => {
    // The change must not turn any other trigger into a manual-style blank.
    expect(getTriggerNodeTypes("slack_event")).toEqual([
      "receive-slack-message",
    ]);
    expect(getTriggerNodeTypes("http_request")).toEqual([
      "http-request",
      "http-response",
    ]);
    expect(getTriggerNodeTypes("manual")).toEqual([]);
  });

  it("keeps every auto-added node type in the trigger id set", () => {
    for (const trigger of [
      "scheduled",
      "http_webhook",
      "email_message",
      "queue_message",
      "discord_event",
    ] as const) {
      for (const id of getTriggerNodeTypes(trigger)) {
        expect(ALL_TRIGGER_NODE_TYPE_IDS.has(id)).toBe(true);
      }
    }
  });
});
