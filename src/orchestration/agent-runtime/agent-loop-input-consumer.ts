import { messageInput, type AgentLoopInput, type InputWaitReservation, type TurnParkedContext, type TurnParkState } from "../../infra/agent-loop-events.js";
import { mergeAbortSignals } from "../../infra/abort.js";
import { formatRuntimeNotification } from "./runtime-notifications.js";
import { Log } from "../../infra/log.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { CurrentTurnInterruption } from "./run-lifecycle.js";
import type { PlannedCompactionOperation } from "./compaction/triggers.js";
import type { TurnHopTracker } from "./turn-hop.js";
import type { OpenWait } from "./agent-loop-state.js";
import { WAIT_EXPIRED_TAG } from "./agent-loop-wait.js";

const log = Log.create({ service: "agent-loop" });

interface LoopInputEffects {
  consumeMessage(
    input: Extract<AgentLoopInput, { kind: "message" }>,
    startLogicalTurn: boolean,
    preserveRequestContext: boolean,
  ): "continue" | Promise<"continue">;
  /** Records the continuation of an interrupted turn a person resumed. */
  consumeResume(startLogicalTurn: boolean): Promise<"continue">;
  scheduleCompaction(operation: PlannedCompactionOperation): void;
  canCompact(): boolean;
  refuseCompaction(): void;
  onCompactionContinuation?(): void | Promise<void>;
  /** The wake hop of the session's turn, which each consumed input updates. */
  readonly turnHop?: TurnHopTracker;
}

interface ConsumeLoopInputOptions {
  /** The input starts a new turn of the session: a park takes it after its
   *  turn was answered or a person resumed. The loop's first input needs no
   *  flag, because the loop reads its first hop from its history. */
  readonly startsTurn?: boolean;
  readonly startLogicalTurn?: boolean;
  readonly preserveRequestContext?: boolean;
  readonly compactAfter?: "continue" | "park";
}

/** A park's consumption: whether the input starts a new turn of the session
 *  (the park's turn was answered, or a person resumed an interrupted one)
 *  instead of continuing the turn that waits on background work. */
interface ConsumeParkedInputOptions extends ConsumeLoopInputOptions {
  readonly startsTurn: boolean;
}

/** Applies one typed loop input: a message, a Resume, a wake, or a compaction
 *  control. It admits no provider request. The person's message enters the
 *  conversation at once, and the request boundary admits the request that
 *  follows, so model routing and provider evidence never hold a sent message
 *  in its queued state. */
export async function consumeAgentLoopInput(
  input: AgentLoopInput | null | undefined,
  effects: LoopInputEffects,
  options: ConsumeLoopInputOptions = {},
): Promise<"empty" | "continue"> {
  const consumed = input ? await applyLoopInput(input, effects, options) : "empty";
  // A run that starts with no new input reads its hop from its history.
  effects.turnHop?.observe(input, options.startsTurn === true);
  return consumed;
}

async function applyLoopInput(
  input: AgentLoopInput,
  effects: LoopInputEffects,
  options: ConsumeLoopInputOptions,
): Promise<"empty" | "continue"> {
  const startLogicalTurn = options.startLogicalTurn ?? true;
  const preserveRequestContext = options.preserveRequestContext ?? false;
  switch (input.kind) {
    case "wake":
      return "continue";
    case "resume":
      return effects.consumeResume(startLogicalTurn);
    case "hold":
      return "empty";
    case "request-context":
      return effects.consumeMessage(input.input, startLogicalTurn, true);
    case "message":
      return effects.consumeMessage(input, startLogicalTurn, preserveRequestContext);
    case "compact": {
      // This early gate reads the last pinned request surface. The note tools
      // it needs are kernel tools of the runner's notes directory, so a park
      // does not change them. The checkpoint request writes its instruction
      // and checks the gate again on its own surface.
      if (!effects.canCompact()) {
        effects.refuseCompaction();
        return "empty";
      }
      effects.scheduleCompaction(input.source === "idle"
        ? { kind: "idle", after: "park" }
        : { kind: "manual", after: options.compactAfter ?? "continue" });
      await effects.onCompactionContinuation?.();
      return "continue";
    }
  }
}

interface LoopInputWaiterState {
  readonly turnCount: number;
  readonly handoffWritten: boolean;
  /** The loop's open explicit wait. A park on work arms the rest of its
   *  expiry, and the expiry notice states the duration it asked for. */
  readonly wait?: OpenWait;
}

