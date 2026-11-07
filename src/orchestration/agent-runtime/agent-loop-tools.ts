/**
 * Foreground and background tool dispatch for one model turn.
 *
 * Each foreground call is one fiber retained in the turn scope with its call
 * identity, plus the settlement proof of the Promise the tool handler actually
 * runs. The fiber owns private call state only; the masked turn coordinator
 * (agent-turn-settlement.ts) is the sole publisher of canonical results and
 * their runtime projections, so a fiber interrupted mid-flight cannot publish
 * after its owner exits.
 *
 * Background calls belong to the host's background-execution owner rather than
 * the turn: they are admitted by that owner, ride its durable signal, and are
 * never turn-forked, so a turn interrupt cannot stop a dispatch mid-
 * registration. They pass the same admission gates (ARCH-TOOLS-001) as a foreground call
 * before they start external work, and the owner's close awaits them there.
 */

import { Cause, Deferred, Effect, Exit, Fiber, Schema, type Scope } from "effect";
import { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import { mergeAbortSignals } from "../../infra/abort.js";
import { errorDetail, errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { BackgroundExecutionOwner } from "./background-execution-owner.js";
import { shouldTerminateToolBatch } from "./tools/tool-batch-termination.js";
import { createToolConcurrencyGate, type ToolConcurrencyGate } from "./tools/tool-concurrency-gate.js";
import type { ExecutionWhitelist } from "./tools/tool-policy.js";
import type { ToolResultEntry } from "./agent-state.js";
import { enforceTurnBudget, limitOutput, textChars, type TurnBudgetEntry } from "./compaction/truncation.js";
import type { TurnOutputBound } from "./compaction/compaction-policy.js";
import { createToolOutputRecovery, measureOriginalContent, type ToolOutputRecovery } from "./tool-output-recovery.js";
import type { StreamEvent, ToolCall } from "./llm/types.js";
import { toTextParts } from "../../infra/llm/tool-output-part-schema.js";
import type { LlmToolOutputPart } from "../../infra/llm/tool-output-part-schema.js";
import { interruptedToolText } from "./llm/heal-messages.js";
import { prepareToolCall, type PreparedToolCall, type ToolExecutionGate } from "./tools/tool-dispatch.js";
import { createNestedToolDispatchBatch, createNestedToolFactPublisher, executeDispatchedTool } from "./tools/nested-tool-dispatch.js";
import { runtimeToolExecution, type RuntimeTool, type ToolAttributionIdentity, type ToolContext, type ToolResult } from "./tools/types.js";
import { writeToolLifecycleDiagnostic } from "./tools/tool-lifecycle-diagnostics.js";
import { assertNever } from "../../infra/assert-never.js";
import type { ToolOutcome } from "../../infra/tool-outcome.js";
import { publishFileMutationAttribution } from "./tools/file-mutation-artifact.js";
import { redactDeep, redactSecrets } from "../../infra/redact-secrets.js";
import { truncateUtf8Prefix } from "../../infra/output/truncate-output.js";
import { MutationEvidenceSchema } from "../../infra/mutation-evidence-schema.js";
import { asRecord } from "../../infra/record.js";
import {
  checkpointFinalizedToolResult,
} from "../session/finalized-tool-result-checkpoint.js";

const log = Log.create({ service: "agent-loop" });

// Tool execution is bounded per turn; an unbounded batch of parallel calls can starve the loop.
const MAX_CONCURRENT_TOOLS = 10;

export function stampToolRegistration(call: ToolCall, registrationIds: ReadonlyMap<string, string>): ToolCall {
  const registrationId = registrationIds.get(call.name);
  return registrationId === undefined ? call : { ...call, registrationId };
}

export type AfterToolCallHook = (call: ToolCall, result: ToolResult, ctx: ToolContext) => ToolResult;

export type ToolBatchEvent = Extract<StreamEvent, {
  kind: "tool_result" | "tool_execution_output" | "tool_result_available" | "tool_result_ack";
}>;

interface TurnDispatcherDeps {
  tools: ReadonlyMap<string, RuntimeTool>;
  executionAdmission?: (toolName: string) => import("./tools/tool-dispatch.js").PreparedCallCapabilityAdmission;
  toolContext: ToolContext;
  /** Turn-scoped signal: aborts on turn interrupt or run disposal. Governs
   *  foreground tools, which live and die within the turn. */
  signal: AbortSignal | undefined;
  /** Owner of this loop's background work: the host that outlives the turn -
   *  and, session-scoped, the runner itself. Background tools (subagent,
   *  workflow) are admitted by it, ride its kill signal, and deliver results
   *  later as notifications. Absent means this loop has no background-dispatch
   *  surface at all; there is no fallback lifetime. */
  background: BackgroundExecutionOwner | undefined;
  /** Owner of every foreground tool fiber. Closing it interrupts and awaits
   *  each one, so no foreground tool outlives the turn that started it. */
  turnScope: Scope.Scope;
  afterToolCall: AfterToolCallHook | undefined;
  onEvent: (event: ToolBatchEvent) => void;
  artifactScopeId: string;
  /** This request's tool batch bound, drawn from the loop's context admission budget. */
  outputBound: TurnOutputBound;
  /** Execution-time tool whitelist (review fork, budget closure); see tool-policy.ts. */
  executionWhitelist?: ExecutionWhitelist;
  toolExecutionGate?: ToolExecutionGate;
  requestAttribution?: { resolve(requestId: string): ToolAttributionIdentity | undefined };
}

interface ToolBatchResult {
  toolResults: ToolResultEntry[];
  terminate: boolean;
  suspended: boolean;
}

/** One settled call, finalized and ready for publication: output caps, recovery
 *  breadcrumbs, and the per-turn budget are already applied. The turn
 *  coordinator publishes these; nothing here emits. */
export interface SettledToolCall {
  readonly tc: ToolCall;
  readonly registrationOrdinal: number;
  readonly content: LlmToolOutputPart[];
  readonly outcome: ToolOutcome;
  /** The handler delivers completion later, so this call publishes an
   *  acknowledgement instead of a terminal result. */
  readonly deferCompletion: boolean;
  readonly details?: unknown;
  readonly nextUserContent?: readonly LlmToolOutputPart[];
  readonly recovery?: ToolOutputRecovery;
  readonly executionOutputTail?: string;
  readonly checkpoint?: { readonly key: string; readonly raw: string };
}

export interface SettledToolBatch extends ToolBatchResult {
  /** One entry per settled non-suspended call, in call order. */
  readonly published: readonly SettledToolCall[];
}

/** Dispatch plus the ordered settlement primitives the masked turn coordinator
 *  drives. Each settlement method is one documented step of that order and has
 *  exactly one caller (agent-turn-settlement.ts). */
export interface TurnDispatcher {
  /** Prepares and dispatches one tool call, returning the call as executed
   *  (name repaired, input coercions stamped) so the caller can emit the
   *  runtime event that matches what actually ran. */
  onToolUse(tc: ToolCall): ToolCall;
  /** Called when the provider stream retries mid-turn. Abandons the attempt:
   *  in-flight background tools see the aborted attempt signal, queued
   *  foreground tools wake and bail, and retained fibers are interrupted. The
   *  abandoned entries hold no settlement authority, so no stale result
   *  surfaces once the re-stream re-emits the same tool_use. */
  onStreamRetry(): void;
  /** Registers any reported call that was never dispatched, releases the
   *  stream gate so ordinary queued foreground tools run, then, when a call
   *  defers on the assistant commit, waits for canonical assistant durability
   *  before opening the commit gate that releases those deferred calls. */
  releaseCalls(allToolCalls: readonly ToolCall[]): Effect.Effect<void>;
  /** Interrupts every retained fiber that has not settled its call yet. */
  interruptUnresolved(): Effect.Effect<void>;
  /** Awaits every retained fiber exit. Interruptible on purpose: a new ESC
   *  during this join must reach tools that were still running. */
  joinAll(): Effect.Effect<void>;
  /** Observes every retained fiber exit and every Promise settlement proof, and
   *  adopts a handler result that landed on the way out. Must run
   *  uninterruptibly: it is what proves no tool is still writing. */
  drain(): Effect.Effect<void, PersistenceWriteRefused>;
  /** Classifies the drained calls, partitions suspended ones out, synthesizes a
   *  tombstone only where no terminal result exists, and enforces the per-turn
   *  output budget. */
  collect(allToolCalls: readonly ToolCall[]): Effect.Effect<SettledToolBatch>;
}

interface ToolEntry {
  tc: ToolCall;
  /** Stable call order captured before execution can settle. */
  registrationOrdinal: number;
  /** Retained foreground fiber; null for a call with no external work of its
   *  own (policy-blocked) and for a background dispatch, which the turn scope
   *  deliberately does not own. */
  fiber: Fiber.Fiber<void, PersistenceWriteRefused> | null;
  /** Awaits real settlement of this call's external work and adopts whatever it
   *  produced. Void for a call that never started any. */
  drain: Effect.Effect<void, PersistenceWriteRefused>;
  result?: ToolResult;
  error?: string;
  content?: LlmToolOutputPart[];
  outcome?: ToolOutcome;
  outputRecovery?: ToolOutputRecovery;
  /** Starts when the call settles, which can be long before the sequential
   *  drain reaches this entry while an earlier call still runs. It therefore
   *  never rejects: it resolves to its exit, so a refused save waits as this
   *  turn's typed failure instead of escaping as an unhandled rejection. */
  finalization?: Promise<Exit.Exit<void, PersistenceWriteRefused>>;
  finalized?: SettledToolCall;
  attributionIdentity?: ToolAttributionIdentity;
  context?: ToolContext;
}

interface AttemptState {
  entries: ToolEntry[];
  submittedIds: Set<string>;
  /** Released by `releaseCalls` to fire queued foreground tools;
   *  `onStreamRetry` aborts `attemptAbort` first, so woken tools see the
   *  aborted signal and return cleanly. */
  streamGate: Deferred.Deferred<void>;
  /** Gate for `deferUntilAssistantCommitted` calls. Only `releaseCalls` opens
   *  it, after the canonical assistant append is acknowledged, so an ordinary
   *  call's eager stream-gate open never wakes a deferred call before the
   *  turn's assistant message (and the loop state derived from it) is
   *  committed. */
  commitGate: Deferred.Deferred<void>;
  /** Aborted on stream retry to cancel in-flight background tool runners. */
  attemptAbort: AbortController;
  /** Fresh per attempt: an abandoned attempt's gate is simply discarded, no
   *  cleanup needed for whatever was mid-acquire on it. */
  concurrencyGate: ToolConcurrencyGate;
}

interface FinalizeContext {
  tools: ReadonlyMap<string, RuntimeTool>;
  executionCwd: string;
  projectRoot: string;
  artifactScopeId: string;
  outputBound: TurnOutputBound;
  toolContext: ToolContext;
  onEvent: (event: ToolBatchEvent) => void;
}

// ── Dispatcher ──────────────────────────────────────────────────

export function createTurnDispatcher(deps: TurnDispatcherDeps): TurnDispatcher {
  const finalizeCtx: FinalizeContext = {
    tools: deps.tools,
    executionCwd: deps.toolContext.executionCwd,
    projectRoot: deps.toolContext.projectRoot,
    artifactScopeId: deps.artifactScopeId,
    outputBound: deps.outputBound,
    toolContext: deps.toolContext,
    onEvent: deps.onEvent,
  };

  function newAttempt(): AttemptState {
    return {
      entries: [],
      submittedIds: new Set(),
      streamGate: Deferred.makeUnsafe<void>(),
      commitGate: Deferred.makeUnsafe<void>(),
      attemptAbort: new AbortController(),
      concurrencyGate: createToolConcurrencyGate(MAX_CONCURRENT_TOOLS),
    };
  }

  let attempt = newAttempt();

  function openStreamGate(attemptCtx: AttemptState): void {
    Effect.runSync(Deferred.succeed(attemptCtx.streamGate, undefined));
  }

  function openCommitGate(attemptCtx: AttemptState): void {
    Effect.runSync(Deferred.succeed(attemptCtx.commitGate, undefined));
  }

  // Both modes merge `attemptAbort` so a stream retry kills the in-flight
  // dispatch before the re-stream re-emits the same tool_use (dedup). They
  // differ only in their base scope: foreground rides the turn signal,
  // background rides the durable signal so turn-end does not kill it.
  function attemptSignal(attemptCtx: AttemptState): AbortSignal {
    return mergeAbortSignals(deps.signal, attemptCtx.attemptAbort.signal);
  }

  function backgroundCallSignal(ownerSignal: AbortSignal, attemptCtx: AttemptState): AbortSignal {
    return mergeAbortSignals(ownerSignal, attemptCtx.attemptAbort.signal);
  }

  function stopped(attemptCtx: AttemptState): boolean {
    return attemptCtx.attemptAbort.signal.aborted || deps.signal?.aborted === true;
  }

  function callContext(call: ToolCall, signal: AbortSignal, attemptCtx: AttemptState, attributionIdentity?: ToolAttributionIdentity): ToolContext {
    const context: ToolContext = {
      ...deps.toolContext,
      signal,
      ...(attributionIdentity ? {
        attributionIdentity,
        gitAiAttribution: attributionIdentity.service,
        canonicalRepositoryRoot: attributionIdentity.repositoryRoot,
      } : {}),
      onExecutionOutput: (text) => deps.onEvent({
        kind: "tool_execution_output",
        toolUseId: call.id,
        output: text,
        ...(call.modelRequestId ? { modelRequestId: call.modelRequestId } : {}),
      }),
    };
    context.createNestedToolDispatchBatch = (options) => createNestedToolDispatchBatch({
      ...options,
      context,
      gate: attemptCtx.concurrencyGate,
      publisher: createNestedToolFactPublisher(context),
      ...(deps.executionWhitelist ? { executionWhitelist: deps.executionWhitelist } : {}),
      ...(deps.toolExecutionGate ? { toolExecutionGate: deps.toolExecutionGate } : {}),
      ...(deps.executionAdmission ? { executionAdmission: deps.executionAdmission } : {}),
    });
    return context;
  }


  function record(entry: ToolEntry, attemptCtx: AttemptState): void {
    attemptCtx.entries.push(entry);
    attemptCtx.submittedIds.add(entry.tc.id);
  }

  function registeredEntry(call: ToolCall, attemptCtx: AttemptState): ToolEntry {
    return {
      tc: call,
      registrationOrdinal: attemptCtx.entries.length,
      fiber: null,
      drain: Effect.void,
      attributionIdentity: call.modelRequestId ? deps.requestAttribution?.resolve(call.modelRequestId) : undefined,
    };
  }

  /** Terminal private state of one call. The afterToolCall hook runs here,
   *  exactly once, wherever the result came from: the fiber's own completion or
   *  its settlement proof. */
  function settle(entry: ToolEntry, result: ToolResult): void {
    if (entry.result || entry.error) return;
    if (entry.context) publishFileMutationAttribution(entry.context);
    let finalResult = result;
    if (deps.afterToolCall) {
      try { finalResult = deps.afterToolCall(entry.tc, result, entry.context ?? deps.toolContext); }
      catch (hookErr) { log.warn("afterToolCall hook threw", { tool: entry.tc.name, error: errorMessage(hookErr), errorDetail: errorDetail(hookErr) }); }
    }
    entry.result = finalResult;
    if (finalResult.suspendTurn !== true) void finalizeEntryOnce(entry, finalizeCtx);
  }

  /** Awaits the call's fiber and then its finalization, and fails with a
   *  refused save from either one. */
  function drainEntry(entry: ToolEntry, fiber: Fiber.Fiber<void, PersistenceWriteRefused>): Effect.Effect<void, PersistenceWriteRefused> {
    return Effect.gen(function* () {
      const exit = yield* Fiber.await(fiber);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        if (error instanceof PersistenceWriteRefused) yield* Effect.fail(error);
      }
      const finalization = entry.finalization;
      if (finalization) yield* Effect.flatten(Effect.promise(() => finalization));
    });
  }


  function interruptedByInput(call: ToolCall): ToolResult {
    return {
      content: `Tool '${call.name}' was interrupted because the user typed a new message. Address the user's input first.`,
      outcome: "interrupted",
    };
  }

  /** A background call the host will never run: no owner admits it, or its owner
   *  closed before the call left the admission gate. */
  function backgroundNotStarted(call: ToolCall): ToolResult {
    return {
      content: `Tool '${call.name}' was not started: the host that owns background work is no longer accepting dispatches.`,
      outcome: "interrupted",
    };
  }

  function startForeground(prepared: PreparedToolCall, attemptCtx: AttemptState): void {
    const call = prepared.call;
    const entry = registeredEntry(call, attemptCtx);
    const deferred = deps.tools.get(call.name)?.deferUntilAssistantCommitted === true;

    const body = Effect.gen(function* () {
      writeToolLifecycleDiagnostic(call, "fiber-entered");
      yield* Deferred.await(deferred ? attemptCtx.commitGate : attemptCtx.streamGate);
      writeToolLifecycleDiagnostic(call, "stream-gate-released");
      if (stopped(attemptCtx)) {
        settle(entry, interruptedByInput(call));
        return;
      }
      const signal = attemptSignal(attemptCtx);
      entry.context = callContext(call, signal, attemptCtx, entry.attributionIdentity);
      yield* executeDispatchedTool({
        prepared,
        context: entry.context,
        gate: attemptCtx.concurrencyGate,
        signal,
        ...(deps.executionWhitelist ? { executionWhitelist: deps.executionWhitelist } : {}),
        ...(deps.toolExecutionGate ? { toolExecutionGate: deps.toolExecutionGate } : {}),
        onSettled: (result) => settle(entry, result),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => writeToolLifecycleDiagnostic(call, "fiber-exited"))));

    writeToolLifecycleDiagnostic(call, "registration-started");
    const fiber = Effect.runSync(Effect.forkIn(body, deps.turnScope));
    entry.fiber = fiber;
    entry.drain = drainEntry(entry, fiber);
    record(entry, attemptCtx);
    writeToolLifecycleDiagnostic(call, "registered");
  }

  function startBackground(prepared: PreparedToolCall, attemptCtx: AttemptState): void {
    const call = prepared.call;
    const entry = registeredEntry(call, attemptCtx);
    const fiber = deps.background?.run((ownerSignal) => Effect.gen(function* () {
      const signal = backgroundCallSignal(ownerSignal, attemptCtx);
      if (signal.aborted) {
        settle(entry, backgroundNotStarted(call));
        return;
      }
      entry.context = callContext(call, signal, attemptCtx, entry.attributionIdentity);
      yield* executeDispatchedTool({
        prepared,
        context: entry.context,
        gate: attemptCtx.concurrencyGate,
        signal,
        ...(deps.executionWhitelist ? { executionWhitelist: deps.executionWhitelist } : {}),
        ...(deps.toolExecutionGate ? { toolExecutionGate: deps.toolExecutionGate } : {}),
        onSettled: (result) => settle(entry, result),
      });
    })) ?? null;
    if (fiber === null) {
      settle(entry, backgroundNotStarted(call));
      record(entry, attemptCtx);
      return;
    }
    entry.drain = drainEntry(entry, fiber);
    record(entry, attemptCtx);
  }


  function onToolUse(tc: ToolCall): ToolCall {
    if (attempt.submittedIds.has(tc.id)) return tc;

    const attemptCtx = attempt;
    const prepared = prepareToolCall(tc, deps.tools, deps.executionAdmission?.(tc.name));
    // Publish the call immediately. Async preparation finalizes repairs before
    // policy and execution; its durable result carries their notices.
    const call = prepared.call;

    const refusal = deps.toolContext.refuseAfterHandoff?.(call);
    if (refusal) {
      const entry = registeredEntry(call, attemptCtx);
      record(entry, attemptCtx);
      settle(entry, refusal);
      return call;
    }
    if (runtimeToolExecution(deps.tools.get(call.name)).mode === "background") {
      startBackground(prepared, attemptCtx);
      return call;
    }
    // Open eagerly per tool call (idempotent) instead of waiting for
    // settlement: a tool_use event already means the model's full JSON input
    // for that call parsed (content_block_stop-equivalent), so there is nothing
    // left to wait for. The settlement open remains as a safety net for an
    // attempt with zero tool_use events. Deferred calls wait on the commit
    // gate instead, so this eager open never releases them.
    if (deps.tools.get(call.name)?.deferUntilAssistantCommitted !== true) openStreamGate(attemptCtx);
    startForeground(prepared, attemptCtx);
    return call;
  }

  function unresolvedFibers(entries: readonly ToolEntry[]): Fiber.Fiber<void, PersistenceWriteRefused>[] {
    return entries.flatMap((entry) => entry.result || entry.error || !entry.fiber ? [] : [entry.fiber]);
  }

  return {
    onToolUse,

    onStreamRetry(): void {
      const abandoned = attempt;
      attempt = newAttempt();
      abandoned.attemptAbort.abort();
      openStreamGate(abandoned);
      openCommitGate(abandoned);
      // Detached: the abandoned entries hold no settlement authority, and the
      // turn scope owns the wait for whatever is still unwinding.
      Effect.runFork(Fiber.interruptAll(unresolvedFibers(abandoned.entries)));
    },

    releaseCalls(allToolCalls: readonly ToolCall[]): Effect.Effect<void> {
      return Effect.gen(function* () {
        for (const tc of allToolCalls) {
          if (!attempt.submittedIds.has(tc.id)) onToolUse(tc);
        }
        openStreamGate(attempt);
        const hasDeferredCall = allToolCalls.some((tc) => deps.tools.get(tc.name)?.deferUntilAssistantCommitted === true);
        if (hasDeferredCall) {
          yield* Effect.promise(() => deps.toolContext.flushCanonicalMessages?.(new Set(allToolCalls.map((tc) => tc.id))) ?? Promise.resolve());
        }
        openCommitGate(attempt);
      });
    },

    interruptUnresolved(): Effect.Effect<void> {
      return Effect.suspend(() => Fiber.interruptAll(unresolvedFibers(attempt.entries)));
    },

    joinAll(): Effect.Effect<void> {
      return Effect.suspend(() => Fiber.awaitAll(attempt.entries.flatMap((entry) => entry.fiber ? [entry.fiber] : []))).pipe(Effect.asVoid);
    },

    drain(): Effect.Effect<void, PersistenceWriteRefused> {
      return Effect.suspend(() => Effect.forEach(attempt.entries, (entry) => entry.drain, { discard: true }));
    },

    collect(allToolCalls: readonly ToolCall[]): Effect.Effect<SettledToolBatch> {
      return Effect.suspend(() => Effect.promise(() => collectSettledBatch(attempt.entries, allToolCalls, finalizeCtx)));
    },
  };
}

// ── Result finalization ─────────────────────────────────────────

// Split text/image parts: limitOutput's 30KB cap applies to text only; images
// pass through atomically. Image parts that originally interleaved with text
// surface after the (possibly truncated) text; acceptable because the cap only
// fires on heavy text output and image-bearing tool_results are uncommon.
async function finalizeEntry(entry: ToolEntry, ctx: FinalizeContext): Promise<void> {
  if (entry.content) return;
  if (!entry.result) {
    entry.content = toTextParts(redactSecrets(`Tool '${entry.tc.name}' failed: ${entry.error ?? "unknown error"}.`));
    entry.outcome = "error";
    return;
  }
  const raw = entry.result.content;
  let textInput: string;
  const imageParts: LlmToolOutputPart[] = [];
  if (typeof raw === "string") {
    textInput = raw;
  } else {
    const textChunks: string[] = [];
    for (const part of raw) {
      switch (part.type) {
        case "text":
          textChunks.push(part.text);
          break;
        case "image":
          imageParts.push(part);
          break;
        default:
          return assertNever(part);
      }
    }
    textInput = textChunks.join("\n");
  }
  const uncapped = ctx.tools.get(entry.tc.name)?.uncappedOutput === true;
  const limited = await limitOutput({
    content: textInput,
    fullContent: entry.result.fullContent,
    retainedFullContent: entry.result.retainedFullContent,
    ...(uncapped ? { maxBytes: Number.POSITIVE_INFINITY } : {}),
    executionCwd: ctx.executionCwd,
    projectRoot: ctx.projectRoot,
    artifactScopeId: ctx.artifactScopeId,
    toolName: entry.tc.name,
    ...(ctx.toolContext.capabilities ? { capabilities: ctx.toolContext.capabilities } : {}),
  });
  if (limited.truncated) {
    entry.outputRecovery = createToolOutputRecovery(entry.result.retainedFullContent ?? measureOriginalContent(entry.result.fullContent ?? textInput), limited);
  }
  entry.content = [
    { type: "text", text: redactSecrets(limited.text) },
    ...imageParts,
  ];
  entry.outcome = entry.result.outcome;
}

/** Finalizes and checkpoints one call at most once. A refused save is a
 *  failed exit; any other error is a defect of the turn that awaits it. */
function finalizeEntryOnce(entry: ToolEntry, ctx: FinalizeContext): Promise<Exit.Exit<void, PersistenceWriteRefused>> {
  entry.finalization ??= finalizeAndCheckpoint(entry, ctx).then(
    () => Exit.void,
    (error: unknown) => error instanceof PersistenceWriteRefused ? Exit.fail(error) : Exit.die(error),
  );
  return entry.finalization;
}

async function finalizeAndCheckpoint(entry: ToolEntry, ctx: FinalizeContext): Promise<void> {
  await finalizeEntry(entry, ctx);
  const content = boundFinalizedContent(finalizedContent(entry));
  const outcome = entry.outcome ?? "error";
  const canonicalDetails = entry.result?.details == null
    ? undefined
    : boundCanonicalDetails(redactDeep(entry.result.details));
  const executionOutputTail = entry.result?.executionOutputTail === undefined
    ? undefined
    : redactSecrets(entry.result.executionOutputTail);
  let finalized: SettledToolCall = {
    tc: entry.tc,
    registrationOrdinal: entry.registrationOrdinal,
    content,
    outcome,
    deferCompletion: entry.result?.deferCompletion === true,
    ...(canonicalDetails !== undefined ? { details: canonicalDetails } : {}),
    ...(entry.result?.nextUserContent ? { nextUserContent: entry.result.nextUserContent } : {}),
    ...(entry.outputRecovery ? { recovery: entry.outputRecovery } : {}),
    ...(executionOutputTail !== undefined ? { executionOutputTail } : {}),
  };
  if (finalized.deferCompletion) {
    entry.finalized = finalized;
    return;
  }
  const conversationId = ctx.toolContext.conversationId;
  if (!conversationId || !ctx.toolContext.flushCanonicalMessages) {
    entry.finalized = finalized;
    return;
  }
  const checkpoint = {
    conversationId,
    toolUseId: finalized.tc.id,
    toolName: finalized.tc.name,
    budgetExempt: budgetExempt(ctx.tools.get(finalized.tc.name), ctx.outputBound),
    turnBudgetChars: ctx.outputBound.chars,
    registrationOrdinal: entry.registrationOrdinal,
    content: finalized.content,
    outcome: finalized.outcome,
    ...(finalized.details != null ? { details: finalized.details } : {}),
    ...(finalized.tc.modelRequestId ? { modelRequestId: finalized.tc.modelRequestId } : {}),
    ...(ctx.toolContext.parentToolUseId ? { parentToolUseId: ctx.toolContext.parentToolUseId } : {}),
    ...finalized.recovery,
    ...(finalized.executionOutputTail !== undefined ? { executionOutputTail: finalized.executionOutputTail } : {}),
  };
  const checkpointed = await checkpointFinalizedToolResult(ctx.toolContext.sessionEventWriter, checkpoint).catch((error: unknown) => {
    if (error instanceof PersistenceWriteRefused && asRecord(finalized.details)?.mutationEvidence) error.stage = "final-result";
    throw error;
  });
  if (checkpointed) {
    finalized = {
      ...finalized,
      checkpoint: checkpointed,
    };
    ctx.onEvent({
      kind: "tool_result_available",
      toolUseId: finalized.tc.id,
      content: finalized.content,
      outcome: finalized.outcome,
      ...(finalized.details != null ? { details: finalized.details } : {}),
      ...finalized.recovery,
      ...(finalized.executionOutputTail !== undefined ? { executionOutputTail: finalized.executionOutputTail } : {}),
    });
  }
  entry.finalized = finalized;
}

const MAX_FINALIZED_DETAILS_BYTES = 30_000;
const MAX_FINALIZED_IMAGE_BYTES = 900_000;

interface TruncatedStructuredDisplay {
  readonly truncated: true;
  readonly preview: string;
}

function boundFinalizedContent(content: readonly LlmToolOutputPart[]): LlmToolOutputPart[] {
  let imageBytes = 0;
  let omitted = 0;
  const bounded = content.flatMap((part): LlmToolOutputPart[] => {
    if (part.type !== "image") return [part];
    const bytes = Buffer.byteLength(part.data);
    if (imageBytes + bytes > MAX_FINALIZED_IMAGE_BYTES) {
      omitted += 1;
      return [];
    }
    imageBytes += bytes;
    return [part];
  });
  return omitted === 0
    ? bounded
    : [...bounded, { type: "text", text: `[${omitted} image part${omitted === 1 ? "" : "s"} omitted because the finalized result exceeded its ${MAX_FINALIZED_IMAGE_BYTES}-byte image bound]` }];
}

/** Keeps a value whose JSON fits the details bound. Otherwise returns the
 *  longest UTF-8 prefix of that JSON whose encoded envelope fits, because
 *  escaping can make the stored preview twice as large as its text. */
function boundStructuredDisplay<T>(value: T): T | TruncatedStructuredDisplay {
  const raw = JSON.stringify(value);
  if (raw === undefined || Buffer.byteLength(raw) <= MAX_FINALIZED_DETAILS_BYTES) return value;
  const envelope = (preview: string): TruncatedStructuredDisplay => ({ truncated: true, preview });
  let fits = 0;
  let exceeds = MAX_FINALIZED_DETAILS_BYTES + 1;
  while (exceeds - fits > 1) {
    const budget = Math.floor((fits + exceeds) / 2);
    const encoded = JSON.stringify(envelope(truncateUtf8Prefix(raw, budget)));
    if (Buffer.byteLength(encoded) <= MAX_FINALIZED_DETAILS_BYTES) fits = budget;
    else exceeds = budget;
  }
  return envelope(truncateUtf8Prefix(raw, fits));
}

const decodeMutationEvidence = Schema.decodeUnknownSync(MutationEvidenceSchema, { onExcessProperty: "error" });

function boundCanonicalDetails<Value>(value: Value) {
  const details = asRecord(value);
  if (details?.mutationEvidence === undefined) return boundStructuredDisplay(value);

  const mutationEvidence = decodeMutationEvidence(details.mutationEvidence);
  const genericDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== "mutationEvidence"),
  );
  const bounded = boundStructuredDisplay(genericDetails);
  return { ...bounded, mutationEvidence };
}

