import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import type { WorkflowVmHostDeps } from "../../../../src/workflows/vm/host-types.js";
import { attemptOf, items, mapSkills, mapWorkflow, PLAN, stage, TAIL, withMaxParallel } from "./_map-fixtures.js";
import { mapHost, SqliteVmDriver } from "./_sqlite-vm-driver.js";

// The production host runs every ready attempt that waits on no other at
// once, and folds each result as it arrives.

const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

const factsOf = (vm: SqliteVmDriver, type: string) => vm.events().filter((event) => event.type === type);

/** When each attempt of a run started and finished, and how many ran at
 *  once. */
interface Timeline {
  readonly started: string[];
  readonly finished: string[];
  /** The attempts that had finished when each attempt started. */
  readonly finishedAtStart: Map<string, readonly string[]>;
  inFlight: number;
  maxInFlight: number;
}

const timeline = (): Timeline => ({ started: [], finished: [], finishedAtStart: new Map(), inFlight: 0, maxInFlight: 0 });

/** Lets the event loop run `count` times, so every attempt the host can
 *  start has started. */
async function turns(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** A gate that opens once `count` attempts that it holds wait at once, or,
 *  so a serial host fails the test instead of hanging, once the event loop
 *  ran a while with fewer. It stays open. */
function overlapGate(count: number): (attemptId: string) => Promise<void> {
  const open = Promise.withResolvers<void>();
  let waiting = 0;
  return async () => {
    waiting += 1;
    if (waiting >= count) open.resolve();
    await Promise.race([open.promise, turns(200)]);
  };
}

/** Answers every attempt of the map fixture with a handoff after `gate`
 *  lets it go, recording the run on `line`. */
function timedRunner(line: Timeline, gate: (attemptId: string, definitionId: string) => Promise<void>): WorkflowVmHostDeps["attemptRunner"]["run"] {
  return async (input, active) => {
    line.started.push(input.attemptId);
    line.finishedAtStart.set(input.attemptId, [...line.finished]);
    line.inFlight += 1;
    line.maxInFlight = Math.max(line.maxInFlight, line.inFlight);
    try {
      await gate(input.attemptId, input.definitionId);
    } finally {
      line.inFlight -= 1;
    }
    line.finished.push(input.attemptId);
    const handoff = input.definitionId === "plan"
      ? { summary: "The plan.", items: items("a", "b", "c") }
      : { summary: `${input.definitionId} of ${JSON.stringify(input.item)}` };
    return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff, reassessment: null };
  };
}

/** The attempts whose success the run committed, once for each commit. */
const succeededAttempts = (vm: SqliteVmDriver): string[] => factsOf(vm, "attempt.succeeded").flatMap(({ payload }) =>
  typeof payload === "object" && payload !== null && "attemptId" in payload && typeof payload.attemptId === "string" ? [payload.attemptId] : []);

