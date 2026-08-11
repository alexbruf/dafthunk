/**
 * Reconciles Dafthunk's `composio_triggers` rows against Composio's live
 * trigger instances.
 *
 * Saving a Composio-triggered workflow writes a row; nothing about that row
 * makes Composio start delivering events. This is the piece that closes that
 * gap, and it is a reconciler rather than a create-on-save hook because the two
 * sides drift for reasons neither owns: a subscription deleted from the Composio
 * dashboard, a workflow deleted here (cascading its row away and orphaning the
 * instance upstream), or a create that failed after the API call but before the
 * write-back.
 *
 * The planning half is pure so it can be tested exhaustively — the test-pool D1
 * has no schema, so anything that talked to the database inline would be
 * untestable.
 */

/** A `composio_triggers` row joined to the connected account it subscribes as. */
export interface ComposioTriggerRow {
  workflowId: string;
  organizationId: string;
  integrationId: string | null;
  /** Resolved from the integration; null once the integration is gone. */
  connectedAccountId: string | null;
  triggerSlug: string;
  instanceId: string | null;
  config: Record<string, unknown>;
  active: boolean;
}

/** The subset of a live Composio trigger instance reconciliation compares on. */
export interface ComposioLiveInstance {
  id: string;
  triggerSlug: string;
  connectedAccountId: string;
  config: Record<string, unknown>;
  disabled: boolean;
}

export type ComposioReconcileAction =
  | {
      kind: "create";
      workflowId: string;
      triggerSlug: string;
      connectedAccountId: string;
      config: Record<string, unknown>;
    }
  | {
      kind: "update";
      workflowId: string;
      instanceId: string;
      triggerSlug: string;
      connectedAccountId: string;
      config: Record<string, unknown>;
    }
  | { kind: "enable"; workflowId: string; instanceId: string }
  | { kind: "delete"; workflowId?: string; instanceId: string };

/**
 * Config equality has to ignore key order: the stored JSON and Composio's
 * response are built by different code, and comparing serialisations in
 * insertion order would report drift on every pass and rewrite the subscription
 * forever.
 */
function sameConfig(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)])
      );
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Produces the actions that would bring Composio in line with the rows.
 *
 * Re-running this against the state its own plan produces must return an empty
 * plan; that is what stops the reconciler leaking subscriptions.
 */
export function planComposioReconciliation(
  rows: ComposioTriggerRow[],
  live: ComposioLiveInstance[]
): ComposioReconcileAction[] {
  const byId = new Map(live.map((instance) => [instance.id, instance]));
  const claimed = new Set<string>();
  const actions: ComposioReconcileAction[] = [];

  for (const row of rows) {
    const existing = row.instanceId ? byId.get(row.instanceId) : undefined;
    if (existing) claimed.add(existing.id);

    if (!row.active) {
      // Deleting rather than disabling: a disabled instance still counts
      // upstream, and re-creating on reactivation costs one call.
      if (existing) {
        actions.push({
          kind: "delete",
          workflowId: row.workflowId,
          instanceId: existing.id,
        });
      }
      continue;
    }

    // No account means the integration was removed (ON DELETE SET NULL). There
    // is nothing to subscribe as, and choosing another account would subscribe
    // a different user's data.
    if (!row.connectedAccountId) continue;

    if (!existing) {
      // Covers both "never created" and "the stored id no longer exists
      // upstream" — trusting a dangling id would leave the workflow silently
      // never firing.
      actions.push({
        kind: "create",
        workflowId: row.workflowId,
        triggerSlug: row.triggerSlug,
        connectedAccountId: row.connectedAccountId,
        config: row.config,
      });
      continue;
    }

    if (
      existing.triggerSlug !== row.triggerSlug ||
      existing.connectedAccountId !== row.connectedAccountId ||
      !sameConfig(existing.config, row.config)
    ) {
      actions.push({
        kind: "update",
        workflowId: row.workflowId,
        instanceId: existing.id,
        triggerSlug: row.triggerSlug,
        connectedAccountId: row.connectedAccountId,
        config: row.config,
      });
      continue;
    }

    if (existing.disabled) {
      actions.push({
        kind: "enable",
        workflowId: row.workflowId,
        instanceId: existing.id,
      });
    }
  }

  for (const instance of live) {
    if (claimed.has(instance.id)) continue;
    // Nothing here claims it, so it bills and delivers forever otherwise.
    actions.push({ kind: "delete", instanceId: instance.id });
  }

  return actions;
}
