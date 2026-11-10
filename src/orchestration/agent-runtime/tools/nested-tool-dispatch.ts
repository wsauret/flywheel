import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import { PersistenceWriteRefused } from "../../../infra/event-store-types.js";
import { toolExpression } from "../../../infra/code-mode/tool-runtime.js";
import { awaitWithAbortSignal, mergeAbortSignals } from "../../../infra/abort.js";
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js";
import { createRuntimeEvent } from "../../../infra/runtime-event-factory.js";
import { toTextParts } from "../../../infra/llm/tool-output-part-schema.js";
import { redactDeep, redactSecrets, redactSecretsWork } from "../../../infra/redact-secrets.js";
import { contentEvidenceWork } from "../../../infra/content-evidence.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../infra/runtime-fact-mapper.js";
import { extractToolContentFact, type ExtractedToolContentFact } from "../../../infra/tool-content-extraction.js";
import { runInTaskSlices, type TaskSliceScheduling } from "../../../infra/task-scheduling.js";
import { bridgeExternalPromise } from "../external-promise-bridge.js";
import { readJsonValue } from "../../../infra/llm/json-parse.js";
import { asRecord } from "../../../infra/record.js";
import { describeInputRepair } from "./coerce-input.js";
import type { ExecutionWhitelist } from "./tool-policy.js";
import { executePreparedTool, prepareToolCall, preparedToolAdmission, withInputRepairNotice, type PreparedToolCall, type ToolExecutionGate } from "./tool-dispatch.js";
import type { ToolConcurrencyGate } from "./tool-concurrency-gate.js";
import type { RuntimeTool, RuntimeToolInput, ToolContext, ToolResult } from "./types.js";
import type { ToolCall } from "../llm/types.js";
import { writeToolLifecycleDiagnostic } from "./tool-lifecycle-diagnostics.js";

interface NestedToolFactMeta {
  readonly parentToolUseId: string;
  readonly modelRequestId?: string;
}

export interface NestedToolFactPublisher {
  input(call: ToolCall, tool: RuntimeTool, meta: NestedToolFactMeta): void | Promise<void>;
  validation(call: ToolCall, result: ToolResult, meta: NestedToolFactMeta): void | Promise<void>;
  output(call: ToolCall, output: string, meta: NestedToolFactMeta): void;
  result(call: ToolCall, result: ToolResult, meta: NestedToolFactMeta): void | Promise<void>;
}

export interface NestedToolDispatchBatch {
  execute(name: string, input: unknown): Effect.Effect<ToolResult, PersistenceWriteRefused>;
  /** The names of the registered calls that have no terminal result yet. */
  unsettled(): ReadonlyArray<string>;
  /** Stops registration, interrupts and joins owned calls, then fills only missing terminal cells. */
  close(): Effect.Effect<void>;
}

export interface ToolDispatchExecutionOptions {
  readonly prepared: PreparedToolCall;
  readonly context: ToolContext;
  readonly gate: ToolConcurrencyGate;
  readonly signal?: AbortSignal;
  readonly executionWhitelist?: ExecutionWhitelist;
  readonly admissionSignal?: AbortSignal;
  readonly onSettled?: (result: ToolResult) => void;
  readonly toolExecutionGate?: ToolExecutionGate;
}

