/**
 * One masked terminal phase per model turn.
 *
 * The provider stream and the tool fibers it starts are interruptible; what
 * settles the turn is not. After the provider exits, this coordinator runs one
 * fixed order under `Effect.uninterruptibleMask` and always reaches the end of
 * it:
 *
 *  1. capture the provider exit and the work's own settlement;
 *  2. append the complete or partial assistant message durably;
 *  3. cross the assistant durability barrier and release calls gated on it;
 *  4. interrupt unresolved tool fibers before waiting, when the provider exit
 *     carries interruption;
 *  5. join the retained fibers through a restored await, so a fresh interrupt
 *     still reaches tools that were running after a clean provider exit;
 *  6. interrupt unresolved fibers again when that join was itself interrupted;
 *  7. drain every fiber exit and Promise settlement proof uninterruptibly;
 *  8. classify the drained calls and partition out only the suspended ones;
 *  9. publish one full display projection per settled call and wait for its
 *     durability barrier while retaining finalized-result checkpoints;
 * 10. append separately budgeted conversation results;
 * 11. guardedly retire their finalized-result checkpoints;
 * 12. close the attempt's audit and surface accounting failures;
 * 13. publish the turn's terminal provider projection; and
 * 14. re-raise the original provider cause last, or publish the settled turn to
 *     its owner before this phase ends.
 *
 * The conversation tree remains the authority for model-visible settlement.
 * Display facts use their own durable save point first, so transcript rendering
 * does not wait for provider-history budgeting.
 *
 * Interrupt detection stays on the raw `Cause`: `Exit.hasInterrupts` is a type
 * guard whose false branch would unsoundly narrow away non-interrupt failures.
 */

import { Cause, Effect, Exit } from "effect";
import type { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import type { SettledToolBatch, SettledToolCall, ToolBatchEvent, TurnDispatcher } from "./agent-loop-tools.js";
import { bridgeExternalPromise } from "./external-promise-bridge.js";
import type { ToolResultEntry } from "./agent-state.js";
import type { ToolCall } from "./llm/types.js";

export interface TurnSettlementRequest<A> {
  dispatcher: TurnDispatcher;
  /** The turn's provider stream. Runs restored, so a turn interrupt or run
   *  abort reaches it, and the supplied signal stops the underlying request. */
  stream: (signal: AbortSignal) => Promise<A>;
  /** Turn interrupt signal (ESC). Flywheel's per-turn interrupt is signal-borne,
   *  so an aborted turn signal is interruption for settlement purposes even when
   *  the provider returned an outcome instead of failing. */
  turnSignal?: AbortSignal;
  /** Durable assistant append for whatever the provider produced, complete or
   *  partial. Returns the calls this turn must settle, in call order: exactly
   *  the `tool_use` blocks the appended assistant message carries, so a canonical
   *  result is never appended for a call no durable message references. */
  commitAssistant: (exit: Exit.Exit<A>) => readonly ToolCall[] | Promise<readonly ToolCall[]>;
  commitAssistantBarrier?: (calls: readonly ToolCall[]) => Promise<void>;
  /** Canonical conversation append of the settled results. Resolves when the
   *  host's durability barrier has run; publication waits for it. */
  commitResults: (results: readonly ToolResultEntry[], calls: readonly SettledToolCall[]) => Promise<void>;
  commitDisplayBarrier?: () => Promise<void>;
  /** Closes request audit and surfaces usage failures after canonical result durability.
   * A rejection is a local settlement failure and prevents terminal publication
   * and provider replacement. */
  closeAttempt?: () => Promise<void>;
  /** Runtime projection sink. */
  onEvent: (event: ToolBatchEvent) => void;
  /** The turn's terminal provider publication, called exactly once. It runs
   *  after every canonical result is acknowledged and every tool projection is
   *  published, and before the provider cause is re-raised, so a turn never
   *  reports itself complete ahead of the work it settled. */
  publishTerminal: (exit: Exit.Exit<A>) => void;
  /** Hands the settled turn to its owner from inside this uninterruptible
   *  phase. An interrupt requested during the turn is delivered the moment the
   *  coordinating fiber becomes interruptible again, which poisons that fiber's
   *  exit; the settlement published here is what the turn's owner reads
   *  instead, so an interrupted turn still reports what it settled. */
  publishSettlement: (settled: SettledTurn<A>) => void;
}

export interface SettledTurn<A> {
  readonly turn: A;
  readonly batch: SettledToolBatch;
}

export function settleTurn<A>(request: TurnSettlementRequest<A>): Effect.Effect<SettledTurn<A>, PersistenceWriteRefused> {
  const { dispatcher } = request;
  return Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const provider = bridgeExternalPromise(request.stream);
    // `Effect.exit` wraps the restored region from outside it: an interrupt
    // delivered inside the region becomes a value here, so the terminal
    // sequence below still runs. Capturing the exit inside `restore` would let
    // the interruption kill this fiber instead.
    const joined = yield* Effect.exit(restore(provider.owned));
    // The stream's own settlement wins over an interrupted join: an interrupted
    // fiber discards what the work actually did on its way out.
    const exit = provider.settlement() ?? joined;

    const calls = yield* Effect.promise(async () => request.commitAssistant(exit));
    yield* Effect.promise(() => request.commitAssistantBarrier?.(calls) ?? Promise.resolve());
    yield* dispatcher.releaseCalls(calls);

    if (interrupted(joined) || request.turnSignal?.aborted === true) yield* dispatcher.interruptUnresolved();
    const join = yield* Effect.exit(restore(dispatcher.joinAll()));
    if (interrupted(join)) yield* dispatcher.interruptUnresolved();
    yield* dispatcher.drain();

    const batch = yield* dispatcher.collect(calls);
    yield* Effect.sync(() => {
      for (const call of batch.published) publish(call, request.onEvent);
    });
    yield* Effect.promise(() => request.commitDisplayBarrier?.() ?? Promise.resolve());
    yield* Effect.promise(() => request.commitResults(batch.toolResults, batch.published));
    yield* Effect.promise(() => request.closeAttempt?.() ?? Promise.resolve());
    yield* Effect.sync(() => {
      request.publishTerminal(exit);
    });

    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
    const settled: SettledTurn<A> = { turn: exit.value, batch };
    yield* Effect.sync(() => request.publishSettlement(settled));
    return settled;
  }));
}

function interrupted<A, E>(exit: Exit.Exit<A, E>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
}

/** One call's terminal projection. A deferred completion publishes only an
 *  acknowledgement: its result arrives later, on its own. */
function publish(call: SettledToolCall, onEvent: (event: ToolBatchEvent) => void): void {
  const requestId = call.tc.modelRequestId ? { modelRequestId: call.tc.modelRequestId } : {};
  if (call.deferCompletion) {
    onEvent({ kind: "tool_result_ack", toolUseId: call.tc.id, ...requestId });
    return;
  }
  onEvent({
    kind: "tool_result",
    toolUseId: call.tc.id,
    content: call.content,
    outcome: call.outcome,
    ...requestId,
    ...(call.details != null ? { details: call.details } : {}),
    ...call.recovery,
    ...(call.executionOutputTail !== undefined ? { executionOutputTail: call.executionOutputTail } : {}),
  });
}
