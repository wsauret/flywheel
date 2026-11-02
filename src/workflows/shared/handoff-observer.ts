/**
 * Handoff watchdog observer. Every agent loop that targets a handoff (workers
 * and subagents) installs one of these. Its job is attempt-scoped: remind the
 * model with `handoffNudge` on every text-only turn that ends without a
 * handoff write, and go permanently quiet once the handoff lands. With a
 * `reminderLimit`, a turn that ends without a handoff after that many
 * reminders gets no reminder, and the observer reports it exhausted, so the
 * owner of the handoff contract ends the run. The loop
 * exits on its own after the handoff (`canComplete` in agent-loop.ts); the
 * observer has no lifecycle authority over the injection queue, which is
 * session-scoped and outlives every worker.
 *
 * Composed inside `createWorkflowLoopObservers` for workflow workers (the
 * subagent gate suppresses this observer while subagents are pending,
 * so a worker waiting on outstanding subagent work is not nudged). Subagents
 * install it directly.
 *
 * The injection queue interface is narrowed locally so this file can sit in
 * `workflows/` without importing from `orchestration/`.
 */

import type { TurnEndedContext } from "../../infra/agent-loop-events.js";

interface InjectionQueueLike {
  enqueue(text: string, opts?: { silent?: boolean }): void;
}

/** The reminder after a turn that ended without a handoff. It names
 *  `message_session` only when the agent has that tool, which it has only
 *  when its host has session messaging; without it no parent can answer, so
 *  the agent decides and states its assumptions (PI-AGENT-024). */
export function handoffNudge(parentChannel: boolean): string {
  const blocked = parentChannel
    ? "message your parent with message_session and wait for its reply. "
    : "decide on your own judgment, because no parent can answer during this run, and state each assumption in your handoff. ";
  return "Automated reminder from the workflow runtime, not from the user: your last turn ended without a handoff. "
    + "If your work is complete, call the handoff tool with the required fields. "
    + "If work remains, continue working; remaining milestones or needing another implementation pass are work to continue. "
    + "Troubleshoot one hypothesis at a time and run the smallest focused experiment or proof of concept that can decide the path, then continue. "
    + `Then call handoff only when the work is done. When a concrete condition outside your control prevents the next bounded action, ${blocked}`
    + "Do not stop early because of this reminder.";
}

/** What one turn end did: nothing, one reminder, or nothing because the
 *  reminders ran out. */
type HandoffWatch = "quiet" | "reminded" | "exhausted";

interface HandoffObserver {
  onTurnEnded(ctx: TurnEndedContext): HandoffWatch;
  /** The number of reminders this observer sent. */
  readonly reminders: number;
  /** Forget the reminders: for a new attempt, or after input that
   *  did not come from the runtime. */
  resetReminders(): void;
}

export function createHandoffObserver(opts: {
  injectionQueue: InjectionQueueLike;
  reminderLimit?: number;
  /** Whether the agent has `message_session`, its channel to its parent. */
  parentChannel: boolean;
}): HandoffObserver {
  const { injectionQueue, reminderLimit } = opts;
  const nudge = handoffNudge(opts.parentChannel);
  let handoffSeen = false;
  let reminders = 0;

  return {
    onTurnEnded(ctx: TurnEndedContext): HandoffWatch {
      if (handoffSeen) return "quiet";
      if (ctx.handoffWritten) {
        handoffSeen = true;
        return "quiet";
      }
      if (reminderLimit !== undefined && reminders >= reminderLimit) return "exhausted";
      reminders += 1;
      injectionQueue.enqueue(nudge, { silent: true });
      return "reminded";
    },
    get reminders() { return reminders; },
    resetReminders() { reminders = 0; },
  };
}