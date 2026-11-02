import { Cause, Effect, Exit, Queue, Scope } from "effect";
import { DebugLog } from "../../../infra/debug-log.js";
import type { Claim } from "../../agent-runtime/llm/types.js";
import type { BridgeConfig, BridgeState, EngineInput, Inbox, LiveQuery, Reservation, StartedEngine } from "./bridge-state.js";
import { cliView, identityDifference, sameCliValue, type CliView, type QueryIdentity } from "./cli-view.js";
import { onceClaim, reportEngineEnd } from "./engine-demand.js";
import type { AccountHold } from "./extra-usage-guard.js";
import { planRequest, type QueryState, type StartPlan } from "./request-plan.js";
import type { WrittenTranscript } from "./transcript.js";

/** What the reservation reads and runs of its bridge (bridge.ts). Every function runs on the bridge's actor. */
interface ReservationBridge {
  readonly config: BridgeConfig;
  readonly state: BridgeState;
  readonly hold: AccountHold;
  readonly offer: (input: Inbox) => boolean;
  readonly queryState: () => QueryState;
  /** Starts the engine of the next query; `reserve` keeps the bridge's lifetime session id open until a query takes it. */
  readonly startEngine: (identity: QueryIdentity, plan: StartPlan, use: { readonly reserve: boolean }) => Effect.Effect<StartedEngine, unknown>;
  readonly removeWritten: (written: WrittenTranscript | undefined) => void;
  readonly stopInBackground: (stop: Effect.Effect<void>) => Effect.Effect<unknown>;
}

/** The bridge's one reserved engine (`BridgeState.reserved`): its start for an anticipated request, its take by a
 *  request, and its end. */
