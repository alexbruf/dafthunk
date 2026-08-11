import { describe, expect, it } from "vitest";

import {
  type ComposioTriggerRow,
  planComposioReconciliation,
} from "./composio-reconcile";

/**
 * The reconciler is the piece that makes a saved trigger actually fire: nothing
 * else creates the upstream subscription. It is expressed as a pure diff so it
 * can be tested exhaustively — the test-pool D1 has no schema, so a reconciler
 * that talked to the database inline could not be asserted on at all.
 *
 * Idempotence is the property that matters most. A reconciler that re-creates
 * subscriptions every pass leaks trigger instances upstream, and Composio bills
 * and delivers on them long after the workflow is gone.
 */

const row = (over: Partial<ComposioTriggerRow> = {}): ComposioTriggerRow => ({
  workflowId: "wf_1",
  organizationId: "org_1",
  integrationId: "int_1",
  connectedAccountId: "ca_1",
  triggerSlug: "GITHUB_STAR_ADDED_EVENT",
  instanceId: null,
  config: { owner: "acme", repo: "widgets" },
  active: true,
  ...over,
});

describe("planComposioReconciliation", () => {
  it("creates a subscription for an active trigger that has none", () => {
    const plan = planComposioReconciliation([row()], []);

    expect(plan).toEqual([
      {
        kind: "create",
        workflowId: "wf_1",
        triggerSlug: "GITHUB_STAR_ADDED_EVENT",
        connectedAccountId: "ca_1",
        config: { owner: "acme", repo: "widgets" },
      },
    ]);
  });

  it("does nothing when an active trigger already matches upstream", () => {
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_1" })],
      [
        {
          id: "ti_1",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: { owner: "acme", repo: "widgets" },
          disabled: false,
        },
      ]
    );

    expect(plan).toEqual([]);
  });

  it("is idempotent: replanning against the result of a create yields nothing", () => {
    const before = planComposioReconciliation([row()], []);
    expect(before).toHaveLength(1);

    // What the applier would have written back after acting on that plan.
    const after = planComposioReconciliation(
      [row({ instanceId: "ti_new" })],
      [
        {
          id: "ti_new",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: { owner: "acme", repo: "widgets" },
          disabled: false,
        },
      ]
    );
    expect(after).toEqual([]);
  });

  it("updates when the trigger config has drifted", () => {
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_1", config: { owner: "acme", repo: "gadgets" } })],
      [
        {
          id: "ti_1",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: { owner: "acme", repo: "widgets" },
          disabled: false,
        },
      ]
    );

    expect(plan).toEqual([
      {
        kind: "update",
        workflowId: "wf_1",
        instanceId: "ti_1",
        triggerSlug: "GITHUB_STAR_ADDED_EVENT",
        connectedAccountId: "ca_1",
        config: { owner: "acme", repo: "gadgets" },
      },
    ]);
  });

  it("ignores key order when comparing config", () => {
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_1", config: { repo: "widgets", owner: "acme" } })],
      [
        {
          id: "ti_1",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: { owner: "acme", repo: "widgets" },
          disabled: false,
        },
      ]
    );

    // Serialising in insertion order would make every pass look like drift and
    // rewrite the subscription forever.
    expect(plan).toEqual([]);
  });

  it("deletes the subscription when the trigger is deactivated", () => {
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_1", active: false })],
      [
        {
          id: "ti_1",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: {},
          disabled: false,
        },
      ]
    );

    expect(plan).toEqual([
      { kind: "delete", workflowId: "wf_1", instanceId: "ti_1" },
    ]);
  });

  it("does not re-create a subscription for an inactive trigger", () => {
    expect(planComposioReconciliation([row({ active: false })], [])).toEqual(
      []
    );
  });

  it("deletes an upstream instance no workflow claims", () => {
    // An orphan bills and delivers forever otherwise — the workflow that owned
    // it may have been deleted, taking its row with it via cascade.
    const plan = planComposioReconciliation(
      [],
      [
        {
          id: "ti_orphan",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: {},
          disabled: false,
        },
      ]
    );

    expect(plan).toEqual([{ kind: "delete", instanceId: "ti_orphan" }]);
  });

  it("re-creates when the row points at an instance that no longer exists", () => {
    // Deleted from the Composio dashboard behind our back. Trusting the stored
    // id would leave the workflow silently never firing.
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_gone" })],
      []
    );

    expect(plan).toEqual([
      {
        kind: "create",
        workflowId: "wf_1",
        triggerSlug: "GITHUB_STAR_ADDED_EVENT",
        connectedAccountId: "ca_1",
        config: { owner: "acme", repo: "widgets" },
      },
    ]);
  });

  it("re-enables an instance that was disabled upstream", () => {
    const plan = planComposioReconciliation(
      [row({ instanceId: "ti_1", config: {} })],
      [
        {
          id: "ti_1",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: {},
          disabled: true,
        },
      ]
    );

    expect(plan).toEqual([
      { kind: "enable", workflowId: "wf_1", instanceId: "ti_1" },
    ]);
  });

  it("skips a row with no connected account rather than guessing one", () => {
    // The integration was deleted (integration_id is ON DELETE SET NULL). There
    // is nothing to subscribe as, and picking another account would subscribe
    // the wrong user's data.
    expect(
      planComposioReconciliation([row({ connectedAccountId: null })], [])
    ).toEqual([]);
  });

  it("plans independently for many rows", () => {
    const plan = planComposioReconciliation(
      [
        row({ workflowId: "wf_a" }),
        row({ workflowId: "wf_b", instanceId: "ti_b", active: false }),
      ],
      [
        {
          id: "ti_b",
          triggerSlug: "GITHUB_STAR_ADDED_EVENT",
          connectedAccountId: "ca_1",
          config: {},
          disabled: false,
        },
      ]
    );

    expect(plan).toHaveLength(2);
    expect(plan.map((a) => a.kind).sort()).toEqual(["create", "delete"]);
  });
});
