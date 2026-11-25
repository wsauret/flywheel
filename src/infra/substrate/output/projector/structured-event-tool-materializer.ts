import { Log } from "../../../diagnostics/log.js";
import type { ProvisionalDiff, ToolEntry, ToolPresentation } from "../../events/output-blocks.js";
import { toFileUri } from "../../../platform/files/paths.js";
import { declaredMutationField, getToolDisplay, resolveToolRowPresentation, targetSessionField } from "../tools/tool-display-registry.js";
import type { ToolDiffInfo, ToolDisplay, ToolRowPresentation } from "../tools/types.js";
import { getFiletype } from "../tools/filetype.js";
import { deferredAgentMeta, deferredAgentMetaPatch } from "./deferred-agent-meta.js";
import { stringField, type JsonFields } from "../tools/json-field.js";
import type { PendingToolInfo, PlacedTool } from "./output-tool-projection-types.js";
import type { StructuredOutputBuilder, ToolInputFields } from "./structured-output-builder.js";
import { createProvisionalDiffInput } from "../streaming/provisional-diff-input.js";
import { provisionalDiffDisplayPaths } from "../display-paths.js";

const log = Log.create({ service: "output-tool-materializer" });

export interface ToolMaterializerOptions {
  builder: StructuredOutputBuilder;
  trackedTools: Map<string, PlacedTool>;
  // Membership only: "this tracked tool is still streaming input". The tool
  // itself lives solely in trackedTools.
  streamingToolIds: Set<string>;
  executionCwd: string;
  sessionId?: string;
  targetDescription?: (input: JsonFields | undefined) => string | undefined;
}

export function materializePendingTool(
  options: ToolMaterializerOptions,
  pending: PendingToolInfo,
  toolUseId: string,
  input: JsonFields,
  streaming: boolean,
): void {
  const { renderLayout } = pending;

  if (renderLayout === "subagent") {
    materializeSubagent(options, pending, toolUseId, input);
  } else if (renderLayout === "standalone-mutation") {
    materializeStandaloneMutation(options, pending, toolUseId, input, streaming);
  } else {
    materializeToolRow(options, pending, toolUseId, input, streaming);
  }
}

export function materializeImmediateTool(
  options: ToolMaterializerOptions,
  name: string,
  input: JsonFields | undefined,
  toolUseId: string,
  timestamp: number,
  presentationOverride?: ToolEntry["presentation"],
  runCategoryOverride?: ToolEntry["runCategoryOverride"],
): void {
  const contract = getToolDisplay(name);
  const derived = toolEntryFields(name, contract, input, options.executionCwd, {
    targetDescription: options.targetDescription?.(input),
    includeDiff: contract.streamingInput === undefined,
    includeProposal: true,
  });
  const entry: ToolEntry = {
    kind: "tool",
    id: toolUseId,
    name,
    timestamp,
    ...derived.entryProps,
    ...(presentationOverride ? { presentation: presentationOverride } : {}),
    ...(runCategoryOverride ? { runCategoryOverride } : {}),
    status: contract.isOptimistic ? "completed" : "pending",
  };
  const tracked = placeToolRow(options.builder, entry, name, contract.streamingInput !== undefined);
  if (tracked) options.trackedTools.set(toolUseId, tracked);
}

function materializeSubagent(
  options: ToolMaterializerOptions,
  pending: PendingToolInfo,
  toolUseId: string,
  input: JsonFields,
): void {
  const { builder, trackedTools } = options;
  const agentId = toolUseId;
  const contract = getToolDisplay(pending.name);
  builder.startAgent(agentId, deferredAgentMeta(pending.name, input, contract.displayName), pending.timestamp, toolUseId);
  trackedTools.set(toolUseId, { kind: "agent", agentId, spawnedAt: pending.timestamp, toolName: pending.name });
  log.debug("agent block materialized", {
    sessionId: options.sessionId,
    toolUseId,
    agentId,
  });
}


function materializeStandaloneMutation(
  options: ToolMaterializerOptions,
  pending: PendingToolInfo,
  toolUseId: string,
  input: JsonFields,
  streaming: boolean,
): void {
  const { builder, trackedTools, streamingToolIds } = options;
  const { name, timestamp } = pending;
  const contract = getToolDisplay(name);
  const derived = toolEntryFields(name, contract, input, options.executionCwd, { includeDiff: !streaming, includeProposal: !streaming, targetDescription: options.targetDescription?.(input) });
  const entryProps = derived.entryProps;
  const idx = builder.pushStandaloneToolEntry({
    kind: "tool",
    name,
    timestamp,
    status: streaming ? "streaming" : "pending",
    id: toolUseId,
    ...entryProps,
  });
  if (idx >= 0) {
    trackedTools.set(toolUseId, { kind: "standalone", toolName: name, streamsInput: contract.streamingInput !== undefined });
    if (streaming) streamingToolIds.add(toolUseId);
  }
}

