/**
 * Dispatch + selection helpers around the runtime tool registry. The
 * exposure planner (see `tool-exposure-planner.ts`) is the single decision
 * point for which tools are exposed and executable per turn; this module
 * keeps the small helpers callers still need:
 *
 *   - `selectedToolNames` converts AgentOptions selections into the
 *     planner's `selected` set;
 *   - `prepareToolCall` + `executePreparedTool` resolve a call against the
 *     executable map produced by the planner and run the handler.
 */

import { mergeAbortSignals } from "../../../infra/abort.js";
import { PersistenceWriteRefused } from "../../../infra/event-store-types.js";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { NO_MODULE_RUNTIMES, type ModuleRuntimes } from "../../../infra/module-runtime.js";
import { durationMs, logCompletion } from "../../../infra/operation-log.js";
import { runModuleGate, type ModuleGate } from "../../module-hooks.js";
import type { ToolCall, ToolInputRepair } from "../llm/types.js";
import type { AgentOptions } from "../types.js";
import type { GateAdmission } from "./tool-concurrency-gate.js";
import { coerceToolInput, describeInputRepair } from "./coerce-input.js";
import { formatToolInputProblems, validateToolInput } from "./validate-input.js";
import { toolNamesForActions } from "./tool-exposure-planner.js";
import { grantCovers, NO_CAPABILITY_ACCESS, refuseDisabledToolCall, withCapabilityGrant, type CapabilityAccess, type RuntimeTool, type RuntimeToolInput, type ShellCommand, type ToolAdmissionContext, type ToolContext, type ToolResult } from "./types.js";
import { toolModuleRequirements } from "./tool-registry.js";
import { createToolRegistry, shellCommandOf } from "../../tool-catalog.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { resolveToolPath } from "./tool-paths.js";

const log = Log.create({ service: "tool-dispatch" });

// Generic inactivity watchdog for tools without their own bounded timeout
// (RuntimeTool.unboundedDuration opts out). Bounded tools must finish or
// report live execution output before this interval elapses; each report
// resets the timer so legitimately busy tools are not killed as hung.
const TOOL_WATCHDOG_MS = 120_000;
/** A tool call that runs this long is one a person notices as a wait, so its
 *  completion records at the default level. */
const SLOW_TOOL_CALL_MS = 60_000;

export function selectedToolNames(options: AgentOptions): ReadonlySet<string> | undefined {
  if (options.toolNames) return new Set(options.toolNames);
  if (options.toolActions) return new Set(toolNamesForActions(options.toolActions, createToolRegistry()));
  return undefined;
}

export type PreparedCallCapabilityAdmission =
  | { readonly ok: true; readonly access?: CapabilityAccess }
  | { readonly ok: false; readonly refusal: ToolResult };

export interface PreparedToolCall {
  call: ToolCall;
  tool: RuntimeTool | undefined;
  input: RuntimeToolInput;
  validationResult?: ToolResult;
  capabilityAdmission?: PreparedCallCapabilityAdmission;
  admissionPreparation?: Promise<void>;
  preparedReservedPaths?: readonly string[];
  /** Leads the result when argument coercion or admission preparation repaired the model's input, one line per repair. */
  repairNotice?: string;
  pendingInputRepairs?: readonly ToolInputRepair[];
}

export interface ToolExecutionGateInput {
  readonly call: Readonly<ToolCall>;
  /** The tool the call runs, whichever registration's name the model used. A gate names tools by this, never by `call.name`. */
  readonly tool: string;
  readonly input: Readonly<RuntimeToolInput>;
  /** The command and directory of a shell call, from the tool's own declaration. */
  readonly shell?: ShellCommand;
  readonly sessionId?: string;
  readonly executionCwd: string;
  readonly preparedReservedPaths: readonly string[];
  /** The runtimes of this runner's enabled modules; a gate reads its own through its handle. */
  readonly modules: ModuleRuntimes;
}

interface ToolReplacementExecutionContext {
  readonly signal?: AbortSignal;
  readonly reportProgress: (text: string) => void;
}

export type ToolExecutionGate = ModuleGate<ToolExecutionGateInput, ToolReplacementExecutionContext, ToolResult>;

const MAX_GATE_PROGRESS_CHARS = 50_000;

function immutable<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) immutable(nested);
    return Object.freeze(value);
  }
  return value;
}

