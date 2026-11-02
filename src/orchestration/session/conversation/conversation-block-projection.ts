import { canonicalize } from "../../../infra/canonical-name.js";
import { assistantContentRuns, reasoningSummaryText } from "../../../infra/output/assistant-content-runs.js";
import { isDeliveryConfirmationText } from "../../../infra/delivery-confirmation.js";
import { isProgressUpdate } from "../../../infra/llm/anthropic-narration.js";
import { isAgentInFlight, messageSenderOf, type AgentGroupBlock, type AnyBlock, type DegradedBlock, type QuestionBlock, type ToolEntry } from "../../../infra/output-blocks.js";
import { deferredAgentMeta } from "../../../infra/output/deferred-agent-meta.js";
import { formatCompactionReport } from "../../../protocol/client/format.js";
import { blockedStatusLine, formatAgentFailureDisplay, launderToolError, resolveAgentFailureDisplay } from "../../../infra/output/output-formatter.js";
import { extractFilePath } from "../../../infra/output/structured-event-tool-materializer.js";
import { agentResultSummary, selectToolResultContent } from "../../../infra/output/structured-event-tool-results.js";
import { toFileUri } from "../../../infra/paths.js";
import { declaredMutationField, getToolDisplay, isHiddenFromTranscript, resolveToolRowPresentation, targetSessionField } from "../../../infra/tools/tool-display-registry.js";
import type { MessageEntry, ConversationEntry } from "./conversation-entry-types.js";
import type { ConversationTreeTranscriptEntry } from "./conversation-projection.js";
import type { ToolResultDisplayMeta } from "./tool-result-meta.js";
import type { ToolHistorySummary } from "../../module-seams.js";
import { installedRuntimeInvocationTool } from "../../module-catalog.js";
import { createProvisionalDiffInput } from "../../../infra/output/provisional-diff-input.js";
import { mutationEvidenceSummaryDisplayPaths, provisionalDiffDisplayPaths } from "../../../infra/output/display-paths.js";
import { resetFailedFileChange } from "../../../infra/output/file-change-settlement.js";
import { redactSecrets } from "../../../infra/redact-secrets.js";
import type { AgentInputEntry } from "../agent-input-projection.js";
import { formatAgentInputAnswers } from "../../../protocol/question-protocol-types.js";
import { CANCELED_LABEL, interruptedLabel, RESUMED_LABEL, STOPPED_LABEL, UNEXPECTED_EXIT_LABEL } from "../../../infra/output/run-labels.js";
import { isContextResetRecord, isVisibleTurnEnd, turnEndOfEntry } from "./turn-end-record.js";
import { isHistoricalCompletionEntry } from "../child-session-completion.js";
import { isBriefEntry } from "./brief-entry.js";
import { rawToolUseId } from "../../../protocol/block-identity.js";
import { sessionMessageRecoveryNotice } from "../../../infra/chat-input.js";
import { CONTINUATION_MESSAGES } from "../../agent-runtime/continuation-messages.js";
import { assignSubagentCards, childCall, ownsSubagentCard, ownSubagentCard, type SubagentCardAssignment } from "./subagent-card-ownership.js";
import type { ToolExecutionEntry } from "../tool-execution-types.js";

type PersistedContent = Extract<MessageEntry["message"], { kind: "user" }>["content"];
type ToolUsePart = Extract<Exclude<PersistedContent, string>[number], { type: "tool_use" }>;
type ToolResultMessage = Extract<MessageEntry["message"], { kind: "toolResult" }>;

export interface TreeBlockProjectionOptions {
  /** Workspace root for tool detail/diff/link rendering, matching the live
   *  output projector's execution directory so synthesized rows format paths
   *  identically. */
  executionCwd: string;
  /** Recorded tool-result display meta keyed by toolUseId (`tool.result.recorded`
   *  facts). Diffs and filetypes live in the result details, not the persisted
   *  tool_use input, so settled tools re-attach them from here. */
  toolResultMeta?: ReadonlyMap<string, ToolResultDisplayMeta>;
  /** Durable tool summaries keyed by their parent toolUseId. Historical
   *  blocks use these header fields without folding nested tool facts; children
   *  are projected only by the expansion query. */
  toolSummaries?: ReadonlyMap<string, ToolHistorySummary>;
  /** Canonical question state keyed by the provider tool-use identity. */
  agentInput?: ReadonlyMap<string, AgentInputEntry>;
}

