import { describe, expect, it } from "bun:test";

import type { AgentRunResult, Agent } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createChildSlotRegistry } from "../../../../../src/orchestration/agent-runtime/child-slot-registry.js";
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";

interface ControlledRunner {
  runner: Agent;
  resolve: (result: AgentRunResult) => void;
  reject: PromiseWithResolvers<AgentRunResult>["reject"];
}

function createControlledRunner(): ControlledRunner {
  const { promise, resolve, reject } = Promise.withResolvers<AgentRunResult>();
  return {
    runner: {
      send(): void {},
      end(): void {},
      abort(): void {
        reject(new DOMException("The operation was aborted", "AbortError"));
      },
      done: promise,
    },
    resolve,
    reject,
  };
}

function completedResult(): AgentRunResult {
  return { servedRequests: 0, durationMs: 1, providerSessionKey: "controlled", terminal: { kind: "completed" } };
}

async function flushPromiseHandlers(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const DISPATCH = {
  persona: "explorer",
  rationale: TEST_RATIONALE,
  prompt: "inspect the relevant code",
};

describe("subagent concurrency reservation", () => {
  it("queues at cap and starts automatically when a slot frees", async () => {
    const slots = createChildSlotRegistry(1);
    const controls: ControlledRunner[] = [];
    const secondStarted = Promise.withResolvers<void>();
    const tool = createSubagentDispatch(makeDeps({
      childSlots: slots,
      createRunner: () => {
        const control = createControlledRunner();
        controls.push(control);
        if (controls.length === 2) secondStarted.resolve();
        return control.runner;
      },
    }));

    const first = await tool.execute(DISPATCH, makeContext());
    const second = await tool.execute(DISPATCH, makeContext());

    expect(first.outcome).toBe("ok");
    expect(JSON.parse(first.content).status).toBe("running");
    expect(second.outcome).toBe("ok");
    const queuedAck = JSON.parse(second.content);
    expect(queuedAck.status).toBe("queued");
    expect(queuedAck.queue_position).toBe(1);
    expect(controls).toHaveLength(1);

    controls[0]!.resolve(completedResult());
    await secondStarted.promise;

    expect(controls).toHaveLength(2);
    controls[1]!.resolve(completedResult());
  });

  it("cancels a queued dispatch on teardown without starting it", async () => {
    const slots = createChildSlotRegistry(1);
    const controls: ControlledRunner[] = [];
    const backgroundTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const tool = createSubagentDispatch(makeDeps({
      backgroundTasks,
      childSlots: slots,
      createRunner: () => {
        const control = createControlledRunner();
        controls.push(control);
        return control.runner;
      },
    }));

    await tool.execute(DISPATCH, makeContext());
    const second = await tool.execute(DISPATCH, makeContext());
    expect(JSON.parse(second.content).status).toBe("queued");

    await backgroundTasks.terminateAll();

    expect(controls).toHaveLength(1);
    const next = await tool.execute(DISPATCH, makeContext());
    expect(JSON.parse(next.content).status).toBe("running");
    controls[1]!.resolve(completedResult());
  });

  it("releases a slot when a child completes", async () => {
    const slots = createChildSlotRegistry(1);
    const controls: ControlledRunner[] = [];
    const tool = createSubagentDispatch(makeDeps({
      childSlots: slots,
      createRunner: () => {
        const control = createControlledRunner();
        controls.push(control);
        return control.runner;
      },
    }));

    await tool.execute(DISPATCH, makeContext());
    controls[0]!.resolve(completedResult());
    await flushPromiseHandlers();

    expect((await tool.execute(DISPATCH, makeContext())).outcome).toBe("ok");
    expect(controls).toHaveLength(2);
    controls[1]!.resolve(completedResult());
  });

  it("releases a slot when a child fails", async () => {
    const slots = createChildSlotRegistry(1);
    const controls: ControlledRunner[] = [];
    const tool = createSubagentDispatch(makeDeps({
      childSlots: slots,
      createRunner: () => {
        const control = createControlledRunner();
        controls.push(control);
        return control.runner;
      },
    }));

    await tool.execute(DISPATCH, makeContext());
    controls[0]!.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider crashed", recovery: { kind: "none" } } });
    await flushPromiseHandlers();

    expect((await tool.execute(DISPATCH, makeContext())).outcome).toBe("ok");
    controls[1]!.resolve(completedResult());
  });

  it("releases a slot when parent teardown aborts a child", async () => {
    const slots = createChildSlotRegistry(1);
    const controls: ControlledRunner[] = [];
    const backgroundTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const tool = createSubagentDispatch(makeDeps({
      backgroundTasks,
      childSlots: slots,
      createRunner: () => {
        const control = createControlledRunner();
        controls.push(control);
        return control.runner;
      },
    }));

    await tool.execute(DISPATCH, makeContext());
    await backgroundTasks.terminateAll();

    expect((await tool.execute(DISPATCH, makeContext())).outcome).toBe("ok");
    controls[1]!.resolve(completedResult());
  });
});