interface LoopInputWaiter {
  readonly runSignal?: AbortSignal;
  readonly providerSessionKey?: string;
  prepareWaitForInput?(signal?: AbortSignal): InputWaitReservation;
  consume(
    input: AgentLoopInput,
    options: ConsumeParkedInputOptions,
  ): Promise<"empty" | "continue">;
  state(): LoopInputWaiterState;
  /** Ends the loop's open wait: its expiry, or an interrupt that gives the
   *  person the turn. */
  closeWait?(): void;
  /** The run's background tasks: what a park delivers and what it waits on. */
  readonly backgroundTasks?: Pick<BackgroundWorkRegistry, "flushSettledNotifications" | "waitableTaskCount" | "awaitedTaskCount"> & Partial<Pick<BackgroundWorkRegistry, "processRecords">>;
  onTurnParked?(context: TurnParkedContext): void | Promise<void>;
  onTurnResumed?(): void;
  /** Records an interrupted turn's end in the tree and in the loop's history.
   *  The waiter calls it once for each interrupt, whether the interrupt cut
   *  a generation or a park that waited on background work. */
  recordInterruption?(): Promise<void>;
  /** The run's turn interruption, whose Escape carried from before a
   *  person's hand-back the waiter discards. */
  readonly currentTurn?: Pick<CurrentTurnInterruption, "discardPendingInterrupt">;
  /** Arms one park-owned expiry and returns its cleanup. Seconds bound only the wait. */
  scheduleWaitExpiry?(seconds: number, expire: () => void): () => void;
}

/** How a park follows an interrupt: `record` when the loop's own generation
 *  was just interrupted, so the waiter records the turn end; `recorded` when
 *  the conversation's last turn already ended by an interrupt, an
 *  unexpected exit, or a stall that the person must answer. */
type ParkAfterInterrupt = "record" | "recorded"

/** Creates the blocking input consumer that owns park and resume lifecycle
 *  effects. It is the one place an interrupt is recorded: a loop whose
 *  generation was interrupted parks here with `afterInterrupt` `record`, and
 *  a park that waits on background work, which is still the agent's turn, is
 *  interrupted here when its wait signal aborts. Either way the turn end is
 *  recorded once, and the loop parks again until a person's message or
 *  Resume authorizes the next request. */