export function createReservations(bridge: ReservationBridge) {
  const { config, state, hold, offer, queryState, startEngine, removeWritten, stopInBackground } = bridge;

  /** Records why an anticipation started no engine, and answers no claim: the request then starts its engine itself. */
  const skipped = (evidence: { readonly reason: "account-held" | "unreadable" | "not-started" | "start-failed"; readonly error?: string; readonly plan?: string; readonly issue?: string }): undefined => {
    DebugLog.record({ type: "provider.claude_sdk.engine.reservation_skipped", payload: {
      ...evidence, wireModelId: config.wireModelId, providerSessionKey: config.providerSessionKey,
    } });
    return undefined;
  };

  /** A new claim on the engine of `held`: the reservation, which ends when its last claim is released, or the live
   *  query, whose idle engine stops then. */
  const claim = (held: Reservation | LiveQuery, kind: "reserved" | "live"): Claim => {
    held.claims += 1;
    return onceClaim(async () => { offer({ kind: "claim-released", query: held.id, held: kind }); });
  };

  /**
   * Starts the engine of an anticipated request (`LLMClient.anticipate`) before the request comes, so that the
   * request finds its engine started: the request of a session that a client shows, which its owner plans as a send
   * of the conversation with a placeholder message, or a request that waits in the workflow prefix hold. The plan
   * reads the anticipated request, whose last message the request replaces, so the engine resumes the transcript of
   * the conversation that the request continues. Only a request that would start a query reserves, and only while no
   * query is live. An anticipation that the reservation matches keeps it; any other replaces it, as a model or effort
   * switch at the session's turn end anticipates its next request. The request starts this same engine when it comes with the same launch
   * values, window, history, and reminders, so a reservation adds no engine. Any other request ends the reservation
   * and starts its own engine, so no request reads a transcript that it did not send. Each anticipation that the
   * reservation serves returns its own claim on it (`Claim`), and the reservation also ends when its last claim is
   * released, when its engine ends, when the module is turned off, and when the bridge closes. A request that takes
   * the reservation holds the engine itself, so a later release of a claim on it does nothing. While a query is live,
   * it serves the request, which continues it or rotates it, so the anticipation returns a claim on the live engine,
   * whose release stops that engine when it rests idle (bridge.ts). A failed start reserves nothing: the request then
   * starts its engine itself and reports the failure.
   */
  const anticipate = (input: Extract<Inbox, { kind: "anticipate" }>) => Effect.gen(function* () {
    if (state.live !== undefined) return claim(state.live, "live");
    const held = yield* hold.refusal();
    if (held !== undefined) return skipped({ reason: "account-held", error: held.name });
    let view: CliView;
    try {
      view = cliView(input.params, input.origins, config.projectRoot);
    } catch (error) {
      return skipped({ reason: "unreadable", error: error instanceof Error ? error.name : typeof error });
    }
    const plan = planRequest(view, queryState());
    // Only a refusal reaches here: no live query means that every request starts one. Its issue is the planner's
    // own text, which names no content of the request.
    if (plan.kind !== "start") return skipped({ reason: "not-started", plan: plan.kind, ...(plan.kind === "refuse" ? { issue: plan.issue } : {}) });
    const earlier = state.reserved;
    if (earlier !== undefined) {
      const replaced = reservationDifference(earlier, view, plan);
      if (replaced === undefined) return claim(earlier, "reserved");
      yield* end("replaced", { field: replaced });
    }
    const exit = yield* Effect.exit(startEngine(view.identity, plan, { reserve: true }));
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      return skipped({ reason: "start-failed", error: failure instanceof Error ? failure.name : typeof failure });
    }
    const reserved: Reservation = {
      ...exit.value, identity: view.identity, contextLimit: state.contextLimit, history: plan.history, reminders: plan.reminders, delivery: plan.delivery, reservedAt: Date.now(),
      claims: 0, inputs: [],
    };
    state.reserved = reserved;
    DebugLog.record({ type: "provider.claude_sdk.engine.reserved", payload: {
      sessionId: reserved.sessionId, historyMessages: plan.history.length, wireModelId: config.wireModelId,
      providerSessionKey: config.providerSessionKey,
    } });
    return claim(reserved, "reserved");
  });

  /** A claim on the reservation of query `query` was released: the reservation ends with its last claim. */
  const released = (query: number) => Effect.gen(function* () {
    const reserved = state.reserved;
    if (reserved?.id !== query) return;
    reserved.claims -= 1;
    if (reserved.claims === 0) yield* end("released");
  });

  /** The first field in which a request of `view` and `plan` differs from `reserved`: a launch value, the window, the
   *  history, the reminders, or the delivery. Undefined when the request would start the reserved engine as it is. */
  const reservationDifference = (reserved: Reservation, view: CliView, plan: StartPlan): string | undefined =>
    reserved.contextLimit !== state.contextLimit ? "context-limit"
      : !sameCliValue(reserved.history, plan.history) ? "history"
      : !sameCliValue(reserved.reminders, plan.reminders) ? "reminders"
      : reserved.delivery !== plan.delivery ? "delivery"
      : identityDifference(reserved.identity, view.identity);

  /** The reservation that a request of `view` and `plan` takes, if any. A reservation that differs from the request
   *  (`reservationDifference`) ends, because the request starts its own engine. */
  const take = (view: CliView, plan: StartPlan) => Effect.gen(function* () {
    const reserved = state.reserved;
    if (reserved === undefined) return undefined;
    const unmatched = reservationDifference(reserved, view, plan);
    if (unmatched !== undefined) {
      yield* end("unmatched", { field: unmatched });
      return undefined;
    }
    state.reserved = undefined;
    return reserved;
  });

  /** One event of the reserved engine's readers. The query that takes the engine reads the events in order at the
   *  take. The end of the engine's SDK stream ends the reservation at once, so the next anticipation starts a new
   *  engine and no request takes an engine that has ended. */
  const observe = (input: EngineInput) => {
    if (input.event.kind !== "sdk-end") {
      state.reserved?.inputs.push(input);
      return Effect.void;
    }
    const { error } = input.event;
    return end("engine-ended", error === undefined ? {} : { errorClass: error instanceof Error ? error.name : typeof error });
  };

  /** Ends the reservation. Its engine stops off the actor's path, as a rotated engine does, and the bridge's scope
   *  waits for the stop. The engine ran no turn, so its stop interrupts nothing. `evidence` names the field that
   *  differed, or the class of the failure that ended the engine's stream. */
  const end = (rule: "released" | "unmatched" | "replaced" | "engine-ended" | "module-off" | "bridge-closed", evidence: { readonly field?: string; readonly errorClass?: string } = {}) => Effect.gen(function* () {
    const reserved = state.reserved;
    if (reserved === undefined) return;
    state.reserved = undefined;
    DebugLog.record({ type: "provider.claude_sdk.engine.reservation_ended", payload: {
      sessionId: reserved.sessionId, rule, ...evidence, reservedMs: Date.now() - reserved.reservedAt,
    } });
    // The reserved engine stops, so no engine reads its transcript, and a request that starts its own engine
    // writes its own.
    removeWritten(reserved.transcript);
    // A drain asks the session for a plan, whose next engine runs as the module now allows; a reserved engine served
    // nothing, so no other end of it asks.
    if (rule === "module-off") reportEngineEnd(config.demand, { drained: true, served: false });
    const { engine } = reserved;
    yield* stopInBackground(engine.launched.stop(false).pipe(
      Effect.andThen(Effect.sync(() => { engine.toolGate.close(); })),
      Effect.andThen(Queue.end(engine.prompt)),
      Effect.andThen(Scope.close(reserved.scope, Exit.void)),
    ));
  });

  return { anticipate, released, take, observe, end };
}