/** A call the turn observed whose handler never produced any terminal result:
 *  the interrupt landed before it answered. */
function interruptedTombstone(call: ToolCall): ToolResult {
  return { content: interruptedToolText(call.name), outcome: "interrupted" };
}

// content and outcome are set together by finalizeEntry, which runs before any
// read. A missing content here is a producer defect, so surface it loudly
// rather than fabricating an empty result.
function finalizedContent(entry: ToolEntry): LlmToolOutputPart[] {
  if (!entry.content) throw new Error(`tool result for ${entry.tc.id} collected before content was finalized`);
  return entry.content;
}

function finalizedCall(entry: ToolEntry): SettledToolCall {
  if (!entry.finalized) throw new Error(`tool result for ${entry.tc.id} collected before the call was finalized`);
  return entry.finalized;
}

async function collectSettledBatch(
  entries: readonly ToolEntry[],
  allToolCalls: readonly ToolCall[],
  ctx: FinalizeContext,
): Promise<SettledToolBatch> {
  const entryById = new Map(entries.map((entry) => [entry.tc.id, entry]));
  const results: ToolResultEntry[] = [];
  const published: SettledToolCall[] = [];
  let suspended = false;

  // Canonical order is call order. A suspended call is the only one that gets
  // neither a canonical result nor a projection: it stays available to the
  // resume path, while its siblings keep theirs.
  for (const tc of allToolCalls) {
    const entry = entryById.get(tc.id);
    if (!entry) throw new Error(`tool call ${tc.id} was never dispatched before settlement`);
    if (entry.result?.suspendTurn === true) {
      suspended = true;
      continue;
    }
    if (!entry.result && !entry.error) entry.result = interruptedTombstone(entry.tc);
    // drain() already failed the turn on every refusal of a settled call, so
    // only a tombstone finalized here can fail, and that is a defect.
    const finalization = await finalizeEntryOnce(entry, ctx);
    if (Exit.isFailure(finalization)) throw Cause.squash(finalization.cause);
    const finalized = finalizedCall(entry);
    results.push({ toolUseId: tc.id, content: finalized.content, outcome: finalized.outcome });
    published.push(finalized);
  }

  return {
    toolResults: await applyTurnBudget(results, entryById, ctx),
    terminate: shouldTerminateToolBatch(allToolCalls.map((tc) => {
      const entry = entryById.get(tc.id);
      if (!entry?.result) return { name: tc.name, outcome: "error" as const };
      return { name: tc.name, outcome: entry.result.outcome, terminate: entry.result.terminate };
    })),
    suspended,
    published,
  };
}