interface ToolProjectionSource {
  readonly index: number;
  readonly part: ToolUsePart;
  readonly blockId: string;
  readonly timestamp: number;
  result?: ToolResultMessage;
  resultTimestamp?: number;
}

/** Stateful per-entry tree fold. Snapshots copy the block list, while block
 * objects are replaced rather than mutated when later entries settle them. */
export class TreeBlockProjection {
  private readonly blocks: AnyBlock[] = [];
  /** Slots holding transcript-hidden plumbing. They remain in the array so
   * tool indices stay stable and are dropped from every snapshot. */
  private readonly hiddenBlockIndices = new Set<number>();
  private readonly toolIndexByUseId = new Map<string, ToolProjectionSource>();
  private readonly toolSourcesByUseId = new Map<string, ToolProjectionSource[]>();
  private readonly toolUseOccurrences = new Map<string, number>();
  private readonly toolResultMeta: Map<string, ToolResultDisplayMeta>;
  private readonly toolSummaries: Map<string, ToolHistorySummary>;
  private readonly summaryIdByTarget = new Map<string, string>();
  private readonly controlsByTarget = new Map<string, ToolProjectionSource[]>();
  /** Subagent calls in conversation order: the input to card ownership. */
  private readonly subagentCalls: ToolProjectionSource[] = [];
  private subagentAssignments: ReadonlyMap<string, SubagentCardAssignment> | undefined;
  private readonly executionCwd: string;
  private readonly agentInput: ReadonlyMap<string, AgentInputEntry>;
  // A paused or exited turn's record was folded and no human message has
  // followed it yet: the next assistant entry continues that turn, which the
  // transcript names the way the live session does when it resumes.
  private awaitingResume = false;

  constructor(opts: TreeBlockProjectionOptions) {
    this.executionCwd = opts.executionCwd;
    this.toolResultMeta = new Map(opts.toolResultMeta);
    this.toolSummaries = new Map(opts.toolSummaries);
    for (const summary of this.toolSummaries.values()) this.indexSummary(summary);
    this.agentInput = opts.agentInput ?? new Map();
  }

  add(entry: ConversationTreeTranscriptEntry): void {
    if (entry.kind === "degraded") {
      this.append(entry.block);
      return;
    }
    switch (entry.kind) {
      case "message":
        this.projectMessage(entry);
        return;
      case "compaction":
        this.append({ kind: "system", id: entry.id, message: formatCompactionReport(entry.tokensBefore, entry.tokensAfter), timestamp: entryTimestamp(entry) });
        return;
      case "branch_summary":
        this.append({ kind: "system", id: entry.id, message: `Branch summary: ${entry.summary}`, timestamp: entryTimestamp(entry) });
        return;
      case "label":
      case "session_info":
      case "leaf":
        return;
      default:
        throw malformedEntry(entry);
    }
  }

  updateToolResultMeta(toolUseId: string, meta: ToolResultDisplayMeta): void {
    const sources = this.toolSourcesByUseId.get(toolUseId);
    if (!sources) return;
    this.toolResultMeta.set(toolUseId, { ...this.toolResultMeta.get(toolUseId), ...meta });
    for (const source of sources) this.resettle(source);
  }

  updateToolSummary(run: ToolHistorySummary): void {
    if (!run.toolUseId) return;
    this.toolSummaries.set(run.toolUseId, run);
    this.indexSummary(run);
    this.subagentAssignments = undefined;
    const sources = new Set(this.toolSourcesByUseId.get(run.toolUseId));
    // A control row states its target's latest run, so any change to that run
    // changes the row.
    if (run.linkUri) {
      for (const source of this.controlsByTarget.get(run.linkUri) ?? []) sources.add(source);
    }
    for (const source of sources) this.resettle(source);
  }

