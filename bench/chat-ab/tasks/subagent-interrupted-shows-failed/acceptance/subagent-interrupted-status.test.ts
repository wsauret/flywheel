import { describe, expect, test } from "bun:test";
import type { AgentOptions, AgentRunResult } from "../src/orchestration/agent-runtime/types";
import { createProcessTool } from "../src/orchestration/agent-runtime/tools/process";
import type { ToolContext } from "../src/orchestration/agent-runtime/tools/types";
import { liveChildRun } from "../src/orchestration/session/live-session-control";
import { makeContext, TEST_RATIONALE } from "../tests/unit/orchestration/agent-runtime/subagent/_fixtures";
import { subagentChildHarnesses, type SubagentChildHarness } from "../tests/unit/orchestration/modules/subagents/_subagent-child-fixtures";

const createHarness = subagentChildHarnesses();

function heldRuns() {
  const runs: { options: AgentOptions; done: PromiseWithResolvers<AgentRunResult> }[] = [];
  const harness = createHarness((options) => {
    const done = Promise.withResolvers<AgentRunResult>();
    runs.push({ options, done });
    return { send() {}, end() {}, abort() { done.resolve({ durationMs: 1, terminal: { kind: "aborted" } }); }, done: done.promise };
  });
  return { harness, runs };
}

async function dispatchChild(harness: SubagentChildHarness): Promise<{ parent: string; child: string }> {
  const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
  await harness.tool(parent).execute(
    { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Hold messages" },
    makeContext({ conversationId: "root-conversation", toolUseId: "dispatch-call" }),
  );
  const child = [...(await harness.manager.read(parent))?.childSessionIds ?? []][0];
  if (!child) throw new Error("Dispatch did not publish a child session");
  return { parent, child };
}

const toolContext: ToolContext = { executionCwd: "/repo", projectRoot: "/repo" };

async function settledRecords(harness: SubagentChildHarness): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (harness.backgroundTasks.processRecords().every((record) => record.status !== "running" && record.status !== "stopping")) return;
    await Bun.sleep(2);
  }
}

describe("the parent's process list for a subagent", () => {
  for (const by of ["person", "runtime"] as const) {
    test(`a child that the ${by} interrupted lists as interrupted, not failed, and leaves the active work count`, async () => {
      const { harness, runs } = heldRuns();
      try {
        const { child } = await dispatchChild(harness);
        expect(harness.backgroundTasks.activeBackgroundCommands()).toHaveLength(1);

        await liveChildRun(harness.reader, child)?.child.pause(by);
        await settledRecords(harness);

        expect(harness.backgroundTasks.processRecords()).toEqual([expect.objectContaining({ kind: "subagent", status: "interrupted" })]);
        expect(harness.backgroundTasks.activeBackgroundCommands()).toEqual([]);
        const list = await createProcessTool(harness.backgroundTasks).execute({ action: "list" }, toolContext);
        expect(list.content).toContain("| interrupted | subagent |");
        expect(list.content).not.toContain("| failed |");
      } finally {
        for (const run of runs) run.done.resolve({ durationMs: 1, terminal: { kind: "aborted" } });
        await harness.close();
      }
    });
  }

  test("a child whose run fails still lists as failed", async () => {
    const { harness, runs } = heldRuns();
    try {
      await dispatchChild(harness);
      runs[0]?.done.reject(new Error("provider broke"));
      await Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)));
      expect(harness.backgroundTasks.processRecords()).toEqual([expect.objectContaining({ kind: "subagent", status: "failed" })]);
    } finally {
      for (const run of runs) run.done.resolve({ durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });
});
