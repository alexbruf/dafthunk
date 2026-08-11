import type { ComposioClient } from "@dafthunk/runtime/utils/composio-client";

import type { ComposioReconcileAction } from "./composio-reconcile";

export interface ComposioApplyHooks {
  /**
   * Records the upstream instance id against the workflow, or clears it.
   *
   * This write is the reason applying is not fire-and-forget: a create that
   * succeeds upstream and is not recorded here looks, on the next pass, like a
   * row that still needs one — so a second subscription is made and the
   * workflow runs twice for every event.
   */
  setInstanceId(workflowId: string, instanceId: string | null): Promise<void>;
}

export interface ComposioApplyResult {
  created: number;
  updated: number;
  deleted: number;
  enabled: number;
  failed: number;
}

/**
 * Carries out a reconciliation plan.
 *
 * Failures are isolated per action: one organization's revoked connection or
 * malformed config must not stop every other organization's triggers from being
 * reconciled. A failed action is simply left for the next pass, which is safe
 * precisely because planning is idempotent.
 */
export async function applyComposioReconciliation(
  client: ComposioClient,
  plan: ComposioReconcileAction[],
  hooks: ComposioApplyHooks
): Promise<ComposioApplyResult> {
  const result: ComposioApplyResult = {
    created: 0,
    updated: 0,
    deleted: 0,
    enabled: 0,
    failed: 0,
  };

  for (const action of plan) {
    try {
      switch (action.kind) {
        case "create":
        case "update": {
          // Composio exposes one upsert for both: creating and re-configuring
          // are the same call, and it returns the id either way.
          const instanceId = await client.upsertTriggerInstance(
            action.triggerSlug,
            {
              connectedAccountId: action.connectedAccountId,
              triggerConfig: action.config,
            }
          );
          await hooks.setInstanceId(action.workflowId, instanceId);
          if (action.kind === "create") result.created += 1;
          else result.updated += 1;
          break;
        }
        case "enable": {
          await client.setTriggerInstanceStatus(action.instanceId, "enable");
          result.enabled += 1;
          break;
        }
        case "delete": {
          await client.deleteTriggerInstance(action.instanceId);
          // An orphan has no row to update. A row that still exists must lose
          // the id, or the next pass tries to delete it again.
          if (action.workflowId) {
            await hooks.setInstanceId(action.workflowId, null);
          }
          result.deleted += 1;
          break;
        }
      }
    } catch (error) {
      result.failed += 1;
      console.error(
        `[ComposioReconcile] ${action.kind} failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return result;
}