  /** Projects runtime-origin evidence through the ordinary workflow card path.
   * The projection-only result marker is never conversation or provider history. */
  addRuntimeWorkflowInvocation(tool: ToolExecutionEntry): void {
    if (!tool.runtimeOrigin || tool.toolName !== installedRuntimeInvocationTool().name || !tool.input) {
      throw new Error(`Runtime workflow invocation ${tool.toolUseId} is incomplete`);
    }
    const result: ToolResultMessage = {
      kind: "toolResult",
      toolUseId: tool.toolUseId,
      // A Flywheel-made invocation has no parent call, and only a nested
      // result records its full text, so its result states its preview.
      content: [{ type: "text", text: tool.contentPreview ?? "" }],
      ...(tool.resultOutcome !== undefined && tool.resultOutcome !== "ok" ? { isError: true } : {}),
      ...(tool.resultOutcome === "interrupted" ? { interrupted: true } : {}),
    };
    this.projectToolUse(
      { type: "tool_use", id: tool.toolUseId, name: tool.toolName, input: tool.input },
      tool.calledAt ?? 0,
      result,
      tool.completedAt,
    );
  }

  snapshot(): AnyBlock[] {
    return this.blocks.filter((_, index) => !this.hiddenBlockIndices.has(index));
  }

  /** Decorate one selected tool occurrence without retaining its result body
   *  in the base fold. The reader names the run summary the row states, and
   *  takes that summary as its owner measured it, so a card states the
   *  figures its run's history measures while the fold reads none. */
  toolBlockReader(block: ToolEntry | AgentGroupBlock): ToolBlockReader {
    const source = this.toolSourcesByUseId.get(rawToolUseId(block.id))?.find((candidate) => candidate.blockId === block.id);
    if (!source) return { read: () => block };
    // The reader keeps the result this revision of the fold saw.
    const { result, resultTimestamp: timestamp = source.timestamp } = source;
    const assignment = this.subagentCardAssignment(source);
    const run = this.toolSummary(source, assignment);
    return {
      ...(run ? { run } : {}),
      read: (meta, measured = run) => {
        const counted = block.kind === "agentGroup" && measured !== run ? { ...block, ...runFigures(measured) } : block;
        if (!result) return counted;
        if (counted.kind !== "tool") return ownSubagentCard(settleContainerGroup(counted, result, timestamp, measured, meta, source.part.name), assignment);
        // The base fold names a call's target before it reads the result, so a
        // name that only the result states is applied here.
        const named = meta?.targetName === undefined
          ? counted
          : { ...counted, ...resolveToolRowPresentation(counted.name, source.part.input, this.executionCwd, { targetDescription: meta.targetName }) };
        return settleToolEntry(named, result, meta, this.executionCwd, measured);
      },
    };
  }

  /** Text from separate entries never joins: two replies stay two rows even
   *  when a hidden entry, such as a runtime notice, is all that separates them. */
  private append(block: AnyBlock): number {
    return this.blocks.push(block) - 1;
  }

