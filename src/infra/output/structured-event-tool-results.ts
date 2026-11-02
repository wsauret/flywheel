import { Option, Result, Schema } from "effect";
import { AgentFailureDisplaySchema, type AgentFailureDisplay, type ToolEntry } from "../output-blocks.js";
import { isDeliveryConfirmationText } from "../delivery-confirmation.js";
import type { LlmToolOutputPart } from "../llm/tool-output-part-schema.js";
import { getToolDisplay } from "../tools/tool-display-registry.js";
import type { ToolDisplay } from "../tools/types.js";
import { sanitizeExternalText } from "../control-characters.js";
import { blockedStatusLine, extractErrorText, launderToolError, resolveAgentFailureDisplay } from "./output-formatter.js";
import { MutationEvidenceSchema } from "../mutation-evidence-schema.js";
import type { MutationEvidence } from "../mutation-evidence.js";
import { arrayField, numberField, stringField } from "./json-field.js";
import type { PlacedTool } from "./output-tool-projection-types.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import type { ToolOutcome } from "../tool-outcome.js";
import { CANCELED_LABEL, STOPPED_LABEL } from "./run-labels.js";
import { asRecord } from "../record.js";
import { ToolResultActionSchema, type ToolResultAction } from "../tool-result-action.js";
import { mutationEvidenceSummaryDisplayPaths } from "./display-paths.js";
import { singleLine } from "../tools/detail-helpers.js";
import { summaryLine } from "../summary-line.js";

interface EditFile { path: string; diff: string; filetype?: string }

/** What a tool's recorded result contributes to its ordinary row, plus the
 * canonical artifact of a durable mutation. */
export interface ToolResultDisplayFields {
  diff?: string;
  filetype?: string;
  exitCode?: number;
  background?: boolean;
  mutationEvidence?: MutationEvidence;
  resultAction?: ToolResultAction;
  agentFailure?: AgentFailureDisplay;
}

/** A command's settled record: its tail, and the project edits a mutating
 *  command published at exit when it settled after its result was recorded. */
export interface SettledExecution {
  readonly output: string;
  readonly mutationEvidence?: MutationEvidence;
}

/** The fields a nested row inside an agent group keeps. Those rows are compact
 *  and disclose no body (see AgentGroupBlock's ToolList), so a preview-bearing
 *  diff, filetype, or captured output would never render. The durable mutation
 *  artifact is not a preview but the evidence that a durable write happened,
 *  so it travels with the child on both the live and the replayed path. */
export function childRowDisplayFields(fields: ToolResultDisplayFields): ToolResultDisplayFields {
  return {
    ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
    ...(fields.mutationEvidence !== undefined ? { mutationEvidence: fields.mutationEvidence } : {}),
    ...(fields.resultAction !== undefined ? { resultAction: fields.resultAction } : {}),
  };
}

const decodeMutationEvidence = Schema.decodeUnknownResult(MutationEvidenceSchema, { onExcessProperty: "error" });
const decodeResultAction = Schema.decodeUnknownOption(ToolResultActionSchema, { onExcessProperty: "error" });
const decodeAgentFailure = Schema.decodeUnknownResult(AgentFailureDisplaySchema, { onExcessProperty: "error" });

/** Where one `details` payload came from, named in the failure a malformed
 *  Flywheel-owned mutation raises so the producer is identifiable. */
export interface ToolResultIdentity {
  /** The tool a live result settles, or the fact type a durable replay reads. */
  readonly source: string;
  readonly toolUseId: string;
}

// `details` is the tool_result payload: writer-owned for our tools, but typed
// `unknown` at this boundary. Narrow each field so a malformed entry is skipped
// explicitly rather than mis-cast.

function asEditFile(entry: unknown): EditFile | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  const path = stringField(record, "path");
  const diff = stringField(record, "diff");
  if (path === undefined || diff === undefined) return undefined;
  const filetype = stringField(record, "filetype");
  return { path, diff, ...(filetype !== undefined ? { filetype } : {}) };
}

