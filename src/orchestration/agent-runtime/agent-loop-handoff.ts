/**
 * Bounded handoff correction loop. Handoff failures come back to the model as
 * correction tool_results (collapsed-payload coaching, schema issues,
 * mechanical validation), but workflow workers run without a maxLLMCalls cap,
 * so a model that cannot produce a valid handoff would otherwise retry
 * forever. After admission, every response without a valid handoff consumes a
 * correction attempt. At MAX_CONSECUTIVE_FAILURES the tracker throws
 * HandoffCorrectionExhausted: the agent broke its handoff contract. It is
 * deliberately outside AgentRuntimeError, so the run rejects with it instead
 * of mapping it to a provider failure, and the workflow host reports it as an
 * invalid handoff for the attempt.
 *
 * Before admission, stream-start refusals are wait states and do not count.
 * Interrupted handoffs neither count nor reset.
 */

import type { ToolResultEntry } from "./agent-state.js";
import type { TurnOutcome } from "./assistant-turn-result.js";
import { HandoffCorrectionExhausted } from "./errors.js";
import type { ToolCall } from "./llm/types.js";
import type { LlmToolOutputPart } from "./llm/messages.js";
import type { HandoffBlock } from "./background-work-readiness.js";
import type { ToolResult } from "./tools/types.js";
import type { BackgroundWorkRegistry } from "./background-work.js";

const MAX_CONSECUTIVE_FAILURES = 3;

const ERROR_EXCERPT_MAX = 400;

/** What an agent that started its handoff is told about every other call and
 *  every response without a handoff: only a corrected handoff can follow. */
export const HANDOFF_OWED_NOTICE = "The session ended when handoff started. Only a corrected handoff in the next response can run.";

interface HandoffTracker {
  readonly isHandingOff: boolean;
  /** One stream's decisions survive argument assembly and execution unchanged. */
  request(): {
    start(call: Pick<ToolCall, "id" | "modelRequestId">): void;
    refuse(call: ToolCall): ToolResult | undefined;
  };
  /** Records a settled response, including responses without tool calls.
   * Returns true for a successful handoff write. Throws HandoffCorrectionExhausted
   * when failed handoffs or admitted responses without a handoff exhaust the bound.
   * Only a response the provider served (`outcome` `ok`) counts toward the bound:
   * a failed request is a provider fault, not a broken handoff contract. */
  recordBatch(
    toolCalls: ReadonlyArray<ToolCall>,
    toolResults: ReadonlyArray<ToolResultEntry>,
    outcome: TurnOutcome["kind"],
  ): boolean;
}

export function createHandoffTracker(options?: {
  background?: Pick<BackgroundWorkRegistry, "assertHandoffReady" | "stopAdmission">;
  onStarted?(): void;
}): HandoffTracker {
  let consecutiveFailures = 0;
  // Null admits a call. Input closure derives from these decisions, not another terminal flag.
  const requests: Map<string, ToolResult | null>[] = [];
  const isHandingOff = (): boolean => requests.some((calls) => [...calls.values()].some((verdict) => verdict === null));
  const ended = (): ToolResult => ({ content: HANDOFF_OWED_NOTICE, outcome: "blocked" });

  return {
    get isHandingOff() { return isHandingOff(); },
    request() {
      const calls = new Map<string, ToolResult | null>();
      const key = (call: Pick<ToolCall, "id" | "modelRequestId">) => JSON.stringify([call.modelRequestId, call.id]);
      const start = (call: Pick<ToolCall, "id" | "modelRequestId">): void => {
        const id = key(call);
        if (calls.has(id)) return;
        if (calls.size === 0) requests.push(calls);
        if ([...calls.values()].some((verdict) => verdict === null)) { calls.set(id, ended()); return; }
        const alreadyAdmitted = isHandingOff();
        const block = alreadyAdmitted ? null : options?.background?.assertHandoffReady();
        calls.set(id, block ? { content: blockedHandoffMessage(block), outcome: "blocked" } : null);
        if (!block && !alreadyAdmitted) {
          options?.background?.stopAdmission();
          options?.onStarted?.();
        }
      };
      return {
        start,
        refuse(call) {
          if (call.name !== "handoff") return isHandingOff() ? ended() : undefined;
          start(call);
          return calls.get(key(call)) ?? undefined;
        },
      };
    },
    recordBatch(toolCalls, toolResults, outcome) {
      const handoffIds = new Set(toolCalls.filter((tc) => tc.name === "handoff").map((tc) => tc.id));
      const results = toolResults.filter((r) => handoffIds.has(r.toolUseId));
      if (results.some((r) => r.outcome === "ok")) {
        consecutiveFailures = 0;
        return true;
      }
      if (outcome !== "ok") return false;
      const failed = results.find((r) => r.outcome === "error");
      if (!failed && (!isHandingOff() || results.some((r) => r.outcome === "interrupted"))) return false;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new HandoffCorrectionExhausted({
          message: `handoff failed ${consecutiveFailures} consecutive attempts; last error: ${failed ? errorExcerpt(failed.content) : "no valid handoff was recorded"}`,
        });
      }
      return false;
    },
  };
}

function blockedHandoffMessage(block: HandoffBlock): string {
  const lines = ["handoff blocked: owned background work is still running or its result has not reached this conversation."];
  if (block.pending > 0) lines.push(`Results still owed: ${block.pendingDescriptions.join("; ")}. Wait for their delivery before handoff.`);
  if (block.active > 0) lines.push(`Still running: ${block.activeDescriptions.join("; ")}. Wait for each to end, or stop it with the process tool, before handoff.`);
  lines.push("Then call handoff again.");
  return lines.join("\n");
}

function errorExcerpt(parts: ReadonlyArray<LlmToolOutputPart>): string {
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (text.length === 0) return "(no error detail)";
  return text.length > ERROR_EXCERPT_MAX ? `${text.slice(0, ERROR_EXCERPT_MAX)}…` : text;
}
