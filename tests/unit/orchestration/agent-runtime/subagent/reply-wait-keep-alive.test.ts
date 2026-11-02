import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { openReplyWait } from "../../../../../src/orchestration/session/reply-waits.js";
import { makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";

// The stall watchdog of a child measures idleness. A child that waits on a
// reply (ARCH-SESSIONS-032) is not idle: the wait is bounded by its own end
// rules, so a parent that asks the person does not trip the watchdog.
describe("subagent reply-wait keep-alive", () => {
  it("feeds the stall watchdog while the child waits on a reply and stops when the wait ends", async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let bumps = 0;
    const fakeRegistry: BackgroundWorkRegistry = {
      ...createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      track: () => ({ bump: () => { bumps++; }, rearm: () => {} }),
    };
    const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
    let options: AgentOptions | undefined;
    const factory = (agentOptions: AgentOptions): Agent => {
      options = agentOptions;
      return { send() {}, end() {}, abort() {}, done: promise };
    };
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
    const store = createSqliteEventStore(path.join(sessionDir, "events.sqlite"));
    const reader = asAsyncEventReadSurface(store);
    const deps = makeDeps({ sessionDir, createRunner: factory, backgroundTasks: fakeRegistry, keepAliveIntervalMs: 5, sessionEventStore: reader });
    await createSubagentDispatch(deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());
    const childSessionId = options?.conversation.kind === "durable-tree" ? options.conversation.sessionId : "";
    const tasks = options?.runtimeSurfaces?.background?.tasks;
    if (!tasks) throw new Error("every child runs with a background owner");

    // The child asks its parent and waits: the wait is no stall.
    const wait = await openReplyWait({ projectionReader: reader, eventWriter: asAsyncEventWriter(store), addresseeState: async () => "running", lineage: async (sessionId) => [sessionId] }, {
      waiter: { sessionId: childSessionId, tasks },
      addressee: { sessionId: "parent", name: "Root" },
      toolUseId: "ask-1",
    });
    bumps = 0;
    const bumpedThrice = () => bumps >= 3;
    for (let attempt = 0; attempt < 500 && !bumpedThrice(); attempt++) await delay(5);
    expect(bumps).toBeGreaterThanOrEqual(3);

    // The wait ends: back to flat idleness.
    wait.withdraw();
    await delay(10);
    bumps = 0;
    await delay(30);
    expect(bumps).toBe(0);

    resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-mock", terminal: { kind: "completed" } });
    await delay(10);
    store.close();
    rmSync(sessionDir, { recursive: true, force: true });
  });
});
