import { TRIGGER_TO_NODE_TYPES } from "@dafthunk/utils";
import { describe, expect, it } from "vitest";

import { workflowTriggers } from "./create-workflow-dialog";

/**
 * The create dialog lists trigger types as untyped array literals, so adding a
 * member to `WorkflowTrigger` does not break this file — the trigger simply
 * never appears and the feature looks unbuilt. That is how Composio shipped
 * end-to-end, deployed and working, while being unreachable from the UI.
 *
 * `TRIGGER_TO_NODE_TYPES` is a `Record<WorkflowTrigger, string[]>`, so its keys
 * are the compiler-checked list of every trigger. Holding the dialog to it
 * turns the next omission into a failing test instead of a missing menu entry.
 */
describe("create workflow dialog trigger options", () => {
  const offered = workflowTriggers.map((t) => t.trigger);
  const allTriggers = Object.keys(TRIGGER_TO_NODE_TYPES);

  it("offers every trigger type the system supports", () => {
    expect([...offered].sort()).toEqual([...allTriggers].sort());
  });

  it("offers Composio explicitly", () => {
    expect(offered).toContain("composio_event");
  });

  it("lists each trigger once, with a title and description", () => {
    expect(new Set(offered).size).toBe(offered.length);
    for (const option of workflowTriggers) {
      expect(option.title.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});
