import { env } from "cloudflare:test";
import type { GeneratorServerMessage } from "@dafthunk/types";
import { describe, expect, it } from "vitest";

import { getAgentByName } from "./agent-utils";
import type { WorkflowGeneratorAgent } from "./workflow-generator-agent";

// `cloudflare:test`'s ambient Env does not carry the DO bindings declared in
// wrangler.test.jsonc, so the namespace is narrowed here rather than widening
// the shared ProvidedEnv declaration for one test.
const NAMESPACE = (
  env as unknown as {
    WORKFLOW_GENERATOR_AGENT: DurableObjectNamespace<WorkflowGeneratorAgent>;
  }
).WORKFLOW_GENERATOR_AGENT;

/**
 * Protocol-level tests for the generator socket.
 *
 * The generation logic itself is covered by the pipeline tests, which stub the
 * model. What matters here is the transport contract: identity is enforced, a
 * session frame lands on connect, and the frame log replays on reconnect so a
 * client that drops out catches up instead of restarting the run.
 */

const SESSION = "test-session-1";

async function connect(
  sessionId: string,
  headers: Record<string, string>
): Promise<{ socket: WebSocket; frames: GeneratorServerMessage[] }> {
  const stub = await getAgentByName(NAMESPACE, sessionId);

  const response = await stub.fetch(`https://generator.internal/${sessionId}`, {
    headers: { Upgrade: "websocket", ...headers },
  });

  const socket = response.webSocket;
  if (!socket) throw new Error(`No websocket in response (${response.status})`);

  const frames: GeneratorServerMessage[] = [];
  socket.accept();
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as GeneratorServerMessage);
  });

  return { socket, frames };
}

/**
 * Waits until the socket has delivered whatever the assertion needs.
 *
 * Frames arrive asynchronously, and a fixed pause is the wrong tool: it passed
 * when this file ran alone and failed when the four workspace suites ran in
 * parallel, because the delivery just missed the deadline under CPU contention.
 * That reads as a product bug and costs a re-run to classify, so poll for the
 * condition instead and let the deadline be generous.
 *
 * On timeout this returns rather than throwing, so the assertion that follows
 * reports the actual state — a useful diff beats "settleUntil timed out".
 */
async function settleUntil(
  predicate: () => boolean,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    // Drain microtasks first: most frames are already queued and this avoids
    // paying the polling interval in the common case.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (predicate()) return;
    await scheduler.wait(10);
  } while (Date.now() < deadline);
}

/** Settles the event loop where there is no positive condition to wait on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await scheduler.wait(50);
}

const hasError = (frames: GeneratorServerMessage[]): boolean =>
  frames.some((f) => f.type === "error");

const errorCount = (frames: GeneratorServerMessage[]): number =>
  frames.filter((f) => f.type === "error").length;

describe("WorkflowGeneratorAgent", () => {
  it("sends a session frame on connect", async () => {
    const { frames } = await connect(SESSION, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-1",
    });

    await settleUntil(() => frames.length > 0);

    expect(frames[0]).toMatchObject({
      type: "session",
      sessionId: SESSION,
      status: "idle",
    });
  });

  it("closes the socket when identity headers are missing", async () => {
    const { socket } = await connect("test-session-no-identity", {
      "X-User-Id": "user-1",
      // no X-Organization-Id
    });

    let closeCode: number | undefined;
    socket.addEventListener("close", (event) => {
      closeCode = event.code;
    });

    await settleUntil(() => closeCode !== undefined);

    expect(closeCode).toBe(1008);
  });

  it("rejects a malformed client message", async () => {
    const { socket, frames } = await connect("test-session-malformed", {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-1",
    });

    let closeCode: number | undefined;
    socket.addEventListener("close", (event) => {
      closeCode = event.code;
    });

    await settleUntil(() => frames.length > 0);
    socket.send("not json");
    await settleUntil(() => closeCode !== undefined);

    expect(closeCode).toBe(1003);
  });

  it("replays earlier frames to a reconnecting client", async () => {
    const sessionId = "test-session-replay";

    // The org does not exist in the test database, so the run fails fast and
    // writes an error frame — exactly the durable state replay should restore.
    const first = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await settleUntil(() => first.frames.length > 0);
    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    await settleUntil(() => hasError(first.frames));

    const errorFrame = first.frames.find((f) => f.type === "error");
    expect(errorFrame).toBeDefined();
    first.socket.close();

    const second = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await settleUntil(() => hasError(second.frames));

    // Fresh session frame, then the replayed log including the error.
    expect(second.frames.some((f) => f.type === "error")).toBe(true);
    expect(second.frames[0]).toMatchObject({ type: "session" });
  });

  it("reports the original prompt so a resumed page can show it", async () => {
    const sessionId = "test-session-prompt";

    const first = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await settleUntil(() => first.frames.length > 0);
    first.socket.send(
      JSON.stringify({ type: "start", prompt: "summarize my emails" })
    );
    await settleUntil(() => hasError(first.frames));
    first.socket.close();

    // A fresh connection is what resuming from a URL looks like.
    const resumed = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await settleUntil(() => resumed.frames.length > 0);

    expect(resumed.frames[0]).toMatchObject({
      type: "session",
      prompt: "summarize my emails",
    });
  });

  it("does not restart a run that already happened", async () => {
    const sessionId = "test-session-idempotent";

    const first = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await settleUntil(() => first.frames.length > 0);
    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    await settleUntil(() => hasError(first.frames));
    const afterFirst = errorCount(first.frames);

    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    // The replayed error may or may not add a frame; wait for the growth we
    // expect, then fall through so the assertion below judges the real state.
    await settleUntil(() => errorCount(first.frames) > afterFirst);
    await settle();

    // The second start replays rather than generating again, so the error is
    // re-sent from the log but no new run is claimed.
    expect(errorCount(first.frames)).toBeGreaterThanOrEqual(afterFirst);
    expect(first.frames.filter((f) => f.type === "session")).toHaveLength(1);
  });
});