/** Shared Effect-native admission and Promise-bridge path for provider and code callers. */
export function executeDispatchedTool(options: ToolDispatchExecutionOptions): Effect.Effect<ToolResult, PersistenceWriteRefused> {
  const { prepared, context } = options;
  let bridge: ReturnType<typeof bridgeExternalPromise<ToolResult>> | undefined;
  return Effect.gen(function* () {
    const refused = context.refuseAfterHandoff?.(prepared.call);
    if (refused) { options.onSettled?.(refused); return refused; }
    const repairNotice = prepared.repairNotice;
    const admission = yield* Effect.promise(() => preparedToolAdmission(prepared, context, options.admissionSignal));
    if (prepared.validationResult !== undefined) {
      // Name and JSON-envelope repairs remain true when later argument
      // validation discards its own unsuccessful repairs.
      prepared.repairNotice ??= repairNotice;
      const result = withInputRepairNotice(prepared, prepared.validationResult);
      options.onSettled?.(result);
      return result;
    }
    // Deterministic execution policy: a refused call reaches no permit,
    // capability admission, or module execution gate (ARCH-TOOLS-008).
    const { call, input } = prepared;
    const whitelist = options.executionWhitelist;
    const policy = prepared.tool?.executionPolicy;
    const refusal = whitelist && !whitelist.tools.has(call.name)
      ? whitelist.deniedReason(call.name)
      : policy && (yield* Effect.promise(() => awaitWithAbortSignal(policy(input, {
        ...context,
        toolUseId: call.id,
        ...(call.modelRequestId ? { modelRequestId: call.modelRequestId } : {}),
      }), options.signal)));
    if (refusal) {
      const result = withInputRepairNotice(prepared, { content: refusal, outcome: "error" });
      options.onSettled?.(result);
      return result;
    }
    return yield* Effect.uninterruptibleMask((restore) => Effect.scoped(Effect.gen(function* () {
      yield* Effect.sync(() => writeToolLifecycleDiagnostic(prepared.call, "admission-wait"));
      yield* Effect.acquireRelease(
        Effect.promise(() => options.gate.acquire(admission, options.admissionSignal)),
        (release) => Effect.sync(() => {
          release();
          writeToolLifecycleDiagnostic(prepared.call, "permit-released");
        }),
      );
      yield* Effect.sync(() => writeToolLifecycleDiagnostic(prepared.call, "admitted"));
      const admissionExit = yield* Effect.exit(restore(Effect.void));
      if (Exit.isFailure(admissionExit) && Cause.hasInterrupts(admissionExit.cause)) {
        return { content: `Tool '${prepared.call.name}' was interrupted before it could complete.`, outcome: "interrupted" as const };
      }
      writeToolLifecycleDiagnostic(prepared.call, "handler-started");
      bridge = bridgeExternalPromise<ToolResult>((bridgeSignal) => {
        const closed = context.refuseAfterHandoff?.(prepared.call);
        if (closed) return Promise.resolve(closed);
        const signal = mergeAbortSignals(options.signal, bridgeSignal);
        return executePreparedTool(prepared, { ...context, signal }, options.toolExecutionGate ? { gate: options.toolExecutionGate } : {}).then((result) =>
          signal.aborted && result.outcome === "error" ? { ...result, outcome: "interrupted" as const } : result);
      });
      const exit = yield* Effect.exit(restore(bridge.owned));
      const settlement = bridge.settlement() ?? exit;
      if (Exit.isSuccess(settlement)) return settlement.value;
      const failure = Cause.squash(settlement.cause);
      if (failure instanceof PersistenceWriteRefused) return yield* Effect.fail(failure);
      if (Cause.hasInterrupts(settlement.cause)) {
        return { content: `Tool '${prepared.call.name}' was interrupted before it could complete.`, outcome: "interrupted" as const };
      }
      return { content: `Tool '${prepared.call.name}' failed: ${errorMessage(Cause.squash(settlement.cause))}`, outcome: "error" as const };
    })).pipe(Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      if (failure instanceof PersistenceWriteRefused) return Effect.fail(failure);
      const settlement = bridge?.settlement();
      if (settlement !== undefined && settlement !== null && Exit.isSuccess(settlement)) return Effect.succeed(settlement.value);
      return Effect.succeed(Cause.hasInterrupts(cause) || options.signal?.aborted === true
        ? { content: `Tool '${prepared.call.name}' was interrupted before it could complete.`, outcome: "interrupted" as const }
        : { content: `Tool '${prepared.call.name}' failed: ${errorMessage(Cause.squash(cause))}`, outcome: "error" as const });
    }), Effect.tap((result) => Effect.sync(() => {
      writeToolLifecycleDiagnostic(prepared.call, "handler-settled");
      if (bridge === undefined && result.outcome === "interrupted") return;
      options.onSettled?.(result);
    }))));
  }).pipe(Effect.catchCause((cause) => {
    const failure = Cause.squash(cause);
    if (failure instanceof PersistenceWriteRefused) return Effect.fail(failure);
    return Effect.succeed(
      Cause.hasInterrupts(cause) || options.signal?.aborted === true
        ? { content: `Tool '${prepared.call.name}' was interrupted before it could complete.`, outcome: "interrupted" as const }
        : { content: `Tool '${prepared.call.name}' failed: ${errorMessage(Cause.squash(cause))}`, outcome: "error" as const },
    );
  }));
}

interface NestedEntry {
  readonly call: ToolCall;
  terminal?: ToolResult;
  fiber?: Fiber.Fiber<ToolResult, PersistenceWriteRefused>;
}

