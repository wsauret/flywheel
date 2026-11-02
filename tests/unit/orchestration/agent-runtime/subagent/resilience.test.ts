/**
 * Subagent runners rebuild only on explicit model reassignment. A provider
 * fault that can clear runs the child again, and the fault ends the dispatch
 * only after six fresh attempts in a row.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as abort from "../../../../../src/infra/abort.js";
import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import { createChildSlotRegistry } from "../../../../../src/orchestration/agent-runtime/child-slot-registry.js";
import type { AgentRunResult, AgentRunTerminal, Agent, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import { childTask, makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";

interface AttemptRecord {
  options: AgentOptions;
  sent: string;
}

/** Each runner resolves with the next terminal in `script`; when the script
 *  runs out, every further runner completes with `finalText`. */
function makeFlakyRunnerFactory(script: AgentRunTerminal[], finalText: string) {
  const attempts: AttemptRecord[] = [];
  const factory = (options: AgentOptions): Agent => {
    const terminal = script[attempts.length];
    const record: AttemptRecord = { options, sent: "" };
    attempts.push(record);
    const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
    return {
      send(text: string): void {
        record.sent = text;
        setTimeout(() => {
          if (!terminal) {
            options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
              type: "model.assistant_message.recorded",
              ...(options.purpose.kind === "subagent" ? { parent_tool_use_id: options.purpose.parentToolUseId } : {}),
              message: { content: [{ type: "text", text: finalText }], usage: { input_tokens: 100 } },
            }));
          }
          resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-mock", terminal: terminal ?? { kind: "completed" } });
        }, 0);
      },
      end() {},
      abort() {},
      done: promise,
    };
  };
  return { factory, attempts };
}

function makeResilienceDeps(
  factory: (options: AgentOptions) => Agent,
  onNotification: (text: string) => void,
  sessionDir: string,
) {
  return makeDeps({
    sessionDir,
    createRunner: factory,
    backgroundTasks: createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: onNotification,
    }),
  });
}

/** Ends each recovery pause at once and records its length. */
function instantRecoveryPauses() {
  const realSleep = abort.abortableSleep;
  const pauses: number[] = [];
  const sleep = spyOn(abort, "abortableSleep").mockImplementation((ms, signal) => {
    if (ms < 5_000) return realSleep(ms, signal);
    pauses.push(ms);
    return Promise.resolve();
  });
  return { pauses, [Symbol.dispose]: () => { sleep.mockRestore(); } };
}

/** Waits for the async recovery loop to publish the observed outcome. A fixed
 *  sleep races the loop on a loaded machine, so settlement polls the caller's
 *  condition with a bounded deadline. */
async function settle(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    await new Promise((r) => setTimeout(r, 10));
    if (done()) return;
  }
}