  private projectMessage(entry: Extract<ConversationEntry, { kind: "message" }>): void {
    const timestamp = entryTimestamp(entry);
    const message = entry.message;
    const turnEnd = turnEndOfEntry(entry);
    if (!isVisibleTurnEnd(turnEnd)) {
      // A planned replacement's cut and the automatic Resume after it are
      // invisible: the transcript reads as one uninterrupted turn.
      this.awaitingResume = false;
      return;
    }
    if (turnEnd?.reason === "paused" || turnEnd?.reason === "crash") {
      // The record itself is model-facing prose; the row says what a person
      // needs, in the words the live session used when it happened.
      this.append({ kind: "system", id: entry.id, message: turnEnd.reason === "paused" ? interruptedLabel(turnEnd.pausedBy) : UNEXPECTED_EXIT_LABEL, timestamp });
      this.awaitingResume = true;
      return;
    }
    // A settled record answers only its own exchange, so it leaves a turn
    // that waits on Resume waiting. A runtime refusal stays visible as a system
    // row. Historical completion and reset records are model-facing only.
    const settledRecord = turnEnd?.reason === "settled";
    if (settledRecord && (isHistoricalCompletionEntry(entry.id) || isContextResetRecord(entry.id))) return;
    if (settledRecord && message.kind === "user" && message.origin === "system") {
      this.append({ kind: "system", id: entry.id, message: contentText(message.content), timestamp });
      return;
    }
    // The Resume's own continuation message says it resumed, so a Resume cut
    // again before it replied still reads as one; a reply stands in for it
    // where the continuation had no message (an older crash resume).
    const resumeContinuation = message.kind === "user" && message.origin === "system" && message.content === CONTINUATION_MESSAGES.resumed;
    if (this.awaitingResume && (message.kind === "assistant" || resumeContinuation)) {
      this.append({ kind: "system", id: `${entry.id}:resumed`, message: RESUMED_LABEL, timestamp });
      this.awaitingResume = false;
    } else if (message.kind === "user" && message.origin !== "system" && !settledRecord) {
      this.awaitingResume = false;
    }
    switch (message.kind) {
      case "user":
        this.projectUserMessage(entry.id, message, timestamp);
        return;
      case "assistant":
        if (typeof message.content === "string") {
          if (message.content.trim()) this.append({ kind: "text", id: entry.id, content: message.content, timestamp });
          return;
        }
        // Every row keeps the identity and position the live display gave it,
        // so a reopened or reseeded transcript indexes the blocks a client
        // already holds. Progress updates and signed narration are public
        // text; other thinking is a thought row, which clients show only when
        // Show thinking is on.
        for (const { part, index: partIndex, text } of assistantContentRuns(message.content)) {
          if (part.type === "text") {
            if (text?.trim()) this.append({ kind: "text", id: `${entry.id}:${partIndex}`, content: text, timestamp });
          } else if (part.type === "thinking" && isProgressUpdate(part)) {
            if (part.thinking.trim()) this.append({ kind: "text", id: `${entry.id}:${partIndex}`, content: redactSecrets(part.thinking), timestamp });
          } else if (part.type === "thinking") {
            if (part.thinking.trim()) this.append({ kind: "thinking", id: `${entry.id}:${partIndex}`, content: part.thinking, status: "completed", timestamp });
          } else if (part.type === "reasoning") {
            const summary = reasoningSummaryText(part);
            if (summary.trim()) this.append({ kind: "thinking", id: `${entry.id}:${partIndex}`, content: summary, status: "completed", timestamp });
          } else if (part.type === "image") {
            this.append({ kind: "system", id: `${entry.id}:${partIndex}`, message: `[image: ${part.mediaType}]`, timestamp });
          } else if (part.type === "tool_use") {
            const lead = getToolDisplay(canonicalize(part.name)).leadingText?.(part.input);
            if (lead) this.append({ kind: "text", id: `${entry.id}:${partIndex}:lead`, content: lead, timestamp });
            this.projectToolUse(part, timestamp);
          } else {
            throw malformedContentPart(part);
          }
        }
        return;
      case "toolResult": {
        const source = this.toolIndexByUseId.get(message.toolUseId);
        if (!source) {
          throw new Error(`Malformed session tree toolResult ${entry.id}: missing/mismatched toolUseId ${message.toolUseId}`);
        }
        source.result = message;
        source.resultTimestamp = timestamp;
        const call = childCall(source.part);
        if (ownsSubagentCard(call)) this.subagentAssignments = undefined;
        if (call?.kind === "resume" && call.target && message.isError !== true) {
          this.resettleTarget(call.target);
        } else {
          this.resettle(source);
        }
        const settled = this.blocks[source.index];
        if (settled?.kind === "tool" && message.blocked === true) {
          const display = getToolDisplay(settled.name);
          if (!isHiddenFromTranscript(display, source.part.input)) {
            this.append({ kind: "userMessage", id: `${entry.id}:blocked`, content: resultText(message), timestamp, pending: false, injected: true });
          }
        }
        return;
      }
      case "system":
        this.append({
          kind: "system",
          id: entry.id,
          message: message.content,
          timestamp,
          // The notice's own evidence, on the notice block: no tool row is
          // synthesized for a write no tool call in this branch made.
          ...("mutationEvidence" in message ? { mutationEvidence: message.mutationEvidence } : {}),
        });
        return;
      case "compactionSummary":
        this.append({ kind: "system", id: entry.id, message: message.content, timestamp });
        return;
      default:
        throw malformedMessage(message);
    }
  }

