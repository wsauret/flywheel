import { describe, expect, it } from "bun:test";

import { createHandoffTracker } from "../src/orchestration/agent-runtime/agent-loop-handoff.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../src/orchestration/agent-runtime/background-work.js";
import type { ToolCall } from "../src/orchestration/agent-runtime/llm/types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let nextCall = 0;
const handoffCall = (): ToolCall => ({ id: `handoff-${nextCall++}`, name: "handoff", input: { summary: "Done" } });

/** A workflow registry whose conversation commits each notification only when the test says so. */
function workflowRegistry() {
  const commits: Array<() => void> = [];
  const registry = createBackgroundWorkRegistry({
    kind: "workflow",
    enqueueNotification: () => new Promise<void>((resolve) => { commits.push(resolve); }),
  });
  const commitAll = async () => {
    for (const commit of commits.splice(0)) commit();
    await delay(5);
  };
  return { registry, commitAll };
}

/** One model response that calls handoff: undefined admits it, a result refuses it. */
function attemptHandoff(tracker: ReturnType<typeof createHandoffTracker>) {
  return tracker.request().refuse(handoffCall());
}

describe("workflow handoff gate and background commands", () => {
  it("blocks handoff while a background command is still active, and until its result reaches the model", async () => {
    const { registry, commitAll } = workflowRegistry();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: done.promise,
      meta: { id: "command-1", type: "background_command", description: "bun run test:perf" },
    });

    const running = registry.assertHandoffReady();
    expect(running).not.toBeNull();
    expect(running!.active).toBe(1);
    expect(running!.activeDescriptions).toContain("bun run test:perf");

    done.resolve({ status: "completed", content: "ok", exit: { code: 0 } });
    await delay(5);

    const owed = registry.assertHandoffReady();
    expect(owed).not.toBeNull();
    expect(owed!.active).toBe(0);
    expect(owed!.pending).toBe(1);
    expect(owed!.pendingDescriptions).toContain("bun run test:perf");

    await commitAll();
    expect(registry.assertHandoffReady()).toBeNull();
  });

  it("the handoff gate refuses while a background command runs or its result is not incorporated, then accepts", async () => {
    const { registry, commitAll } = workflowRegistry();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: done.promise,
      meta: { id: "command-1", type: "background_command", description: "bun run test:perf" },
    });
    let started = 0;
    const tracker = createHandoffTracker({ background: registry, onStarted: () => { started++; } });

    const running = attemptHandoff(tracker);
    expect(running?.outcome).toBe("blocked");
    expect(String(running?.content)).toContain("bun run test:perf");
    expect(started).toBe(0);

    done.resolve({ status: "completed", content: "ok", exit: { code: 0 } });
    await delay(5);
    const owed = attemptHandoff(tracker);
    expect(owed?.outcome).toBe("blocked");
    expect(String(owed?.content)).toContain("bun run test:perf");
    expect(started).toBe(0);

    await commitAll();
    expect(attemptHandoff(tracker)).toBeUndefined();
    expect(started).toBe(1);
  });

  it("still gates handoff on subagents as before", async () => {
    const { registry, commitAll } = workflowRegistry();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: done.promise,
      meta: { id: "reviewer-1", type: "subagent", description: "Architecture review" },
    });
    let started = 0;
    const tracker = createHandoffTracker({ background: registry, onStarted: () => { started++; } });

    const running = attemptHandoff(tracker);
    expect(running?.outcome).toBe("blocked");
    expect(String(running?.content)).toContain("Architecture review");

    done.resolve({ status: "completed", content: "ok" });
    await delay(5);
    const owed = attemptHandoff(tracker);
    expect(owed?.outcome).toBe("blocked");
    expect(started).toBe(0);

    await commitAll();
    expect(attemptHandoff(tracker)).toBeUndefined();
    expect(started).toBe(1);
  });
});
