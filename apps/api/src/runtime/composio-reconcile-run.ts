import { ComposioClient } from "@dafthunk/runtime/utils/composio-client";
import { eq } from "drizzle-orm";

import type { Bindings } from "../context";
import {
  composioTriggers,
  createDatabase,
  getAllComposioTriggersWithIntegration,
} from "../db";
import { decryptSecret } from "../utils/encryption";
import { applyComposioReconciliation } from "./composio-apply";
import {
  type ComposioLiveInstance,
  type ComposioTriggerRow,
  planComposioReconciliation,
} from "./composio-reconcile";

/**
 * One reconciliation pass: read both sides, diff, act.
 *
 * Kept apart from the planner and the applier so each stays testable on its own
 * — this layer is the only part that needs a database and a network, and the
 * test-pool D1 has no schema.
 */
export async function runComposioReconciliation(
  env: Bindings
): Promise<{ planned: number; applied: number; failed: number } | null> {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) return null;

  const db = createDatabase(env.DB);
  const joined = await getAllComposioTriggersWithIntegration(db);
  const client = new ComposioClient({ apiKey });

  const rows: ComposioTriggerRow[] = [];
  for (const { composioTrigger, integration } of joined) {
    // The connected account id is stored through the encrypted column, so it
    // has to be decrypted per row with that organization's key.
    let connectedAccountId: string | null = null;
    if (integration && integration.status === "active") {
      try {
        connectedAccountId = await decryptSecret(
          integration.encryptedToken,
          env,
          composioTrigger.organizationId
        );
      } catch (error) {
        // An undecryptable integration leaves the row unsubscribable rather
        // than failing the whole pass for every other organization.
        console.error(
          `[ComposioReconcile] Could not read connection for workflow ${composioTrigger.workflowId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    rows.push({
      workflowId: composioTrigger.workflowId,
      organizationId: composioTrigger.organizationId,
      integrationId: composioTrigger.integrationId,
      connectedAccountId,
      triggerSlug: composioTrigger.triggerSlug,
      instanceId: composioTrigger.instanceId,
      config: parseConfig(composioTrigger.config),
      active: composioTrigger.active,
    });
  }

  const live: ComposioLiveInstance[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listActiveTriggerInstances({
      limit: 100,
      cursor,
    });
    for (const item of page.items) {
      live.push({
        id: item.id,
        triggerSlug: item.trigger_name,
        connectedAccountId: item.connected_account_id,
        config: item.trigger_config,
        disabled: item.disabled_at !== null,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const plan = planComposioReconciliation(rows, live);
  if (plan.length === 0) return { planned: 0, applied: 0, failed: 0 };

  const result = await applyComposioReconciliation(client, plan, {
    async setInstanceId(workflowId, instanceId) {
      await db
        .update(composioTriggers)
        .set({ instanceId, updatedAt: new Date() })
        .where(eq(composioTriggers.workflowId, workflowId));
    },
  });

  const applied =
    result.created + result.updated + result.deleted + result.enabled;
  console.log(
    `[ComposioReconcile] planned=${plan.length} created=${result.created} updated=${result.updated} deleted=${result.deleted} enabled=${result.enabled} failed=${result.failed}`
  );
  return { planned: plan.length, applied, failed: result.failed };
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A corrupt config should not take the pass down; an empty one simply
    // reads as drift and gets rewritten from the row on the next update.
    return {};
  }
}