function descriptorPaths(prepared: PreparedToolCall, executionCwd: string): readonly string[] {
  if (prepared.preparedReservedPaths) return prepared.preparedReservedPaths;
  const reserved = prepared.tool?.reservedPaths?.(prepared.input, executionCwd);
  if (reserved) return reserved;
  const pathValue = prepared.input.path;
  if ((prepared.call.name === "read" || prepared.call.name === "search") && typeof pathValue === "string") {
    const rawPath = prepared.call.name === "read" ? pathValue.replace(/:(?:raw|[-\d+,]+)$/u, "") : pathValue;
    return [canonicalMutationPath(resolveToolPath(executionCwd, rawPath))];
  }
  if (prepared.call.name === "search" && pathValue === undefined) return [canonicalMutationPath(executionCwd)];
  return [];
}

function immutableGateInput(prepared: PreparedToolCall, context: ToolContext): ToolExecutionGateInput {
  const { call, input } = prepared;
  const immutableInput = immutable(structuredClone(input));
  const shell = prepared.tool && shellCommandOf(prepared.tool.name, immutableInput, context.executionCwd);
  return immutable({
    call: immutable({ ...call, input: immutableInput }),
    tool: context.toolNames?.logical(call.name) ?? call.name,
    input: immutableInput,
    ...(shell ? { shell } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    executionCwd: context.executionCwd,
    preparedReservedPaths: [...descriptorPaths(prepared, context.executionCwd)],
    modules: context.moduleRuntimes ?? NO_MODULE_RUNTIMES,
  });
}

/** Normalization ladder for mismatched tool names, applied before rejection.
 *  Models emit variants that differ only in casing, separators, or class-like
 *  suffixes (`TodoTool_tool`, `Patch_tool`, `write file`), and some provider
 *  layers leak XML attribute fragments into the name field. Each unrepaired
 *  mismatch costs a full model round-trip, so normalize aggressively and fall
 *  back to an unambiguous fuzzy match. A repair only succeeds when the result
 *  is an exact member of the current turn's exposure map, so it can never
 *  widen the tool surface, only recover a reference the model already has. */
export function repairToolName(name: string, tools: ReadonlyMap<string, RuntimeTool>): string | null {
  if (!name || tools.has(name)) return null;

  // Trim at the first XML/quote character to strip provider protocol leaks
  // like `terminal" parameter="command"`. Deliberately not split on
  // whitespace: `write file` must keep flowing through normalization.
  let cleaned = name;
  for (const sep of ['"', "'", "<", ">"]) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0) cleaned = cleaned.slice(0, idx);
  }
  if (!cleaned) return null;

  const norm = (s: string): string => s.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const camelToSnake = (s: string): string => s.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();
  const stripToolSuffix = (s: string): string | null => {
    const lc = s.toLowerCase();
    for (const suffix of ["_tool", "-tool", "tool"]) {
      if (lc.endsWith(suffix)) return s.slice(0, s.length - suffix.length).replace(/[_-]+$/, "");
    }
    return null;
  };

  // Cheap fast paths first; these cover the common case.
  const lowered = cleaned.toLowerCase();
  if (tools.has(lowered)) return lowered;
  const normalized = norm(cleaned);
  if (tools.has(normalized)) return normalized;

  // Full candidate set for class-like emissions. Suffix-strip runs twice so
  // double-tacked suffixes like `TodoTool_tool` reduce all the way.
  const candidates = new Set([cleaned, lowered, normalized, camelToSnake(cleaned)]);
  for (let round = 0; round < 2; round++) {
    const extra = new Set<string>();
    for (const candidate of candidates) {
      const stripped = stripToolSuffix(candidate);
      if (stripped) {
        extra.add(stripped);
        extra.add(norm(stripped));
        extra.add(camelToSnake(stripped));
      }
    }
    for (const entry of extra) candidates.add(entry);
  }
  for (const candidate of candidates) {
    if (candidate && tools.has(candidate)) return candidate;
  }

  // Fuzzy match as last resort: relative edit distance with the same 0.7
  // cutoff as Hermes's difflib call, accepted only when the best is unambiguous.
  let best: string | null = null;
  let bestScore = 0;
  let ambiguous = false;
  for (const valid of tools.keys()) {
    const score = nameSimilarity(lowered, valid);
    if (score < 0.7) continue;
    if (score > bestScore) {
      best = valid;
      bestScore = score;
      ambiguous = false;
    } else if (score === bestScore) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

/** 1 - levenshtein(a, b) / max length; 1 means identical. */
function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return 1 - (previous[b.length] ?? maxLen) / maxLen;
}

