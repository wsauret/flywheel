import { randomUUID } from "node:crypto";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Queue, Scope } from "effect";
import { DebugLog } from "../../../infra/debug-log.js";
import { localDate } from "../../../infra/env-detection.js";
import type { AnthropicOperations } from "../../agent-runtime/llm/anthropic.js";
import { bridgeClosedError as closedError, createBridgeRequests } from "./bridge-requests.js";
import { createReservations } from "./bridge-reservation.js";
import type { BridgeConfig, BridgeState, CliErrorEvidence, EngineInput, Inbox, LiveQuery, OpenRequest, SinkEvent, StartedEngine, StopDecision, StopOptions } from "./bridge-state.js";
import { classifyAnthropicError } from "../../agent-runtime/llm/anthropic-adapter-helpers.js";
import { LlmStreamError, ModelAccessRefusedError, ProviderRequestValidationError } from "../../agent-runtime/llm/errors.js";
import { createAssistantAssembler, type AssistantAssembler } from "./assistant-assembler.js";
import { cliView, type CliMessage, type CliView, type QueryIdentity } from "./cli-view.js";
import { createEngineAudit } from "./engine-additions.js";
import { reportEngineEnd } from "./engine-demand.js";
import { createReplayAcks, planReload, ReloadFailure, replayFrames, runReload } from "./in-place.js";
import { EngineCannotStartError, loginFailure } from "./login-observations.js";
import { accountHold, usageReports, type GuardStop } from "./extra-usage-guard.js";
import { CLAUDE_AGENT_SDK_LABEL, TOOL_MCP_PREFIX } from "./names.js";
import type { CliUserFrame, QueryLaunch, QueryStop } from "./query-launcher.js";
import { registerLiveBridge } from "./live-bridges.js";
import { engineValues, startColdEngine } from "./query-engine.js";
import type { EngineObserver } from "./observed-engine.js";
import { queueIterable } from "./queue-iterable.js";
import { planRequest, type QueryState, type StartPlan } from "./request-plan.js";
import { cliFailure, cliResendFailure, readSdkMessage, type CliErrorReport, type CliTurnResult, type SdkInput } from "./sdk-events.js";
import { decidedAtTurnEnd, serviceRequests, wireFailure, wireKind } from "./service-requests.js";
import { bridgeSessionId } from "./session-id.js";
import {
  countBySource, recordLateRequests, silentDebugOutputFailure, type StderrSignal, type StoppedQuery,
} from "./stderr-signals.js";
import { createStepGate, STEP_GATE_PLUGIN, stepGateFailure, type StepGateFault } from "./step-gate.js";
import { cliKeyOrder, removeTranscript, sessionLocks, transcriptFiles, transcriptRows, userRowIds, writeTranscript, type WrittenTranscript } from "./transcript.js";

/** How long a failed request waits for the CLI's error report and turn result before it fails without them. */
const ERROR_HOLD_MS = 2_000;
/** The longest in-place rotation before the bridge starts a new process instead. A replay takes under a millisecond
 *  for each message, and a cut waits up to one second while the CLI ends a turn. */
const RELOAD_BOUND_MS = 10_000;

/**
 * Builds the bridge that serves the shared Anthropic adapter's requests through the Claude CLI. One actor fiber
 * owns every query of the bridge and is the only writer of its state: requests, SDK messages, CLI debug lines,
 * aborts, and timers all reach it through one queue, in order. Closing the scope runs the stop procedure for a
 * live query before anything else of the bridge closes.
 */
