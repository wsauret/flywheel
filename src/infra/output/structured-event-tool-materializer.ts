import { Log } from "../log.js";
import type { ProvisionalDiff, ToolEntry, ToolPresentation } from "../output-blocks.js";
import { toFileUri } from "../paths.js";
import { declaredMutationField, getToolDisplay, resolveToolRowPresentation, targetSessionField } from "../tools/tool-display-registry.js";
import type { ToolDiffInfo, ToolDisplay } from "../tools/types.js";
import { getFiletype } from "../tools/filetype.js";
import { deferredAgentMeta, deferredAgentMetaPatch } from "./deferred-agent-meta.js";
import { stringField, type JsonFields } from "./json-field.js";
import type { PendingToolInfo, PlacedTool, TrackedTool } from "./output-tool-projection-types.js";
import type { StructuredOutputBuilder, ToolInputFields } from "./structured-output-builder.js";
import { createProvisionalDiffInput } from "./provisional-diff-input.js";
import { provisionalDiffDisplayPaths } from "./display-paths.js";

const log = Log.create({ service: "output-tool-materializer" });

export interface ToolMaterializerOptions {
  builder: StructuredOutputBuilder;
  trackedTools: Map<string, TrackedTool>;
  // Membership only: "this tracked tool is still streaming input". The tool
  // itself lives solely in trackedTools.
  streamingToolIds: Set<string>;
  subagentAgentIds: Set<string>;
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
  parentAgentId: string | undefined,
  timestamp: number,
  presentationOverride?: ToolEntry["presentation"],
  runCategoryOverride?: ToolEntry["runCategoryOverride"],
): void {
  const contract = getToolDisplay(name);
  const derived = toolEntryFields(name, contract, input, options.executionCwd, {
    targetDescription: options.targetDescription?.(input),
    includeDiff: !parentAgentId && contract.streamingInput === undefined,
    includeProposal: !parentAgentId || !options.subagentAgentIds.has(parentAgentId),
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
  const tracked = trackToolRow(options.builder, entry, name, parentAgentId, contract.streamingInput !== undefined, options.subagentAgentIds, options.sessionId);
  if (tracked) options.trackedTools.set(toolUseId, tracked);
}

function materializeSubagent(
  options: ToolMaterializerOptions,
  pending: PendingToolInfo,
  toolUseId: string,
  input: JsonFields,
): void {
  const { builder, trackedTools, subagentAgentIds } = options;
  const agentId = toolUseId;
  const contract = getToolDisplay(pending.name);
  builder.startAgent(agentId, deferredAgentMeta(pending.name, input, contract.displayName), pending.timestamp, toolUseId);
  subagentAgentIds.add(agentId);
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
  const derived = toolEntryFields(name, contract, input, options.executionCwd, { includeDiff: !streaming && !pending.parentAgentId, includeProposal: !streaming, targetDescription: options.targetDescription?.(input) });
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
  const { name, timestamp, parentAgentId } = pending;
  const contract = getToolDisplay(name);
  const derived = toolEntryFields(pending.name, contract, input, options.executionCwd, {
    targetDescription: options.targetDescription?.(input),
    includeDiff: !streaming && !parentAgentId,
    includeProposal: !streaming && (!parentAgentId || !options.subagentAgentIds.has(parentAgentId)),
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

  const tracked = trackToolRow(builder, entry, name, parentAgentId, contract.streamingInput !== undefined, options.subagentAgentIds, options.sessionId);
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
  if (tracked.kind === "standalone") {
    const index = builder.toolBlockIndex(toolUseId);
    if (index === undefined) return;
    builder.finalizeStandaloneTool(index, fields, true);
  } else if (tracked.kind === "row") {
    builder.finalizeAgentChildTool(tracked.agentId, tracked.childIndex, fields, !tracked.inSubagent);
  }
}

export function retainStreamingProposal(
  options: ToolMaterializerOptions,
  toolUseId: string,
  fileChangeKind: ToolEntry["fileChangeKind"],
  proposedDiff: ProvisionalDiff,
): void {
  const tracked = options.trackedTools.get(toolUseId);
  if (!tracked || tracked.kind === "agent") return;
  if (tracked.kind === "standalone") {
    const index = options.builder.toolBlockIndex(toolUseId);
    if (index === undefined) return;
    options.builder.finalizeStandaloneTool(index, { fileChangeKind, proposedDiff });
  } else {
    options.builder.finalizeAgentChildTool(tracked.agentId, tracked.childIndex, { fileChangeKind, proposedDiff });
  }
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

export function refineStreamingTool(
  options: ToolMaterializerOptions,
  toolUseId: string,
  parsed: JsonFields,
): void {
  const tracked = options.trackedTools.get(toolUseId);
  if (!tracked) return;
  if (tracked.kind === "agent") {
    const patch = deferredAgentMetaPatch(tracked.toolName, parsed, { streaming: true });
    if (patch.label || patch.description !== undefined) options.builder.updateAgentMeta(tracked.agentId, patch.label, patch.description, patch.agentType, patch.sentence);
    return;
  }
  const contract = getToolDisplay(tracked.toolName);
  const { presentation, linkUri, entryProps } = toolEntryFields(tracked.toolName, contract, parsed, options.executionCwd, { includeDiff: false, includeProposal: false, targetDescription: options.targetDescription?.(parsed) });
  const fields: ToolInputFields = { presentation, sentence: entryProps.sentence, linkUri, fileChangeKind: entryProps.fileChangeKind, declaresMutation: entryProps.declaresMutation, targetSessionId: entryProps.targetSessionId };
  const unchanged = (current: ToolEntry | undefined) => current !== undefined
    && current.presentation.name === presentation.name
    && current.presentation.detail === presentation.detail
    && current.sentence?.name === fields.sentence?.name
    && current.sentence?.detail === fields.sentence?.detail
    && current.linkUri === linkUri
    && current.fileChangeKind === fields.fileChangeKind
    && current.declaresMutation === fields.declaresMutation
    && current.targetSessionId === fields.targetSessionId;
  if (tracked.kind === "standalone") {
    const index = options.builder.toolBlockIndex(toolUseId);
    if (index === undefined) return;
    const current = options.builder.getBlocks()[index];
    if (current?.kind === "tool" && unchanged(current)) return;
    options.builder.finalizeStandaloneTool(index, fields);
  } else {
    const parent = options.builder.getBlocks().find((block) => block.kind === "agentGroup" && block.id === tracked.agentId);
    if (unchanged(parent?.kind === "agentGroup" ? parent.children[tracked.childIndex] : undefined)) return;
    options.builder.finalizeAgentChildTool(tracked.agentId, tracked.childIndex, fields);
  }
}

export function extractFilePath(input: JsonFields): string | undefined {
  return stringField(input, "path");
}

function extractLinkUri(input: JsonFields, executionCwd: string): string | undefined {
  const filePath = extractFilePath(input);
  return filePath ? toFileUri(filePath, executionCwd) : undefined;
}

/** Shared presentation/link/diff derivation for one invocation. The resolver is
 * the only presentation producer, so a live row, its streaming refinement, and
 * its historical reconstruction read the same name. `includeDiff` carries each
 * call site's genuine guard (streaming, parent agent, subagent row);
 * `entryProps` is the conditional ToolEntry fragment the materializers spread. */
interface DiffOptions {
  targetDescription?: string;
  includeDiff: boolean;
  includeProposal: boolean;
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
  const { presentation, sentence } = resolveToolRowPresentation(toolName, input, executionCwd, { targetDescription: opts.targetDescription });
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
      ...(linkUri && { linkUri }),
      ...(!fileChangeKind && diffInfo?.diff && { diff: diffInfo.diff }),
      ...(!fileChangeKind && diffInfo?.content && { content: diffInfo.content }),
      ...(!fileChangeKind && diffInfo?.filetype && { filetype: diffInfo.filetype }),
      ...(fileChangeKind ? { fileChangeKind } : {}),
      ...declaredMutationField(toolName, input),
      ...targetSessionField(toolName, input),
      ...(proposedDiffInput ? { proposedDiff: provisionalDiffDisplayPaths(proposedDiffInput.snapshot(), executionCwd) } : {}),
      ...(invocationBody ? { invocationBody } : {}),
    },
  };
}

/** Track one visible tool row at its stable tree location. */
export function trackToolRow(
  builder: StructuredOutputBuilder, entry: ToolEntry, name: string, parentAgentId: string | undefined, streamsInput: boolean, subagentAgentIds: Set<string>, sessionId?: string,
): TrackedTool | null {
  return placeToolRow(builder, entry, name, parentAgentId, streamsInput, subagentAgentIds, sessionId);
}

/** Place one tool row where it belongs: inside its agent group, or standalone
 *  when the call has no parent agent. */
function placeToolRow(
  builder: StructuredOutputBuilder, entry: ToolEntry, name: string, parentAgentId: string | undefined, streamsInput: boolean, subagentAgentIds: Set<string>, sessionId?: string,
): PlacedTool | null {
  if (parentAgentId) {
    const inSubagent = subagentAgentIds.has(parentAgentId);
    const childIndex = builder.pushToolRowToAgent(parentAgentId, entry);
    if (childIndex >= 0) return { kind: "row", agentId: parentAgentId, childIndex, toolName: name, streamsInput, inSubagent };
    log.warn("placeToolRow: agent block not found in builder, falling back to standalone", {
      sessionId,
      parentAgentId,
      toolName: name,
      detail: entry.presentation.detail,
    });
    const index = builder.pushStandaloneToolEntry(entry);
    return index >= 0 ? { kind: "standalone", toolName: name, streamsInput } : null;
  }
  const index = builder.pushStandaloneToolEntry(entry);
  return index >= 0 ? { kind: "standalone", toolName: name, streamsInput } : null;
}
