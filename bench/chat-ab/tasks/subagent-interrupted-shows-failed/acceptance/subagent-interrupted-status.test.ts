import { describe, expect, test } from "bun:test";
import type { AgentOptions, AgentRunResult } from "../src/orchestration/agent-runtime/types";
import { liveChildRun } from "../src/orchestration/session/live-session-control";
import { makeContext, TEST_RATIONALE } from "../tests/unit/orchestration/agent-runtime/subagent/_fixtures";
import { subagentChildHarnesses, type SubagentChildHarness } from "../tests/unit/orchestration/modules/subagents/_subagent-child-fixtures";

const createHarness = subagentChildHarnesses();

const aborted: AgentRunResult = { servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } };

function heldRuns() {
  const runs: { options: AgentOptions; done: PromiseWithResolvers<AgentRunResult> }[] = [];
  const harness = createHarness((options) => {
    const done = Promise.withResolvers<AgentRunResult>();
    runs.push({ options, done });
    return { send() {}, end() {}, abort() { done.resolve(aborted); }, done: done.promise };
  });
  return { harness, runs };
}

async function dispatchChild(harness: SubagentChildHarness): Promise<string> {
  const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
  await harness.tool(parent).execute(
    { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Hold messages" },
    makeContext({ conversationId: "root-conversation", toolUseId: "dispatch-call" }),
  );
  const child = [...(await harness.manager.read(parent))?.childSessionIds ?? []][0];
  if (!child) throw new Error("Dispatch did not publish a child session");
  return child;
}

async function settledRecords(harness: SubagentChildHarness): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (harness.backgroundTasks.processRecords().every((record) => record.status !== "running" && record.status !== "stopping")) return;
    await Bun.sleep(5);
  }
}

// A child that a person interrupted stays the parent's outstanding work, so
// the parent's waits park on it until they expire; a child that the runtime
// interrupted leaves it, so no wait parks on it and it blocks no handoff
// (PI-AGENT-025). Either way the run has not ended and can resume.
const interrupters = [
  { by: "person", outstanding: 1, effect: "stays the parent's outstanding work" },
  { by: "runtime", outstanding: 0, effect: "leaves the parent's outstanding work" },
] as const;

describe("the parent's record of an interrupted subagent", () => {
  for (const { by, outstanding, effect } of interrupters) {
    test(`a child that the ${by} interrupted records as interrupted, not stopped or failed, and ${effect}`, async () => {
      const { harness, runs } = heldRuns();
      try {
        const child = await dispatchChild(harness);
        expect(harness.backgroundTasks.activeTaskCount()).toBe(1);

        await liveChildRun(harness.reader, child)?.child.interrupt(by);
        await settledRecords(harness);

        expect(harness.backgroundTasks.processRecords()).toEqual([expect.objectContaining({ kind: "subagent", status: "interrupted" })]);
        expect(harness.backgroundTasks.activeTaskCount()).toBe(outstanding);
      } finally {
        for (const run of runs) run.done.resolve(aborted);
        await harness.close();
      }
    });
  }

  test("a child whose run fails with a provider error still records as failed", async () => {
    const { harness, runs } = heldRuns();
    try {
      await dispatchChild(harness);
      runs[0]?.done.resolve({ servedRequests: 1, durationMs: 1, terminal: { kind: "api_error", message: "provider broke", recovery: { kind: "none" } } });
      await settledRecords(harness);
      expect(harness.backgroundTasks.processRecords()).toEqual([expect.objectContaining({ kind: "subagent", status: "failed" })]);
    } finally {
      for (const run of runs) run.done.resolve(aborted);
      await harness.close();
    }
  });
});
