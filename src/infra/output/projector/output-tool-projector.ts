import { randomUUID } from "node:crypto";
import type { LlmToolOutputPart } from "../../llm/tool-output-part-schema.js";
import { canonicalize } from "../../canonical-name.js";
import { Log } from "../../diagnostics/log.js";
import type { AgentGroupBlock, AnyBlock, ToolEntry } from "../../output-blocks.js";
import { toFileUri } from "../../paths.js";
import { getToolDisplay, isHiddenFromTranscript, resolveToolRowPresentation } from "../../tools/tool-display-registry.js";
import type { ToolDisplay } from "../../tools/types.js";
import { getFiletype } from "../../tools/filetype.js";
import { nestedExecutePresentation } from "./execute-presentation.js";
import type { OutputProjectionEvent, ToolInput } from "../output-projection-events.js";
import type { PendingToolInfo, PlacedTool } from "./output-tool-projection-types.js";
import { StreamingToolInputs } from "../streaming/streaming-tool-inputs.js";
import {
  extractFilePath,
  finalizeStreamingTool,
  materializeImmediateTool,
  materializePendingTool,
  retainStreamingProposal,
  refineStreamingTool,
  type ToolMaterializerOptions,
} from "./structured-event-tool-materializer.js";
import { isBackgroundResult, resolveTrackedToolResult, type SettledExecution } from "./structured-event-tool-results.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import type { ToolOutcome } from "../../runtime-facts/tool-outcome.js";
import { createProvisionalDiffInput } from "../streaming/provisional-diff-input.js";
import { mutationEvidenceSummaryDisplayPaths, provisionalDiffDisplayPaths } from "../display-paths.js";
import { interruptedLabel } from "../run-labels.js";

/** The row text an interrupted child card carries, by any actor: the one
 *  mark a seeded card keeps to stay routable for its resume. */
const INTERRUPTED_LABELS: ReadonlySet<string> = new Set([interruptedLabel("person"), interruptedLabel("agent"), interruptedLabel("runtime")]);

const log = Log.create({ service: "output-tool-projector" });

/** The words that a control row names a child by: a workflow's title, which
 *  is its run summary, or a subagent's description. */
function childGoal(block: AgentGroupBlock): string {
  return block.containerKind === "workflow" ? block.label : block.description;
}

type ToolUseEvent = Extract<OutputProjectionEvent, { type: "tool-use" }>;

function fileProposalFields(contract: ToolDisplay, input: ToolInput | undefined, executionCwd: string): Partial<Pick<ToolEntry, "fileChangeKind" | "proposedDiff">> {
  if (!input || !contract.fileChangeKind) return {};
  const fileChangeKind = typeof contract.fileChangeKind === "function" ? contract.fileChangeKind(input) : contract.fileChangeKind;
  const proposal = createProvisionalDiffInput(fileChangeKind);
  proposal.complete(input);
  return { fileChangeKind, proposedDiff: provisionalDiffDisplayPaths(proposal.snapshot(), executionCwd) };
}

export class OutputToolProjector {
  private trackedTools = new Map<string, PlacedTool>();
  private readonly streamingInputs: StreamingToolInputs;
  private streamingToolIds = new Set<string>();
  private pendingTools = new Map<string, PendingToolInfo>();
  private deferredToolResults = new Set<string>();
  private executionOutputs = new Map<string, SettledExecution>();
  // Identity survives viewport eviction and foreground turn resets.
  private readonly childGoalsByLink = new Map<string, string>();
  private readonly executionCwd: string;
  /** The session id that log metadata names; its owner can change it. */
  private readonly sessionId: () => string | undefined;

  constructor(private readonly builder: StructuredOutputBuilder, options: { executionCwd: string; sessionId?: () => string | undefined }) {
    this.executionCwd = options.executionCwd;
    this.sessionId = options.sessionId ?? (() => undefined);
    this.streamingInputs = new StreamingToolInputs(options.executionCwd);
  }