describe("subagent runner recovery", () => {
  it("completes the child in one runner with its durable conversation", async () => {
    const { factory, attempts } = makeFlakyRunnerFactory(
      [],
      "recovered and finished",
    );
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);
    let notification = "";
    const deps = makeResilienceDeps(factory, (text) => { notification = text; }, sessionDir);
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext({ toolUseId: "tc_recover" }));
    await settle(() => notification !== "");

    expect(attempts.length).toBe(1);
    const first = attempts[0];
    if (!first) throw new Error("expected an attempt record");
    const firstConversation = first.options.conversation;
    expect(firstConversation.kind).toBe("durable-tree");
    if (firstConversation.kind !== "durable-tree") throw new Error("Expected durable subagent conversation");
    expect(firstConversation.priorMessages).toEqual([{ kind: "user", content: "find stuff" }, { kind: "user", content: childTask(first.options), origin: "system" }]);
    expect(first.sent).toBe("find stuff");
    expect(notification).toContain("<status>completed</status>");
    expect(notification).toContain("recovered and finished");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("a persistent overload ends the dispatch after six fresh attempts with doubling pauses", async () => {
    using recovery = instantRecoveryPauses();
    const alwaysOverloaded = Array.from({ length: 20 }, (): AgentRunTerminal => ({
      kind: "api_overloaded",
      message: '{"type":"overloaded_error","message":"Overloaded"}',
    }));
    const { factory, attempts } = makeFlakyRunnerFactory(alwaysOverloaded, "unreachable");
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);
    let notification = "";
    const deps = makeResilienceDeps(factory, (text) => { notification = text; }, sessionDir);
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext({ toolUseId: "tc_exhaust" }));
    await settle(() => notification !== "");

    expect(attempts.length).toBe(7);
    expect(recovery.pauses).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000]);
    expect(notification).toContain("<status>failed</status>");
    // The canonical description from the shared resilience layer, identical
    // to what chat and workers surface for the same failure.
    expect(notification).toContain("Overloaded");
    expect(notification).not.toContain("re-dispatch");
    expect(notification).not.toContain("'general' subagent");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("non-retryable failures do not trigger recovery attempts", async () => {
    const { factory, attempts } = makeFlakyRunnerFactory(
      [{ kind: "api_error", message: "401 invalid api key", recovery: { kind: "none" } }],
      "unreachable",
    );
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);
    let notification = "";
    const deps = makeResilienceDeps(factory, (text) => { notification = text; }, sessionDir);
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext({ toolUseId: "tc_fatal" }));
    await settle(() => notification !== "");

    expect(attempts.length).toBe(1);
    expect(notification).toContain("<status>failed</status>");

    rmSync(sessionDir, { recursive: true, force: true });
  });
});

describe("subagent recovery edge paths", () => {
  it("persistent disconnects retain their cause without redispatch advice", async () => {
    using _recovery = instantRecoveryPauses();
    const alwaysDropping = Array.from({ length: 20 }, (): AgentRunTerminal => ({
      kind: "transient_disconnect",
      message: "socket hang up",
    }));
    const { factory } = makeFlakyRunnerFactory(alwaysDropping, "unreachable");
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);
    let notification = "";
    const deps = makeResilienceDeps(factory, (text) => { notification = text; }, sessionDir);
    const tool = createSubagentDispatch(deps);

    await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext({ toolUseId: "tc_disconnect" }));
    await settle(() => notification !== "");

    expect(notification).toContain("<status>failed</status>");
    expect(notification).toContain("socket hang up");
    expect(notification).not.toContain("re-dispatch");
    expect(notification).not.toContain("'general' subagent");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("a person stopping a queued dispatch settles it as stopped, not a mid-run failure", async () => {
    // Runs until aborted; abort settles the runner as aborted so the
    // notification batch (which waits for every active subagent) can fire.
    const neverFinishing = (options: AgentOptions): Agent => {
      void options;
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
      return {
        send(): void {},
        end() {},
        abort() { resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
        done: promise,
      };
    };
    const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}-${Math.random()}`);
    const notifications: string[] = [];
    const backgroundTasks = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => { notifications.push(text); },
    });
    const deps = makeDeps({
      sessionDir,
      createRunner: neverFinishing,
      backgroundTasks,
      childSlots: createChildSlotRegistry(1),
    });
    const tool = createSubagentDispatch(deps);

    // First dispatch occupies the only slot; the second queues.
    await tool.execute({ persona: "explorer", description: "occupy", rationale: TEST_RATIONALE, prompt: "occupy" }, makeContext({ toolUseId: "tc_hold" }));
    const queuedAck = await tool.execute({ persona: "explorer", description: "wait in line", rationale: TEST_RATIONALE, prompt: "wait in line" }, makeContext({ toolUseId: "tc_queued" }));
    expect(JSON.parse(queuedAck.content).status).toBe("queued");

    backgroundTasks.terminate("tc_queued");
    backgroundTasks.terminate("tc_hold");
    await settle(() => notifications.some((text) => text.includes("wait in line")));

    const cancelled = notifications.find((text) => text.includes("wait in line")) ?? notifications.join("\n");
    expect(cancelled).toContain("was stopped by the user");
    expect(cancelled).not.toContain("failed mid-run");

    rmSync(sessionDir, { recursive: true, force: true });
  });
});