  private projectUserMessage(id: string, message: Extract<MessageEntry["message"], { kind: "user" }>, timestamp: number): void {
    // Inline step/skill invocations render as their divider plus the raw
    // user arguments; the expanded prompt body is model-facing only.
    if (message.invocation) {
      this.append({ kind: "divider", id: `${id}:boundary`, label: message.invocation.label, timestamp });
      if (message.invocation.args) {
        this.append({ kind: "userMessage", id, content: message.invocation.args, timestamp, pending: false, injected: false, ...(message.submissionIds?.length ? { submissionIds: message.submissionIds } : {}) });
      }
    } else if (message.origin !== "system" || isBriefEntry(id)) {
      // System-origin user-role messages are model-visible but hidden from the
      // user, matching the live renderer, which never paints them. An
      // agent's brief is the one that stays a row: the agent view opens with
      // it, and the workflow transcript filters it out with the other
      // seeded prompts.
      this.append(userMessageRow(id, message, timestamp));
    }
  }

  private projectToolUse(
    part: ToolUsePart,
    timestamp: number,
    result?: ToolResultMessage,
    resultTimestamp?: number,
  ): void {
    const occurrence = (this.toolUseOccurrences.get(part.id) ?? 0) + 1;
    this.toolUseOccurrences.set(part.id, occurrence);
    // A damaged branch can repeat a provider toolUseId. Keep list identity
    // unique while durable-fact joins continue to use the raw provider id.
    const blockId = occurrence === 1 ? part.id : `${part.id}#${occurrence}`;
    const source: ToolProjectionSource = {
      index: this.blocks.length,
      part,
      blockId,
      timestamp,
      ...(result ? { result } : {}),
      ...(resultTimestamp !== undefined ? { resultTimestamp } : {}),
    };
    this.toolIndexByUseId.set(part.id, source);
    const sources = this.toolSourcesByUseId.get(part.id);
    if (sources) sources.push(source);
    else this.toolSourcesByUseId.set(part.id, [source]);
    const call = childCall(part);
    if (ownsSubagentCard(call)) {
      this.subagentCalls.push(source);
      this.subagentAssignments = undefined;
    }
    if (call?.target) {
      const controls = this.controlsByTarget.get(call.target);
      if (controls) controls.push(source);
      else this.controlsByTarget.set(call.target, [source]);
    }
    const assignment = this.subagentCardAssignment(source);
    const base = projectToolUse(part, blockId, timestamp, this.executionCwd, this.toolSummary(source, assignment), this.agentInput.get(part.id), this.targetDescription(part));
    const projected = base.kind === "agentGroup" ? ownSubagentCard(base, assignment) : base;
    this.append(projected);
    const interaction = this.agentInput.get(part.id);
    if (projected.kind === "degraded" && interaction?.kind === "unreadable") {
      for (const gap of interaction.gaps.slice(1)) this.append({ ...gap, id: `${gap.id}:${blockId}` });
    }
    this.trackToolVisibility(source.index, projected, part.input);
    if (result) this.resettle(source);
  }

  private resettle(source: ToolProjectionSource): void {
    const assignment = this.subagentCardAssignment(source);
    const run = this.toolSummary(source, assignment);
    const projected = projectToolUse(source.part, source.blockId, source.timestamp, this.executionCwd, run, this.agentInput.get(source.part.id), this.targetDescription(source.part));
    const settled = projected.kind === "question" || projected.kind === "degraded" || !source.result
      ? projected
      : projected.kind === "tool"
        ? settleToolEntry(projected, source.result, this.toolResultMeta.get(source.part.id), this.executionCwd, run)
        : settleContainerGroup(projected, source.result, source.resultTimestamp ?? source.timestamp, run, this.toolResultMeta.get(source.part.id), source.part.name);
    const owned = settled.kind === "agentGroup" ? ownSubagentCard(settled, assignment) : settled;
    this.blocks[source.index] = owned;
    this.trackToolVisibility(source.index, owned, source.part.input);
  }