/** Applies the repair ladder to a call, stamping the original name so the
 *  tool.input.completed fact records the repair. Identity when no repair. */
export function repairToolCall(call: ToolCall, tools: ReadonlyMap<string, RuntimeTool>): ToolCall {
  const repaired = repairToolName(call.name, tools);
  if (repaired === null) return call;
  log.info("tool name auto-repaired", { from: call.name, to: repaired, toolUseId: call.id });
  return { ...call, name: repaired, repairedFrom: call.name };
}

export function prepareToolCall(rawCall: ToolCall, tools: ReadonlyMap<string, RuntimeTool>, capabilityAdmission?: PreparedCallCapabilityAdmission): PreparedToolCall {
  const call = repairToolCall(rawCall, tools);
  const tool = tools.get(call.name);
  if (!tool) {
    const available = [...tools.keys()].join(", ");
    return {
      call,
      tool,
      input: call.input,
      validationResult: {
        content: `Unknown tool '${call.name}'; this tool is not registered in the current session. Available tools: ${available}. Either you misspelled the tool name or the tool is not loaded for this run; pick one from the available set.`,
        outcome: "error",
      },
    };
  }
  if (call.inputParseError) {
    return {
      call,
      tool,
      input: call.input,
      validationResult: {
        content: `Tool '${call.name}' was not executed: failed to parse tool arguments: ${call.inputParseError}. Re-send the call with well-formed JSON arguments.`,
        outcome: "error",
      },
    };
  }
  const inputRepairs: ToolInputRepair[] = [];
  const inputSchema = tool.inputValidationSchema ?? tool.inputSchema;
  // A custom-grammar tool takes raw text, so its arguments stay as written.
  const input = coerceToolInput(call.input, inputSchema, (repair) => inputRepairs.push(repair), { verbatimText: tool.wire?.kind === "custom" });
  const prepared: PreparedToolCall = {
    call, tool, input, pendingInputRepairs: inputRepairs,
    ...(capabilityAdmission ? { capabilityAdmission } : {}),
  };
  if (!tool.prepareAdmission) validatePreparedInput(prepared);
  return prepared;
}

/** Final validation is shared by synchronous tools and tools with an async repair. */
function validatePreparedInput(prepared: PreparedToolCall): void {
  const { tool, call } = prepared;
  if (!tool) return;
  const inputSchema = tool.inputValidationSchema ?? tool.inputSchema;
  const problemsOf = (candidate: RuntimeToolInput) => tool.validatesOwnInput ? [] : validateToolInput(candidate, inputSchema);
  const inputRepairs = prepared.pendingInputRepairs ?? [];
  let problems = problemsOf(prepared.input);
  const keepRepairs = inputRepairs.length > 0 && problems.length === 0;
  if (inputRepairs.length > 0) {
    log.info("tool input repaired before validation", { tool: call.name, toolUseId: call.id, repairs: inputRepairs, kept: keepRepairs });
  }
  if (problems.length > 0) {
    prepared.input = call.input;
    prepared.repairNotice = undefined;
    prepared.preparedReservedPaths = undefined;
    problems = problemsOf(call.input);
    prepared.validationResult = { content: formatToolInputProblems(call.name, problems), outcome: "error" };
  } else if (keepRepairs) {
    call.inputRepairs = [...inputRepairs];
    const sharedNotice = inputRepairs.map(describeInputRepair).join("\n");
    prepared.repairNotice = prepared.repairNotice ? `${sharedNotice}\n${prepared.repairNotice}` : sharedNotice;
  }
  prepared.pendingInputRepairs = undefined;
}

/** Performs one tool-owned asynchronous normalization before path admission. */
async function ensureAdmissionPrepared(prepared: PreparedToolCall, context: ToolAdmissionContext, signal?: AbortSignal): Promise<void> {
  if (!prepared.tool?.prepareAdmission || prepared.validationResult) return;
  prepared.admissionPreparation ??= prepared.tool.prepareAdmission(prepared.input, context, signal).then((result) => {
    if (result.repair) {
      // Per call, so DEBUG: the notice leads the durable tool result.
      log.debug("tool input repaired", { tool: prepared.call.name, toolUseId: prepared.call.id });
      prepared.input = result.repair.input;
      prepared.repairNotice = prepared.repairNotice === undefined ? result.repair.notice : `${prepared.repairNotice}\n${result.repair.notice}`;
    }
    if (result.reservedPaths) prepared.preparedReservedPaths = result.reservedPaths;
    validatePreparedInput(prepared);
  }).catch((error) => {
    prepared.validationResult = {
      content: signal?.aborted ? `Tool '${prepared.call.name}' was aborted by the user before it could start. No work was done.` : `Tool '${prepared.call.name}' was not executed: ${errorMessage(error)}`,
      outcome: signal?.aborted ? "interrupted" : "error",
    };
  });
  await prepared.admissionPreparation;
}