export function createAgentLoopInputWaiter(input: LoopInputWaiter) {
  return async (
    parkedOnBackgroundWork: boolean,
    waitSignal: AbortSignal | undefined,
    afterInterrupt?: ParkAfterInterrupt,
  ): Promise<"empty" | "continue"> => {
    if (!input.prepareWaitForInput) return "empty";
    const prepareWaitForInput = input.prepareWaitForInput;
    let activeWaitSignal = waitSignal;
    let requireUserResume = false;
    const expiry = new AbortController();
    let clearExpiry: (() => void) | undefined;
    const waitExpiry = input.state().wait?.expiry;
    // After an interrupt only the run's own end cuts the wait: another
    // interrupt has nothing left to cut and records nothing. A park whose
    // turn already ended (no background work) has no turn end to record.
    const takeTurnBack = async (recordTurnEnd: boolean): Promise<void> => {
      requireUserResume = true;
      input.closeWait?.();
      clearExpiry?.();
      clearExpiry = undefined;
      activeWaitSignal = input.runSignal;
      if (recordTurnEnd) await input.recordInterruption?.();
    };
    if (afterInterrupt) await takeTurnBack(afterInterrupt === "record");
    try {
    while (true) {
      // Deliver what has already settled before parking on it. The registry
      // batches settled subagents on a timer, and whether that timer has fired
      // yet must not decide what the model sees: the park below consumes a
      // notification without starting a logical turn, so a result already in
      // hand rides into the turn the user's next message starts instead of
      // arriving after it as a turn of its own.
      input.backgroundTasks?.flushSettledNotifications();
      const state = input.state();
      const activeBackgroundCount = (state.wait
        ? input.backgroundTasks?.waitableTaskCount()
        : input.backgroundTasks?.awaitedTaskCount()) ?? 0;
      const park: TurnParkState = requireUserResume ? "interrupted" : parkedOnBackgroundWork || activeBackgroundCount > 0 ? "waiting_on_work" : "idle";
      const waitsOnBackgroundWork = park === "waiting_on_work";
      log.debug("agent-loop parking", {
        providerSessionKey: input.providerSessionKey,
        turnCount: state.turnCount,
        handoffWritten: state.handoffWritten,
        parkedOnBackgroundWork,
        userResumeRequired: requireUserResume,
      });
      const preparedInput = prepareWaitForInput(waitsOnBackgroundWork ? mergeAbortSignals(activeWaitSignal, expiry.signal) : activeWaitSignal);
      // Awaited: the host lands the turn's last durable writes here, and the
      // park must not block on input while those are still in flight.
      try {
        await input.onTurnParked?.({
          handoffWritten: state.handoffWritten,
          turnCount: state.turnCount,
          activeBackgroundCount,
          parkedOnBackgroundWork,
          waitRequested: state.wait !== undefined,
          userResumeRequired: requireUserResume,
          park,
        });
        if (waitsOnBackgroundWork && waitExpiry !== undefined && !clearExpiry) {
          const schedule = input.scheduleWaitExpiry ?? ((duration, expire) => {
            const timer = setTimeout(expire, duration * 1000);
            return () => { clearTimeout(timer); };
          });
          // The rest of the wait: the requests since its call, such as a
          // reply nudge or a compaction, and a restart's downtime count.
          clearExpiry = schedule(Math.max(0, (waitExpiry.deadlineMs - Date.now()) / 1000), () => { expiry.abort(); });
        }
      } catch (error) {
        await preparedInput.cancel();
        throw error;
      }
      const committed = await preparedInput.commit();
      const interruptedWait = activeWaitSignal?.aborted === true && !input.runSignal?.aborted;
      if (interruptedWait) await takeTurnBack(waitsOnBackgroundWork);
      const expired = committed === null && expiry.signal.aborted && !activeWaitSignal?.aborted && !requireUserResume;
      if (expired) input.closeWait?.();
      const raw = committed ?? (expired
        ? messageInput(formatRuntimeNotification({
          tag: WAIT_EXPIRED_TAG,
          fields: [
            ["seconds", String(waitExpiry?.seconds)],
            ["pending", String(input.backgroundTasks?.waitableTaskCount() ?? 0)],
            ["processes", JSON.stringify(input.backgroundTasks?.processRecords?.().filter((record) => record.status === "running" || record.status === "stopping").map((record) => ({
              id: record.id, kind: record.kind, elapsed_seconds: Math.floor((Date.now() - record.startedAtMs) / 1000),
            })) ?? [])],
          ],
          handling: "This wait expired once. Expiry does not stop managed work. Inspect progress or interact if needed. If nothing needs action or a reply, call process(action='wait') again with a fresh remaining-work estimate in soft_timeout seconds and no visible text. Include subagents and workflows. Do not send status chatter.",
        }), { origin: "silent-system", runtimeNotice: true })
        : null);
      if (!raw) {
        if (interruptedWait) continue;
        return "empty";
      }
      // Only what a person gives ends a park after an interrupt: a message
      // they sent or their Resume. Every other input (a message from another
      // session, a background notification, a runtime nudge, a wake) folds
      // into history and the loop parks again. The list allows; it never
      // excludes, so a new origin cannot authorize a request by omission.
      const authorizesResume = raw.kind === "resume" || (raw.kind === "message" && raw.origin === "human");
      const resumedFromInterrupt = requireUserResume && authorizesResume;
      // A message the wake hop limit holds folds into history the same way:
      // it lands for the next turn and starts none.
      const resumes = raw.kind === "message" && raw.held ? false : !requireUserResume || authorizesResume;
      // The person's latest decision wins: an Escape pressed again before
      // this hand-back or their /compact (a double press, a lagging status)
      // is older than it, and one pressed after it still carries into the
      // turn or the compaction it opens.
      if (resumedFromInterrupt || (requireUserResume && raw.kind === "compact")) input.currentTurn?.discardPendingInterrupt();
      if (resumes) {
        const resumedState = input.state();
        log.debug("agent-loop resuming", {
          providerSessionKey: input.providerSessionKey,
          turnCount: resumedState.turnCount,
        });
        input.onTurnResumed?.();
      }
      const consumed = await input.consume(raw, {
        startLogicalTurn: resumes,
        preserveRequestContext: resumedFromInterrupt,
        compactAfter: "park",
        startsTurn: resumes && (requireUserResume || !waitsOnBackgroundWork),
      });
      // A compaction that the person asks for runs at once, even while the
      // park waits for them. It resumes no turn: the loop parks for the
      // person again after the reset, as a park that `onTurnParked` reported.
      if (!resumes) {
        if (raw.kind === "compact" && consumed === "continue") return "continue";
        continue;
      }
      if (consumed === "continue") return "continue";
      // A compact consumed while parked is handled input, not a closed source:
      // re-park so a message queued during the compaction (or later) still has
      // a live consumer instead of the loop exiting as input_closed.
    }
    } finally {
      clearExpiry?.();
    }
  };
}
