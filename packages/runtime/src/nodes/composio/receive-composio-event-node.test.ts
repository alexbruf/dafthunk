import type { ComposioEvent, Node } from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import type { NodeContext } from "../../node-types";
import { ReceiveComposioEventNode } from "./receive-composio-event-node";

const event = (overrides: Partial<ComposioEvent> = {}): ComposioEvent => ({
  eventId: "evt_1",
  type: "composio.trigger.message",
  timestamp: "2026-01-01T00:00:00.000Z",
  triggerInstanceId: "ti_abc",
  triggerSlug: "GITHUB_STAR_ADDED_EVENT",
  toolkitSlug: "github",
  connectedAccountId: "ca_abc",
  userId: "org_1",
  payload: { repository: "dafthunk/dafthunk" },
  ...overrides,
});

const createContext = (composioEvent?: ComposioEvent): NodeContext =>
  ({
    nodeId: "receive-composio-event",
    inputs: {},
    composioEvent,
    getIntegration: async () => {
      throw new Error("No integrations in test");
    },
    env: {},
  }) as unknown as NodeContext;

const createNode = () =>
  new ReceiveComposioEventNode({
    nodeId: "receive-composio-event",
  } as unknown as Node);

describe("ReceiveComposioEventNode", () => {
  it("emits the delivery's payload and identifiers", async () => {
    const result = await createNode().execute(createContext(event()));

    expect(result.status).toBe("completed");
    expect(result.outputs?.payload).toEqual({
      repository: "dafthunk/dafthunk",
    });
    expect(result.outputs?.triggerSlug).toBe("GITHUB_STAR_ADDED_EVENT");
    expect(result.outputs?.toolkitSlug).toBe("github");
    expect(result.outputs?.eventId).toBe("evt_1");
  });

  it("passes the payload through untouched", async () => {
    const payload = { nested: { a: [1, 2, 3] }, flag: false };
    const result = await createNode().execute(
      createContext(event({ payload }))
    );

    expect(result.outputs?.payload).toEqual(payload);
  });

  it("errors instead of throwing when the context carries no event", async () => {
    const result = await createNode().execute(createContext(undefined));

    expect(result.status).toBe("error");
    expect(result.error).toContain("Composio event");
  });

  it("declares itself as a trigger node", () => {
    expect(ReceiveComposioEventNode.nodeType.trigger).toBe(true);
  });
});