  /** The run a subagent call's card states and whether it owns that run.
   *  Only subagent calls carry run summaries, so other tools have none. */
  private subagentCardAssignment(source: ToolProjectionSource): SubagentCardAssignment | undefined {
    if (!ownsSubagentCard(childCall(source.part))) return undefined;
    this.subagentAssignments ??= assignSubagentCards(this.subagentCalls.map((candidate) => {
      const call = childCall(candidate.part);
      const accepted = candidate.result !== undefined && candidate.result.isError !== true;
      return { cardId: candidate.blockId, toolUseId: candidate.part.id, kind: call?.kind, ...(call?.target ? { target: call.target } : {}), accepted };
    }), this.toolSummaries);
    return this.subagentAssignments.get(source.blockId);
  }

  private toolSummary(
    source: ToolProjectionSource,
    assignment: SubagentCardAssignment | undefined,
  ): ToolHistorySummary | undefined {
    return canonicalize(source.part.name) === installedRuntimeInvocationTool().name
      ? this.toolSummaries.get(source.part.id)
      : assignment?.run;
  }

  private resettleTarget(target: string): void {
    const sources = new Set(this.controlsByTarget.get(target));
    for (const summary of this.toolSummaries.values()) {
      if (summary.linkUri !== target) continue;
      for (const source of this.toolSourcesByUseId.get(summary.toolUseId) ?? []) sources.add(source);
    }
    for (const source of sources) this.resettle(source);
  }

  private indexSummary(summary: ToolHistorySummary): void {
    if (summary.linkUri && !this.summaryIdByTarget.has(summary.linkUri)) this.summaryIdByTarget.set(summary.linkUri, summary.toolUseId);
  }

  private descriptionForTarget(linkUri: string): string | undefined {
    const id = this.summaryIdByTarget.get(linkUri);
    return id === undefined ? undefined : this.toolSummaries.get(id)?.description;
  }

  /** The name of the session a call addressed: the name its result states,
   *  or else the goal of the child session it names, when the transcript
   *  knows it. */
  private targetDescription(part: ToolUsePart): string | undefined {
    const stated = this.toolResultMeta.get(part.id)?.targetName;
    if (stated !== undefined) return stated;
    const target = childCall(part)?.target ?? targetSessionField(part.name, part.input).targetSessionId;
    return target === undefined ? undefined : this.descriptionForTarget(target.startsWith("flywheel://") ? target : `flywheel://session/${target}`);
  }

  /** Presentation-only visibility. Transcript-hidden plumbing never appears. */
  private trackToolVisibility(index: number, block: AnyBlock, input: ToolUsePart["input"]): void {
    if (block.kind !== "tool") return;
    if (isHiddenFromTranscript(getToolDisplay(block.name), input)) this.hiddenBlockIndices.add(index);
    else this.hiddenBlockIndices.delete(index);
  }
}

/** Semantic re-projection of chat-tree entries into coalesced output blocks. */
export function projectBlocksFromEntries(entries: readonly ConversationTreeTranscriptEntry[], opts: TreeBlockProjectionOptions): AnyBlock[] {
  const projection = new TreeBlockProjection(opts);
  for (const entry of entries) projection.add(entry);
  return projection.snapshot();
}

/** One selected tool occurrence of the base fold. */
export interface ToolBlockReader {
  /** The run summary the row states, as the fold read it. */
  readonly run?: ToolHistorySummary;
  /** The row with its result meta and the given run summary. */
  read(meta: ToolResultDisplayMeta | undefined, run?: ToolHistorySummary): AnyBlock;
}