describe("concurrent attempts through the production host", () => {
  it("starts every ready attempt at once with no default cap, runs each branch's chain in order, and joins only after every branch", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const firstStages = overlapGate(3);
    const records: { readonly type: string; readonly payload?: unknown }[] = [];
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry); });
    try {
      const gate = (_attemptId: string, definitionId: string) => definitionId === "implement" ? firstStages(_attemptId) : Promise.resolve();
      expect((await mapHost(vm, "launch", timedRunner(line, gate)).run()).kind).toBe("completed");
    } finally {
      record.mockRestore();
    }

    // The three branches' first stages ran at the same time.
    expect(line.maxInFlight).toBe(3);
    expect(line.started.slice(0, 4)).toEqual([PLAN, stage(1, 1), stage(2, 1), stage(3, 1)].map(attemptOf));
    // A branch's second stage waits for its own first stage only.
    for (const ordinal of [1, 2, 3]) {
      expect(line.finishedAtStart.get(attemptOf(stage(ordinal, 2)))).toContain(attemptOf(stage(ordinal, 1)));
    }
    // The join waits for every branch, and the tail reads it after.
    expect(line.started.at(-1)).toBe(attemptOf(TAIL));
    expect(line.finishedAtStart.get(attemptOf(TAIL))).toEqual(expect.arrayContaining([1, 2, 3].flatMap((ordinal) => [stage(ordinal, 1), stage(ordinal, 2)]).map(attemptOf)));
    expect(factsOf(vm, "group.settled")[0]?.payload.summary).toEqual({ total: 3, completed: 3, failed: 0 });
    // One record names each batch that admission started, with no content.
    const admitted = records.filter(({ type }) => type === "workflow.attempts.admitted").map(({ payload }) => payload);
    expect(admitted).toContainEqual({ admitted: 3, running: 3, waiting: 0, cap: null });
    // Strict replay derives the same control from the facts.
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("caps how many attempts run at once at the author's max_parallel", async () => {
    const vm = new SqliteVmDriver({ workflow: withMaxParallel(mapWorkflow, 2), skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const gate = overlapGate(2);
    const records: { readonly type: string; readonly payload?: unknown }[] = [];
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry); });
    try {
      expect((await mapHost(vm, "launch", timedRunner(line, (attemptId, definitionId) => definitionId === "plan" ? Promise.resolve() : gate(attemptId))).run()).kind).toBe("completed");
    } finally {
      record.mockRestore();
    }

    expect(line.maxInFlight).toBe(2);
    expect(line.started).toHaveLength(8);
    expect(records.filter(({ type }) => type === "workflow.attempts.admitted").map(({ payload }) => payload)).toContainEqual({ admitted: 2, running: 2, waiting: 1, cap: 2 });
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("reaches the same graph, join, and tail input whatever order the parallel attempts finish in", async () => {
    async function runInOrder(finishOrder: readonly number[]) {
      const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
      drivers.push(vm);
      await vm.initialize();
      const line = timeline();
      const release = new Map([1, 2, 3].map((ordinal) => [attemptOf(stage(ordinal, 1)), Promise.withResolvers<void>()]));
      const tail = Promise.withResolvers<{ readonly artifacts: readonly string[]; readonly prior: string | undefined }>();
      const answer = timedRunner(line, (attemptId) => release.get(attemptId)?.promise ?? Promise.resolve());
      const host = mapHost(vm, "launch", async (input, active) => {
        if (input.attemptId === attemptOf(TAIL)) {
          const context = await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope });
          tail.resolve({ artifacts: context.artifacts.map(({ id, value }) => `${id}:${JSON.stringify(value)}`), prior: context.priorHandoff?.entryId });
        }
        return answer(input, active);
      });
      const running = host.run();
      while (line.inFlight < 3) await turns(1);
      for (const ordinal of finishOrder) {
        const attemptId = attemptOf(stage(ordinal, 1));
        release.get(attemptId)?.resolve();
        while (!line.finished.includes(attemptId)) await turns(1);
        await turns(20);
      }
      expect((await running).kind).toBe("completed");
      expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
      const control = vm.freshViews().control;
      return {
        finished: line.finished,
        nodes: control.graph.nodes.map(({ id, state }) => `${id}=${state._tag}`),
        attempts: control.attempts.map(({ id, state }) => `${id}=${state._tag}`),
        settled: factsOf(vm, "group.settled").map(({ payload }) => payload),
        tail: await tail.promise,
      };
    }

    const forward = await runInOrder([1, 2, 3]);
    const reverse = await runInOrder([3, 2, 1]);
    // The runs finished in different orders...
    const firstStages = (finished: readonly string[]) => finished.filter((attemptId) => attemptId.includes(":phase:1:"));
    expect(firstStages(forward.finished)).toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))));
    expect(firstStages(reverse.finished)).toEqual([3, 2, 1].map((ordinal) => attemptOf(stage(ordinal, 1))));
    // ...and reached the same state in graph order.
    expect(reverse.nodes).toEqual(forward.nodes);
    expect(reverse.attempts).toEqual(forward.attempts);
    expect(reverse.settled).toEqual(forward.settled);
    expect(reverse.tail).toEqual(forward.tail);
  });

  it("interrupts every attempt in flight at a Stop, and a Resume runs each of them once", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const answer = timedRunner(line, () => Promise.resolve());
    const interrupted: string[] = [];
    const first = mapHost(vm, "launch", async (input, active) => {
      if (input.definitionId !== "implement") return answer(input, active);
      line.started.push(input.attemptId);
      line.inFlight += 1;
      await new Promise<void>((resolve) => { active.signal.addEventListener("abort", () => resolve(), { once: true }); });
      interrupted.push(input.attemptId);
      throw active.signal.reason;
    });
    const running = first.run();
    while (line.inFlight < 3) await turns(1);
    await first.abort("Runtime shutdown");
    expect((await running).kind).toBe("paused");
    expect(interrupted.toSorted()).toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))).toSorted());
    expect(succeededAttempts(vm)).toEqual([attemptOf(PLAN)]);

    const resumed = timeline();
    expect((await mapHost(vm, "operator_resume", timedRunner(resumed, () => Promise.resolve())).run()).kind).toBe("completed");
    // Each interrupted attempt ran once more, under its own identity, and
    // nothing that completed ran again.
    expect(resumed.started.filter((attemptId) => attemptId.includes(":phase:1:")).toSorted()).toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))).toSorted());
    expect(resumed.started).not.toContain(attemptOf(PLAN));
    const succeeded = succeededAttempts(vm);
    expect(succeeded).toHaveLength(new Set(succeeded).size);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("recovers a run that stopped with attempts in flight, and runs each of them once", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const answer = timedRunner(line, () => Promise.resolve());
    // The process stops while three attempts run: their workers never
    // answer, and nothing aborts them.
    void mapHost(vm, "launch", async (input, active) => {
      if (input.definitionId !== "implement") return answer(input, active);
      line.started.push(input.attemptId);
      line.inFlight += 1;
      return await new Promise<never>(() => {});
    }).run();
    while (line.inFlight < 3) await turns(1);
    const stopped = vm.freshViews().control;
    expect(stopped.attempts.filter(({ state }) => state._tag === "running").map(({ id }) => id)).toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))));

    const recovered = timeline();
    expect((await mapHost(vm, "operator_resume", timedRunner(recovered, () => Promise.resolve())).run()).kind).toBe("completed");
    expect(recovered.started.filter((attemptId) => attemptId.includes(":phase:1:")).toSorted()).toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))).toSorted());
    const succeeded = succeededAttempts(vm);
    expect(succeeded).toHaveLength(new Set(succeeded).size);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  /** An answer that holds each first stage until the test releases it, then
   *  fails `failing` with a transient error and answers the others with a
   *  handoff. It records which attempts' signals aborted. */
  function heldFirstStages(line: Timeline, failing: number) {
    const release = new Map([1, 2, 3].map((ordinal) => [attemptOf(stage(ordinal, 1)), Promise.withResolvers<void>()]));
    const aborted: string[] = [];
    const answer = timedRunner(line, () => Promise.resolve());
    const run: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      const held = release.get(input.attemptId);
      if (!held) return answer(input, active);
      active.signal.addEventListener("abort", () => { aborted.push(input.attemptId); }, { once: true });
      line.started.push(input.attemptId);
      line.inFlight += 1;
      await held.promise;
      line.inFlight -= 1;
      line.finished.push(input.attemptId);
      if (input.attemptId === attemptOf(stage(failing, 1))) {
        return { kind: "transient", attemptId: input.attemptId, conversationId: active.conversationId, reason: "provider not responding" };
      }
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: `implement of ${JSON.stringify(input.item)}` }, reassessment: null };
    };
    return { run, aborted, release: (ordinal: number) => release.get(attemptOf(stage(ordinal, 1)))?.resolve() };
  }

  for (const timing of ["at the same moment", "after the failure"] as const) {
    it(`keeps every sibling that finishes ${timing} when one attempt fails, and fails only that attempt's branch`, async () => {
      const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
      drivers.push(vm);
      await vm.initialize();
      const line = timeline();
      const held = heldFirstStages(line, 1);
      const running = mapHost(vm, "launch", held.run).run();
      while (line.inFlight < 3) await turns(1);
      held.release(1);
      if (timing === "after the failure") await turns(20);
      held.release(2);
      held.release(3);
      // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
      expect((await running).kind).toBe("failed");

      // The failure stopped no sibling, and only its own branch stopped.
      expect(held.aborted).toEqual([]);
      expect(factsOf(vm, "attempt.failed").map(({ payload }) => payload)).toEqual([
        { attemptId: attemptOf(stage(1, 1)), kind: "transient", reason: "provider not responding" },
      ]);
      expect(factsOf(vm, "attempt.reverted")).toEqual([]);
      expect(line.started).not.toContain(attemptOf(stage(1, 2)));
      expect(succeededAttempts(vm).toSorted()).toEqual([PLAN, stage(2, 1), stage(2, 2), stage(3, 1), stage(3, 2), TAIL].map(attemptOf).toSorted());
      expect(factsOf(vm, "group.settled")[0]?.payload.summary).toEqual({ total: 3, completed: 2, failed: 1 });
      expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
    });
  }

  it("settles each attempt in flight that fails as failed, once, and runs the work after the join", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const answer = timedRunner(line, () => Promise.resolve());
    const outage = overlapGate(3);
    const running = mapHost(vm, "launch", async (input, active) => {
      if (input.definitionId !== "implement") return answer(input, active);
      await outage(input.attemptId);
      return { kind: "transient", attemptId: input.attemptId, conversationId: active.conversationId, reason: "provider not responding" };
    }).run();
    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect((await running).kind).toBe("failed");
    expect(factsOf(vm, "attempt.reverted")).toEqual([]);
    expect(factsOf(vm, "attempt.failed").map(({ payload }) => payload.attemptId).toSorted())
      .toEqual([1, 2, 3].map((ordinal) => attemptOf(stage(ordinal, 1))).toSorted());
    expect(vm.freshViews().control.attempts.filter(({ state }) => state._tag === "running")).toEqual([]);
    expect(factsOf(vm, "group.settled")[0]?.payload.summary).toEqual({ total: 3, completed: 0, failed: 3 });
    expect(succeededAttempts(vm)).toEqual([PLAN, TAIL].map(attemptOf));
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("lets the attempts in flight finish when the start policy refuses a new attempt", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const held = heldFirstStages(line, 0);
    const refused = attemptOf(stage(1, 2));
    const running = mapHost(vm, "launch", held.run, { preAttemptPolicy: ({ attemptId }) => attemptId === refused ? "Budget reached" : null }).run();
    while (line.inFlight < 3) await turns(1);
    held.release(1);
    await turns(20);
    held.release(2);
    held.release(3);
    const result = await running;
    expect(result.kind).toBe("paused");

    // The refusal aborted no attempt that ran, and the run kept their results.
    expect(held.aborted).toEqual([]);
    expect(succeededAttempts(vm)).toEqual([PLAN, stage(1, 1), stage(2, 1), stage(3, 1)].map(attemptOf));
    expect(line.started).not.toContain(refused);
    expect(factsOf(vm, "workflow.paused").map(({ payload }) => payload)).toEqual([{ reason: "Budget reached" }]);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("interrupts every attempt in flight when the host fails", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const line = timeline();
    const answer = timedRunner(line, () => Promise.resolve());
    const aborted: string[] = [];
    const failing = Promise.withResolvers<void>();
    const running = mapHost(vm, "launch", async (input, active) => {
      if (input.definitionId !== "implement") return answer(input, active);
      line.inFlight += 1;
      if (input.attemptId === attemptOf(stage(1, 1))) {
        await failing.promise;
        throw new Error("boom");
      }
      await new Promise<void>((resolve) => { active.signal.addEventListener("abort", () => resolve(), { once: true }); });
      aborted.push(input.attemptId);
      throw active.signal.reason;
    }).run();
    while (line.inFlight < 3) await turns(1);
    failing.resolve();
    expect((await running).kind).toBe("failed");
    await turns(5);
    expect(aborted.toSorted()).toEqual([stage(2, 1), stage(3, 1)].map(attemptOf));
  });
});