/** Leads a result with a notice; image parts keep their order after it. */
function prependNotice(result: ToolResult, notice: string): ToolResult {
  const content = typeof result.content === "string"
    ? `${notice}\n${result.content}`
    : [{ type: "text" as const, text: notice }, ...result.content];
  return { ...result, content };
}

/** Leads a result with the notice of an input repair. */
export function withInputRepairNotice(prepared: PreparedToolCall, result: ToolResult): ToolResult {
  return prepared.repairNotice === undefined ? result : prependNotice(result, prepared.repairNotice);
}

/** Gate admission for a prepared call after its one-time asynchronous normalization. */
export async function preparedToolAdmission(prepared: PreparedToolCall, context: ToolAdmissionContext, signal?: AbortSignal): Promise<GateAdmission> {
  await ensureAdmissionPrepared(prepared, context, signal);
  if (prepared.validationResult || !prepared.tool) return { kind: "exclusive" };
  if (prepared.tool.gateAdmission === "none") return { kind: "none" };
  const safety = prepared.tool.isConcurrencySafe;
  const safe = typeof safety === "function" ? safety(prepared.input) : safety;
  if (safe) return { kind: "safe" };
  const paths = prepared.preparedReservedPaths ?? prepared.tool.reservedPaths?.(prepared.input, context.executionCwd);
  if (paths && paths.length > 0) return { kind: "paths", paths };
  return { kind: "exclusive" };
}

/** Capability admission for one prepared call (ARCH-RUNTIME-068, ARCH-TOOLS-008).
 *
 *  The check is here, after input validation and before `tool.execute`, so a
 *  stale call the model kept from an earlier request is refused before any body,
 *  model request, or background side effect. An operation that already holds a
 *  grant covering the requirement uses it: an admitted learning review must not
 *  be refused mid-run by a disable that landed after it started. Everything else
 *  performs a fresh atomic admission and forwards the minted grant, so a deep
 *  callee of this one call never admits the same operation a second time. */
type PreparedCallAdmission = PreparedCallCapabilityAdmission;

async function admitPreparedCall(tool: RuntimeTool, context: ToolContext): Promise<PreparedCallAdmission> {
  const required = toolModuleRequirements(context.toolNames?.logical(tool.name) ?? tool.name, createToolRegistry());
  if (required.length === 0) return { ok: true };
  // A context that owns no capability policy holds no optional capability, so
  // its refusal lands here rather than in the tool body.
  const access = context.capabilityAccess ?? NO_CAPABILITY_ACCESS;
  if (grantCovers(access.grant, required)) return { ok: true };
  const admission = await access.admit({ operation: `the ${tool.name} tool`, required });
  if (!admission.ok) {
    return { ok: false, refusal: { content: refuseDisabledToolCall(tool.name, admission.reason), outcome: "error" } };
  }
  return { ok: true, access: withCapabilityGrant(access, admission.grant) };
}