  private get opts(): ToolMaterializerOptions {
    return {
      builder: this.builder,
      trackedTools: this.trackedTools,
      streamingToolIds: this.streamingToolIds,
      executionCwd: this.executionCwd,
      sessionId: this.sessionId(),
      // A subagent call names its child by `session_id`, a message by `to`,
      // and a control of a child by `process_id`.
      targetDescription: (input) => {
        const target = input?.session_id ?? input?.to ?? input?.process_id
        return typeof target === "string" ? this.childGoalsByLink.get(`flywheel://session/${target}`) : undefined
      },
    };
  }

  reset(): void {
    this.retainStreamingProposals();
    for (const toolUseId of this.trackedTools.keys()) {
      if (!this.deferredToolResults.has(toolUseId)) this.trackedTools.delete(toolUseId);
    }
    this.streamingInputs.reset();
    this.streamingToolIds.clear();
    this.pendingTools.clear();
    this.executionOutputs.clear();
  }

  parentAgentId(toolUseId: string): string | undefined {
    const tracked = this.trackedTools.get(toolUseId);
    return tracked?.kind === "agent" ? tracked.agentId : undefined;
  }

  /** A session re-opened from durable history seeds its transcript as blocks,
   *  never as live tool uses. The cards a child can still reach must be
   *  routable all the same: a running child pauses or completes under its
   *  original tool use id, and a paused or crash-interrupted child
   *  re-dispatches under it, so each of those events settles the seeded card.
   *  Settled cards stay unrouted; nothing reaches them again. */
  seedAgentBlocks(prior: readonly AnyBlock[]): void {
    for (const block of prior) {
      if (block.kind === "agentGroup" && block.linkUri) this.childGoalsByLink.set(block.linkUri, childGoal(block));
      if (block.kind === "tool" && block.name === "subagent" && block.linkUri) {
        if (block.presentation.detail) this.childGoalsByLink.set(block.linkUri, block.presentation.detail);
        if (block.status === "pending" || block.status === "interrupted" || (block.status === "blocked" && INTERRUPTED_LABELS.has(block.statusMessage ?? ""))) {
          this.trackedTools.set(block.id, { kind: "standalone", toolName: block.name, streamsInput: false });
          this.deferredToolResults.add(block.id);
        }
      }
      if (block.kind !== "agentGroup" || (block.status !== "active" && block.status !== "paused" && block.status !== "interrupted")) continue;
      this.trackedTools.set(block.toolUseId, { kind: "agent", agentId: block.id, spawnedAt: block.timestamp, toolName: block.containerKind });
    }
  }

  get trackedToolCount(): number { return this.trackedTools.size; }

  get hasActiveTools(): boolean { return this.trackedTools.size > 0; }

  finalizeActiveTopLevelTools(finalStatus: "completed" | "paused"): void {
    this.retainStreamingProposals();
    for (const [toolUseId, tracked] of this.trackedTools) {
      if (tracked.kind !== "standalone" || this.deferredToolResults.has(toolUseId)) continue;
      const index = this.builder.toolBlockIndex(toolUseId);
      if (index === undefined) continue;
      if (finalStatus === "paused") this.builder.interruptTool(index);
      else this.builder.completeTool(index);
    }
  }

  /** An unfinished input persists no tool call, so the durable fold has no
   *  row for its preview: the preview leaves the live display too, or every
   *  later block index differs between the two (ARCH-PROTOCOL-054). */
  abandonToolInputs(): void {
    for (const toolUseId of this.pendingTools.keys()) {
      this.builder.removeToolPreview(toolUseId);
      this.trackedTools.delete(toolUseId);
      this.pendingTools.delete(toolUseId);
      this.streamingInputs.discard(toolUseId);
      this.streamingToolIds.delete(toolUseId);
      this.builder.clearToolText(toolUseId);
    }
  }