/** The figures a card states from the run summary it is given: its
 *  operations, tokens, duration, handoff summary, workflow card, and workflow name. A
 *  settled card keeps them, so a completed run with incomplete coverage
 *  still names it. */
export const runFigures = (run: ToolHistorySummary | undefined): Partial<Pick<AgentGroupBlock, "label" | "summary">> & Pick<AgentGroupBlock, "totalToolCount" | "totalTokens" | "duration" | "card"> =>
  ({ totalToolCount: run?.totalToolCount ?? 0, ...(run?.totalTokens !== undefined ? { totalTokens: run.totalTokens } : {}), ...(run?.duration !== undefined ? { duration: run.duration } : {}), ...(run?.card !== undefined ? { card: run.card } : {}), ...(run?.label !== undefined ? { label: run.label } : {}), ...(run?.summary !== undefined ? { summary: run.summary } : {}) });

/** Projects one canonical tool input with its retained run evidence.
 * Does not settle tool results or load child operation bodies. */
export function projectToolUse(
  part: ToolUsePart,
  blockId: string,
  timestamp: number,
  executionCwd: string,
  run: ToolHistorySummary | undefined,
  agentInput: AgentInputEntry | undefined,
  targetDescription: string | undefined,
): ToolEntry | AgentGroupBlock | QuestionBlock | DegradedBlock {
  const name = canonicalize(part.name);
  if (name === "ask_user" && agentInput) {
    if (agentInput.kind === "unreadable") return { ...agentInput.gaps[0], id: `${agentInput.gaps[0].id}:${blockId}` };
    const base = {
      kind: "question" as const,
      toolUseId: blockId,
      questions: [...agentInput.request],
      timestamp,
    };
    if (agentInput.kind === "answered") {
      return {
        ...base,
        answers: formatAgentInputAnswers(agentInput.answers),
      };
    }
    if (agentInput.kind === "cancelled" || agentInput.kind === "withdrawn") return { ...base, cancelled: true };
    return base;
  }
  const contract = getToolDisplay(name);
  const call = childCall(part);
  const continuation = call?.kind === "retry" || call?.kind === "resume";
  const rendersAsAgentBlock = continuation
    ? run !== undefined
    : typeof contract.rendersAsAgentBlock === "function"
      ? contract.rendersAsAgentBlock(part.input)
      : contract.rendersAsAgentBlock === true;
  if (rendersAsAgentBlock) {
    const meta = continuation && run
      ? {
          // A `process` resume continues a subagent: its card is the child's.
          ...deferredAgentMeta("subagent", { ...part.input, ...(run.agentType ? { persona: run.agentType } : {}) }, getToolDisplay("subagent").displayName),
          description: run.description ?? "",
        }
      : deferredAgentMeta(name, part.input, contract.displayName);
    const model = run?.model;
    const base = {
      kind: "agentGroup" as const,
      id: blockId,
      ...meta,
      label: continuation ? `${meta.label} ${call.kind}` : meta.label,
      children: [],
      ...runFigures(run),
      timestamp,
      toolUseId: part.id,
      ...(model ? { model } : {}),
      ...(run?.linkUri ? { linkUri: run.linkUri } : {}),
    };
    // A run with no history summary has no owner and no result: it was
    // interrupted. A summary states the run's own settled state.
    if (!run) return { ...base, status: "interrupted" };
    if (run.status === "error") return { ...base, status: "error", failure: run.failure };
    if (run.status === "paused") return { ...base, status: "paused", pausedBy: run.pausedBy };
    return { ...base, status: run.status };
  }
  const diffInfo = contract.extractDiff?.(part.input, executionCwd);
  const rawPath = extractFilePath(part.input);
  const proposal = contract.fileChangeKind
    ? (() => {
        const fileChangeKind = typeof contract.fileChangeKind === "function" ? contract.fileChangeKind(part.input) : contract.fileChangeKind;
        const input = createProvisionalDiffInput(fileChangeKind);
        input.complete(part.input);
        return { fileChangeKind, proposedDiff: provisionalDiffDisplayPaths(input.snapshot(), executionCwd) };
      })()
    : {};
  return {
    kind: "tool",
    id: blockId,
    name,
    ...resolveToolRowPresentation(name, part.input, executionCwd, { targetDescription }),
    // The client folds reads into runs and abbreviates a linked read to its
    // file by this field; a reopened row without it rendered as a call of no
    // kind, apart from the live row it had been.
    action: contract.action,
    timestamp,
    ...(run?.linkUri ? { linkUri: run.linkUri } : {}),
    ...(contract.invocationBody?.(part.input) ? { invocationBody: contract.invocationBody(part.input) } : {}),
    status: "interrupted",
    ...(rawPath ? { linkUri: toFileUri(rawPath, executionCwd) } : {}),
    ...(!contract.fileChangeKind && diffInfo?.diff ? { diff: diffInfo.diff } : {}),
    ...(!contract.fileChangeKind && diffInfo?.content ? { content: diffInfo.content } : {}),
    ...(!contract.fileChangeKind && diffInfo?.filetype ? { filetype: diffInfo.filetype } : {}),
    ...proposal,
    ...declaredMutationField(name, part.input),
    ...targetSessionField(name, part.input),
  };
}

