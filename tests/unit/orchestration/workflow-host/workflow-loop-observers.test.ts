import { describe, expect, test } from "bun:test";

import type { EmitFn } from "../../../../src/infra/event-bus.js";
import {
  createBackgroundWorkRegistry,
  type BackgroundWorkResult,
} from "../../../../src/orchestration/agent-runtime/background-work.js";
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue.js";
import { createWorkflowLoopObservers } from "../../../../src/orchestration/workflow-host/loop-observers.js";
import { HandoffCorrectionExhausted } from "../../../../src/orchestration/agent-runtime/errors.js";
import { handoffNudge } from "../../../../src/workflows/shared/handoff-observer.js";

const emit: EmitFn = () => {};

function drainAll(queue: WorkflowInjectionQueue): string[] {
  const collected: string[] = [];
  let pending = queue.drainPending();
  while (pending !== null) {
    if (pending.kind === "message") collected.push(pending.text);
    pending = queue.drainPending();
  }
  return collected;
}

describe("createWorkflowLoopObservers", () => {
  test("a batch observer's notice reaches the agent as a runtime notice, and a post-handoff turn end enqueues nothing", async () => {
    const injectionQueue = new WorkflowInjectionQueue();
    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      observerChain: {
        async onBatchSettled() { return ["budget notice"]; },
        reset() {},
      },
      emit,
      sessionId: "wf-test",
    });

    await observers.onToolBatchSettled();
    expect(injectionQueue.drainPending()).toMatchObject({ kind: "message", text: "budget notice", origin: "silent-system", runtimeNotice: true });

    // The queue is session-scoped and outlives this worker: anything enqueued
    // here would either re-drive the exiting loop or surface in the next
    // worker's input, so a post-handoff turn end must enqueue nothing.
    await observers.onTurnEnded({ handoffWritten: true, turnCount: 4 });
    expect(drainAll(injectionQueue)).toEqual([]);
  });

  test("subagent gate suppresses handoff watchdog while tasks are pending", async () => {
    const injectionQueue = new WorkflowInjectionQueue();
    const backgroundTasks = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => { injectionQueue.enqueue(text, { silent: true }); },
    });
    const done = Promise.withResolvers<BackgroundWorkResult>();
    backgroundTasks.track({
      done: done.promise,
      meta: { id: "t1", type: "subagent", description: "reviewer" },
    });

    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      backgroundTasks,
      emit,
      sessionId: "wf-test",
    });

    // Text-only turns must stay silent while a subagent is pending,
    // because the agent is legitimately waiting on its completion.
    await observers.onTurnEnded({ handoffWritten: false, turnCount: 1 });
    await observers.onTurnEnded({ handoffWritten: false, turnCount: 2 });

    expect(drainAll(injectionQueue)).toEqual([]);
  });

  test("handoff watchdog nudges on every text-only turn while only a service runs", async () => {
    const injectionQueue = new WorkflowInjectionQueue();
    // A service wakes nothing, so the step must still be asked for its
    // handoff; the handoff refusal then tells it to stop the service.
    const backgroundTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    backgroundTasks.track({
      done: new Promise<never>(() => {}),
      meta: { id: "command-1", type: "background_command", description: "python3 server.py" },
      service: true,
    });
    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      backgroundTasks,
      emit,
      sessionId: "wf-test",
    });

    await observers.onTurnEnded({ handoffWritten: false, turnCount: 1 });
    const afterFirst = drainAll(injectionQueue);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toContain("call handoff");

    await observers.onTurnEnded({ handoffWritten: false, turnCount: 2 });
    const afterSecond = drainAll(injectionQueue);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toContain("call handoff");
  });

  test("a worker that stops without a handoff after two reminders breaks its handoff contract", async () => {
    const injectionQueue = new WorkflowInjectionQueue();
    const observers = createWorkflowLoopObservers({ parentChannel: true, injectionQueue, emit, sessionId: "wf-test" });

    for (const turnCount of [1, 2]) {
      await observers.onTurnEnded({ handoffWritten: false, turnCount });
      expect(drainAll(injectionQueue)).toEqual([handoffNudge(true)]);
    }
    const third = observers.onTurnEnded({ handoffWritten: false, turnCount: 3 });
    await expect(third).rejects.toBeInstanceOf(HandoffCorrectionExhausted);
    await expect(third).rejects.toThrow("The agent stopped 3 times without a handoff, after 2 reminders");
    expect(drainAll(injectionQueue)).toEqual([]);

    // A new runner attempt of the step starts with no reminder spent.
    observers.reset();
    await observers.onTurnEnded({ handoffWritten: false, turnCount: 1 });
    expect(drainAll(injectionQueue)).toEqual([handoffNudge(true)]);
  });

  test("a person's message, a parent's message, or a Resume starts the reminders over, because only stops that answer a reminder count", async () => {
    const injectionQueue = new WorkflowInjectionQueue();
    const observers = createWorkflowLoopObservers({ parentChannel: true, injectionQueue, emit, sessionId: "wf-test" });
    const stopTwice = async (): Promise<void> => {
      for (const turnCount of [1, 2]) {
        await observers.onTurnEnded({ handoffWritten: false, turnCount });
        expect(observers.inputSource.drainPending()).toMatchObject({ kind: "message", text: handoffNudge(true) });
      }
    };
    for (const deliver of [
      () => { injectionQueue.enqueueMessage({ text: "What did you find?" }); },
      () => { injectionQueue.enqueueMessage({ text: "Continue", producer: { kind: "session", sessionId: "parent", conversationId: "conversation", toolUseId: "tool", hop: 1 } }); },
      () => { injectionQueue.enqueueResume(); },
    ]) {
      await stopTwice();
      deliver();
      expect(observers.inputSource.drainPending()).not.toBeNull();
    }
    await stopTwice();
    await expect(observers.onTurnEnded({ handoffWritten: false, turnCount: 3 })).rejects.toBeInstanceOf(HandoffCorrectionExhausted);
  });
});
