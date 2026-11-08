import { describe, it, expect } from "bun:test";

import type { ToolCall } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import {
  createObserverChain,
  createBudgetAwarenessObserver,
  createContextPressureObserver,
} from "../../../../../src/orchestration/agent-runtime/batch-observers.js";
import { createRepetitionGuard } from "../../../../../src/orchestration/agent-runtime/doom-loop.js";

let callCount = 0;
function call(name: string, input: ToolCall["input"] = {}): ToolCall {
  return { id: `tu_${callCount++}`, name, input };
}

const none = new Set<string>();

describe("RepetitionGuard", () => {
  it("sends its notice in the batch where the third identical call settles", () => {
    const guard = createRepetitionGuard();
    expect(guard.observeBatch([call("bash", { command: "bun run test" })], none)).toBeNull();
    expect(guard.observeBatch([call("bash", { command: "bun run test" })], none)).toBeNull();
    const notice = guard.observeBatch([call("bash", { command: "bun run test" })], none);
    expect(notice).toContain("<repetition_notice>");
    expect(notice).toContain("The same tool call has repeated 3 or more times");
  });

  it("finds an ABAB cycle inside one batch", () => {
    const guard = createRepetitionGuard();
    const batch = Array.from({ length: 3 }, () => [call("Read", { file_path: "/a.ts" }), call("Write", { file_path: "/a.ts", content: "x" })]).flat();
    expect(guard.observeBatch(batch, none)).toContain("sequence of 2 tool calls");
  });

  it("does not fire for commands that differ only after a long shared prefix", () => {
    const guard = createRepetitionGuard();
    const prefix = `cd ${"/work/session/scratch".repeat(8)} && python3 -c "import pyarrow.parquet as pq; d = pq.read_table('data.parquet');`;
    const batch = ["print(d.num_rows)", "print(d.schema)", "print(d.column(0))"].map((tail) => call("bash", { command: `${prefix} ${tail}"` }));
    expect(guard.observeBatch(batch, none)).toBeNull();
  });

  it("does not fire for varied calls or calls that differ only in object-valued arguments", () => {
    const guard = createRepetitionGuard();
    expect(guard.observeBatch([call("Read", { file_path: "/a.ts" }), call("Write", { file_path: "/b.ts" }), call("Bash", { command: "ls" })], none)).toBeNull();
    expect(guard.observeBatch([
      call("edit", { ops: { path: "/a.ts", line: 1 } }),
      call("edit", { ops: { path: "/b.ts", line: 9 } }),
      call("edit", { ops: { path: "/c.ts", line: 4 } }),
    ], none)).toBeNull();
  });

  it("reports a pattern once, until a new call extends it", () => {
    const guard = createRepetitionGuard();
    expect(guard.observeBatch([call("Read", { file_path: "/foo.ts" }), call("Read", { file_path: "/foo.ts" }), call("Read", { file_path: "/foo.ts" })], none)).not.toBeNull();
    expect(guard.observeBatch([], none)).toBeNull();
    expect(guard.observeBatch([call("Read", { file_path: "/foo.ts" })], none)).not.toBeNull();
  });

  it("leaves a parked wait out of the history and keeps a wait that found nothing to wait for", () => {
    const parked = createRepetitionGuard();
    for (let i = 0; i < 3; i++) {
      const wait = call("process", { action: "wait" });
      expect(parked.observeBatch([wait], new Set([wait.id]))).toBeNull();
    }
    const empty = createRepetitionGuard();
    const notices = Array.from({ length: 3 }, () => empty.observeBatch([call("process", { action: "wait" })], none));
    expect(notices.at(-1)).toContain("<repetition_notice>");
  });

  it("still finds a repeated failing call between parked waits", () => {
    const guard = createRepetitionGuard();
    const notices = Array.from({ length: 3 }, () => {
      const wait = call("process", { action: "wait" });
      return guard.observeBatch([call("bash", { command: "bun run missing-script" }), wait], new Set([wait.id]));
    });
    expect(notices.slice(0, 2)).toEqual([null, null]);
    expect(notices[2]).toContain("The same tool call");
  });

  it("starts its history again at reset", () => {
    const guard = createRepetitionGuard();
    guard.observeBatch([call("Read", { file_path: "/foo.ts" }), call("Read", { file_path: "/foo.ts" })], none);
    guard.reset();
    expect(guard.observeBatch([call("Read", { file_path: "/foo.ts" })], none)).toBeNull();
  });
});

describe("ObserverChain", () => {
  it("isolates a throwing middle observer for every operation", async () => {
    const calls: string[] = [];
    const observer = (name: string, throws: boolean) => ({
      async onBatchSettled(): Promise<string | null> { calls.push(`${name}:batch`); if (throws) throw new Error(name); return name; },
      reset(): void { calls.push(`${name}:reset`); if (throws) throw new Error(name); },
    });
    const chain = createObserverChain([observer("first", false), observer("middle", true), observer("last", false)]);

    expect(await chain.onBatchSettled()).toEqual(["first", "last"]);
    chain.reset();
    expect(calls).toEqual(["first:batch", "middle:batch", "last:batch", "first:reset", "middle:reset", "last:reset"]);
  });
});

describe("BudgetAwarenessObserver", () => {
  it("names only the low limit once, again when another limit joins it, and again after reset", async () => {
    let info = { remainingCalls: Number.POSITIVE_INFINITY, remainingTokens: 5_000 };
    const observer = createBudgetAwarenessObserver(() => info);
    const first = await observer.onBatchSettled();
    expect(first).toContain("<workflow_budget_notice>");
    expect(first).toContain("Workflow budget running low: 5000 tokens remain. This agent can finish, but no attempt starts after the budget runs out.");
    expect(await observer.onBatchSettled()).toBeNull();
    info = { remainingCalls: 4, remainingTokens: 4_000 };
    expect(await observer.onBatchSettled()).toContain("4 attempts and 4000 tokens remain");
    observer.reset();
    expect(await observer.onBatchSettled()).not.toBeNull();
  });

  it("does not fire when the budget is unlimited or at the boundary", async () => {
    expect(await createBudgetAwarenessObserver(() => null).onBatchSettled()).toBeNull();
    expect(await createBudgetAwarenessObserver(() => ({ remainingCalls: 5, remainingTokens: 100_000 })).onBatchSettled()).toBeNull();
  });
});

describe("ContextPressureObserver", () => {
  it("fires once above 60% and not at exactly 60%", async () => {
    expect(await createContextPressureObserver(() => 60).onBatchSettled()).toBeNull();
    const observer = createContextPressureObserver(() => 61);
    expect(await observer.onBatchSettled()).toContain("Context is filling up.");
    expect(await observer.onBatchSettled()).toBeNull();
  });
});