export function makeBridge(config: BridgeConfig): Effect.Effect<AnthropicOperations, LlmStreamError, Scope.Scope> {
  return Effect.gen(function* () {
    const bridgeScope = yield* Effect.scope;
    const isClosed = () => bridgeScope.state._tag === "Closed";
    if (isClosed()) return yield* Effect.fail(closedError());
    const queries = yield* Scope.fork(bridgeScope);
    const inbox = yield* Queue.unbounded<Inbox>();
    const files = config.transcriptFiles ?? transcriptFiles;
    const locks = sessionLocks(config.configDir);
    /** The release of the bridge's hold on its lifetime session id. */
    let releaseLifetime: (() => void) | undefined;
    // The scope of every query closes before this finalizer runs, so the lifetime session id stays locked until every
    // stop of every engine on it ended.
    yield* Scope.addFinalizer(queries, Effect.sync(() => releaseLifetime?.()));
    const state: BridgeState = { live: undefined, reserved: undefined, ended: "released", stopped: undefined, queries: 0, lastPromptTokens: 0, contextLimit: config.contextLimit };
    const hold = accountHold();
    const audit = createEngineAudit(config.accountEmail);
    /** The CLI session of every query of the bridge, so a rotation resumes the same session. The first
     *  query sets it, also when it takes a reserved engine, whose id it then keeps. */
    let lifetimeSessionId: string | undefined;
    const fixLifetime = (sessionId: string): void => {
      if (lifetimeSessionId !== undefined) return;
      lifetimeSessionId = sessionId;
      releaseLifetime = locks.hold(sessionId);
    };

    /** False once the bridge closed: the actor takes nothing more. */
    const offer = (input: Inbox): boolean => Queue.offerUnsafe(inbox, input);

    const openRequest = (live: LiveQuery): OpenRequest | undefined =>
      live.phase.kind === "awaiting" || live.phase.kind === "streaming" || live.phase.kind === "failing" ? live.phase.request : undefined;

    const turnActive = (live: LiveQuery): boolean => live.phase.kind !== "idle" && !live.turnEnded;

    const queryState = (): QueryState => {
      const live = state.live;
      if (live === undefined) return { kind: state.ended };
      const copy = { identity: live.identity, messages: live.messages };
      if ((live.phase.kind === "idle" || live.phase.kind === "parked") && live.diverged) return { kind: "poisoned" };
      if (live.phase.kind === "idle") return { kind: "idle", copy };
      if (live.phase.kind === "parked") return { kind: "parked", copy, toolUseIds: live.phase.toolUseIds };
      return { kind: "busy" };
    };

    /** Sends a timer event after `ms` on the query's clock. A later `arm` or `disarm` makes the event stale. */
    const arm = (live: LiveQuery, ms: number) => Effect.gen(function* () {
      yield* disarm(live);
      const armed = live.armed;
      live.timer = yield* Effect.forkIn(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(() => { offer({ kind: "timer", query: live.id, armed }); }))), live.scope);
    });

    const disarm = (live: LiveQuery) => Effect.gen(function* () {
      live.armed += 1;
      if (live.timer !== undefined) yield* Fiber.interrupt(live.timer);
      live.timer = undefined;
    });

    const removeWritten = (written: WrittenTranscript | undefined): void => {
      if (written === undefined) return;
      try {
        removeTranscript(written, files);
      } catch {
        // The session stays locked until this process ends, so that a later sweep removes the transcript then.
        locks.hold(written.sessionId);
      }
    };

    const clearTranscript = (live: LiveQuery): void => {
      removeWritten(live.transcript);
      live.transcript = undefined;
    };

    /**
     * Ends a query by bridge rule 3. An open request fails first, so the adapter sees the failure at once. The
     * gate settles its waiting calls only after the CLI stopped, so no settled call reaches the model. The stop
     * record names the decision and the request accounting at the stop: the phase, the announced request lines by
     * caller, and how many of them Flywheel had not admitted.
     */
    const stopLive = (live: LiveQuery, decision: StopDecision, options: StopOptions) => detachLive(live, decision, options).pipe(Effect.flatten);

    /**
     * Takes `live` out of the bridge at once and returns its engine's stop. From the detach on, the query admits no
     * step, holds no request, and owns no rotation transcript, and every later line of its engine counts as late
     * (`state.stopped`). The stop interrupts an active turn, waits for the login's refresh lock, and ends the engine
     * (`stopQuery`); then the gate settles its waiting calls, the query's scope closes, and the stop is recorded.
     */
    const detachLive = (live: LiveQuery, decision: StopDecision, options: StopOptions) => Effect.gen(function* () {
      const phase = live.phase.kind;
      live.stepGate.close();
      // The closed gate refuses every step of the CLI's own while the stop waits for the report of its last response.
      const usageStop = yield* settleReport(live);
      state.live = undefined;
      state.ended = options.poisoned ? "poisoned" : "released";
      // The session's engine ends here unless a rotation hands it to the next query. An end that the client's close, a
      // stop of its request, or the release of the session's last claim decided needs no plan: the turn that a stop
      // ends plans at its end.
      const decided = decision.reason === "rotation" || decision.reason === "close" || decision.reason === "abort" || (decision.reason === "release" && decision.rule === "released");
      if (!decided) {
        reportEngineEnd(config.demand, { drained: decision.reason === "release" && decision.rule === "module-off", served: live.served });
      }
      // A pushed request that has no message_start yet can still reach the host.
      const stopped: StoppedQuery = {
        id: live.id, sessionId: live.sessionId, lines: live.requestLines, accounted: live.admitted + live.hidden + (phase === "awaiting" ? 1 : 0), endedWith: live.endedWith,
      };
      const accounting = { requestLines: countBySource(stopped.lines), unadmittedLines: Math.max(0, stopped.lines.length - stopped.accounted) };
      state.stopped = stopped;
      const request = openRequest(live);
      const failure = loginFailure(options.error, decision.reason === "cli-exited" && request !== undefined);
      if (failure !== undefined) config.recordOutcome(failure);
      if (request !== undefined && options.keepRequest !== true) yield* Queue.fail(request.sink, options.error ?? new LlmStreamError("The Claude CLI query stopped before the request ended", "transient"));
      config.silentVersions.check(live);
      // The next query of a bridge with a lifetime writes its transcript at the same path, so this one goes now.
      clearTranscript(live);
      return Effect.gen(function* () {
        const stop: QueryStop = yield* live.launched.stop(options.turnActive);
        live.toolGate.close();
        yield* Queue.end(live.prompt);
        yield* Scope.close(live.scope, Exit.void);
        DebugLog.record({ type: "provider.claude_sdk.query.stopped", payload: {
          sessionId: live.sessionId, reason: decision.reason, rule: decision.rule, poisoned: options.poisoned, requests: live.admitted, pings: live.pings,
          ...(live.cliVersion === undefined ? {} : { cliVersion: live.cliVersion }), ...stop,
          phase, turnEnded: live.turnEnded, ...accounting,
          ...("evidence" in decision && decision.evidence !== undefined ? { evidence: {
            ...decision.evidence,
            ...("retry" in decision.evidence && decision.evidence.retry === "fresh-engine" && request?.signal.aborted ? { retry: "cancelled" } : {}),
          } } : {}),
          ...(usageStop === undefined ? {} : { extraUsage: usageStop.evidence }),
          ...(decision.reason === "cli-error" && decision.evidence.report === "authentication_failed" && live.requestLines.length === 0
            ? { signIn: live.signIn.snapshot() } : {}),
          ...(decision.reason === "rotation" ? { overlapped: true } : {}),
        } });
        audit.late(recordLateRequests(stopped));
      });
    });

    /**
     * A step of the CLI's own that the gate refused, so the CLI sent no request for it. Most come just after a
     * settlement stop, such as the nudge after an empty reply. A live query keeps its open request, which its stream
     * settles, but no longer serves a later request.
     */
    const refusedStep = (input: Extract<Inbox, { kind: "step-refused" }>, live: LiveQuery | undefined): void => {
      DebugLog.record({ type: "provider.claude_sdk.step.refused", payload: {
        sessionId: input.sessionId, index: input.step.index, messageCount: input.step.messageCount, phase: live?.phase.kind ?? "stopped",
      } });
      if (live !== undefined) live.diverged = true;
    };

    /** A request that Flywheel did not admit (bridge rule 4): it fails the open request, if any, and ends the query. */
    const hiddenRequest = (live: LiveQuery, source: { readonly tag: string; readonly signal?: StderrSignal; readonly inputTokens?: number }) => Effect.gen(function* () {
      live.hidden += 1;
      const announcedBy = source.signal === undefined ? "message_start" : "retry-line";
      audit.hidden({ sessionId: live.sessionId, tag: source.tag, phase: live.phase.kind, announcedBy, endedWith: live.endedWith, inputTokens: source.inputTokens });
      const error = source.signal !== undefined ? cliResendFailure(source.signal)
        : live.phase.kind === "failing" ? failureOf(live, live.phase.report, undefined)
        : new LlmStreamError("The Claude CLI started a model request that Flywheel did not send", "transient");
      yield* stopLive(live, { reason: "hidden-request", rule: announcedBy === "message_start" ? "unadmitted-message-start" : "retry-line" }, { turnActive: true, poisoned: true, error });
    });

    /** The step gate does not hold for this query: without it the CLI can send requests that Flywheel did not admit,
     *  or it refuses Flywheel's own. */
    const refuseToServe = (live: LiveQuery, fault: StepGateFault) =>
      stopLive(live, { reason: "step-gate", rule: fault, evidence: live.launched.stepGateEvidence() }, { turnActive: turnActive(live), poisoned: true, error: stepGateFailure(fault) });

    /**
     * The hook refused the unread request's own step because it could not ask the gate, so the request reached no
     * service. A fault of the engine's process, such as a socket that its hook could not open, can clear on a new
     * process, so the same request gets that fresh start once. A fresh engine that meets the fault again refuses to
     * serve.
     */
    const gateUnreachable = (live: LiveQuery, request: OpenRequest) => Effect.gen(function* () {
      if (request.freshEngineRetried) return yield* refuseToServe(live, "gate-unreachable");
      const decision: StopDecision = { reason: "step-gate", rule: "gate-unreachable", evidence: { ...live.launched.stepGateEvidence(), retry: "fresh-engine" } };
      yield* stopLive(live, decision, { turnActive: turnActive(live), poisoned: true, keepRequest: true });
      yield* resendUnread(request, stepGateFailure("gate-unreachable"), true);
    });

    /**
     * Sends an unread request that a stop kept once more, on a new query, which always starts a new engine.
     * `freshEngine` marks the request's one retry after an engine-local fault. `error` fails the request when the plan cannot start a query for it. Returns false when the request did
     * not go to a new query because it was aborted or no start was planned.
     */
    const resendUnread = (request: OpenRequest, error: Error, freshEngine: boolean) => Effect.gen(function* () {
      if (request.signal.aborted) {
        yield* Queue.fail(request.sink, asError(request.signal.reason));
        return false;
      }
      if (freshEngine) request.freshEngineRetried = true;
      const plan = planRequest(request.view, queryState());
      if (plan.kind !== "start") {
        yield* Queue.fail(request.sink, error);
        return false;
      }
      const started = yield* Effect.exit(startQuery(request.view, plan, request));
      if (Exit.isFailure(started)) yield* Queue.fail(request.sink, asError(Cause.squash(started.cause)));
      return true;
    });

    /**
     * Bridge rule 14: a query whose first complete response still owes its usage report waits for it before it takes
     * another request or stops, so no later request reaches the CLI before the guard read the report, and no stop
     * drops it. A stop of the guard holds the account.
     */
    const settleReport = (live: LiveQuery) => live.usage.settle().pipe(Effect.tap((stop) => stop === undefined ? Effect.void : hold.hold(stop)));

    const stopForUsage = (live: LiveQuery, stop: GuardStop) => hold.hold(stop).pipe(
      Effect.andThen(stopLive(live, { reason: "extra-usage", rule: stop.evidence }, { turnActive: turnActive(live), poisoned: true, error: stop.error })),
    );

    /** The query's CLI version has silent debug output, so the bridge cannot see a request of the CLI's own. */
    const refuseSilent = (live: LiveQuery, version: string) =>
      stopLive(live, { reason: "debug-output", rule: "requests-unannounced" }, { turnActive: turnActive(live), poisoned: true, error: silentDebugOutputFailure(version) });

    /** The error map of the live query's open request, with the service's answer that the bridge kept for it. */
    const failureOf = (live: LiveQuery, report: CliErrorReport | undefined, result: CliTurnResult | undefined) =>
      cliFailure(report, result, config.markQuotaExhausted, live.usage.limitResetAtMs, live.answer);

    /** A request that the CLI ended with an error: its report and its turn result, either of which can be missing. */
    const failAtTurnEnd = (live: LiveQuery, rule: "turn-result-during-request" | "error-hold-expired", report: CliErrorReport | undefined, result: CliTurnResult | undefined) =>
      failRequest(live, rule, failureOf(live, report, result), {
        report: report?.error ?? "none",
        ...(result?.status === undefined || result.status === null ? {} : { status: result.status }),
        ...(result?.terminalReason === undefined ? {} : { terminalReason: result.terminalReason }),
      }, result === undefined && !live.turnEnded);

    /**
     * Ends a request that the CLI or the service failed. A refusal of the extended window states that the standard
     * window is open, so the bridge keeps that window for every later query. When the adapter has read no event of the
     * open request, the bridge also sends it once more at that window and records the refusal, because the adapter
     * never sees it. An engine-local login fault gets one cold retry before the adapter sees a refusal.
     * Every other refusal reaches the adapter, and the provider walk records it.
     */
    const failRequest = (live: LiveQuery, rule: Extract<StopDecision, { reason: "cli-error" }>["rule"], error: Error, evidence: CliErrorEvidence, cliTurnActive: boolean) => Effect.gen(function* () {
      const phase = live.phase;
      const unread = phase.kind === "awaiting" || (phase.kind === "failing" && !phase.streamed) ? phase.request : undefined;
      // The adapter classifies the service's raw answer itself; the bridge reads the same class for the window.
      const refused = classifyAnthropicError(error);
      const narrowed = refused instanceof ModelAccessRefusedError && refused.refusal.kind === "extended-context" && state.contextLimit > refused.refusal.contextLimit
        ? refused.refusal : undefined;
      if (narrowed !== undefined) state.contextLimit = narrowed.contextLimit;
      // With no announced request, this engine-local refusal reached no service. Only a fresh engine can clear
      // the engine's cached no-login state, and the same request gets that fresh start once.
      const loginRetry = unread !== undefined && !unread.freshEngineRetried && evidence.report === "authentication_failed"
        && live.requestLines.length === 0 && live.signIn.snapshot().signals.some(({ kind }) => kind === "authentication-unresolved");
      const resend = unread !== undefined && (narrowed !== undefined || loginRetry);
      const wire = live.answer;
      const decision: StopDecision = { reason: "cli-error", rule, evidence: {
        ...evidence, ...(wire === undefined ? {} : { wire: wireKind(wire) }),
        ...(loginRetry ? { retry: "fresh-engine" } : resend ? { resentAt: state.contextLimit } : {}),
      } };
      yield* stopLive(live, decision, { turnActive: cliTurnActive, poisoned: true, error: loginRetry ? undefined : error, keepRequest: resend });
      if (!resend) return;
      const resent = yield* resendUnread(unread, error, loginRetry);
      if (resent && narrowed !== undefined) config.recordModelRefusal(narrowed);
    });

    const forward = (request: OpenRequest, event: BetaRawMessageStreamEvent): void => {
      // SAFETY: the CLI forwards the service's stream events unchanged; the assembler stops a request whose block
      // types the shared adapter does not read.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK types its stream with the beta event union
      Queue.offerUnsafe(request.sink, event as SinkEvent);
    };

    const onStreamEvent = (live: LiveQuery, event: BetaRawMessageStreamEvent) => Effect.gen(function* () {
      const phase = live.phase;
      if (event.type === "message_start") {
        if (phase.kind !== "awaiting") return yield* hiddenRequest(live, { tag: "message_start", inputTokens: event.message.usage.input_tokens });
        // The hook uses the admission up before the CLI sends the request, so an unused one means the hook did not run.
        if (live.stepGate.armed()) return yield* refuseToServe(live, "step-not-asked");
        // The CLI hands a call to a handler by the tool's MCP name or by its alias.
        const assembler = createAssistantAssembler(new Map(live.identity.tools.flatMap(({ name, inputSchema }) => [[name, inputSchema], [`${TOOL_MCP_PREFIX}${name}`, inputSchema]])));
        assembler.add(event);
        live.phase = { kind: "streaming", request: phase.request, assembler };
        live.admitted += 1;
        live.endedWith = undefined;
        if (live.rotated) recordRotationCache(live, assembler);
        forward(phase.request, event);
        return;
      }
      // After a request ended, the SDK still sends its own `message_stop`; nothing else of it reaches Flywheel.
      if (phase.kind !== "streaming") return;
      const step = phase.assembler.add(event);
      if (step.kind === "continue") return forward(phase.request, event);
      if (step.kind === "hold") return;
      if (step.kind === "cut") {
        live.phase = { kind: "failing", request: phase.request, streamed: true, report: undefined };
        return yield* arm(live, ERROR_HOLD_MS);
      }
      // Bridge rule 1: the first stop reason ends the request.
      live.endedWith = step.evidence.stopReason;
      for (const held of step.held) forward(phase.request, held);
      forward(phase.request, event);
      Queue.offerUnsafe(phase.request.sink, { type: "message_stop" });
      yield* Queue.end(phase.request.sink);
      config.recordOutcome("served");
      live.usage.served();
      live.served = true;
      live.messages.push(phase.assembler.message());
      const usage = phase.assembler.usage();
      state.lastPromptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
      if (step.settlement === "park") {
        live.phase = { kind: "parked", toolUseIds: step.toolUseIds };
        if (live.releaseAtRest) yield* arm(live, 0);
        return;
      }
      live.phase = { kind: "idle" };
      if (step.settlement === "idle") {
        live.owedTurnResults += 1;
        if (live.releaseAtRest) yield* arm(live, 0);
        return;
      }
      // The CLI would send a request of its own next, so the interrupt cannot wait.
      const { rule, ...evidence } = step.evidence;
      yield* stopLive(live, { reason: "settlement", rule, evidence }, { turnActive: true, poisoned: true });
    });

    const onSdk = (live: LiveQuery, input: SdkInput) => Effect.gen(function* () {
      const usageStop = live.usage.read(input);
      if (usageStop !== undefined) return yield* stopForUsage(live, usageStop);
      switch (input.kind) {
        case "event": return yield* onStreamEvent(live, input.event);
        case "ping": live.pings += 1; return;
        case "init": {
          live.cliVersion = input.cliVersion;
          if (!input.plugins.includes(STEP_GATE_PLUGIN)) return yield* refuseToServe(live, "plugin-not-loaded");
          if (config.silentVersions.check(live) !== undefined) return yield* refuseSilent(live, input.cliVersion);
          // The first ask for a version starts its self-test, so the test runs before the query's first rotation. The
          // bridge's scope owns the test, so a closed bridge stops it.
          yield* Scope.provide(queries)(config.inPlace.status(input.cliVersion));
          // The CLI reads a rotation transcript only at boot.
          clearTranscript(live);
          return;
        }
        case "refusal":
          if (live.phase.kind === "streaming") live.phase = { ...live.phase, refused: true };
          return;
        case "cli-error": {
          const phase = live.phase;
          // Native ends a refused response at its stop reason, which the adapter reads with its explanation, so the
          // CLI's error report of the refusal fails nothing.
          if (phase.kind === "streaming" && phase.refused === true) return;
          if (phase.kind === "failing") phase.report ??= input.report;
          else if (phase.kind === "awaiting" || phase.kind === "streaming") {
            live.phase = { kind: "failing", request: phase.request, streamed: phase.kind === "streaming", report: input.report };
            yield* arm(live, ERROR_HOLD_MS);
          }
          return;
        }
        case "turn-result": {
          const phase = live.phase;
          if (live.owedTurnResults > 0 && (phase.kind === "idle" || phase.kind === "awaiting")) {
            live.owedTurnResults -= 1;
            return;
          }
          live.turnEnded = true;
          if (phase.kind === "idle" || phase.kind === "parked") return yield* stopLive(live, { reason: "turn-ended", rule: "turn-result-at-rest" }, { turnActive: false, poisoned: true });
          // A hook that cannot ask the gate refuses the admitted step, and the CLI then ends a completed turn that sent
          // no request. A turn that the CLI refuses locally before its first step, such as for an image above its
          // limit, names its own terminal reason.
          if (phase.kind === "awaiting" && live.stepGate.armed() && input.result.terminalReason === "completed") return yield* gateUnreachable(live, phase.request);
          return yield* failAtTurnEnd(live, "turn-result-during-request", phase.kind === "failing" ? phase.report : undefined, input.result);
        }
        // The guard read the report above.
        case "rate-limit": case "ignored": return;
      }
    });

    const recordRotationCache = (live: LiveQuery, assembler: AssistantAssembler): void => {
      live.rotated = false;
      const { cacheReadTokens } = assembler.usage();
      // A rotation that misses the cached history prefix pays for the whole history again (bridge rule 7).
      DebugLog.record({ type: "provider.claude_sdk.rotation.cache", notable: cacheReadTokens < state.lastPromptTokens / 2, payload: {
        sessionId: live.sessionId, cacheReadTokens, previousPromptTokens: state.lastPromptTokens,
      } });
    };

    /** Admits the next model request of a live query and opens `request` on it. `frame` is the pushed user message,
     *  absent when parked handlers take the tail's results and the CLI writes the row itself. */
    const openTurn = (live: LiveQuery, request: OpenRequest, tail: CliMessage, frame: CliUserFrame | undefined): void => {
      live.stepGate.arm(frame === undefined ? "continuation" : "turn-start");
      if (frame !== undefined) Queue.offerUnsafe(live.prompt, frame);
      live.messages.push(tail);
      if (frame !== undefined) live.rows.set(live.messages.length - 1, frame.uuid);
      live.phase = { kind: "awaiting", request };
      live.turnEnded = false;
    };

    /**
     * Rule 13: a rotation that reloads the live CLI instead of starting a new one. It runs only on a CLI version that
     * passed its self-test, and only when the planner can reproduce the cold rotation's request. A parked turn is
     * interrupted first, which sends no request; the CLI then owes that turn's result. Returns why the rotation needs a
     * new process instead, or undefined once the request's tail is pushed.
     */
    const reloadInPlace = (live: LiveQuery, view: CliView, plan: StartPlan, request: OpenRequest) => Effect.gen(function* () {
      const status = live.cliVersion === undefined ? "no-version" : yield* Scope.provide(queries)(config.inPlace.status(live.cliVersion));
      if (status !== "ready") return status;
      const parked = live.phase.kind === "parked";
      // A step that the gate refuses reaches the actor before the CLI's turn result does, so a copy is exact only once
      // the CLI ended its turn with no refused step. Otherwise the reload cuts at the copy's last turn start.
      const exact = live.phase.kind === "idle" && live.owedTurnResults === 0 && !live.diverged;
      const decision = planReload({ ...live, exact }, view, plan, { today: localDate(), environment: config.openingEnvironment });
      if (decision.kind === "cold") return decision.reason;
      yield* disarm(live);
      const frames = replayFrames(decision, config.wireModelId);
      const [elapsed, exit] = yield* Effect.exit(Effect.gen(function* () {
        if (parked) {
          yield* Effect.tryPromise({ try: () => live.launched.query.interrupt(), catch: (error) => new ReloadFailure("interrupt", asError(error).name) });
          live.turnEnded = true;
          live.owedTurnResults += 1;
        }
        yield* runReload(live.launched, live.acks, live.stepGate, (frame) => { Queue.offerUnsafe(live.prompt, frame); }, decision, frames);
      }).pipe(Effect.timeoutOrElse({ duration: RELOAD_BOUND_MS, orElse: () => Effect.fail(new ReloadFailure("replay", "timeout")) }))).pipe(Effect.timed);
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause);
        // A request that its caller cancelled during the reload starts no engine, and the engine whose reload failed
        // holds an unknown conversation, so it stops. The adapter controller reaches the adapter only with the reply.
        if (request.signal.aborted) return yield* stopLive(live, { reason: "abort", rule: "caller-signal" }, { turnActive: turnActive(live), poisoned: false }).pipe(Effect.andThen(Effect.fail(asError(request.signal.reason))));
        return failure instanceof ReloadFailure ? `${failure.step}:${failure.reason}` : "reload-error";
      }
      live.identity = view.identity;
      live.messages.splice(decision.from, Infinity, ...decision.replay);
      for (const index of live.rows.keys()) if (index >= decision.from) live.rows.delete(index);
      for (const [offset, frame] of frames.entries()) if (frame.type === "user") live.rows.set(decision.from + offset, frame.uuid);
      live.diverged = false;
      live.rotated = true;
      DebugLog.record({ type: "provider.claude_sdk.query.reloaded", payload: {
        sessionId: live.sessionId, trigger: plan.trigger.kind, ...(plan.trigger.kind === "identity" ? { field: plan.trigger.field } : {}), interrupted: parked,
        systemPrompt: decision.systemPrompt !== undefined, cut: decision.cut !== undefined, opening: decision.opening, keptMessages: decision.from, replayedMessages: decision.replay.length,
        durationMs: Math.round(Duration.toMillis(elapsed)),
      } });
      if (request.signal.aborted) {
        // The caller cancelled the request during the reload: its tail goes nowhere, and the engine rests on the
        // replayed conversation, which the next request continues.
        live.phase = { kind: "idle" };
        if (live.releaseAtRest) yield* arm(live, 0);
        return yield* Effect.fail(asError(request.signal.reason));
      }
      openTurn(live, request, plan.message, userFrame(plan.message));
      return undefined;
    });

    /**
     * Starts the engine of the next query, which resumes the transcript of `plan.history`. A start for a query fixes
     * the bridge's lifetime session id at once, also when the engine then fails to start; a reservation fixes it only
     * when a query takes it.
     */
    const startEngine = (identity: QueryIdentity, plan: Pick<StartPlan, "history" | "reminders" | "delivery">, use: { readonly reserve: boolean }) => Effect.gen(function* () {
      const id = state.queries + 1;
      state.queries = id;
      const scope = yield* Scope.fork(queries);
      const sessionId = lifetimeSessionId ?? bridgeSessionId();
      // The engine holds its session id until its awaited close: the scope closes the engine before this release.
      const unlock = yield* Effect.try({ try: () => locks.hold(sessionId), catch: asError }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      yield* Scope.addFinalizer(scope, Effect.sync(unlock));
      if (!use.reserve) fixLifetime(sessionId);
      const stepGate = createStepGate((step) => { offer({ kind: "step-refused", query: id, sessionId, step }); });
      const acks = createReplayAcks();
      const usage = usageReports({ extraUsage: config.extraUsage, reportsExtraUsage: config.reportsExtraUsage(), sessionId, markQuotaExhausted: config.markQuotaExhausted, onStop: config.onExtraUsageStop, recordUsage: config.recordUsage });
      // The answer to a replayed row settles its wait in the reader, and a usage report reaches the guard as it
      // arrives, because the actor can wait on either. Everything else reaches the actor in the engine's order.
      const observer: EngineObserver = {
        message: (message) => {
          const input = readSdkMessage(message, acks);
          if (input === undefined) return;
          usage.arrived(input);
          audit.sdkInput(id, input);
          offer({ kind: "engine", query: id, event: { kind: "sdk", input } });
        },
        ended: (error) => {
          acks.end();
          usage.arrived(undefined);
          offer({ kind: "engine", query: id, event: { kind: "sdk-end", error } });
        },
        debugLine: (line) => {
          audit.debugLine(id, line);
          offer({ kind: "engine", query: id, event: line });
        },
      };
      const accountEmail = plan.history.length === 0 ? undefined : config.accountEmail();
      const shell = plan.history.length === 0 ? undefined : config.engineShell();
      const rows = transcriptRows({
        sessionId, model: config.wireModelId, history: plan.history, reminders: plan.reminders,
        ...(accountEmail === undefined ? {} : { accountEmail }), ...(shell === undefined ? {} : { shell }),
      });
      const written = rows.length === 0 ? undefined : yield* Effect.try({ try: () => writeTranscript(config.configDir, identity.cwd, sessionId, rows, files), catch: asError }).pipe(
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const session: QueryLaunch["session"] = written === undefined ? { kind: "fresh", id: sessionId } : { kind: "resume", id: sessionId, at: written.resumeAt };
      const engine = yield* startColdEngine(config.launchQuery, identity, engineValues(identity, config.wireModelId, state.contextLimit), session, stepGate, observer).pipe(
        Effect.tapError(() => Effect.sync(() => { removeWritten(written); })), Effect.onError(() => Scope.close(scope, Exit.void)));
      yield* Scope.addFinalizer(scope, Effect.promise(() => engine.close()));
      const started: StartedEngine = { id, sessionId, scope, stepGate, engine, acks, usage, transcript: written, historyRows: userRowIds(plan.history, rows) };
      return started;
    });

    /** Runs an engine's stop off the actor's path. The fiber is uninterruptible from its creation, so a close of the
     *  bridge that comes before the fiber first runs still waits for the whole stop. */
    const stopInBackground = (stop: Effect.Effect<void>) => Effect.forkIn(stop, queries, { uninterruptible: true });

    const reservations = createReservations({ config, state, hold, offer, queryState, startEngine, removeWritten, stopInBackground });

    /** Stops the live query and starts the next one, on the engine reserved for its request or on one that
     *  `startEngine` starts. `coldBecause` names why a live query did not reload in place. */
    const startQuery = (view: CliView, plan: StartPlan, request: OpenRequest, options?: { readonly coldBecause?: string }) => Effect.gen(function* () {
      const previous = state.live;
      if (previous !== undefined) {
        const evidence = { ...(plan.trigger.kind === "identity" ? { field: plan.trigger.field } : {}), ...(options?.coldBecause === undefined ? {} : { inPlace: options.coldBecause }) };
        const decision: StopDecision = { reason: "rotation", rule: plan.trigger.kind, ...(Object.keys(evidence).length === 0 ? {} : { evidence }) };
        const stop = yield* detachLive(previous, decision, { turnActive: turnActive(previous), poisoned: false, error: new LlmStreamError("A newer request replaced this request", "transient") });
        // The old engine stops beside the new one's start, off the request's path. It can send nothing more, because
        // its gate is closed, and the two engines share no file: neither persists its session, the old transcript is
        // gone, and the stop's cleanup keeps every record of a live engine. The bridge's scope waits for the stop.
        yield* stopInBackground(stop);
      }
      const identity = view.identity;
      const reserved = yield* reservations.take(view, plan);
      if (reserved !== undefined) fixLifetime(reserved.sessionId);
      // A rotation whose new engine cannot start ends the session's engine that it would have taken on.
      const started = reserved ?? (yield* startEngine(identity, plan, { reserve: false }).pipe(
        Effect.tapError(() => Effect.sync(() => { if (previous !== undefined) reportEngineEnd(config.demand, { drained: false, served: previous.served }); })),
      ));
      const { id, sessionId, scope, stepGate, engine, acks, usage, transcript: written } = started;
      const { launched, toolGate, prompt } = engine;
      const frame = userFrame(plan.message);
      state.live = {
        id, sessionId, launched, toolGate, stepGate, prompt, acks, scope, identity, signIn: engine.signIn, rotated: written !== undefined,
        messages: [...view.messages], rows: new Map([...started.historyRows, ...(plan.delivery === "push" ? [[view.messages.length - 1, frame.uuid] as const] : [])]),
        phase: { kind: "awaiting", request }, turnEnded: false, diverged: false, owedTurnResults: 0,
        transcript: written, timer: undefined, armed: 0, admitted: 0, endedWith: undefined, requestLines: [], requests: serviceRequests(sessionId), answer: undefined, hidden: 0, releaseAtRest: false, pings: 0, cliVersion: undefined, usage,
        served: previous?.served ?? false, claims: 0,
      };
      // The query reads what its engine said while reserved before anything that the engine says later.
      for (const input of reserved?.inputs ?? []) yield* onEngine(input);
      stepGate.arm("turn-start");
      Queue.offerUnsafe(prompt, frame);
      DebugLog.record({ type: "provider.claude_sdk.query.started", payload: {
        sessionId, trigger: plan.trigger.kind, ...(plan.trigger.kind === "identity" ? { field: plan.trigger.field } : {}), historyMessages: plan.history.length, delivery: plan.delivery,
        contextLimit: state.contextLimit, wireModelId: config.wireModelId, engine: reserved === undefined ? "cold" : "reserved",
        ...(reserved === undefined ? {} : { reservedMs: Date.now() - reserved.reservedAt }),
        // The conversation's key ties the bridge's random session id to the requests that it served.
        providerSessionKey: config.providerSessionKey,
      } });
    });

    /** A request that its caller cancelled before the bridge acted on it starts nothing: it takes no reservation,
     *  launches no engine, and delivers nothing to a parked query. */
    const refuseCancelled = (signal: AbortSignal) => signal.aborted ? Effect.fail(asError(signal.reason)) : Effect.void;

    /** Bridge rules 2, 5, and 11: the planner decides; this runs the plan and answers the adapter. */
    const onRequest = (input: Extract<Inbox, { kind: "request" }>) => Effect.gen(function* () {
      yield* refuseCancelled(input.signal);
      const held = yield* hold.refusal();
      if (held !== undefined) return yield* Effect.fail(held);
      const view = yield* Effect.try({ try: () => cliView(input.params, input.origins, config.projectRoot), catch: asError });
      const plan = planRequest(view, queryState());
      if (plan.kind === "refuse") return yield* Effect.fail(new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, plan.issue));
      const live = state.live;
      const silent = live === undefined ? undefined : config.silentVersions.check(live);
      if (live !== undefined && silent !== undefined) {
        yield* refuseSilent(live, silent);
        return yield* Effect.fail(silentDebugOutputFailure(silent));
      }
      const usageStop = live === undefined ? undefined : yield* settleReport(live);
      if (live !== undefined && usageStop !== undefined) return yield* stopForUsage(live, usageStop).pipe(Effect.andThen(Effect.fail(usageStop.error)));
      // The usage report can take a while, and the caller can cancel the request meanwhile.
      yield* refuseCancelled(input.signal);
      const request: OpenRequest = { id: input.id, sink: yield* Queue.unbounded<SinkEvent, Error | Cause.Done>(), signal: input.signal, view, freshEngineRetried: false };
      if (plan.kind === "start") {
        const coldBecause = live === undefined ? undefined : yield* reloadInPlace(live, view, plan, request);
        if (live === undefined || coldBecause !== undefined) {
          // The in-place check can take a while, and the caller can cancel the request meanwhile.
          yield* refuseCancelled(input.signal);
          yield* startQuery(view, plan, request, { coldBecause });
        }
      } else if (live === undefined) return yield* Effect.fail(new Error("The bridge planned to continue a query that does not exist"));
      else {
        yield* disarm(live);
        const tail = view.messages.at(-1);
        if (tail === undefined) return yield* Effect.fail(new Error("The bridge planned a request without a message"));
        openTurn(live, request, tail, plan.kind === "push" ? userFrame(plan.message) : undefined);
        if (plan.kind === "deliver") live.toolGate.deliver(plan.results);
      }
      return audit.recorded(input.params, view, queueIterable(request.sink, input.signal));
    });

    /**
     * Bridge rule 4: native Flywheel fails a request at the service's answer, with the native client's error. Every
     * model request of the chat's engine is its main loop's, so the failure of a complete main-loop model record is
     * the open request's answer. An answer of any other record is recorded and fails nothing. An error body that no
     * record takes means that the engine's debug output is not the format that the bridge reads, so its version
     * serves nothing more.
     */
    const onServiceRequest = (live: LiveQuery, line: Parameters<LiveQuery["requests"]["read"]>[0]) => Effect.gen(function* () {
      const event = live.requests.read(line);
      if (event?.kind === "unjoinable") {
        if (live.cliVersion === undefined) return;
        config.silentVersions.drifted(live.sessionId, live.cliVersion, "body-unjoined");
        return yield* refuseSilent(live, live.cliVersion);
      }
      // A new main-loop model request starts a new answer.
      if (event?.kind === "opened" && event.request.agent === undefined && event.request.model) live.answer = undefined;
      if (event?.kind !== "failed") return;
      const { request, wire } = event;
      if (request.agent !== undefined || !request.model) {
        DebugLog.record({ type: "provider.claude_sdk.api_error.unattributed", payload: {
          sessionId: live.sessionId, signal: wireKind(wire), ...(wire.status === undefined ? {} : { status: wire.status }), model: request.model, hosted: request.agent !== undefined,
        } });
        return;
      }
      if (openRequest(live) === undefined) return;
      live.answer = wire;
      if (decidedAtTurnEnd(wire)) return;
      return yield* failRequest(live, wire.status === undefined ? "stream-error-line" : "api-error-line", wireFailure(wire), { report: "none", ...(wire.status === undefined ? {} : { status: wire.status }) }, true);
    });

    /** One event of the engine of a query that is live or stopped: the live query acts on it, and a stopped query
     *  counts a model request that its engine sent late. */
    const onEngine = ({ query, event }: EngineInput): Effect.Effect<void, unknown> => Effect.gen(function* () {
      const live = state.live;
      if (live?.id !== query) {
        const stopped = state.stopped;
        if (event.kind !== "request-line" || stopped?.id !== query || !event.request.model) return;
        stopped.lines.push({ source: event.request.source, arrivedIn: "stopped", endedWith: stopped.endedWith });
        return audit.late(recordLateRequests(stopped));
      }
      switch (event.kind) {
        case "sdk":
          return yield* onSdk(live, event.input);
        case "stderr":
          return yield* hiddenRequest(live, { tag: event.signal.tag, signal: event.signal });
        case "request-sent": case "status-line": case "response": case "response-unread": case "api-error": case "stream-error":
          return yield* onServiceRequest(live, event);
        case "request-line":
          if (event.request.model) live.requestLines.push({ source: event.request.source, arrivedIn: live.phase.kind, endedWith: live.endedWith });
          return;
        case "request-unread":
          return;
        case "sdk-end": {
          if (live.launched.process.cannotStart()) {
            return yield* stopLive(live, { reason: "cli-exited", rule: "engine-not-started" }, { turnActive: false, poisoned: true, error: new EngineCannotStartError() });
          }
          const error = live.phase.kind === "failing" ? failureOf(live, live.phase.report, undefined)
            : new LlmStreamError(`The Claude CLI stopped: ${event.error instanceof Error ? event.error.message : "its message stream ended"}`, "transient");
          const decision: StopDecision = event.error === undefined ? { reason: "cli-exited", rule: "sdk-stream-ended" }
            : { reason: "cli-exited", rule: "sdk-stream-failed", evidence: { errorClass: event.error instanceof Error ? event.error.name : typeof event.error } };
          return yield* stopLive(live, decision, { turnActive: false, poisoned: true, error });
        }
      }
    });

    const handle = (input: Exclude<Inbox, { kind: "close" }>) => Effect.gen(function* () {
      if (input.kind === "request") {
        const exit = yield* Effect.exit(onRequest(input));
        yield* Exit.isSuccess(exit) ? Deferred.succeed(input.reply, exit.value) : Deferred.fail(input.reply, asError(Cause.squash(exit.cause)));
        return;
      }
      if (input.kind === "anticipate") {
        // The reply settles on every exit, so a defect that the actor records never leaves the anticipation waiting.
        return yield* reservations.anticipate(input).pipe(Effect.onExit((exit) => Deferred.succeed(input.reply, Exit.isSuccess(exit) ? exit.value : undefined)));
      }
      const live = state.live;
      if (input.kind === "claim-released") {
        if (input.held === "reserved") return yield* reservations.released(input.query);
        if (live?.id !== input.query) return;
        live.claims -= 1;
        // The session no longer wants the idle engine. A busy engine is held by its request: the session's owner
        // ends its client when that request's turn ends.
        if (live.claims === 0 && live.phase.kind === "idle") yield* stopLive(live, { reason: "release", rule: "released" }, { turnActive: false, poisoned: false });
        return;
      }
      if (input.kind === "module-off") {
        yield* reservations.end("module-off");
        if (live === undefined) return;
        // A query at rest stops now; a busy query stops as soon as its request ends.
        live.releaseAtRest = true;
        if (live.phase.kind === "idle" || live.phase.kind === "parked") yield* arm(live, 0);
        return;
      }
      if (input.kind === "step-refused") return refusedStep(input, live?.id === input.query ? live : undefined);
      if (input.kind === "engine") return yield* (state.reserved?.id === input.query ? reservations.observe(input) : onEngine(input));
      if (live === undefined) return;
      switch (input.kind) {
        case "abort": {
          if (openRequest(live)?.id !== input.request) return;
          return yield* stopLive(live, { reason: "abort", rule: input.source }, { turnActive: turnActive(live), poisoned: true, error: asError(input.reason) });
        }
        case "timer": {
          if (input.query !== live.id || input.armed !== live.armed) return;
          live.timer = undefined;
          if (live.phase.kind === "failing") return yield* failAtTurnEnd(live, "error-hold-expired", live.phase.report, undefined);
          // Only a query whose module was turned off arms a timer at rest; the next request rotates from history.
          return yield* stopLive(live, { reason: "release", rule: "module-off" }, { turnActive: turnActive(live), poisoned: false });
        }
      }
    });

    const actor = Effect.gen(function* () {
      while (true) {
        const input = yield* Queue.take(inbox);
        if (input.kind === "close") {
          // Admission stops first, so a request that arrives during the stop fails at once instead of waiting
          // for an actor that has ended.
          yield* Queue.interrupt(inbox);
          yield* reservations.end("bridge-closed");
          if (state.live !== undefined) yield* stopLive(state.live, { reason: "close", rule: "bridge-closed" }, { turnActive: turnActive(state.live), poisoned: false, error: closedError() });
          for (const left of yield* Queue.clear(inbox)) {
            if (left.kind === "request") yield* Deferred.fail(left.reply, closedError());
          }
          yield* Deferred.succeed(input.done, undefined);
          return;
        }
        yield* handle(input).pipe(Effect.catchCause((cause) => Effect.sync(() => {
          const failure = Cause.squash(cause);
          DebugLog.record({ type: "provider.claude_sdk.bridge.defect", payload: { input: input.kind, error: failure instanceof Error ? failure.name : typeof failure } });
        })));
      }
    });

    const running = yield* Effect.forkScoped(actor);
    // The module's service releases every live bridge's CLI when the module is turned off.
    const unregister = registerLiveBridge(() => { offer({ kind: "module-off" }); });
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      offer({ kind: "close", done });
      yield* Effect.raceFirst(Deferred.await(done), Fiber.await(running).pipe(Effect.asVoid));
    }));
    if (isClosed()) return yield* Effect.fail(closedError());
    return createBridgeRequests(offer, running);
  });
}

/** One pushed user message that carries a whole Flywheel user message, without cache marks or reminders, in the
 *  CLI's key order. Its id names the CLI's row, at which a later in-place rotation can cut the conversation. */
function userFrame(message: CliMessage): CliUserFrame {
  return { type: "user", uuid: randomUUID(), message: { role: "user", content: message.content.map(cliKeyOrder) }, parent_tool_use_id: null };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