function materializeToolRow(
  options: ToolMaterializerOptions,
  pending: PendingToolInfo,
  toolUseId: string,
  input: JsonFields,
  streaming: boolean,
): void {
  const { builder, trackedTools, streamingToolIds } = options;
  const { name, timestamp } = pending;
  const contract = getToolDisplay(name);
  const derived = toolEntryFields(pending.name, contract, input, options.executionCwd, {
    targetDescription: options.targetDescription?.(input),
    includeDiff: !streaming,
    includeProposal: !streaming,
  });
  const entryProps = derived.entryProps;

  const entry: ToolEntry = {
    kind: "tool",
    name,
    timestamp,
    status: streaming ? "streaming" : (contract.isOptimistic ? "completed" : "pending"),
    id: toolUseId,
    ...entryProps,
    ...(pending.presentationOverride ? { presentation: pending.presentationOverride } : {}),
    ...(pending.runCategoryOverride ? { runCategoryOverride: pending.runCategoryOverride } : {}),
  };

  const tracked = placeToolRow(builder, entry, name, contract.streamingInput !== undefined);
  if (tracked) {
    trackedTools.set(toolUseId, tracked);
    if (streaming) streamingToolIds.add(toolUseId);
  }
}

export function finalizeStreamingTool(
  options: ToolMaterializerOptions,
  toolUseId: string,
  input: JsonFields,
  proposal?: { fileChangeKind: ToolEntry["fileChangeKind"]; proposedDiff: ProvisionalDiff },
): void {
  const { builder, trackedTools, streamingToolIds } = options;

  const agentTracked = trackedTools.get(toolUseId);
  if (agentTracked?.kind === "agent" && input) {
    const patch = deferredAgentMetaPatch(agentTracked.toolName, input, { streaming: false });
    if (patch.label || patch.description !== undefined) builder.updateAgentMeta(agentTracked.agentId, patch.label, patch.description, patch.agentType, patch.sentence);
  }

  const wasStreaming = streamingToolIds.delete(toolUseId);
  const tracked = wasStreaming ? trackedTools.get(toolUseId) : undefined;
  if (!tracked || tracked.kind === "agent") return;

  const name = tracked.toolName;
  const contract = getToolDisplay(name);
  const { presentation, linkUri, entryProps } = toolEntryFields(name, contract, input, options.executionCwd, { includeDiff: false, includeProposal: false, targetDescription: options.targetDescription?.(input) });
  const body = streamingInputBody(contract, input);
  const filePath = extractFilePath(input);
  const filetype = body?.presentation === "diff" ? "diff" : filePath ? getFiletype(filePath) : undefined;

  const fields: ToolInputFields = {
    presentation,
    sentence: entryProps.sentence,
    invocationBody: entryProps.invocationBody,
    linkUri,
    content: contract.fileChangeKind ? undefined : body?.content,
    filetype: contract.fileChangeKind ? undefined : filetype,
    fileChangeKind: proposal?.fileChangeKind ?? entryProps.fileChangeKind,
    declaresMutation: entryProps.declaresMutation,
    targetSessionId: entryProps.targetSessionId,
    proposedDiff: proposal?.proposedDiff ?? entryProps.proposedDiff,
  };
  const index = builder.toolBlockIndex(toolUseId);
  if (index !== undefined) builder.finalizeStandaloneTool(index, fields, true);
}

export function retainStreamingProposal(
  options: ToolMaterializerOptions,
  toolUseId: string,
  fileChangeKind: ToolEntry["fileChangeKind"],
  proposedDiff: ProvisionalDiff,
): void {
  const tracked = options.trackedTools.get(toolUseId);
  if (tracked?.kind !== "standalone") return;
  const index = options.builder.toolBlockIndex(toolUseId);
  if (index !== undefined) options.builder.finalizeStandaloneTool(index, { fileChangeKind, proposedDiff });
}

function streamingInputBody(
  contract: ToolDisplay,
  input: JsonFields,
): { content: string; presentation: "content" | "diff" } | undefined {
  const bodyFields = contract.streamingInput?.bodyFields;
  if (!bodyFields) return undefined;
  for (const [field, presentation] of Object.entries(bodyFields)) {
    const content = stringField(input, field);
    if (content !== undefined) return { content, presentation };
  }
  return undefined;
}

/** Refines a streaming row from the input decoded so far. `row` is the row
 *  that the display derived from the deltas, when it derives one; the row is
 *  then not resolved again from the whole partial input. */