  handleToolUse(event: ToolUseEvent): void {
    const toolUseId = event.toolUseId;
    const name = canonicalize(event.name);
    const contract = getToolDisplay(name);
    if (isHiddenFromTranscript(contract, event.input)) return;
    const input = event.input;
    if (toolUseId && (this.trackedTools.has(toolUseId) || this.pendingTools.has(toolUseId))) {
      if (input && Object.keys(input).length > 0) this.handleToolInputComplete(toolUseId, name, input, event.timestamp, event.parentToolUseId, event.nestedInCode, event.leadingTextId);
      return;
    }
    const parentTracked = event.parentToolUseId ? this.trackedTools.get(event.parentToolUseId) : undefined;
    // A script's nested calls can arrive before their parent code call is
    // registered: the durable-fact broadcast applies synchronously while the
    // parent's stream events ride the batched UI bus. The translator stamps
    // nestedInCode on events it derives from code-nested facts, so parentage
    // never depends on delivery order; the map checks cover stream-delivered
    // events that carry no stamp.
    const nestedInCode = event.nestedInCode === true
      || (parentTracked?.kind === "standalone" && parentTracked.toolName === "code")
      || (parentTracked === undefined && event.parentToolUseId !== undefined && this.pendingTools.get(event.parentToolUseId)?.name === "code");
    if (event.parentToolUseId && !nestedInCode) {
      log.debug("dropping nested event under a parent that is not a script", {
        sessionId: this.sessionId(),
        parentToolUseId: event.parentToolUseId,
        toolUseId,
        name,
      });
      return;
    }

    const isStreamingStart = input !== undefined && Object.keys(input).length === 0;
    const rendersAsAgentBlock = typeof contract.rendersAsAgentBlock === "function"
      ? contract.rendersAsAgentBlock(input ?? {})
      : contract.rendersAsAgentBlock === true;
    if (rendersAsAgentBlock) {
      if (!toolUseId) return;
      this.handleSubagentToolUse(name, input, toolUseId, isStreamingStart, event.timestamp);
      return;
    }

    if (!nestedInCode && this.handleTopLevelToolUse(name, contract, input, toolUseId, isStreamingStart, event.timestamp)) {
      if (input && toolUseId) this.insertLeadingText(toolUseId, name, input, event.timestamp, event.leadingTextId);
      return;
    }

    if (isStreamingStart && toolUseId) {
      const pending: PendingToolInfo = {
        name,
        timestamp: event.timestamp,
        renderLayout: "row",
        ...(nestedInCode ? { runCategoryOverride: "execute", presentationOverride: nestedExecutePresentation(event.name, input) } : {}),
      };
      this.pendingTools.set(toolUseId, pending);
      materializePendingTool(this.opts, pending, toolUseId, {}, true);
      this.streamingInputs.start(toolUseId, name);
      return;
    }

    if (toolUseId) {
      materializeImmediateTool(this.opts, name, input, toolUseId, event.timestamp,
        nestedInCode ? nestedExecutePresentation(event.name, input) : undefined,
        nestedInCode ? "execute" : undefined);
    } else {
      this.pushUntrackedToolRow(name, contract, input, event.timestamp);
    }
  }

  handleToolInputDelta(toolUseId: string, delta: string): void {
    const update = this.streamingInputs.append(toolUseId, delta);
    if (!update) return;
    if (update.proposedDiff) this.builder.proposeToolDiff(toolUseId, update.proposedDiff);
    if (update.kind === "failed") {
      if (!update.proposedDiff) this.builder.clearToolText(toolUseId);
      refineStreamingTool(this.opts, toolUseId, {});
      return;
    }
    const pending = this.pendingTools.get(toolUseId);
    if (pending && update.presentationInput) {
      this.refineLayout(toolUseId, pending, update.presentationInput);
      refineStreamingTool(this.opts, toolUseId, update.presentationInput, update.row);
    }

    if (!this.streamingToolIds.has(toolUseId) || update.proposedDiff) return;
    const tracked = this.trackedTools.get(toolUseId);
    if (!tracked || tracked.kind === "agent") return;

    if (tracked.streamsInput) {
      const streamingInput = getToolDisplay(tracked.toolName).streamingInput;
      const body = streamingInput
        ? Object.entries(streamingInput.bodyFields).find(([field]) => update.additions[field] !== undefined)
        : undefined;
      if (body) {
        const [field, presentation] = body;
        const filePath = update.filePath;
        const filetype = presentation === "diff" ? "diff" : filePath ? getFiletype(filePath) : undefined;
        this.builder.appendToolText(toolUseId, update.additions[field] ?? "", filetype);
      }
    }
  }

  handleToolPreviewCheck(toolUseId: string, operation: { type: "set"; advice: string } | { type: "clear" }): void {
    if (!this.streamingInputs.proposes(toolUseId)) return;
    this.builder.setToolPreviewCheck(toolUseId, operation.type === "set" ? operation.advice : null);
  }