export function createNestedToolDispatchBatch(options: {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly context: ToolContext;
  readonly gate: ToolConcurrencyGate;
  readonly parentToolUseId: string;
  readonly modelRequestId?: string;
  readonly publisher: NestedToolFactPublisher;
  readonly executionWhitelist?: ExecutionWhitelist;
  readonly onNestedStart?: (breadcrumb: string) => void;
  readonly toolExecutionGate?: ToolExecutionGate;
  readonly executionAdmission?: (toolName: string) => import("./tool-dispatch.js").PreparedCallCapabilityAdmission;
}): NestedToolDispatchBatch {
  if (options.parentToolUseId.length === 0 || options.parentToolUseId.includes("#")) {
    throw new Error("Nested tool parent ID must be non-empty and cannot contain '#'.");
  }
  const scope = Scope.makeUnsafe("sequential");
  const abort = new AbortController();
  const entries: NestedEntry[] = [];
  let sequence = 0;
  let closed = false;
  const meta: NestedToolFactMeta = {
    parentToolUseId: options.parentToolUseId,
    ...(options.modelRequestId ? { modelRequestId: options.modelRequestId } : {}),
  };

  const publish = (operation: void | Promise<void>): Effect.Effect<void> => Effect.promise(() => Promise.resolve(operation));
  const publishTerminal = (entry: NestedEntry, result: ToolResult): Effect.Effect<void> => Effect.suspend(() => {
    if (entry.terminal !== undefined) return Effect.void;
    return publish(options.publisher.result(entry.call, result, meta)).pipe(
      Effect.tap(() => Effect.sync(() => { entry.terminal = result; })),
    );
  });

  const execute = (name: string, rawInput: unknown): Effect.Effect<ToolResult, PersistenceWriteRefused> => Effect.suspend(() => {
    if (closed) return Effect.succeed({ content: "Code tool dispatch is closed.", outcome: "interrupted" });
    sequence += 1;
    const input = asRecord(typeof rawInput === "string" ? readJsonValue(rawInput)?.value : rawInput);
    const call: ToolCall = {
      id: `${options.parentToolUseId}#${sequence}`,
      name,
      input: input ?? {},
      ...(input ? {} : { inputParseError: `Tool '${name}' received an input that is not an object.` }),
      ...(options.modelRequestId ? { modelRequestId: options.modelRequestId } : {}),
    };
    const prepared = prepareToolCall(call, options.tools);
    prepared.capabilityAdmission = options.executionAdmission?.(prepared.call.name);
    const notices = [
      ...(typeof rawInput === "string" && input ? [describeInputRepair({ kind: "parsed_value", path: "input", type: "object" })] : []),
      ...(prepared.call.repairedFrom ? [`Note: tool '${prepared.call.repairedFrom}' was read as '${prepared.call.name}'.`] : []),
      ...(prepared.repairNotice ? [prepared.repairNotice] : []),
    ];
    if (notices.length > 0) prepared.repairNotice = notices.join("\n");
    const entry: NestedEntry = { call: prepared.call };
    entries.push(entry);

    const work = Effect.gen(function* () {
      const refused = options.context.refuseAfterHandoff?.(prepared.call);
      if (refused) {
        yield* publishTerminal(entry, refused);
        return refused;
      }
      if (prepared.validationResult !== undefined || prepared.tool === undefined) {
        const validation = withInputRepairNotice(prepared, prepared.validationResult ?? { content: `Unknown tool '${name}'.`, outcome: "error" as const });
        yield* publish(options.publisher.validation(prepared.call, validation, meta));
        entry.terminal = validation;
        return validation;
      }
      yield* publish(options.publisher.input(prepared.call, prepared.tool, meta));
      options.onNestedStart?.(`-> ${toolExpression(prepared.call.name)} ${JSON.stringify(redactDeep(prepared.call.input))}`);
      const context: ToolContext = {
        ...options.context,
        signal: mergeAbortSignals(options.context.signal, abort.signal),
        toolUseId: prepared.call.id,
        ...(options.modelRequestId ? { modelRequestId: options.modelRequestId } : {}),
        onExecutionOutput: (output) => { options.publisher.output(prepared.call, output, meta); },
      };
      const result = yield* executeDispatchedTool({
        prepared,
        context,
        gate: options.gate,
        signal: mergeAbortSignals(options.context.signal, abort.signal),
        admissionSignal: abort.signal,
        ...(options.executionWhitelist ? { executionWhitelist: options.executionWhitelist } : {}),
        ...(options.toolExecutionGate ? { toolExecutionGate: options.toolExecutionGate } : {}),
      });
      yield* publishTerminal(entry, result);
      return result;
    });
    entry.fiber = Effect.runSync(Effect.forkIn(work, scope));
    return Fiber.join(entry.fiber).pipe(Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      if (failure instanceof PersistenceWriteRefused) return Effect.fail(failure);
      return Effect.succeed(
      Cause.hasInterrupts(cause)
        ? { content: `Tool '${name}' was interrupted before it could complete.`, outcome: "interrupted" as const }
        : { content: `Tool '${name}' failed: ${errorMessage(Cause.squash(cause))}`, outcome: "error" as const },
      );
    }));
  });

  return {
    execute,
    unsettled: () => entries.flatMap((entry) => entry.terminal === undefined ? [entry.call.name] : []),
    close: () => Effect.uninterruptible(Effect.gen(function* () {
      if (closed) return;
      closed = true;
      abort.abort();
      for (const entry of entries) {
        if (entry.fiber !== undefined) yield* Fiber.await(entry.fiber);
      }
      yield* Scope.close(scope, Exit.void);
      for (const entry of entries) {
        if (entry.terminal !== undefined) continue;
        yield* publishTerminal(entry, {
          content: `Tool '${entry.call.name}' was interrupted before it could complete.`,
          outcome: "interrupted",
        });
      }
    })),
  };
}