export function refineStreamingTool(
  options: ToolMaterializerOptions,
  toolUseId: string,
  parsed: JsonFields,
  row?: ToolRowPresentation,
): void {
  const tracked = options.trackedTools.get(toolUseId);
  if (!tracked) return;
  if (tracked.kind === "agent") {
    const patch = deferredAgentMetaPatch(tracked.toolName, parsed, { streaming: true });
    if (patch.label || patch.description !== undefined) options.builder.updateAgentMeta(tracked.agentId, patch.label, patch.description, patch.agentType, patch.sentence);
    return;
  }
  const contract = getToolDisplay(tracked.toolName);
  const { presentation, linkUri, entryProps } = toolEntryFields(tracked.toolName, contract, parsed, options.executionCwd, { includeDiff: false, includeProposal: false, targetDescription: options.targetDescription?.(parsed), row });
  const fields: ToolInputFields = { presentation, sentence: entryProps.sentence, linkUri, fileChangeKind: entryProps.fileChangeKind, declaresMutation: entryProps.declaresMutation, targetSessionId: entryProps.targetSessionId };
  const index = options.builder.toolBlockIndex(toolUseId);
  if (index === undefined) return;
  const current = options.builder.getBlocks()[index];
  const unchanged = current?.kind === "tool"
    && current.presentation.name === presentation.name
    && current.presentation.detail === presentation.detail
    && current.sentence?.name === fields.sentence?.name
    && current.sentence?.detail === fields.sentence?.detail
    && current.linkUri === linkUri
    && current.fileChangeKind === fields.fileChangeKind
    && current.declaresMutation === fields.declaresMutation
    && current.targetSessionId === fields.targetSessionId;
  if (!unchanged) options.builder.finalizeStandaloneTool(index, fields);
}

export function extractFilePath(input: JsonFields): string | undefined {
  return stringField(input, "path");
}

function extractLinkUri(input: JsonFields, executionCwd: string): string | undefined {
  const filePath = extractFilePath(input);
  return filePath ? toFileUri(filePath, executionCwd) : undefined;
}

/** Shared presentation/link/diff derivation for one invocation. The resolver
 * produces the presentation, so a live row, its streaming refinement, and its
 * historical reconstruction read the same name; a streaming row that its
 * display derives from each delta equals the resolver's once its presentation
 * fields complete. `includeDiff` and
 * `includeProposal` carry each call site's guard (a streaming input);
 * `entryProps` is the conditional ToolEntry fragment the materializers spread. */
interface DiffOptions {
  targetDescription?: string;
  includeDiff: boolean;
  includeProposal: boolean;
  /** A row the display already derived, used in place of resolving one. */
  row?: ToolRowPresentation | undefined;
}

interface ToolEntryDerivation {
  presentation: ToolPresentation;
  linkUri: string | undefined;
  diffInfo: ToolDiffInfo | undefined;
  entryProps: Pick<ToolEntry, "presentation" | "sentence" | "action"> & Partial<Pick<ToolEntry, "linkUri" | "diff" | "content" | "filetype" | "invocationBody" | "runCategoryOverride" | "fileChangeKind" | "declaresMutation" | "targetSessionId" | "proposedDiff">>;
}

function toolEntryFields(
  toolName: string,
  contract: ToolDisplay,
  input: JsonFields | undefined,
  executionCwd: string,
  opts: DiffOptions,
): ToolEntryDerivation {
  const { presentation, sentence } = opts.row ?? resolveToolRowPresentation(toolName, input, executionCwd, { targetDescription: opts.targetDescription });
  const linkUri = input ? extractLinkUri(input, executionCwd) : undefined;
  const diffInfo = opts.includeDiff && input ? contract.extractDiff?.(input, executionCwd) : undefined;
  const fileChangeKind = input && contract.fileChangeKind
    ? typeof contract.fileChangeKind === "function" ? contract.fileChangeKind(input) : contract.fileChangeKind
    : undefined;
  const proposedDiffInput = opts.includeProposal && fileChangeKind ? createProvisionalDiffInput(fileChangeKind) : undefined;
  if (input) proposedDiffInput?.complete(input);
  const invocationBody = input && !fileChangeKind ? contract.invocationBody?.(input) : undefined;
  return {
    presentation,
    linkUri,
    diffInfo,
    entryProps: {
      presentation,
      sentence,
      action: contract.action,
      ...(linkUri ? { linkUri } : {}),
      ...(!fileChangeKind && diffInfo?.diff ? { diff: diffInfo.diff } : {}),
      ...(!fileChangeKind && diffInfo?.content ? { content: diffInfo.content } : {}),
      ...(!fileChangeKind && diffInfo?.filetype ? { filetype: diffInfo.filetype } : {}),
      ...(fileChangeKind ? { fileChangeKind } : {}),
      ...declaredMutationField(toolName, input),
      ...targetSessionField(toolName, input),
      ...(proposedDiffInput ? { proposedDiff: provisionalDiffDisplayPaths(proposedDiffInput.snapshot(), executionCwd) } : {}),
      ...(invocationBody ? { invocationBody } : {}),
    },
  };
}

/** Place one tool row as its own transcript block. */
function placeToolRow(builder: StructuredOutputBuilder, entry: ToolEntry, name: string, streamsInput: boolean): PlacedTool | null {
  const index = builder.pushStandaloneToolEntry(entry);
  return index >= 0 ? { kind: "standalone", toolName: name, streamsInput } : null;
}