  handleToolExecutionOutput(toolUseId: string, output: string): void {
    const tracked = this.trackedTools.get(toolUseId);
    if (tracked?.kind === "agent") return;
    this.builder.replaceToolText(toolUseId, output);
  }

  handleToolExecutionOutputRecorded(toolUseId: string, settled: SettledExecution): void {
    // A recorded tail is a settled command's output, with the project edits
    // a mutating command published at exit. One that settles after its row did
    // (a command that ran on in the background) patches the completed row
    // directly, resolved through the builder's id-to-index map rather than a
    // whole-array scan, and ends the live tail the row showed while it ran.
    const index = this.builder.toolBlockIndex(toolUseId);
    const block = index !== undefined ? this.builder.getBlocks()[index] : undefined;
    if (index !== undefined && block?.kind === "tool" && block.status === "completed" && getToolDisplay(block.name).resultContentFromExecutionOutput) {
      this.builder.clearToolTextSilently(toolUseId);
      this.builder.completeTool(index, {
        content: settled.output,
        ...(settled.mutationEvidence ? { mutationEvidence: mutationEvidenceSummaryDisplayPaths(settled.mutationEvidence, this.executionCwd) } : {}),
      });
      return;
    }
    // The row has not settled yet: the record travels with settlement so the
    // completed row carries it (see resolveToolResult).
    const tracked = this.trackedTools.get(toolUseId);
    if (tracked?.kind === "standalone" && getToolDisplay(tracked.toolName).resultContentFromExecutionOutput) {
      this.executionOutputs.set(toolUseId, {
        output: settled.output,
        ...(settled.mutationEvidence ? { mutationEvidence: settled.mutationEvidence } : {}),
      });
    }
  }

  /** The work a call left running ended, which can be long after the call
   *  settled, so the row is found through the builder's id-to-index map. */
  handleToolWorkEnded(toolUseId: string, endedAt: number): void {
    const index = this.builder.toolBlockIndex(toolUseId);
    if (index !== undefined) this.builder.patchTool(index, { endedAt });
  }

  handleToolInputComplete(toolUseId: string, name: string, input: ToolInput, timestamp: number, parentToolUseId?: string, nestedInCode?: true, leadingTextId?: string): void {
    const existingIndex = this.builder.toolBlockIndex(toolUseId);
    const existing = existingIndex !== undefined ? this.builder.getBlocks()[existingIndex] : undefined;
    if (existing?.kind === "tool" && existing.status === "error") {
      this.pendingTools.delete(toolUseId);
      this.streamingInputs.discard(toolUseId);
      this.streamingToolIds.delete(toolUseId);
      this.builder.clearToolText(toolUseId);
      return;
    }
    const pending = this.pendingTools.get(toolUseId);
    if (pending) {
      this.pendingTools.delete(toolUseId);
      const contract = getToolDisplay(pending.name);
      const rendersAsAgentBlock = typeof contract.rendersAsAgentBlock === "function"
        ? contract.rendersAsAgentBlock(input)
        : contract.rendersAsAgentBlock === true;
      if (pending.renderLayout === "row" && rendersAsAgentBlock) {
        this.streamingInputs.discard(toolUseId);
        this.streamingToolIds.delete(toolUseId);
        materializePendingTool(this.opts, { ...pending, renderLayout: "subagent" }, toolUseId, input, false);
        this.builder.clearToolText(toolUseId);
        return;
      }
      const proposal = this.streamingInputs.complete(toolUseId, name, input);
      if (proposal) this.builder.clearToolTextSilently(toolUseId);
      finalizeStreamingTool(this.opts, toolUseId, input, proposal);
      this.builder.clearToolText(toolUseId);
      return;
    }

    const tracked = this.trackedTools.get(toolUseId);
    if (!tracked) {
      // No streaming start was seen: a complete-with-input is equivalent to an
      // immediate tool-use, so reuse that one materialization path.
      this.streamingInputs.discard(toolUseId);
      this.handleToolUse({ type: "tool-use", toolUseId, name, input, timestamp, leadingTextId, ...(parentToolUseId ? { parentToolUseId } : {}), ...(nestedInCode ? { nestedInCode } : {}) });
      return;
    }
    this.insertLeadingText(toolUseId, name, input, timestamp, leadingTextId);
    const proposal = this.streamingInputs.complete(toolUseId, name, input);
    if (proposal) this.builder.clearToolTextSilently(toolUseId);
    finalizeStreamingTool(this.opts, toolUseId, input, proposal);
    this.builder.clearToolText(toolUseId);
  }

