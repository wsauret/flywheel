/**
 * Resolves a subagent's terminal outcome into the status and content the
 * parent agent reads, optionally appending an LLM-generated (or
 * deterministic) work summary when the run left no result.
 *
 * The dispatcher hands off everything captured during the run (turnLog,
 * textState, stats, budget) and the resolver decides the status and the
 * content source of every path. Every content it produces passes through
 * `result-budget.ts`, the one module that bounds a subagent result.
 */

import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { PERSON_STOP_INSTRUCTION } from "../../../../infra/tool-outcome.js";
import { formatAgentFailure } from "../../../agent-runtime/failure-message.js";
import { failureTerminal, type AgentFailureReason, type AgentRunResult } from "../../../agent-runtime/types.js";
import type { BackgroundWorkResult, EndedWorkResult } from "../../../agent-runtime/background-work.js";
import type { SubagentStats, SubagentTextState } from "./stream-filter.js";
import type { SubagentToolCallRecord } from "./work-log.js";
import { boundHandoff, boundText, type ResultBudget } from "./result-budget.js";
import type { RunEnd } from "./run-end.js";

interface CapturedHandoff {
  [key: string]: unknown;
}

const log = Log.create({ service: "subagent-result-resolver" });

interface ResolverDeps {
  onRenderEvent: (event: RuntimeEvent) => void;
  summarizeOnFailure?: (
    records: ReadonlyArray<SubagentToolCallRecord>,
    terminalError: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export interface SubagentResultContext {
  agentType: string;
  childRunId: string;
  childSessionId: string;
  toolUseId: string | undefined;
  descriptionText: string;
  maxTurns: number;
  /** Child model identity, used to attribute a degraded-provider failure to
   *  the model the child was dispatched on. */
  model?: string;
  /** How the run ended, which its owner decided once. */
  end: RunEnd;
  textState: SubagentTextState;
  modelRequestId: string | undefined;
  /** Tool-use id the dispatching runner nests under; echoed on the child's
   *  terminal result fact so it matches the input fact's identity. */
  parentToolUseId: string | undefined;
  stats: SubagentStats;
  deps: ResolverDeps;
  turnLog: ReadonlyArray<SubagentToolCallRecord>;
  /** The bound of the parent-facing content, sized when the run settles. */
  budget: ResultBudget;
  signal?: AbortSignal;
}

export async function resolveSubagentResult(
  result: AgentRunResult,
  ctx: SubagentResultContext,
): Promise<EndedWorkResult> {
  const { agentType, descriptionText, textState, stats } = ctx;
  const durationMs = result.durationMs;
  const usage = usageFromStats(stats, durationMs);
  const label = subagentLabel(agentType, descriptionText);

  const budgetExhausted = result.terminal.kind === "budget_exhausted";
  // A handoff decides the result over an abort that landed before the loop
  // saw it written. A handoff stands only when the loop then returns
  // completed, its budget's end, or an abort; any other failure fails the
  // run first, so its end is no longer `handed_off` here.
  if (ctx.end.kind === "handed_off") return await handoffSubagentResult(ctx, usage, budgetExhausted, ctx.end.payload);

  const failure = subagentFailure(result);
  if (failure) {
    // A Stop is terminal: the parent's call fails with who stopped it, not
    // with a runner failure to diagnose. The loop's return decides the end
    // too, so a later Stop leaves the loop's own failure.
    if (failure.kind === "aborted" && ctx.end.kind === "stopped") {
      return ctx.end.by === "agent"
        ? cancelledSubagentResult(ctx, usage, label)
        : { status: "stopped", content: stoppedSubagentContent(agentType, descriptionText), usage };
    }
    return await failedSubagentResult(result, failure, ctx, usage, label);
  }

  const resultText = textState.finalAssistantText;
  if (resultText) {
    return await textSubagentResult(ctx, usage, budgetExhausted, resultText);
  }

  if (budgetExhausted) {
    return await budgetExhaustedSubagentResult(ctx, usage, label);
  }

  return await emptySubagentResult(ctx, usage, label);
}

function cancelledSubagentResult(
  _ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  label: string,
): EndedWorkResult {
  return { status: "cancelled", content: `${label} ${CANCELLED_TEXT}`, usage };
}

const CANCELLED_TEXT = "was canceled by the requesting agent.";

/** The parent-facing result of its own Stop, whether it cut a live run or
 *  ended a run that waited. */
export function cancelledSubagentContent(agentType: string, descriptionText: string): string {
  return `${subagentLabel(agentType, descriptionText)} ${CANCELLED_TEXT}`;
}

/** Subagents have no park loop, so `interrupted` and `input_closed` are run
 *  kill signals here, folded into the aborted failure the parent reports. */
function subagentFailure(result: AgentRunResult): AgentFailureReason | null {
  if (result.terminal.kind === "interrupted" || result.terminal.kind === "input_closed") return { kind: "aborted" };
  return failureTerminal(result.terminal);
}

async function failedSubagentResult(
  result: AgentRunResult,
  failure: AgentFailureReason,
  ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  label: string,
): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId, deps, turnLog, signal } = ctx;
  const failureDetail = formatAgentFailure(failure);
  const interrupted = failure.kind === "aborted";
  // An abort is an outcome, not a fault. The stall watchdog, the one abort
  // that is not owner-initiated, warns at its own decision point.
  if (interrupted) {
    log.info("subagent runner aborted", { agentType, toolUseId, childSessionId, runEnd: ctx.end.kind, durationMs: result.durationMs });
  } else {
    log.error("subagent runner failed", {
      agentType, toolUseId, childSessionId,
      failureKind: failure.kind, failureDetail, durationMs: result.durationMs,
    });
  }
  const detailSentence = failureDetail.endsWith(".") ? failureDetail : `${failureDetail}.`;
  const baseMessage = interrupted
    ? `${label} was interrupted: ${detailSentence} The runner exited before producing a result.`
    : `${label} failed: ${detailSentence}`;
  const content = await boundText(await appendWorkSummary(baseMessage, turnLog, failureDetail, deps, signal, interrupted), ctx.budget);
  return { status: "failed", content, usage, ...(!interrupted && failure.kind !== "local_persistence_error" ? { modelFailure: true as const } : {}) };
}