function settleContainerGroup(
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

function settleToolEntry(tool: ToolEntry, result: ToolResultMessage, meta: ToolResultDisplayMeta | undefined, executionCwd: string, run?: ToolHistorySummary): ToolEntry {
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
  };
  return result.isError === true && result.blocked !== true
    ? resetFailedFileChange(projected)
    : projected;
}

/** The row of a user message the person sees: its words, its images, and
 *  the sender of a message from another session. */
function userMessageRow(id: string, message: Extract<MessageEntry["message"], { kind: "user" }>, timestamp: number): AnyBlock {
  const gap = sessionMessageRecoveryNotice(message.producer);
  if (gap) return { kind: "system", id, message: `${gap}\n${contentText(message.content)}`, timestamp };
  const images = typeof message.content === "string" ? [] : message.content.flatMap((part) => part.type === "image" ? [{ mediaType: part.mediaType, data: part.data }] : []);
  const from = messageSenderOf(message.producer);
  return { kind: "userMessage", id, content: contentText(message.content), timestamp, pending: false, injected: false, ...(message.submissionIds?.length ? { submissionIds: message.submissionIds } : {}), ...(images.length ? { images } : {}), ...(from ? { from } : {}) };
}

/** A user message's transcript text: its words. The attachment blocks after
 *  them, an image or a text file, are already named in the words by the
 *  markers the composer wrote, so the transcript shows each attachment once.
 *  Any other shape is flattened with one placeholder per part. */
function contentText(content: PersistedContent): string {
  if (typeof content === "string") return content;
  const [words, ...rest] = content;
  if (words?.type === "text" && rest.every((part) => part.type === "image" || part.type === "text")) return words.text;
  return content
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "image") return [`[image: ${part.mediaType}]`];
      if (part.type === "tool_use") return [`[tool_use: ${part.name}]`];
      // thinking/reasoning persist for provider replay only; they carry no
      // user-facing transcript text.
      if (part.type === "thinking" || part.type === "reasoning") return [];
      throw malformedContentPart(part);
    })
    .join("\n");
}

function resultText(result: ToolResultMessage): string {
  return result.content
    // The delivery receipt is turn metadata for the model, not tool output.
    .filter((part) => !(part.type === "text" && isDeliveryConfirmationText(part.text)))
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mediaType}]`))
    .join("\n");
}

function entryTimestamp(entry: ConversationEntry): number {
  return Date.parse(entry.timestamp);
}

function malformedEntry(entry: { readonly kind: never }): Error {
  return new Error(`Malformed session tree entry kind: ${String(entry.kind)}`);
}

function malformedMessage(message: { readonly kind: never }): Error {
  return new Error(`Malformed session tree message kind: ${String(message.kind)}`);
}

function malformedContentPart(part: { readonly type: never }): Error {
  return new Error(`Malformed persisted content part type: ${String(part.type)}`);
}