  private insertLeadingText(toolUseId: string, name: string, input: ToolInput, timestamp: number, leadingTextId?: string): void {
    const text = getToolDisplay(canonicalize(name)).leadingText?.(input);
    if (text) this.builder.insertTextBeforeTool(toolUseId, text, timestamp, leadingTextId ?? `${toolUseId}:lead`);
  }

  resolveToolResult(
    toolUseId: string,
    outcome: ToolOutcome,
    rawContent: LlmToolOutputPart[] | undefined,
    source: "render" | "conversation" | "availability",
    details?: unknown,
    executionOutputTail?: string,
  ): void {
    if (source === "conversation" && this.deferredToolResults.has(toolUseId)) return;
    const streamed = this.streamingInputs.settle(toolUseId);
    if (streamed) retainStreamingProposal(this.opts, toolUseId, streamed.fileChangeKind, streamed.proposedDiff);
    if (!isBackgroundResult(details)) this.builder.clearToolText(toolUseId);
    this.deferredToolResults.delete(toolUseId);
    this.pendingTools.delete(toolUseId);
    this.streamingToolIds.delete(toolUseId);
    const tracked = this.trackedTools.get(toolUseId);
    if (!tracked) return;
    if (tracked.kind === "agent") {
      log.debug("resolving agent tool result", {
        sessionId: this.sessionId(),
        toolUseId,
        agentId: tracked.agentId,
        source,
        outcome,
      });
    }

    // Conversation projection can settle the visible status first, but the
    // verified live result owns semantic metadata and cleanup when available.
    if (source !== "conversation") this.trackedTools.delete(toolUseId);
    const recorded = this.executionOutputs.get(toolUseId);
    if (source !== "conversation") this.executionOutputs.delete(toolUseId);
    resolveTrackedToolResult(
      this.builder,
      tracked,
      toolUseId,
      outcome,
      this.executionCwd,
      rawContent,
      details,
      executionOutputTail ?? recorded?.output,
      recorded,
    );
  }


  ackToolResult(toolUseId: string): void {
    this.pendingTools.delete(toolUseId);
    this.deferredToolResults.add(toolUseId);
  }

  private handleSubagentToolUse(
    name: string,
    input: ToolInput | undefined,
    toolUseId: string,
    isStreamingStart: boolean,
    timestamp: number,
  ): void {
    const pending: PendingToolInfo = { name, timestamp, renderLayout: "subagent" };
    if (isStreamingStart) {
      this.pendingTools.set(toolUseId, pending);
      this.streamingInputs.start(toolUseId, name);
      materializePendingTool(this.opts, pending, toolUseId, {}, true);
      return;
    }
    materializePendingTool(this.opts, pending, toolUseId, input ?? {}, false);
  }

  private refineLayout(toolUseId: string, pending: PendingToolInfo, input: ToolInput): void {
    const display = getToolDisplay(pending.name);
    if (pending.renderLayout !== "row"
      || typeof display.rendersAsAgentBlock !== "function" || !display.rendersAsAgentBlock(input)) return;
    const refined = { ...pending, renderLayout: "subagent" as const };
    this.pendingTools.set(toolUseId, refined);
    materializePendingTool(this.opts, refined, toolUseId, input, true);
  }

  setChildLink(toolUseId: string, linkUri: string): void {
    const tracked = this.trackedTools.get(toolUseId);
    if (tracked?.kind === "agent") {
      this.builder.setAgentLink(tracked.agentId, linkUri);
      const block = this.builder.getBlocks().find((candidate) => candidate.kind === "agentGroup" && candidate.id === tracked.agentId);
      if (block?.kind === "agentGroup") this.childGoalsByLink.set(linkUri, childGoal(block));
    } else if (tracked?.kind === "standalone") {
      const index = this.builder.toolBlockIndex(toolUseId);
      if (index !== undefined) this.builder.patchTool(index, { linkUri });
    }
  }