async function handoffSubagentResult(
  ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  budgetExhausted: boolean,
  handoff: CapturedHandoff,
): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId } = ctx;
  const content = await boundHandoff(handoff, ctx.budget);
  const status = budgetExhausted ? "partial" : "completed";
  // The one completion record of a dispatch. The handoff itself is in the
  // child session and the parent's durable tool result.
  log.info("subagent completed with handoff", {
    agentType, toolUseId, childSessionId, status,
    durationMs: usage.durationMs, handoffBytes: Buffer.byteLength(content), budgetExhausted,
  });
  return { status, content, usage };
}

async function textSubagentResult(
  ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  budgetExhausted: boolean,
  resultText: string,
): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId } = ctx;
  // A genuine provider/API failure surfaces as a typed `result.failure` and is
  // handled above. Reaching here means the run succeeded structurally, so the
  // status derives from that typed outcome - never from scanning the assistant's
  // prose, which false-flags legitimate text (e.g. "fixed the 404 handler").
  // A run cut by its turn budget is `partial`: the status says so, and the
  // content stays the model's own text.
  const status = budgetExhausted ? "partial" : "completed";
  log.info("subagent completed with text", {
    agentType, toolUseId, childSessionId, status,
    durationMs: usage.durationMs, textBytes: Buffer.byteLength(resultText), budgetExhausted,
  });
  return { status, content: await boundText(resultText, ctx.budget), usage };
}

async function budgetExhaustedSubagentResult(
  ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  label: string,
): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId, maxTurns, deps, turnLog, signal } = ctx;
  // The run did not break: its turn budget cut it, so its work so far is a
  // partial result (PI-AGENT-019). The partial status handling gives the
  // parent its choices, so the content carries no retry advice.
  log.info("subagent reached budget without result", {
    agentType, toolUseId, childSessionId, maxTurns, durationMs: usage.durationMs,
  });
  const baseMessage = `${label} reached its turn budget (${maxTurns} LLM calls) before it wrote a result.`;
  const content = await appendWorkSummary(baseMessage, turnLog, `turn budget of ${maxTurns} LLM calls reached`, deps, signal, false);
  return { status: "partial", content: await boundText(content, ctx.budget), usage };
}

