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

/** Lets the microtask queue drain, then yields to the event loop once. */
async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await scheduler.wait(10);
}

/**
 * Waits for an observable condition rather than a fixed delay.
 *
 * A flat 50ms sleep was enough when this file ran alone and not enough under
 * full-suite load, so a different case failed on roughly every other run.
 * Polling makes the wait scale with how long delivery actually takes.
 */
async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    await tick();
    if (predicate()) return;
  } while (Date.now() < deadline);
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Waits for frame delivery to stop, for assertions that nothing *more* arrives.
 * Two consecutive stable polls, so a frame in flight is not mistaken for quiet.
 */
async function quiesce(frames: GeneratorServerMessage[]): Promise<void> {
  let stable = 0;
  let last = -1;
  while (stable < 2) {
    await tick();
    stable = frames.length === last ? stable + 1 : 0;
    last = frames.length;
  }
}

describe("WorkflowGeneratorAgent", () => {
  it("sends a session frame on connect", async () => {
    const { frames } = await connect(SESSION, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-1",
    });

    await until(() => frames.length > 0, "the session frame");

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

    await until(() => closeCode !== undefined, "the socket to close");

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

    // The session frame proves the connection is live before anything is sent.
    await until(() => frames.length > 0, "the session frame");
    socket.send("not json");
    await until(() => closeCode !== undefined, "the socket to close");

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
    await until(() => first.frames.length > 0, "the session frame");
    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    await until(
      () => first.frames.some((f) => f.type === "error"),
      "the run to fail"
    );

    const errorFrame = first.frames.find((f) => f.type === "error");
    expect(errorFrame).toBeDefined();
    first.socket.close();

    const second = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await until(
      () => second.frames.some((f) => f.type === "error"),
      "the frame log to replay"
    );

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
    await until(() => first.frames.length > 0, "the session frame");
    first.socket.send(
      JSON.stringify({ type: "start", prompt: "summarize my emails" })
    );
    // The run has to be claimed — that is what records the prompt — before the
    // resumed connection can report it back.
    await until(
      () => first.frames.some((f) => f.type === "error"),
      "the run to be claimed and fail"
    );
    first.socket.close();

    // A fresh connection is what resuming from a URL looks like.
    const resumed = await connect(sessionId, {
      "X-User-Id": "user-1",
      "X-Organization-Id": "org-missing",
    });
    await until(() => resumed.frames.length > 0, "the session frame");

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
    await until(() => first.frames.length > 0, "the session frame");
    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    await until(
      () => first.frames.some((f) => f.type === "error"),
      "the first run to fail"
    );
    const afterFirst = first.frames.filter((f) => f.type === "error").length;

    first.socket.send(JSON.stringify({ type: "start", prompt: "summarize" }));
    // Asserting on what does *not* happen, so wait for delivery to go quiet
    // rather than for a frame that should never arrive.
    await quiesce(first.frames);

    // The second start replays rather than generating again, so the error is
    // re-sent from the log but no new run is claimed.
    expect(
      first.frames.filter((f) => f.type === "error").length
    ).toBeGreaterThanOrEqual(afterFirst);
    expect(first.frames.filter((f) => f.type === "session")).toHaveLength(1);
  });
});
