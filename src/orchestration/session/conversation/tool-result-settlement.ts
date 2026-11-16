import { canonicalize } from "../../../infra/canonical-name.js";
import { isDeliveryConfirmationText } from "../../../infra/delivery-confirmation.js";
import { isAgentInFlight, type AgentGroupBlock, type ToolEntry } from "../../../infra/output-blocks.js";
import { blockedStatusLine, formatAgentFailureDisplay, launderToolError, resolveAgentFailureDisplay } from "../../../infra/output/output-formatter.js";
import { agentResultSummary, selectToolResultContent } from "../../../infra/output/structured-event-tool-results.js";
import { mutationEvidenceSummaryDisplayPaths } from "../../../infra/output/display-paths.js";
import { resetFailedFileChange } from "../../../infra/output/file-change-settlement.js";
import { CANCELED_LABEL, interruptedLabel, STOPPED_LABEL } from "../../../infra/output/run-labels.js";
import { contractReadRow, getToolDisplay } from "../../../infra/tools/tool-display-registry.js";
import type { ToolHistorySummary } from "../../module-seams.js";
import { installedRuntimeInvocationTool } from "../../module-catalog.js";
import type { MessageEntry } from "./conversation-entry-types.js";
import type { ToolResultDisplayMeta } from "./tool-result-meta.js";

export type ToolResultMessage = Extract<MessageEntry["message"], { kind: "toolResult" }>;

/** Settles a projected agent card from its tool result, the run summary, and the recorded result meta. */
export function settleContainerGroup(
  group: AgentGroupBlock,
  result: ToolResultMessage,
  timestamp: number,
  run: ToolHistorySummary | undefined,
  meta: ToolResultDisplayMeta | undefined,
  toolName: string,
): AgentGroupBlock {
  const duration = group.duration ?? Math.max(0, timestamp - group.timestamp);
  if (canonicalize(toolName) === installedRuntimeInvocationTool().name) {
    if (result.interrupted === true) return { ...group, status: "interrupted", duration };
    switch (meta?.terminalOutcome) {
      // A launch acknowledgement settles nothing: the card states the
      // workflow's own state and time from its summary. With no summary yet,
      // the launch is pending; the time since launch is not its active time.
      case undefined: return run === undefined ? { ...group, status: "pending" } : group;
      // An ok result delivered the run's completion, which can report a
      // failed run that a Resume continues: the summary states the run, and
      // only a run with no summary reads as the completion it delivered.
      case "ok":
        if (run === undefined) return { ...group, status: "completed", duration };
        return isAgentInFlight(group.status) ? group : { ...group, duration };
      case "cancelled": return { ...group, status: "cancelled", duration };
      case "stopped": return { ...group, status: "stopped", duration };
      case "interrupted": return { ...group, status: "interrupted", duration };
      case "error":
      case "blocked":
        return {
          ...group,
          status: "error",
          duration,
          failure: meta.agentFailure ?? formatAgentFailureDisplay(meta.displayContent ?? "Workflow failed"),
        };
    }
  }
  // A successful run projection owns terminal status and metrics. A failed run
  // still reads its exact tree result so the display never degrades to a preview.
  const summary = run === undefined ? agentResultSummary(meta?.displayContent ?? resultText(result)) : run.summary;
  const summarized = summary !== undefined && (group.status === "completed" || group.status === "partial")
    ? { ...group, summary } : group;
  if (run?.ownsSettlement) return summarized;
  if (result.interrupted === true) return { ...group, status: "interrupted", duration };
  if (result.isError === true) {
    return { ...group, status: "error", duration, failure: resolveAgentFailureDisplay(resultText(result), meta?.agentFailure) };
  }
  if (group.status === "completed" || group.status === "error") return summarized;
  return { ...group, status: "completed", duration, ...(summary === undefined ? {} : { summary }) };
}

/** Settles a call row from its result. `resultTimestamp` is when the result
 *  entry was stored, which the row states as `settledAt` unless its run still
 *  holds it pending. */
