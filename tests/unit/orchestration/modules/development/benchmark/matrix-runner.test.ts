import { describe, expect, it } from "bun:test";
import { ChatRoutingFailure } from "../../../../../../src/orchestration/modules/development/benchmark/chat-routing-run.js";
import { DEFAULT_BENCHMARK_CONCURRENCY, completionIndex, planMatrix, runMatrix } from "../../../../../../src/orchestration/modules/development/benchmark/matrix-runner.js";
import { unavailableBenchmarkAccounting } from "../../../../../../src/orchestration/modules/development/benchmark/evidence.js";

describe("benchmark matrix runner", () => {
  it("plans the Cartesian product and shares one completion index", async () => {
    const groups = planMatrix(["a", "b"], ["x", "y"], 2).map((group) =>
      group.map((cell) => ({ variant: cell.variant, fixture: cell.fixture, repeat: cell.repeat })),
    );
    expect(groups).toHaveLength(2);
    expect(groups.flat()).toHaveLength(8);
    const completed = completionIndex([{ variant: "a", fixture: "x", repeat: 0 }], (row) => row);
    const ran: string[] = [];
    const failures = await runMatrix({
      groups,
      completed,
      run: async (cell) => { ran.push(`${cell.variant}/${cell.fixture}/${cell.repeat}`); return cell; },
      persist: async () => {},
      onError: () => {},
    });
    expect(failures).toBe(0);
    expect(ran).toHaveLength(7);
    expect(ran).not.toContain("a/x/0");
  });

  it("rejects duplicate completion authority", () => {
    const rows = [{ variant: "a", fixture: "x", repeat: 0 }, { variant: "a", fixture: "x", repeat: 0 }];
    expect(() => completionIndex(rows, (row) => row)).toThrow(/Duplicate completed matrix cell/);
  });

  it("advances a fast variant lane without waiting for a slow sibling lane", async () => {
    const slow = Promise.withResolvers<void>();
    const fastFirst = Promise.withResolvers<void>();
    const started: string[] = [];
    const groups = planMatrix(["fast", "slow"], ["one", "two"], 1);
    const run = async (cell: (typeof groups)[number][number]) => {
      started.push(`${cell.variant}/${cell.fixture}`);
      if (cell.variant === "slow" && cell.fixture === "one") await slow.promise;
      return cell;
    };
    const running = runMatrix({
      groups,
      completed: new Set(),
      run,
      persist: async (cell) => { if (cell.variant === "fast" && cell.fixture === "one") fastFirst.resolve(); },
      onError: () => {},
      concurrency: 2,
    });
    await fastFirst.promise;
    await Bun.sleep(0);
    const fastAdvanced = started.includes("fast/two");
    slow.resolve();
    expect(await running).toBe(0);
    expect(fastAdvanced).toBe(true);
    expect(started.indexOf("fast/two")).toBeLessThan(started.indexOf("slow/two"));
  });

  it("requeues a progressing lane behind lanes that are already waiting", async () => {
    const started: string[] = [];
    const groups = [
      [{ variant: "a", fixture: "1", repeat: 0 }, { variant: "a", fixture: "2", repeat: 0 }],
      [{ variant: "b", fixture: "1", repeat: 0 }, { variant: "b", fixture: "2", repeat: 0 }],
    ];

    await runMatrix({
      groups,
      completed: new Set(),
      run: async (cell) => {
        started.push(`${cell.variant}${cell.fixture}`);
        return cell;
      },
      persist: async () => {},
      onError: () => {},
      concurrency: 1,
    });

    expect(started).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("defaults to four active cells while preserving the whole group", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const running = runMatrix({
      groups: ["a", "b", "c", "d", "e", "f"].map((variant) => [{ variant, fixture: "x", repeat: 0 }]),
      completed: new Set(),
      run: async (cell) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        active--;
        return cell;
      },
      persist: async () => {},
      onError: () => {},
    });
    await Bun.sleep(0);
    expect(active).toBe(DEFAULT_BENCHMARK_CONCURRENCY);
    for (const release of releases.splice(0)) release();
    await Bun.sleep(0);
    for (const release of releases.splice(0)) release();
    expect(await running).toBe(0);
    expect(peak).toBe(4);
  });

  it("records a stalled timeout without completion and reschedules exactly that cell", async () => {
    const groups = [[{ variant: "ok", fixture: "x", repeat: 0 }, { variant: "stalled", fixture: "x", repeat: 0 }]];
    const completed: typeof groups[number] = [];
    const attempts: Array<{ variant: string; terminal: ChatRoutingFailure["terminal"] }> = [];
    await runMatrix({
      groups,
      completed: new Set(),
      run: async (cell) => {
        if (cell.variant === "stalled") throw new ChatRoutingFailure(
          { kind: "timed-out", timeoutMs: 50 },
          50,
          unavailableBenchmarkAccounting("the test cell timed out"),
        );
        return cell;
      },
      persist: async (_cell, result) => { completed.push(result); },
      onError: (cell, error) => {
        if (!(error instanceof ChatRoutingFailure)) throw error;
        attempts.push({ variant: cell.variant, terminal: error.terminal });
      },
    });
    expect(completed.map((cell) => cell.variant)).toEqual(["ok"]);
    expect(attempts).toEqual([{ variant: "stalled", terminal: { kind: "timed-out", timeoutMs: 50 } }]);
    const resumed: string[] = [];
    await runMatrix({ groups, completed: completionIndex(completed, (row) => row), run: async (cell) => { resumed.push(cell.variant); return cell; }, persist: async () => {}, onError: () => {} });
    expect(resumed).toEqual(["stalled"]);
  });
});
