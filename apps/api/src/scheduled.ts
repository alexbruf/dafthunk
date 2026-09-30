import CronParser from "cron-parser";

import type { Bindings } from "./context";
import {
  createDatabase,
  getActiveScheduledTriggers,
  resolveOrganizationBillingOptions,
} from "./db";
import { getAgentByName } from "./durable-objects/agent-utils";
import { createWorkerRuntime } from "./runtime/cloudflare-worker-runtime";
import { runComposioReconciliation } from "./runtime/composio-reconcile-run";
import { WorkflowStore } from "./stores/workflow-store";
import { creditChecksEnabled } from "./utils/credits";

export async function handleScheduledEvent(
  _event: ScheduledEvent,
  env: Bindings,
  _ctx: ExecutionContext
): Promise<void> {
  console.log("Scheduled event triggered at:", new Date().toISOString());

  // The cron fires every minute, but reconciliation reads Composio's whole
  // trigger-instance list, so it runs on a slower beat. Five minutes is well
  // inside the window where a newly saved trigger still feels immediate, and it
  // keeps a project-wide listing off the per-minute path.
  const minute = new Date(_event.scheduledTime).getUTCMinutes();
  if (minute % 5 === 0) {
    try {
      await runComposioReconciliation(env);
    } catch (error) {
      // Never let this starve the scheduled workflows below.
      console.error(
        "[ComposioReconcile] Pass failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const db = createDatabase(env.DB);
  const workflowStore = new WorkflowStore(env);

  const triggers = await getActiveScheduledTriggers(
    db,
    creditChecksEnabled(env.CLOUDFLARE_ENV)
  );
  console.log(`Found ${triggers.length} active scheduled triggers`);

  const now = Date.now();

  for (const { scheduledTrigger, workflow, organizationBilling } of triggers) {
    try {
      // Skip workflows that are not enabled
      if (!workflow.enabled) {
        console.log(`Skipping scheduled workflow ${workflow.id}: not enabled`);
        continue;
      }

      // Parse schedule expression
      const interval = CronParser.parse(scheduledTrigger.scheduleExpression, {
        currentDate: new Date(now),
        tz: "UTC",
      });

      const scheduledTime = interval.prev().toDate();

      // Check if should run now (within last minute since we run every minute)
      if (Math.abs(now - scheduledTime.getTime()) > 60000) {
        continue; // Not time to execute
      }

      console.log(
        `Executing scheduled workflow ${workflow.id} (${scheduledTrigger.scheduleExpression})`
      );

      // Load workflow data from working version
      const workflowWithData = await workflowStore.getWithData(
        workflow.id,
        workflow.organizationId
      );
      if (!workflowWithData?.data) {
        console.error(`Failed to load workflow data for ${workflow.id}`);
        continue;
      }
      const workflowData = workflowWithData.data;

      const billingOptions = resolveOrganizationBillingOptions(
        organizationBilling,
        env.CLOUDFLARE_ENV
      );

      const executionParams = {
        userId: "scheduled_trigger",
        organizationId: workflow.organizationId,
        ...billingOptions,
        workflow: {
          id: workflow.id,
          name: workflow.name,
          trigger: workflowData.trigger,
          runtime: workflowData.runtime,
          nodes: workflowData.nodes,
          edges: workflowData.edges,
        },
        scheduledTrigger: {
          timestamp: now,
          scheduledTime: scheduledTime.getTime(),
          scheduleExpression: scheduledTrigger.scheduleExpression,
        },
      };

      // Use WorkerRuntime for "worker" runtime (synchronous execution)
      // Use Cloudflare Workflows for "workflow" runtime (durable execution, default)
      if (workflowData.runtime === "worker") {
        const workerRuntime = createWorkerRuntime(env);
        const execution = await workerRuntime.execute(executionParams);
        console.log(
          `[Execution] ${execution.id} workflow=${workflow.id} runtime=worker trigger=scheduled`
        );
      } else {
        const agent = await getAgentByName(env.WORKFLOW_AGENT, workflow.id);
        const executionId = await agent.executeWorkflow(executionParams);
        console.log(
          `[Execution] ${executionId} workflow=${workflow.id} runtime=workflow trigger=scheduled`
        );
      }
    } catch (error) {
      console.error(
        `Error executing scheduled workflow ${workflow.id}:`,
        error
      );
    }
  }
}