  dispatchChild(toolUseId: string): boolean {
    const tracked = this.trackedTools.get(toolUseId);
    if (tracked?.kind !== "standalone" || !this.deferredToolResults.has(toolUseId)) return false;
    const index = this.builder.toolBlockIndex(toolUseId);
    if (index !== undefined) this.builder.patchTool(index, { status: "pending" });
    return true;
  }

  pauseChild(toolUseId: string, message: string): boolean {
    const tracked = this.trackedTools.get(toolUseId);
    if (tracked?.kind !== "standalone") return false;
    const index = this.builder.toolBlockIndex(toolUseId);
    if (index !== undefined) this.builder.blockTool(index, message);
    return true;
  }

  private handleTopLevelToolUse(
    name: string,
    contract: ToolDisplay,
    input: ToolInput | undefined,
    toolUseId: string | undefined,
    isStreamingStart: boolean,
    timestamp: number,
  ): boolean {
    const isDiffStreaming = contract.extractDiff !== undefined;
    if (isStreamingStart && isDiffStreaming && toolUseId) {
      const pending: PendingToolInfo = { name, timestamp, renderLayout: "standalone-mutation" };
      this.pendingTools.set(toolUseId, pending);
      this.streamingInputs.start(toolUseId, name);
      materializePendingTool(this.opts, pending, toolUseId, {}, true);
      return true;
    }

    const handler = contract.standaloneHandler;
    if (handler) {
      const location = handler(input, timestamp, this.builder, toolUseId);
      if (location && toolUseId) this.trackedTools.set(toolUseId, { kind: "standalone", toolName: location.toolName, streamsInput: contract.streamingInput !== undefined });
      return true;
    }

    if (isDiffStreaming) {
      if (toolUseId) {
        materializeImmediateTool(this.opts, name, input, toolUseId, timestamp);
        return true;
      }
      const rowPresentation = resolveToolRowPresentation(name, input, this.executionCwd);
      const rawPath = input ? extractFilePath(input) : undefined;
      const linkUri = rawPath ? toFileUri(rawPath, this.executionCwd) : undefined;
      const diffInfo = contract.streamingInput === undefined && input
        ? contract.extractDiff?.(input, this.executionCwd)
        : undefined;
      const index = this.builder.pushStandaloneToolEntry({
        kind: "tool",
        id: toolUseId ?? randomUUID(),
        name,
        ...rowPresentation,
        action: contract.action,
        timestamp,
        status: "pending",
        ...(linkUri ? { linkUri } : {}),
        ...(!contract.fileChangeKind && diffInfo?.diff ? { diff: diffInfo.diff } : {}),
        ...(!contract.fileChangeKind && diffInfo?.content ? { content: diffInfo.content } : {}),
        ...(!contract.fileChangeKind && diffInfo?.filetype ? { filetype: diffInfo.filetype } : {}),
        ...fileProposalFields(contract, input, this.executionCwd),
      });
      if (index >= 0 && toolUseId) this.trackedTools.set(toolUseId, { kind: "standalone", toolName: name, streamsInput: contract.streamingInput !== undefined });
      return true;
    }

    return false;
  }

  private retainStreamingProposals(): void {
    for (const proposal of this.streamingInputs.retain()) {
      retainStreamingProposal(this.opts, proposal.toolUseId, proposal.fileChangeKind, proposal.proposedDiff);
    }
  }

  private pushUntrackedToolRow(
    name: string,
    contract: ToolDisplay,
    input: ToolInput | undefined,
    timestamp: number,
  ): void {
    const rawPath = input ? extractFilePath(input) : undefined;
    const tool: ToolEntry = {
      kind: "tool",
      id: randomUUID(),
      name,
      ...resolveToolRowPresentation(name, input, this.executionCwd),
      action: contract.action,
      timestamp,
      status: contract.isOptimistic ? "completed" : "pending",
      ...(rawPath ? { linkUri: toFileUri(rawPath, this.executionCwd) } : {}),
      ...fileProposalFields(contract, input, this.executionCwd),
    };
    this.builder.pushStandaloneToolEntry(tool);
  }

}