export function settleToolEntry(call: ToolEntry, result: ToolResultMessage, resultTimestamp: number | undefined, meta: ToolResultDisplayMeta | undefined, executionCwd: string, run?: ToolHistorySummary): ToolEntry {
  // Only the result says that a call read its tool's contract (PI-AGENT-131), as on the live row.
  const tool = meta?.contractRead === true ? { ...call, ...contractReadRow(call.name) } : call;
  const rawResult = resultText(result);
  const display = getToolDisplay(tool.name);
  const content = selectToolResultContent(display, meta?.displayContent ?? rawResult, meta?.executionOutput, meta?.background);
  const preserved = display.preservesResultContent === true && content !== undefined ? { content } : {};
  let settled: ToolEntry;
  if (run && (run.ownsSettlement || tool.name === "subagent")) {
    switch (run.status) {
      case "active":
      case "pending":
      case "queued":
        settled = { ...tool, ...preserved, status: "pending" };
        break;
      case "error":
        settled = { ...tool, ...preserved, status: "error", errorMessage: run.failure.message };
        break;
      case "interrupted":
        settled = { ...tool, ...preserved, status: "interrupted" };
        break;
      case "paused":
        settled = { ...tool, ...preserved, status: "blocked", statusMessage: interruptedLabel(run.pausedBy) };
        break;
      case "partial":
        settled = { ...tool, ...preserved, status: "blocked", statusMessage: "Partial" };
        break;
      case "completed":
        settled = { ...tool, ...preserved, status: "completed" };
        break;
      case "cancelled":
        settled = { ...tool, ...preserved, status: "error", errorMessage: CANCELED_LABEL };
        break;
      case "stopped":
        settled = { ...tool, ...preserved, status: "error", errorMessage: STOPPED_LABEL };
        break;
    }
  } else if (result.interrupted === true) settled = { ...tool, ...preserved, status: "interrupted" };
  else if (result.blocked === true) settled = { ...tool, ...preserved, status: "blocked", statusMessage: blockedStatusLine(rawResult) };
  else if (result.isError === true) settled = { ...tool, ...preserved, status: "error", errorMessage: launderToolError(rawResult) };
  else if (meta?.statusMessage !== undefined) settled = { ...tool, ...preserved, status: "blocked", statusMessage: meta.statusMessage };
  else settled = { ...tool, ...preserved, status: "completed" };
  if (display.preservesResultContent === true && content === undefined) {
    const { content: _content, ...row } = settled;
    settled = row;
  }
  const { proposedDiff: _proposal, ...canonical } = settled;
  const published = meta?.mutationEvidence !== undefined || (result.interrupted !== true && result.blocked !== true && result.isError !== true);
  const projected = {
    ...(published ? canonical : settled),
    ...(meta?.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
    ...(meta?.diff !== undefined ? { diff: meta.diff } : {}),
    ...(meta?.filetype !== undefined ? { filetype: meta.filetype } : {}),
    ...(meta?.mutationEvidence !== undefined ? { mutationEvidence: mutationEvidenceSummaryDisplayPaths(meta.mutationEvidence, executionCwd) } : {}),
    ...(meta?.resultAction !== undefined ? { resultAction: meta.resultAction } : {}),
    ...(meta?.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
    ...(resultTimestamp !== undefined && settled.status !== "pending" ? { settledAt: resultTimestamp } : {}),
    ...(tool.targetSessionId === undefined && meta?.targetSessionId !== undefined ? { targetSessionId: meta.targetSessionId } : {}),
  };
  return result.isError === true && result.blocked !== true
    ? resetFailedFileChange(projected)
    : projected;
}

/** A tool result's text as the transcript shows it. */
export function resultText(result: ToolResultMessage): string {
  return result.content
    // The delivery receipt is turn metadata for the model, not tool output.
    .filter((part) => !(part.type === "text" && isDeliveryConfirmationText(part.text)))
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mediaType}]`))
    .join("\n");
}