type NestedRuntimeEvent = Parameters<typeof mapRuntimeEventToSessionRuntimeFacts>[0];

const log = Log.create({ service: "nested-tool-dispatch" });

/** Execution output is progress, not a terminal fact, so a failed record of it
 *  is contained: it never rejects a result and never escapes unhandled. The
 *  first failure in a session records in full, and its repeats become one
 *  count when the window closes or an output record succeeds again. */
const outputRecordFailures = coalesceRepeats<{ readonly toolUseId: string; readonly error: string }>({
  windowMs: 60_000,
  first: (sessionId, failure) => { log.warn("nested tool execution output was not recorded", { sessionId, ...failure }); },
  repeated: (sessionId, repeats) => {
    log.warn("nested tool execution output was not recorded again", { sessionId, count: repeats.count, windowMs: repeats.windowMs, error: repeats.events[0]?.error });
  },
});

// The durable boundary for nested tool text: large nested result content and
// execution output become content-row references, matching the parent-level
// runtime-fact subscriber. Each extraction hashes its capped text, so it is one unit.
function* durableFactsWork(event: NestedRuntimeEvent): Generator<void, ExtractedToolContentFact[]> {
  const facts: ExtractedToolContentFact[] = [];
  for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) {
    yield;
    facts.push(extractToolContentFact(fact));
  }
  return facts;
}

function* resultFactsWork(call: ToolCall, result: ToolResult, meta: NestedToolFactMeta): Generator<void, ExtractedToolContentFact[]> {
  const texts: string[] = [];
  if (typeof result.content === "string") texts.push(yield* redactSecretsWork(result.content));
  else for (const part of result.content) texts.push(part.type === "text" ? yield* redactSecretsWork(part.text) : `[image ${part.mediaType}]`);
  const content = texts.join("\n");
  // The whole result is hashed here in bounded units, so the fact mapping does not hash it in one.
  const evidence = yield* contentEvidenceWork(content);
  return yield* durableFactsWork(createRuntimeEvent("tool.result.recorded", {
    tool_use_id: call.id,
    content: toTextParts(content),
    content_bytes: evidence.bytes,
    content_sha256: evidence.sha256,
    outcome: result.outcome,
    is_error: result.outcome !== "ok",
    ...(result.outcome === "interrupted" ? { interrupted: true } : {}),
    ...(result.details != null ? { details: redactDeep(result.details) } : {}),
    parent_tool_use_id: meta.parentToolUseId,
    ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
  }));
}

/** Durable ordinary-fact publisher for one nested batch. Input publication is awaited before execution.
 *  Each publication prepares its facts in task slices: redaction, fact mapping, and the content hash of
 *  a result of several megabytes then do not hold one host task, and a small publication takes no task
 *  hop. Results record in publication order: a result that is ready early waits for the results
 *  published before it. */