async function emptySubagentResult(
  ctx: SubagentResultContext,
  usage: NonNullable<BackgroundWorkResult["usage"]>,
  label: string,
): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId, stats, deps, turnLog, signal } = ctx;
  log.warn("subagent produced no output", {
    agentType, toolUseId, childSessionId, durationMs: usage.durationMs,
    costUsd: stats.totalCostUsd,
    inputTokens: stats.totalInputTokens,
    outputTokens: stats.totalOutputTokens,
  });
  const baseMessage = `${label} completed without producing text output or a handoff. Retry with a tighter scope, or do the work directly.`;
  const content = await appendWorkSummary(baseMessage, turnLog, "no output produced", deps, signal, false);
  return { status: "failed", content: await boundText(content, ctx.budget), usage };
}

/** The parent-facing result of a runner that rejected, or of a settlement
 *  that itself threw: the parent still needs a terminal answer. */
export async function failedRunResult(err: unknown, phase: "run" | "settlement", ctx: SubagentResultContext): Promise<EndedWorkResult> {
  const { agentType, toolUseId, childSessionId, descriptionText, deps, turnLog, signal, stats } = ctx;
  log.error(phase === "run" ? "subagent promise rejected" : "subagent settlement failed", { agentType, toolUseId, childSessionId, error: errorMessage(err) });
  const label = subagentLabel(agentType, descriptionText);
  const baseMessage = phase === "run"
    ? `${label} failed mid-run: ${errorMessage(err)}. The subagent did not produce a final result.`
    : `${label} finished, but its result could not be settled: ${errorMessage(err)}.`;
  const content = await appendWorkSummary(baseMessage, turnLog, errorMessage(err), deps, signal, false);
  return { status: "failed", content: await boundText(content, ctx.budget), usage: usageFromStats(stats, 0) };
}

function subagentLabel(agentType: string, descriptionText: string): string {
  return `Subagent '${agentType}' (${descriptionText})`;
}

/** The parent-facing result of a person's Stop, whether it cut a live run or
 *  ended one that an interrupt or an unexpected exit left waiting. */
export function stoppedSubagentContent(agentType: string, descriptionText: string): string {
  return `${subagentLabel(agentType, descriptionText)} was stopped by the user. ${PERSON_STOP_INSTRUCTION}`;
}

export function usageFromStats(stats: SubagentStats, durationMs: number): NonNullable<BackgroundWorkResult["usage"]> {
  return {
    totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
    inputTokens: stats.totalInputTokens,
    outputTokens: stats.totalOutputTokens,
    cacheReadTokens: stats.totalCacheReadTokens,
    cacheCreateTokens: stats.totalCacheCreateTokens,
    reasoningTokens: stats.totalReasoningTokens,
    totalCostUsd: stats.totalCostUsd,
    toolUses: stats.toolUseCount,
    durationMs,
  };
}

/** Appends a markdown summary of the captured work to a message about a run
 *  that left no result, when the dep is wired and the run wasn't
 *  user-aborted. Failure to summarize is non-fatal - the base message ships
 *  unmodified. */
async function appendWorkSummary(
  baseMessage: string,
  turnLog: ReadonlyArray<SubagentToolCallRecord>,
  terminalError: string,
  deps: ResolverDeps,
  signal: AbortSignal | undefined,
  isAborted: boolean,
): Promise<string> {
  if (isAborted || turnLog.length === 0 || !deps.summarizeOnFailure) return baseMessage;
  try {
    const summary = await deps.summarizeOnFailure(turnLog, terminalError, signal);
    if (summary && summary.trim() !== "") return `${baseMessage}\n\n${summary}`;
  } catch (err) {
    log.warn("failure summary threw, dropping summary", { error: errorMessage(err) });
  }
  return baseMessage;
}