/** Exported for the derived-history tool-result meta reader
 *  (orchestration/session/conversation/tool-result-meta.ts), which narrows the same
 *  recorded `details` payload the live resolver reads. */
export function extractDisplayMeta(details: unknown, identity: ToolResultIdentity): ToolResultDisplayFields {
  const d = asRecord(details);
  if (!d) return {};
  const mutationEvidence = decodeOwnedMutationEvidence(d.mutationEvidence, identity);
  const resultAction = Option.getOrUndefined(decodeResultAction(d.resultAction));
  const agentFailure = decodeOwnedAgentFailure(d.agentFailure, identity);
  const artifact = {
    ...(mutationEvidence !== undefined ? { mutationEvidence } : {}),
    ...(resultAction !== undefined ? { resultAction } : {}),
    ...(agentFailure !== undefined ? { agentFailure } : {}),
  };
  const exitCode = numberField(d, "exitCode");
  const background = d.background === true ? true : undefined;
  const nonDiffMeta = {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(background !== undefined ? { background } : {}),
  };
  if (mutationEvidence !== undefined) return { ...artifact, ...nonDiffMeta };

  const files = arrayField(d, "files");
  if (files && files.length > 0) {
    const first = asEditFile(files[0]);
    return first ? { ...artifact, diff: first.diff, ...(first.filetype !== undefined ? { filetype: first.filetype } : {}) } : artifact;
  }
  const diff = stringField(d, "diff");
  const filetype = stringField(d, "filetype");
  return {
    ...artifact,
    ...(diff !== undefined ? { diff } : {}),
    ...(filetype !== undefined ? { filetype } : {}),
    ...nonDiffMeta,
  };
}

function decodeOwnedMutationEvidence(value: unknown, identity: ToolResultIdentity): MutationEvidence | undefined {
  if (value === undefined) return undefined;
  const decoded = decodeMutationEvidence(value);
  if (Result.isSuccess(decoded)) return decoded.success;
  throw new Error(`malformed mutationEvidence in ${identity.source} result details for ${identity.toolUseId}: ${decoded.failure.message}`);
}

function decodeOwnedAgentFailure(value: unknown, identity: ToolResultIdentity): AgentFailureDisplay | undefined {
  if (value === undefined) return undefined;
  const decoded = decodeAgentFailure(value);
  if (Result.isSuccess(decoded)) return decoded.success;
  throw new Error(`malformed agent failure in ${identity.source} result details for ${identity.toolUseId}: ${decoded.failure.message}`);
}

/** True when the result reports work that continues after it: its streaming text
 *  outlives the row's settlement. Reads `details` without decoding an artifact. */
export function isBackgroundResult(details: unknown): boolean {
  return asRecord(details)?.background === true;
}

// Subagent completions ride token totals in the tool_result `details` payload
// (see subagent-result-resolver) so the completed agent header can show usage.
function agentTotalTokens(details: unknown): number | undefined {
  const d = asRecord(details);
  return d ? numberField(d, "totalTokens") : undefined;
}

function agentPartial(details: unknown): boolean {
  return asRecord(details)?.partial === true;
}

/** A dispatch can return a handoff object or plain assistant text. Only a
 *  handoff's string summary supplies the card's result sentence. */
export function agentResultSummary(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return undefined; }
  const summary = asRecord(value)?.summary;
  return typeof summary === "string" ? summaryLine(sanitizeExternalText(summary)) : undefined;
}

