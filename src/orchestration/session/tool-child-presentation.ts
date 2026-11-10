import { canonicalize } from "../../infra/canonical-name.js"
import type { ToolEntry } from "../../infra/output-blocks.js"
import { extractFilePath } from "../../infra/output/structured-event-tool-materializer.js"
import { nestedExecutePresentation } from "../../infra/output/execute-presentation.js"
import { childRowDisplayFields, selectToolResultContent } from "../../infra/output/structured-event-tool-results.js"
import { blockedStatusLine, launderToolError } from "../../infra/output/output-formatter.js"
import { sanitizeExternalText } from "../../infra/control-characters.js"
import { toFileUri } from "../../infra/paths.js"
import { declaredMutationField, getToolDisplay, resolveToolRowPresentation, targetSessionField } from "../../infra/tools/tool-display-registry.js"
import type { ToolResultDisplayMeta } from "./conversation/tool-result-meta.js"
import type { ToolExecutionEntry } from "./tool-execution-types.js"
import { createProvisionalDiffInput } from "../../infra/output/provisional-diff-input.js"

const LEGACY_RESULT_TRUNCATION_MARKER = "[Historical result content truncated]"

/** An ok call settles as completed, or as waiting with the line its result
 *  states, such as a held message. */
function settledOk<Base extends Omit<ToolEntry, "status">>(base: Base, meta: ToolResultDisplayMeta | undefined): ToolEntry {
  const fields = { ...base, ...childRowDisplayFields(meta ?? {}) }
  return meta?.statusMessage === undefined ? { ...fields, status: "completed" } : { ...fields, status: "blocked", statusMessage: meta.statusMessage }
}

/** Projects one decoded nested Code call, including its available result
 *  body: `resultContent` is the full text its result fact recorded. */
export function projectHistoricalExecuteChild(tool: ToolExecutionEntry, executionCwd: string, meta: ToolResultDisplayMeta | undefined, resultContent: string | undefined): ToolEntry {
  const name = canonicalize(tool.toolName)
  const input = tool.input ?? {}
  const rawContent = selectToolResultContent(getToolDisplay(name),
    meta?.displayContent ?? resultContent ?? (tool.contentPreview !== undefined
      ? `${tool.contentPreview}\n${LEGACY_RESULT_TRUNCATION_MARKER}` : undefined),
    meta?.executionOutput, meta?.background)
  const content = rawContent !== undefined ? sanitizeExternalText(rawContent) : undefined
  const base = {
    kind: "tool" as const, id: tool.toolUseId, name,
    presentation: nestedExecutePresentation(name, input), runCategoryOverride: "execute" as const,
    timestamp: tool.calledAt ?? tool.validationFailedAt ?? tool.completedAt ?? 0,
    ...(content !== undefined ? { content } : {}),
    ...(meta?.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
  }
  if (tool.status === "validation_failed") return { ...base, status: "error", errorMessage: launderToolError(tool.validationReason ?? "Tool validation failed") }
  switch (tool.resultOutcome) {
    case "ok": return settledOk(base, meta)
    case "error":
    case "cancelled":
    case "stopped": return { ...base, status: "error", errorMessage: launderToolError(content ?? "Unknown error") }
    case "blocked": return { ...base, status: "blocked", statusMessage: blockedStatusLine(content ?? "") }
    case "interrupted": return { ...base, status: "interrupted" }
    case undefined: return { ...base, status: "pending" }
  }
}

/** Projects one decoded subagent operation with execution-relative paths, without its result body. */
export function projectHistoricalContainerChild(tool: ToolExecutionEntry, executionCwd: string, meta: ToolResultDisplayMeta | undefined): ToolEntry {
  const name = canonicalize(tool.toolName)
  const input = tool.input ?? {}
  const rawPath = extractFilePath(input)
  const contract = getToolDisplay(name)
  const proposal = contract.fileChangeKind && tool.resultOutcome === undefined
    ? (() => {
        const fileChangeKind = typeof contract.fileChangeKind === "function" ? contract.fileChangeKind(input) : contract.fileChangeKind
        const diffInput = createProvisionalDiffInput(fileChangeKind)
        diffInput.complete(input)
        return { fileChangeKind, proposedDiff: diffInput.snapshot() }
      })() : {}
  const base = {
    kind: "tool" as const, id: tool.toolUseId, name,
    // The call carries only a session id; its result names the session, as the live row shows it.
    ...resolveToolRowPresentation(name, input, executionCwd, { targetDescription: meta?.targetName }),
    timestamp: tool.calledAt ?? tool.validationFailedAt ?? tool.completedAt ?? 0,
    ...(rawPath ? { linkUri: toFileUri(rawPath, executionCwd) } : {}), ...proposal, ...declaredMutationField(name, input), ...targetSessionField(name, input),
  }
  if (tool.status === "validation_failed") return { ...base, status: "error", errorMessage: launderToolError(tool.validationReason ?? "Tool validation failed") }
  // Acknowledgement overwrites execution status, but cannot change the recorded outcome.
  switch (tool.resultOutcome) {
    case "ok": return settledOk(base, meta)
    case "error":
    case "cancelled":
    case "stopped": return { ...base, status: "error", errorMessage: launderToolError(tool.contentPreview ?? "Tool failed") }
    case "blocked": return { ...base, status: "blocked", statusMessage: blockedStatusLine(tool.contentPreview ?? "") }
    case "interrupted": return { ...base, status: "interrupted" }
    case undefined: return { ...base, status: "pending" }
  }
}
