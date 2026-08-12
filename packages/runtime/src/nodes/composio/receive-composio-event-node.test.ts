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

describe("ReceiveComposioEventNode payload fan-out", () => {
  /**
   * The palette entry for a trigger declares one output per field of that
   * trigger's payload schema — `comment_id`, `authors`, `data` and so on —
   * because that is what makes a trigger wirable without a JSON-picking node in
   * between. The runtime only persists declared outputs, so emitting a single
   * `payload` object left every schema-derived output empty and dropped the
   * object itself for having no matching declaration. The node ran green and
   * produced nothing but the envelope fields.
   *
   * So the payload is spread across the top level AND kept whole: the
   * synthesised entries read the spread fields, the generic base node reads
   * `payload`.
   */
  const runWith = async (payload: Record<string, unknown>) => {
    const node = new ReceiveComposioEventNode({
      nodeId: "receive-composio-event",
    } as unknown as Node);
    return node.execute({
      nodeId: "receive-composio-event",
      inputs: {},
      composioEvent: {
        eventId: "msg_1",
        type: "composio.trigger.message",
        timestamp: "2026-08-11T00:00:00Z",
        triggerInstanceId: "ti_1",
        triggerSlug: "NOTION_COMMENT_CREATED",
        toolkitSlug: "NOTION",
        payload,
      },
      env: {},
    } as unknown as NodeContext);
  };

  it("exposes each payload field as its own output", async () => {
    const result = await runWith({
      comment_id: "c1",
      authors: [{ id: "u1" }],
      data: { text: "hello" },
    });

    expect(result.status).toBe("completed");
    expect(result.outputs?.comment_id).toBe("c1");
    expect(result.outputs?.authors).toEqual([{ id: "u1" }]);
    expect(result.outputs?.data).toEqual({ text: "hello" });
  });

  it("still emits the whole payload for the generic node", async () => {
    const result = await runWith({ comment_id: "c1" });
    expect(result.outputs?.payload).toEqual({ comment_id: "c1" });
  });

  it("does not let a payload field shadow the envelope outputs", async () => {
    // A provider is free to send a field called triggerSlug; routing metadata
    // must win, or a downstream node reads the provider's value as ours.
    const result = await runWith({
      triggerSlug: "SPOOFED",
      eventId: "spoofed",
      comment_id: "c1",
    });

    expect(result.outputs?.triggerSlug).toBe("NOTION_COMMENT_CREATED");
    expect(result.outputs?.eventId).toBe("msg_1");
    expect(result.outputs?.comment_id).toBe("c1");
  });

  it("handles an empty payload without dropping the envelope", async () => {
    const result = await runWith({});
    expect(result.status).toBe("completed");
    expect(result.outputs?.triggerSlug).toBe("NOTION_COMMENT_CREATED");
    expect(result.outputs?.payload).toEqual({});
  });
});
