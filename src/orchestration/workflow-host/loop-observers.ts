/**
 * Workflow loop observers and input source. Replaces the prior `TurnPolicy`
 * abstraction with explicit producers: each observer (handoff watchdog,
 * observer chain, subagent completion gate) owns its predicate and
 * enqueues into the injection queue when its predicate fires. The agent loop
 * unconditionally drains after firing the lifecycle hooks.
 *
 * Returns the shape the loop expects: `inputSource` (drain + park),
 * `onToolBatchSettled`, and `onTurnEnded`, plus a `reset` hook so
 * observer-chain state can be cleared between runner attempts.
 */

import { createHandoffObserver } from "../../workflows/shared/handoff-observer.js";
import type {
  AgentLoopInput,
  InputSource,
  TurnEndedContext,
} from "../../infra/agent-loop-events.js";
import type { EmitFn } from "../../infra/event-bus.js";
import { Log } from "../../infra/log.js";
import { awaitsWork, type BackgroundWorkRegistry } from "../agent-runtime/background-work.js";
import { HandoffCorrectionExhausted } from "../agent-runtime/errors.js";
import type { WorkflowInjectionQueue } from "./injection-queue.js";

const log = Log.create({ service: "workflow-loop-observers" });

/** How many reminders an attempt gets when it stops without a handoff.
 *  The next such stop breaks the agent's handoff contract, so the attempt fails
 *  and its authored retry, if any, runs. Without a limit, a model that never
 *  calls handoff loops for as long as its budget allows. Only stops that
 *  answer a reminder count: a person or another session can write to an
 *  agent of a workflow, and a text reply to them is not a missed handoff. */
const HANDOFF_REMINDER_LIMIT = 2;

/** Whether the agent got input from a person or another session: a message
 *  from either, or a person's Resume. A reminder, a runtime notice, and a
 *  background result come from the runtime. */
function fromOutside(input: AgentLoopInput | null): boolean {
  return input?.kind === "resume" || (input?.kind === "message" && (input.origin === "human" || input.origin === "session"));
}

interface WorkflowLoopObserversDeps {
  injectionQueue: WorkflowInjectionQueue;
  observerChain?: { onBatchSettled(): Promise<string[]>; reset(): void };
  /** Workflow subagent registry. Required to suppress the handoff watchdog
   *  while subagents are active or pending and to clear the pending bucket on
   *  injection drain. The handoff tool itself blocks premature handoffs. */
  backgroundTasks?: Extract<BackgroundWorkRegistry, { kind: "workflow" }>;
  emit: EmitFn;
  sessionId: string;
  /** Whether the agent has `message_session`, its channel to its parent. */
  parentChannel: boolean;
}

interface WorkflowLoopObservers {
  inputSource: InputSource;
  onToolBatchSettled: () => Promise<void>;
  onTurnEnded: (ctx: TurnEndedContext) => Promise<void>;
  reset: () => void;
}

export function createWorkflowLoopObservers(
  deps: WorkflowLoopObserversDeps,
): WorkflowLoopObservers {
  const { injectionQueue, observerChain, backgroundTasks, emit, sessionId, parentChannel } = deps;

  // Handoff watchdog: nudges after a text-only turn without a handoff and
  // goes quiet once the handoff lands. Same primitive subagents install
  // directly, without a limit.
  const handoffObserver = createHandoffObserver({ injectionQueue, reminderLimit: HANDOFF_REMINDER_LIMIT, parentChannel });

  // Only visible system-origin injections enter the live transcript.
  injectionQueue.onDrain((result) => {
    if (result.origin === undefined) {
      emit("agent.message.injected", { sessionId, data: { message: result.message, origin: "system" } });
    }
    log.info("injection drained to worker", { origin: result.origin ?? "nudge" });
  });

  // Each input passes through here, so input from outside the agent starts
  // the reminders over.
  const noteInput = (input: AgentLoopInput | null): AgentLoopInput | null => {
    if (fromOutside(input)) handoffObserver.resetReminders();
    return input;
  };
  const inputSource: InputSource = {
    drainPending: () => noteInput(injectionQueue.drainPending()),
    prepareWaitForInput: (signal) => {
      const reservation = injectionQueue.prepareWaitForInput(signal);
      return { commit: async () => noteInput(await reservation.commit()), cancel: () => reservation.cancel() };
    },
    enqueueRuntimeNotice: (text) => { injectionQueue.enqueueRuntimeNotice(text); },
  };

  return {
    inputSource,

    // The batch observers (workflow budget, context pressure) speak after each
    // tool batch, through the runtime-notice channel, so the agent reads the
    // notice with that batch's results (ARCH-TOOLS-007).
    async onToolBatchSettled(): Promise<void> {
      for (const notice of await observerChain?.onBatchSettled() ?? []) injectionQueue.enqueueRuntimeNotice(notice);
    },

    async onTurnEnded(ctx: TurnEndedContext): Promise<void> {
      // A worker that has written its handoff exits at this turn boundary
      // (agent-loop's canComplete). Enqueue nothing more on its behalf: a
      // leftover nudge would re-drive this loop past its exit.
      if (ctx.handoffWritten) return;

      // Suppress the handoff watchdog while work that will wake this run is
      // pending. A running service wakes nothing, so the watchdog still asks
      // for the handoff, whose refusal tells the agent to stop the service.
      if (awaitsWork(backgroundTasks?.assertHandoffReady())) return;

      if (handoffObserver.onTurnEnded(ctx) === "exhausted") {
        log.info("workflow agent stopped without a handoff after its reminders", { sessionId, reminders: handoffObserver.reminders, turnCount: ctx.turnCount });
        throw new HandoffCorrectionExhausted({
          message: `The agent stopped ${handoffObserver.reminders + 1} times without a handoff, after ${handoffObserver.reminders} reminders to call the handoff tool.`,
        });
      }
    },

    reset(): void {
      observerChain?.reset();
      handoffObserver.resetReminders();
    },
  };
}
