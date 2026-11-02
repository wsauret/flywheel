import { describe, expect, it } from "bun:test";

import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../src/orchestration/agent-runtime/background-work.js";
import { handoffDefinition } from "../src/orchestration/agent-runtime/tools/handoff.js";
import { makeContext } from "../tests/unit/orchestration/agent-runtime/tools/_fixtures.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("workflow handoff gate and background commands", () => {
  it("blocks handoff while a background command is still active, and until its result reaches the model", async () => {
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const done = Promise.withResolvers<BackgroundWorkResult>();

    registry.track({
      done: done.promise,
      meta: { id: "command-1", type: "background_command", description: "bun run test:perf" },
    });

    const blockers = registry.assertHandoffReady();
    expect(blockers).not.toBeNull();
    expect(blockers!.active).toBe(1);
    expect(blockers!.activeDescriptions).toContain("bun run test:perf");

    done.resolve({ status: "completed", content: "ok" });
    await delay(5);

    const pending = registry.assertHandoffReady();
    expect(pending).not.toBeNull();
    expect(pending!.active).toBe(0);
    expect(pending!.pending).toBe(1);
    registry.clearPending();
    expect(registry.assertHandoffReady()).toBeNull();
  });

  it("the handoff tool refuses while a background command runs or its result is not incorporated, then accepts", async () => {
    let captured: { [key: string]: unknown } | null = null;
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const commandDone = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: commandDone.promise,
      meta: { id: "command-1", type: "background_command", description: "bun run test:perf" },
    });
    const ctx = makeContext({
      handoff: { onContent: (content) => { captured = content; } },
      backgroundTasks: registry,
    });

    const commandBlocked = await handoffDefinition.execute({ summary: "Premature" }, ctx);
    expect(commandBlocked.outcome).toBe("blocked");
    expect(commandBlocked.content).toContain("bun run test:perf");
    expect(captured).toBeNull();

    commandDone.resolve({ status: "completed", content: "ok" });
    await delay(5);
    const commandPending = await handoffDefinition.execute({ summary: "Still premature" }, ctx);
    expect(commandPending.outcome).toBe("blocked");
    expect(commandPending.content).toContain("bun run test:perf");
    expect(captured).toBeNull();

    registry.clearPending();
    const ok = await handoffDefinition.execute({ summary: "Final" }, ctx);
    expect(ok.outcome).toBe("ok");
    expect(captured).toEqual({ summary: "Final" });
  });

  it("still gates handoff on subagents as before", async () => {
    let captured: { [key: string]: unknown } | null = null;
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const reviewerDone = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: reviewerDone.promise,
      meta: { id: "reviewer-1", type: "subagent", description: "Architecture review" },
    });
    const ctx = makeContext({
      handoff: { onContent: (content) => { captured = content; } },
      backgroundTasks: registry,
    });

    const blocked = await handoffDefinition.execute({ summary: "Premature" }, ctx);
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.content).toContain("Architecture review");
    expect(captured).toBeNull();

    reviewerDone.resolve({ status: "completed", content: "ok" });
    await delay(5);
    const undelivered = await handoffDefinition.execute({ summary: "Still premature" }, ctx);
    expect(undelivered.outcome).toBe("blocked");
    expect(captured).toBeNull();

    registry.clearPending();
    const ok = await handoffDefinition.execute({ summary: "Final" }, ctx);
    expect(ok.outcome).toBe("ok");
    expect(captured).toEqual({ summary: "Final" });
  });
});
