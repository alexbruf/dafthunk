/**
 * MCP route, mounted at `/mcp` in index.ts.
 *
 * Streamable-HTTP transport, stateless mode: each request builds a fresh
 * server + transport because there is nothing to keep between requests. The
 * heavy operations (node catalog, workflow execution, execution reads) live in
 * the `McpBackends` wired here from the same store/service paths the HTTP
 * routes use, so the MCP surface and the REST surface share the real logic.
 *
 * Auth is `accessIdentityMiddleware`: it reads `Cf-Access-Jwt-Assertion`,
 * validates the Access signature, `aud` and `iss`, resolves email → user →
 * membership, and sets `userId` + `organizationId` exactly as `jwtMiddleware`
 * does. Nothing in this file runs without those two variables, and the handler
 * re-checks them rather than trusting the mount.
 *
 * Deliberately not API keys: those resolve to an organization but not to a
 * user, and `WorkflowExecutor.execute` needs a real one. Access supplies an
 * email, so attribution survives. API keys stay the path for unattended
 * automation, which is also where `execute` is allowed to default true.
 */

import type {
  NodeType,
  WorkflowExecution,
  WorkflowExecutionStatus,
} from "@dafthunk/types";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";

import type { ApiContext } from "../context";
import {
  createDatabase,
  getOrganizationBillingInfo,
  getWorkflowByIdUnscoped,
  resolveOrganizationBillingOptions,
} from "../db";
import {
  buildMcpServer,
  type McpBackends,
  type McpServerContext,
} from "../mcp/mcp-server";
import { accessIdentityMiddleware } from "../middleware/access-identity";
import { CloudflareExecutionStore } from "../runtime/cloudflare-execution-store";
import { CloudflareNodeRegistry } from "../runtime/cloudflare-node-registry";
import {
  WorkflowExecutor,
  type WorkflowExecutorParameters,
} from "../services/workflow-executor";
import { WorkflowStore } from "../stores/workflow-store";
import { isCreditExhausted } from "../utils/credits";
import { isUuid } from "../utils/validation";
import { findHttpTrigger } from "./http-triggers";

function listNodeTypes(ctx: McpServerContext): NodeType[] {
  // Same static catalog as GET /types (minus the per-model Cloudflare synthesis,
  // which is editor sugar): the catalog the generator is allowed to emit.
  const registry = new CloudflareNodeRegistry(ctx.env, false);
  return registry.getNodeTypes();
}

async function runWorkflow(
  ctx: McpServerContext,
  workflowId: string,
  parameters: Record<string, unknown>
): Promise<WorkflowExecution> {
  const db = createDatabase(ctx.env.DB);

  const workflow = await getWorkflowByIdUnscoped(db, workflowId);
  if (!workflow || !workflow.enabled) {
    throw new Error("Workflow not found");
  }
  const organizationId = workflow.organizationId;

  // Tenant boundary: the caller is authenticated as ctx.organizationId and can
  // only run workflows inside it. The workflow id in the path picks the record,
  // never the tenant.
  if (organizationId !== ctx.organizationId) {
    throw new Error("Workflow not found");
  }

  const store = new WorkflowStore(ctx.env);
  const workflowWithData = await store.getWithData(workflowId, organizationId);
  if (!workflowWithData?.data) {
    throw new Error("Workflow not found");
  }
  const workflowData = workflowWithData.data;

  const runtime = findHttpTrigger(workflowData.nodes);
  if (!runtime) {
    throw new Error("Workflow has no HTTP trigger");
  }

  const billingInfo = await getOrganizationBillingInfo(db, organizationId);
  if (!billingInfo) {
    throw new Error("Organization not found");
  }
  if (isCreditExhausted(billingInfo, ctx.env.CLOUDFLARE_ENV)) {
    throw new Error("Insufficient compute credits");
  }

  const { execution } = await WorkflowExecutor.execute({
    workflow: {
      id: workflow.id,
      name: workflow.name,
      trigger: workflowData.trigger,
      runtime,
      nodes: workflowData.nodes,
      edges: workflowData.edges,
    },
    userId: ctx.userId,
    organizationId,
    ...resolveOrganizationBillingOptions(billingInfo, ctx.env.CLOUDFLARE_ENV),
    parameters: parameters as WorkflowExecutorParameters,
    env: ctx.env,
  });

  return execution;
}

async function getExecution(
  ctx: McpServerContext,
  executionId: string
): Promise<WorkflowExecution | null> {
  if (!isUuid(executionId)) {
    return null;
  }
  const executionStore = new CloudflareExecutionStore(ctx.env);
  const execution = await executionStore.getWithData(
    executionId,
    ctx.organizationId
  );
  if (!execution) {
    return null;
  }
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    status: execution.status as WorkflowExecutionStatus,
    nodeExecutions: execution.data.nodeExecutions || [],
    error: execution.error || undefined,
    startedAt: execution.startedAt ?? execution.data.startedAt,
    endedAt: execution.endedAt ?? execution.data.endedAt,
  };
}

const mcpRoutes = new Hono<ApiContext>();

const mcpBackends: McpBackends = {
  listNodeTypes,
  runWorkflow,
  getExecution,
};

mcpRoutes.use("/", accessIdentityMiddleware);

mcpRoutes.all("/", async (c) => {
  const organizationId = c.get("organizationId");
  const userId = c.get("userId");

  if (!organizationId || !userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const ctx: McpServerContext = {
    env: c.env,
    organizationId,
    userId,
  };

  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = buildMcpServer(ctx, { backends: mcpBackends });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcpRoutes;