export function createNestedToolFactPublisher(context: ToolContext, scheduling: TaskSliceScheduling = {}): NestedToolFactPublisher {
  const MAX_PENDING_OUTPUT_BYTES = 50 * 1024;
  const encoder = new TextEncoder();
  const pendingOutput = new Map<string, { call: ToolCall; meta: NestedToolFactMeta; output: string }>();
  let outputWrite: Promise<void> | undefined;
  let resultsRecorded: Promise<void> = Promise.resolve();

  const recordFacts = async (type: NestedRuntimeEvent["type"], work: Generator<void, ExtractedToolContentFact[]>, after?: Promise<void>): Promise<void> => {
    const writer = context.sessionEventWriter;
    if (writer === undefined) return;
    const facts = await runInTaskSlices(`nested-facts:${type}`, work, scheduling);
    await after;
    for (const { fact, contentRows } of facts) {
      const stored = await writer.record(fact, contentRows);
      if (stored === null) throw new Error(`Nested tool fact '${fact.type}' was not persisted.`);
      await context.applyNestedStoredFact?.(stored);
    }
  };
  const recordEvent = (event: NestedRuntimeEvent): Promise<void> => recordFacts(event.type, durableFactsWork(event));
  const execution = (tool: RuntimeTool | undefined) => {
    const metadata = tool?.execution ?? { mode: "foreground" as const, traceKind: "tool" as const };
    return { mode: metadata.mode, trace_kind: metadata.traceKind, ...(metadata.childHasOwnViewport ? { child_has_own_viewport: true } : {}) };
  };
  const outputFailureKey = context.sessionId ?? "no session";
  const flushOutput = async (): Promise<void> => {
    while (pendingOutput.size > 0) {
      const pending = pendingOutput.entries().next().value;
      if (pending === undefined) return;
      const [toolUseId, { call, meta, output }] = pending;
      pendingOutput.delete(toolUseId);
      await recordEvent(createRuntimeEvent("tool.execution_output.recorded", {
        tool_use_id: call.id,
        output,
        parent_tool_use_id: meta.parentToolUseId,
        ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
      })).then(
        () => { outputRecordFailures.end(outputFailureKey); },
        (error: unknown) => { outputRecordFailures.observe(outputFailureKey, { toolUseId, error: errorMessage(error) }); },
      );
    }
  };
  const queueOutput = (call: ToolCall, output: string, meta: NestedToolFactMeta): void => {
    const redacted = redactSecrets(output);
    const prior = pendingOutput.get(call.id)?.output;
    const combined = prior === undefined ? redacted : `${prior}\n${redacted}`;
    const bytes = encoder.encode(combined);
    pendingOutput.set(call.id, {
      call,
      meta,
      output: bytes.length <= MAX_PENDING_OUTPUT_BYTES
        ? combined
        : new TextDecoder().decode(bytes.slice(bytes.length - MAX_PENDING_OUTPUT_BYTES)),
    });
    outputWrite ??= Promise.resolve().then(flushOutput).finally(() => { outputWrite = undefined; });
  };
  const redactedInput = (call: ToolCall): RuntimeToolInput => {
    const input: RuntimeToolInput = {};
    for (const [key, value] of Object.entries(call.input)) input[key] = redactDeep(value);
    return input;
  };
  return {
    input: (call, tool, meta) => recordEvent(createRuntimeEvent("tool.input.completed", {
      tool_use: {
        ...call,
        provider_call_id: call.id,
        provider_tool_name: call.name,
        executable_tool_name: call.name,
        input: redactedInput(call),
        execution: execution(tool),
      },
      parent_tool_use_id: meta.parentToolUseId,
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    })),
    validation: (call, result, meta) => recordEvent(createRuntimeEvent("tool.validation.failed", {
      tool_use_id: call.id,
      tool_name: call.name,
      input: redactedInput(call),
      reason: redactSecrets(typeof result.content === "string" ? result.content : "Tool input validation failed."),
      execution: execution(undefined),
      parent_tool_use_id: meta.parentToolUseId,
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    })),
    output: (call, output, meta) => {
      const redacted = redactSecrets(output);
      context.onExecutionOutput?.(redacted);
      queueOutput(call, redacted, meta);
    },
    result: (call, result, meta) => {
      const earlierResults = resultsRecorded;
      const recorded = (async () => {
        await outputWrite;
        if (pendingOutput.size > 0) await flushOutput();
        await recordFacts("tool.result.recorded", resultFactsWork(call, result, meta), earlierResults);
      })();
      // The caller of each publication receives its own failure; a failed
      // earlier result does not stop the results after it.
      resultsRecorded = recorded.catch(() => undefined);
      return recorded;
    },
  };
}