export async function executePreparedTool(
  prepared: PreparedToolCall,
  context: ToolContext,
  options: { watchdogMs?: number; gate?: ToolExecutionGate } = {},
): Promise<ToolResult> {
  await ensureAdmissionPrepared(prepared, context, context.signal);
  const { call, tool, input, validationResult } = prepared;
  if (validationResult) {
    log.warn("tool admission failed", { tool: call.name, toolUseId: call.id });
    return withInputRepairNotice(prepared, validationResult);
  }
  if (!tool) throw new Error("prepared tool call has neither tool nor validation result");
  const admission = prepared.capabilityAdmission ?? await admitPreparedCall(tool, context);
  if (!admission.ok) {
    log.info("tool refused by capability policy", { tool: call.name, toolUseId: call.id });
    return withInputRepairNotice(prepared, admission.refusal);
  }
  if (context.signal?.aborted) {
    log.info("tool skipped before start", { tool: call.name, toolUseId: call.id, reason: "aborted" });
    return withInputRepairNotice(prepared, { content: `Tool '${call.name}' was aborted by the user before it could start. No work was done. Wait for the user's next instruction before retrying.`, outcome: "interrupted" });
  }
  const watchdog = tool.unboundedDuration ? undefined : new AbortController();
  const watchdogMs = options.watchdogMs ?? TOOL_WATCHDOG_MS;
  const watchdogTimeoutContent = `Tool '${call.name}' was aborted after ${watchdogMs / 1000}s without reporting any activity/output. Long-running work should stream progress output; otherwise try a narrower input or a different approach.`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetWatchdog = () => {
    if (!watchdog || watchdog.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => watchdog.abort(), watchdogMs);
  };
  const { onExecutionOutput, ...baseContext } = context;
  const ctx: ToolContext = {
    ...baseContext,
    signal: watchdog ? mergeAbortSignals(context.signal, watchdog.signal) : context.signal,
    toolUseId: call.id,
    ...(admission.access ? { capabilityAccess: admission.access } : {}),
    ...(call.modelRequestId ? { modelRequestId: call.modelRequestId } : {}),
    ...(onExecutionOutput ? { onExecutionOutput: (text: string) => { resetWatchdog(); onExecutionOutput(text); } } : {}),
  };
  resetWatchdog();
  const start = performance.now();
  // DEBUG for the same reason loggedOperation records its start there: the done
  // and failed records carry the same fields plus duration and outcome, so at
  // INFO this only doubled the volume of every tool call. The correlation key
  // moved to the done record rather than being lost with it.
  log.debug("tool execution start", { tool: call.name, toolUseId: call.id, sessionId: context.sessionId, artifactScopeId: context.artifactScopeId, modelRequestId: call.modelRequestId });
  try {
    const result = options.gate
      ? await runModuleGate(
        options.gate,
        immutableGateInput(prepared, context),
        Object.freeze({
          signal: ctx.signal,
          reportProgress: (text: string) => ctx.onExecutionOutput?.(text.slice(0, MAX_GATE_PROGRESS_CHARS)),
        }),
        () => tool.execute(input, ctx),
      )
      : await tool.execute(input, ctx);
    if ("kind" in result) {
      log.info("tool vetoed by capability gate", { tool: call.name, toolUseId: call.id });
      return withInputRepairNotice(prepared, { content: result.reason, outcome: "error" });
    }
    if (watchdog?.signal.aborted && !context.signal?.aborted) {
      log.warn("tool execution timed out", { tool: call.name, toolUseId: call.id, durationMs: durationMs(start), timeoutMs: watchdogMs });
      // The tool's own account follows the notice: it can say what the
      // aborted work had already done, such as a request that reached a server.
      return withInputRepairNotice(prepared, { ...prependNotice(result, watchdogTimeoutContent), outcome: "error" });
    }
    // Per call, so DEBUG unless slow: the durable tool result holds the
    // outcome, and the run's completion record counts the calls.
    logCompletion(log, "tool execution done", { tool: call.name, toolUseId: call.id, modelRequestId: call.modelRequestId, outcome: result.outcome, deferCompletion: result.deferCompletion }, { durationMs: durationMs(start), slowMs: SLOW_TOOL_CALL_MS });
    return withInputRepairNotice(prepared, result);
  } catch (err) {
    if (err instanceof PersistenceWriteRefused) throw err;
    if (watchdog?.signal.aborted && !context.signal?.aborted) {
      log.warn("tool execution timed out", { tool: call.name, toolUseId: call.id, durationMs: durationMs(start), timeoutMs: watchdogMs, error: errorMessage(err), errorDetail: errorDetail(err) });
      return withInputRepairNotice(prepared, { content: watchdogTimeoutContent, outcome: "error" });
    }
    if (context.signal?.aborted) {
      log.info("tool execution interrupted", { tool: call.name, toolUseId: call.id, durationMs: durationMs(start), error: errorMessage(err), errorDetail: errorDetail(err) });
      return withInputRepairNotice(prepared, { content: `Tool '${call.name}' was interrupted by the user before it could complete.`, outcome: "interrupted" });
    }
    log.warn("tool execution failed", { tool: call.name, toolUseId: call.id, durationMs: durationMs(start), error: errorMessage(err), errorDetail: errorDetail(err) });
    return withInputRepairNotice(prepared, { content: `Tool '${call.name}' failed: ${errorMessage(err)}`, outcome: "error" });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