/** Uncapped tools carry author-bounded definition text that a preview would
 *  corrupt. Reads stay whole while the fixed share binds, so a persisted
 *  result read back cannot persist again. */
function budgetExempt(tool: RuntimeTool | undefined, bound: TurnOutputBound): boolean {
  return tool?.uncappedOutput === true || (bound.readsExempt && tool?.action === "file_read");
}

// Aggregate per-turn budget: a batch of individually capped results can still
// land tens of thousands of tokens in one hop. Replace the largest results with
// preview-pointer blocks until the batch fits. The published projections carry
// the full capped text; only the conversation (what every later model call
// re-reads) gets the preview.
async function applyTurnBudget(
  results: ToolResultEntry[],
  entryById: ReadonlyMap<string, ToolEntry>,
  ctx: FinalizeContext,
): Promise<ToolResultEntry[]> {
  const budgetEntries: TurnBudgetEntry[] = results.map((result) => {
    const entry = entryById.get(result.toolUseId);
    return {
      toolUseId: result.toolUseId,
      toolName: entry?.tc.name ?? "tool",
      exempt: budgetExempt(entry ? ctx.tools.get(entry.tc.name) : undefined, ctx.outputBound),
      content: result.content,
      ...(entry?.outputRecovery?.fullContentPath ? { fullContentPath: entry.outputRecovery.fullContentPath } : {}),
    };
  });
  const replacements = await enforceTurnBudget(budgetEntries, {
    budgetChars: ctx.outputBound.chars,
    executionCwd: ctx.executionCwd,
    projectRoot: ctx.projectRoot,
    artifactScopeId: ctx.artifactScopeId,
    ...(ctx.toolContext.capabilities ? { capabilities: ctx.toolContext.capabilities } : {}),
  });
  const replacementById = new Map(replacements.map((r) => [r.toolUseId, r.content]));
  if (replacements.length > 0) log.info("turn tool-output budget enforced", { replaced: replacementById.size, batchSize: results.length, budgetChars: ctx.outputBound.chars, readsExempt: ctx.outputBound.readsExempt });
  const admitted = results.map((result) => {
    const content = replacementById.get(result.toolUseId);
    return content ? { ...result, content } : result;
  });
  ctx.outputBound.admit(admitted.reduce((sum, result) => sum + textChars(result.content), 0));
  return admitted;
}