function extractResultText(content: LlmToolOutputPart[] | undefined): string | undefined {
  if (!content) return undefined;
  const lines: string[] = [];
  for (const part of content) {
    // The delivery receipt is turn metadata for the model, not tool output;
    // rendering it inside a tool body attributes it to the wrong speaker.
    if (part.type === "text" && isDeliveryConfirmationText(part.text)) continue;
    if (part.type === "text") lines.push(part.text);
    else lines.push(`[image: ${part.mediaType}]`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** The result text a contract keeps as the row body, before sanitizing. */
function preservedResultText(contract: ToolDisplay, rawContent: LlmToolOutputPart[] | undefined): string | undefined {
  if (!contract.preservesResultContent) return undefined;
  const text = extractResultText(rawContent);
  return text && text.trim().length > 0 ? text : undefined;
}

/** The one sanitized body a resolved row shows. A result can be megabytes of
 *  text, so it is sanitized once here and every later patch of the row reuses it. */
function displayedResultContent(
  contract: ToolDisplay,
  resultContent: string | undefined,
  executionOutput: string | undefined,
  background: boolean | undefined,
): string | undefined {
  const selected = selectToolResultContent(contract, resultContent, executionOutput, background);
  return selected === undefined ? undefined : sanitizeExternalText(selected);
}

/** Selects a transcript body without exposing shell management acknowledgements.
 * Background shell results have no body until execution output is available. */
export function selectToolResultContent(
  contract: ToolDisplay,
  resultContent: string | undefined,
  executionOutput: string | undefined,
  background: boolean | undefined,
): string | undefined {
  return contract.resultContentFromExecutionOutput && (background === true || executionOutput !== undefined)
    ? executionOutput
    : resultContent;
}

/** The display name of the session a call addressed, which its result states
 *  under `details.targetName`. The call itself carries only the session id.
 *  Exported for the derived-history tool-result meta reader. */
export function resultTargetName(details: unknown): string | undefined {
  const name = asRecord(details)?.targetName;
  return typeof name === "string" ? singleLine(sanitizeExternalText(name)) || undefined : undefined;
}

/** The line an ok result states when its work now waits instead of being
 *  done, such as a message its recipient holds, under `details.statusMessage`.
 *  Its row settles as waiting with that line, not as completed. Exported for
 *  the derived-history tool-result meta reader. */
export function resultStatusMessage(details: unknown): string | undefined {
  const message = asRecord(details)?.statusMessage;
  return typeof message === "string" ? singleLine(sanitizeExternalText(message)) || undefined : undefined;
}

/** A result that names its target shows that name as the row's detail. */
function nameResultTarget(builder: StructuredOutputBuilder, tracked: PlacedTool, toolUseId: string, name: string): void {
  if (tracked.kind === "standalone") {
    const index = builder.toolBlockIndex(toolUseId);
    const block = index === undefined ? undefined : builder.getBlocks()[index];
    if (index !== undefined && block?.kind === "tool") builder.patchTool(index, { presentation: { ...block.presentation, detail: name } });
  } else if (tracked.kind === "row") {
    const group = builder.getBlocks().find((block) => block.kind === "agentGroup" && block.id === tracked.agentId);
    const child = group?.kind === "agentGroup" ? group.children[tracked.childIndex] : undefined;
    if (child) builder.patchAgentChild(tracked.agentId, tracked.childIndex, { presentation: { ...child.presentation, detail: name } });
  }
}

export function resolveTrackedToolResult(
  builder: StructuredOutputBuilder,
  tracked: PlacedTool,
  toolUseId: string,
  outcome: ToolOutcome,
  executionCwd: string,
  rawContent?: LlmToolOutputPart[],
  details?: unknown,
  executionOutputTail?: string,
  settled?: SettledExecution,
): void {
  const rawMeta: ToolResultDisplayFields = {
    ...extractDisplayMeta(details, { source: tracked.toolName, toolUseId }),
    ...(settled?.mutationEvidence ? { mutationEvidence: settled.mutationEvidence } : {}),
  };
  const projectedMeta = rawMeta.mutationEvidence !== undefined
    ? { ...rawMeta, mutationEvidence: mutationEvidenceSummaryDisplayPaths(rawMeta.mutationEvidence, executionCwd) }
    : rawMeta;
  const displayMeta = tracked.kind === "row" && tracked.inSubagent ? childRowDisplayFields(projectedMeta) : projectedMeta;
  const waiting = outcome === "ok" ? resultStatusMessage(details) : undefined;
  switch (tracked.kind) {
    case "agent":
      resolveAgentResult(builder, tracked, outcome, rawContent, details, displayMeta);
      break;
    case "row":
      resolveRowResult(builder, tracked, outcome, rawContent, displayMeta, waiting);
      break;
    case "standalone":
      if (tracked.toolName === "subagent" && outcome === "ok" && agentPartial(details)) {
        const index = builder.toolBlockIndex(toolUseId);
        if (index !== undefined) builder.blockTool(index, "Partial");
        break;
      }
      resolveStandaloneResult(builder, tracked, toolUseId, outcome, rawContent, displayMeta, executionOutputTail, waiting);
      break;
  }
  const targetName = resultTargetName(details);
  if (targetName !== undefined) nameResultTarget(builder, tracked, toolUseId, targetName);
}

function resolveAgentResult(
  builder: StructuredOutputBuilder,
  tracked: Extract<PlacedTool, { kind: "agent" }>,
  outcome: ToolOutcome,
  rawContent: LlmToolOutputPart[] | undefined,
  details: unknown,
  displayMeta: ToolResultDisplayFields,
): void {
  const durationMs = Date.now() - tracked.spawnedAt;
  if (outcome === "interrupted") {
    // Interrupted status renders its own "Interrupted" label; passing it as
    // the description would clobber the goal text and duplicate the label.
    builder.interruptAgent(tracked.agentId, durationMs);
  } else if (outcome === "cancelled" || outcome === "stopped") {
    builder.cancelAgent(tracked.agentId, durationMs, outcome);
  } else if (outcome === "error" || outcome === "blocked") {
    // "blocked" is unreachable for agent dispatch tools (only the handoff tool
    // returns wait-states); if one ever arrives, failing the group is the
    // loudest safe rendering.
    const rawText = extractErrorText(rawContent) ?? "Unknown error";
    builder.errorAgent(tracked.agentId, resolveAgentFailureDisplay(rawText, displayMeta.agentFailure));
  } else {
    const totalTokens = agentTotalTokens(details);
    const summary = agentResultSummary(extractResultText(rawContent));
    builder.completeAgent(tracked.agentId, durationMs, {
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(agentPartial(details) ? { partial: true } : {}),
    });
  }
}


function resolveRowResult(
  builder: StructuredOutputBuilder,
  tracked: Extract<PlacedTool, { kind: "row" }>,
  outcome: ToolOutcome,
  rawContent: LlmToolOutputPart[] | undefined,
  displayMeta: ToolResultDisplayFields,
  waiting: string | undefined,
): void {
  if (getToolDisplay(tracked.toolName).fileChangeKind || displayMeta.mutationEvidence !== undefined) {
    builder.patchAgentChild(tracked.agentId, tracked.childIndex, {
      proposedDiff: undefined, diff: undefined, invocationBody: undefined,
      ...(displayMeta.mutationEvidence !== undefined ? { mutationEvidence: displayMeta.mutationEvidence } : {}),
    });
  }
  if (outcome === "interrupted") {
    builder.interruptAgentChildTool(tracked.agentId, tracked.childIndex);
  } else if (outcome === "blocked") {
    builder.blockAgentChildTool(tracked.agentId, tracked.childIndex, blockedStatusLine(extractResultText(rawContent) ?? ""));
  } else if (outcome === "error" || outcome === "cancelled" || outcome === "stopped") {
    const rawText = extractErrorText(rawContent) ?? "Unknown error";
    const message = launderToolError(rawText);
    builder.errorAgentChildTool(tracked.agentId, tracked.childIndex, message, failureEvidence(displayMeta));
  } else {
    const contract = getToolDisplay(tracked.toolName);
    const content = displayedResultContent(contract, preservedResultText(contract, rawContent), undefined, displayMeta.background);
    const settled = verifiedCompletionMeta(contract, rawContent, displayMeta, content);
    if (waiting === undefined) builder.completeAgentChildTool(tracked.agentId, tracked.childIndex, settled);
    else builder.patchAgentChild(tracked.agentId, tracked.childIndex, { ...settled, status: "blocked", statusMessage: waiting });
  }
}

function resolveStandaloneResult(
  builder: StructuredOutputBuilder,
  tracked: Extract<PlacedTool, { kind: "standalone" }>,
  toolUseId: string,
  outcome: ToolOutcome,
  rawContent: LlmToolOutputPart[] | undefined,
  displayMeta: ToolResultDisplayFields,
  executionOutputTail: string | undefined,
  waiting: string | undefined,
): void {
  const index = builder.toolBlockIndex(toolUseId);
  if (index === undefined) return;
  if (getToolDisplay(tracked.toolName).fileChangeKind || displayMeta.mutationEvidence !== undefined) {
    builder.patchTool(index, { proposedDiff: undefined, diff: undefined, invocationBody: undefined,
      ...(displayMeta.mutationEvidence !== undefined ? { mutationEvidence: displayMeta.mutationEvidence } : {}) });
  }
  const block = builder.getBlocks()[index];
  const executeContent = block?.kind === "tool" && block.runCategoryOverride === "execute"
    ? extractResultText(rawContent)
    : undefined;
  const contract = getToolDisplay(tracked.toolName);
  const content = displayedResultContent(contract, executeContent ?? preservedResultText(contract, rawContent), executionOutputTail, displayMeta.background);
  if (content !== undefined) builder.finalizeStandaloneTool(index, { content });
  if (outcome === "interrupted") {
    builder.interruptTool(index);
  } else if (outcome === "blocked") {
    // A wait-state result (e.g. the handoff subagent gate). The full
    // message is user-facing context, so it renders as an injected system
    // message (header + bordered body); the row keeps a one-line summary.
    const text = extractResultText(rawContent) ?? "";
    builder.blockTool(index, blockedStatusLine(text));
    builder.pushUserMessage(text, Date.now(), false, true);
  } else if (outcome === "error" || outcome === "cancelled" || outcome === "stopped") {
    const rawText = extractErrorText(rawContent) ?? "Unknown error";
    const message = tracked.toolName === "subagent" && outcome === "cancelled" ? CANCELED_LABEL
      : tracked.toolName === "subagent" && outcome === "stopped" ? STOPPED_LABEL
      : launderToolError(rawText);
    builder.errorTool(index, message, failureEvidence(displayMeta));
  } else {
    const settled = verifiedCompletionMeta(contract, rawContent, displayMeta, content);
    if (waiting === undefined) builder.completeTool(index, settled);
    else builder.patchTool(index, { ...settled, status: "blocked", statusMessage: waiting });
  }
}

function failureEvidence(displayMeta: ToolResultDisplayFields): Partial<ToolEntry> {
  return {
    ...(displayMeta.mutationEvidence !== undefined ? { mutationEvidence: displayMeta.mutationEvidence } : {}),
    ...(displayMeta.exitCode !== undefined ? { exitCode: displayMeta.exitCode } : {}),
    ...(displayMeta.resultAction !== undefined ? { resultAction: displayMeta.resultAction } : {}),
  };
}

function verifiedCompletionMeta(
  contract: ToolDisplay,
  rawContent: LlmToolOutputPart[] | undefined,
  displayMeta: ToolResultDisplayFields,
  content: string | undefined,
): ToolResultDisplayFields & Partial<Pick<ToolEntry, "content" | "linkUri" | "fileChangeKind" | "proposedDiff" | "invocationBody">> {
  const linkUri = contract.resultLinkUri?.(rawContent);
  if (contract.fileChangeKind) {
    return {
      proposedDiff: undefined,
      invocationBody: undefined,
      diff: undefined,
      content: undefined,
      filetype: undefined,
      ...(displayMeta.mutationEvidence !== undefined ? { mutationEvidence: displayMeta.mutationEvidence } : {}),
      ...(displayMeta.exitCode !== undefined ? { exitCode: displayMeta.exitCode } : {}),
      ...(displayMeta.resultAction !== undefined ? { resultAction: displayMeta.resultAction } : {}),
    };
  }
  return {
    ...(displayMeta.mutationEvidence !== undefined ? { diff: undefined, filetype: undefined } : {}),
    ...displayMeta,
    ...(content ? { content } : {}),
    ...(linkUri ? { linkUri } : {}),
  };
}
