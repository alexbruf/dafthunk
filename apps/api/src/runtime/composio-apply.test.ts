import { describe, expect, it, vi } from "vitest";

import { applyComposioReconciliation } from "./composio-apply";
import type { ComposioReconcileAction } from "./composio-reconcile";

/**
 * Applying is separated from planning so the plan stays a pure value, but the
 * applier has one job the plan cannot express: writing the upstream id back.
 * If that write is skipped or misordered, the next pass sees a row with no
 * instance id, creates a second subscription, and the workflow starts running
 * twice per event.
 */

function fakeClient(
  over: Partial<{
    upsertTriggerInstance: ReturnType<typeof vi.fn>;
    deleteTriggerInstance: ReturnType<typeof vi.fn>;
    setTriggerInstanceStatus: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    upsertTriggerInstance: vi.fn(async () => "ti_created"),
    deleteTriggerInstance: vi.fn(async () => undefined),
    setTriggerInstanceStatus: vi.fn(async () => undefined),
    ...over,
  };
}

const create = (workflowId = "wf_1"): ComposioReconcileAction => ({
  kind: "create",
  workflowId,
  triggerSlug: "GITHUB_STAR_ADDED_EVENT",
  connectedAccountId: "ca_1",
  config: { owner: "acme", repo: "widgets" },
});

describe("applyComposioReconciliation", () => {
  it("creates upstream and writes the id back", async () => {
    const client = fakeClient();
    const setInstanceId = vi.fn(async () => undefined);

    const result = await applyComposioReconciliation(
      client as never,
      [create()],
      { setInstanceId }
    );

    expect(client.upsertTriggerInstance).toHaveBeenCalledWith(
      "GITHUB_STAR_ADDED_EVENT",
      {
        connectedAccountId: "ca_1",
        triggerConfig: { owner: "acme", repo: "widgets" },
      }
    );
    expect(setInstanceId).toHaveBeenCalledWith("wf_1", "ti_created");
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("does not write back when the upstream create failed", async () => {
    // Recording an id we never received would make the next pass believe a
    // subscription exists and stop trying to make one.
    const client = fakeClient({
      upsertTriggerInstance: vi.fn(async () => {
        throw new Error("upstream down");
      }),
    });
    const setInstanceId = vi.fn(async () => undefined);

    const result = await applyComposioReconciliation(
      client as never,
      [create()],
      { setInstanceId }
    );

    expect(setInstanceId).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("updates through the same upsert and refreshes the id", async () => {
    const client = fakeClient({
      upsertTriggerInstance: vi.fn(async () => "ti_same"),
    });
    const setInstanceId = vi.fn(async () => undefined);

    await applyComposioReconciliation(
      client as never,
      [
        {
          kind: "update",
          workflowId: "wf_1",
          instanceId: "ti_same",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: { owner: "acme", repo: "gadgets" },
        },
      ],
      { setInstanceId }
    );

    expect(client.upsertTriggerInstance).toHaveBeenCalledTimes(1);
    expect(setInstanceId).toHaveBeenCalledWith("wf_1", "ti_same");
  });

  it("clears the id when deleting a subscription a workflow still owns", async () => {
    const client = fakeClient();
    const setInstanceId = vi.fn(async () => undefined);

    const result = await applyComposioReconciliation(
      client as never,
      [{ kind: "delete", workflowId: "wf_1", instanceId: "ti_1" }],
      { setInstanceId }
    );

    expect(client.deleteTriggerInstance).toHaveBeenCalledWith("ti_1");
    // Leaving a stale id behind would make the next pass try to delete it again.
    expect(setInstanceId).toHaveBeenCalledWith("wf_1", null);
    expect(result.deleted).toBe(1);
  });

  it("deletes an orphan without touching the database", async () => {
    const client = fakeClient();
    const setInstanceId = vi.fn(async () => undefined);

    await applyComposioReconciliation(
      client as never,
      [{ kind: "delete", instanceId: "ti_orphan" }],
      { setInstanceId }
    );

    expect(client.deleteTriggerInstance).toHaveBeenCalledWith("ti_orphan");
    expect(setInstanceId).not.toHaveBeenCalled();
  });

  it("enables an instance disabled upstream", async () => {
    const client = fakeClient();
    const result = await applyComposioReconciliation(
      client as never,
      [{ kind: "enable", workflowId: "wf_1", instanceId: "ti_1" }],
      { setInstanceId: vi.fn(async () => undefined) }
    );

    expect(client.setTriggerInstanceStatus).toHaveBeenCalledWith(
      "ti_1",
      "enable"
    );
    expect(result.enabled).toBe(1);
  });

  it("isolates a failure so the rest of the plan still applies", async () => {
    // One organization's broken connection must not stop every other
    // organization's triggers from being reconciled.
    let call = 0;
    const client = fakeClient({
      upsertTriggerInstance: vi.fn(async () => {
        call += 1;
        if (call === 2) throw new Error("nope");
        return `ti_${call}`;
      }),
    });
    const setInstanceId = vi.fn(async () => undefined);

    const result = await applyComposioReconciliation(
      client as never,
      [create("wf_a"), create("wf_b"), create("wf_c")],
      { setInstanceId }
    );

    expect(client.upsertTriggerInstance).toHaveBeenCalledTimes(3);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(setInstanceId).toHaveBeenCalledWith("wf_a", "ti_1");
    expect(setInstanceId).toHaveBeenCalledWith("wf_c", "ti_3");
  });

  it("reports nothing to do for an empty plan without calling out", async () => {
    const client = fakeClient();
    const result = await applyComposioReconciliation(client as never, [], {
      setInstanceId: vi.fn(async () => undefined),
    });

    expect(client.upsertTriggerInstance).not.toHaveBeenCalled();
    expect(client.deleteTriggerInstance).not.toHaveBeenCalled();
    expect(result).toEqual({
      created: 0,
      updated: 0,
      deleted: 0,
      enabled: 0,
      failed: 0,
    });
  });
});
