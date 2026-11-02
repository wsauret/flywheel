import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { createHash } from "node:crypto"
import { isAgentInFlight, isVisibleMessageBlock, type AnyBlock } from "../../../infra/output-blocks.js"
import { blockIdentity, rawToolUseId } from "../../../protocol/block-identity.js"
import { memoizeSuccess } from "../../../infra/success-memo.js"
import { createReadQueue } from "../../../infra/read-queue.js"
import { createMicrotaskBatch } from "../../../infra/microtask-batch.js"
import { createSessionToolSummaryReader } from "../../modules.js"
import type { ToolHistorySummary, SessionToolSummaryReader, SessionToolSummarySnapshot } from "../../module-seams.js"
import { branchVisibleTranscriptEntries, createConversationTreeProjection, type ConversationTreeProjectionState, type ConversationTreeTranscriptEntry } from "./conversation-projection.js"
import type { ConversationEntry } from "./conversation-entry-types.js"
import type { ToolExecutionEntry } from "../tool-execution-types.js"
import { ConversationTreeError } from "./conversation-tree-storage.js"
import { walkBranchFromLeaf } from "./conversation-tree-context.js"
import { BranchHistoryBuilder, type IndexedTranscript, type IndexedGroupChildren, indexEntries } from "./branch-history-builder.js"
import type { ToolBlockReader } from "./conversation-block-projection.js"
import { turnEndOfEntry } from "./turn-end-record.js"
import {
  createAgentInputCursorReader,
  type AgentInputCursorReader,
  type AgentInputSnapshot,
} from "../agent-input-projection.js"
import {
  createToolResultDisplayMetaCursorReader,
  createToolResultDisplayMetaSetReader,
  type ToolDisplaySource,
  type ToolResultDisplayMetaCatchUp,
  type ToolResultDisplayMetaCursorReader,
  type ToolResultDisplayMetaSetReader,
} from "./tool-result-meta.js"

export interface TranscriptAuxiliarySnapshot {
  readonly agentInput: AgentInputSnapshot
  readonly toolMeta: ToolResultDisplayMetaCatchUp
  readonly toolSummaries: SessionToolSummarySnapshot
}

/** Both accessors share the auxiliary snapshot captured by the first read.
 * Read failures reject the accessor promise; creating the view starts no work. */
export interface SessionTranscriptReadView {
  readAgentInput(): Promise<AgentInputSnapshot>
  readConversation(conversationId: string): Promise<IndexedTranscript | null>
}

export interface SessionTranscriptProjectionOptions {
  readonly conversationId: string
  readonly sessionId: string
  readonly store: AsyncEventStateReadSurface
  readonly projectionReader?: AsyncEventStateReadSurface
  readonly executionCwd: string
  readonly auxiliarySource?: "external"
  /** Primary history includes unanchored session facts; worker conversations never do. */
  readonly historyScope?: "session" | "conversation"
}

interface DisplaySlot {
  readonly id: string
  readonly base?: AnyBlock
  readonly metaSource?: ToolDisplaySource
  readonly readBase?: ToolBlockReader
  readonly readChild?: () => AnyBlock | Promise<AnyBlock>
  readonly position: number
}

export class SessionTranscriptProjection {
  private readonly projectionReader: AsyncEventStateReadSurface
  private readonly tree: ReturnType<typeof createConversationTreeProjection>
  private readonly toolResultMetaReader: ToolResultDisplayMetaCursorReader | null
  private readonly toolSummariesReader: Required<SessionToolSummaryReader> | null
  private readonly agentInputReader: AgentInputCursorReader | null
  private builder: BranchHistoryBuilder | null = null
  private state: ConversationTreeProjectionState | null = null
  private toolMetaPosition = 0
  private toolSummariesPosition = 0
  private agentInputPosition = 0
  private runtimeInvocationPosition = 0
  private branch: ConversationTreeTranscriptEntry[] = []
  private toolUseIds = new Set<string>()
  private history: IndexedTranscript | null = null
  private baseBlocks: readonly AnyBlock[] = []
  private slots: DisplaySlot[] = []
  private readonly runs = new Map<string, ToolHistorySummary>()
  /** The tool sources of the child sessions the cards link: those of the
   *  running cards at each refresh, and a settled card's when it is read. */
  private readonly linkedChildren: ToolResultDisplayMetaSetReader
  /** One settled card's child, read with the other cards' children that a
   *  reader asks for together. */
  private readonly readSettledChild: (childSessionId: string) => Promise<ToolResultDisplayMetaCatchUp>
  private runningChildIds: readonly string[] = []
  private childPosition = ""
  /** Materialized tool rows. A slot outlives a refresh while its base block
   *  and source position stay the same, so its row is read once. */
  private readonly materialized = new WeakMap<DisplaySlot, AnyBlock | Promise<AnyBlock>>()
  /** Reads fold and commit one at a time, in arrival order. */
  private readonly reads = createReadQueue(() => this.readOnce())
  private disposed = false

  constructor(private readonly options: SessionTranscriptProjectionOptions) {
    this.projectionReader = options.projectionReader ?? options.store
    this.tree = createConversationTreeProjection(
      this.projectionReader,
      options.conversationId,
    )
    this.linkedChildren = createToolResultDisplayMetaSetReader(this.projectionReader)
    this.readSettledChild = createMicrotaskBatch((childSessionIds: readonly string[]) => this.linkedChildren.replay(childSessionIds))
    this.toolResultMetaReader = options.auxiliarySource === "external"
      ? null
      : createToolResultDisplayMetaCursorReader(this.projectionReader, options.sessionId)
    this.toolSummariesReader = options.auxiliarySource === "external"
      ? null
      : createSessionToolSummaryReader(this.projectionReader, options.sessionId)
    this.agentInputReader = options.auxiliarySource === "external"
      ? null
      : createAgentInputCursorReader(this.projectionReader, options.sessionId)
  }

  /** Each read captures the tree state after the previous read committed. A
   *  read awaits state reads after it starts to write the fold, so two
   *  interleaved reads could commit an older history under a newer state, and
   *  the unchanged-read check would then return that history until the tree
   *  changes again. A read without a snapshot joins a queued read that has not
   *  started, because that read captures the state after this call. */
  read(auxiliarySnapshot?: TranscriptAuxiliarySnapshot): Promise<IndexedTranscript | null> {
    if (this.disposed) return Promise.reject(new Error("Session transcript projection is disposed"))
    return auxiliarySnapshot === undefined ? this.reads.read() : this.reads.run(() => this.readOnce(auxiliarySnapshot))
  }

  private async readOnce(auxiliarySnapshot?: TranscriptAuxiliarySnapshot): Promise<IndexedTranscript | null> {
    if (this.disposed) throw new Error("Session transcript projection is disposed")
    const state = await this.tree.replay()
    const auxiliary = auxiliarySnapshot ?? await this.replayAuxiliary()
    const gaps = this.options.historyScope === "session" ? auxiliary.agentInput.gaps : []
    const childPosition = linkedChildPosition(await this.linkedChildren.replay(this.runningChildIds))
    if (!state.created && gaps.length === 0) return null
    if (this.history && state === this.state
      && auxiliary.agentInput.position === this.agentInputPosition
      && auxiliary.toolMeta.position === this.toolMetaPosition
      && auxiliary.toolSummaries.position === this.toolSummariesPosition
      && auxiliary.toolMeta.runtimeInvocationPosition === this.runtimeInvocationPosition
      && childPosition === this.childPosition) return this.history
    const agentInputChanged = auxiliary.agentInput.position !== this.agentInputPosition
    const runtimeInvocationsChanged = auxiliary.toolMeta.runtimeInvocationPosition !== this.runtimeInvocationPosition
    let baseChanged = state !== this.state || agentInputChanged || runtimeInvocationsChanged
    if (baseChanged) {
      const branch = branchVisibleTranscriptEntries(branchFromState(state, this.options.conversationId), state.degraded)
      const degradedUnchanged = this.branch.filter((entry) => entry.kind === "degraded").length === branch.filter((entry) => entry.kind === "degraded").length
      if (this.builder && !agentInputChanged && !runtimeInvocationsChanged && isBranchPrefix(this.branch, branch) && degradedUnchanged) {
        for (const entry of branch.slice(this.branch.length)) this.builder.add(entry)
      } else {
        this.builder = new BranchHistoryBuilder({
          executionCwd: this.options.executionCwd,
          agentInput: new Map([...auxiliary.agentInput.entries].filter(([, entry]) => entry.conversationId === this.options.conversationId)),
          runtimeInvocations: await runtimeInvocationsByAnchor(auxiliary.toolMeta, this.options.conversationId),
        })
        this.runs.clear()
        this.slots = []
        for (const entry of branch) this.builder.add(entry)
      }
      this.toolUseIds = new Set([
        ...toolUseIdsFromEntries(branch),
        ...[...auxiliary.toolMeta.runtimeInvocations.values()]
          .filter((invocation) => invocation.parentConversationId === this.options.conversationId)
          .map((invocation) => invocation.toolUseId),
      ])
      this.branch = branch
    }
    const builder = this.builder
    if (!builder) throw new Error("Missing transcript base fold")
    for (const id of this.toolUseIds) {
      const run = auxiliary.toolSummaries.summaries.get(id)
      if (run && this.runs.get(id) !== run) {
        builder.updateToolSummary(run)
        this.runs.set(id, run)
        baseChanged = true
      }
    }
    if (baseChanged) this.baseBlocks = [...builder.snapshot().blocks, ...gaps]
    this.state = state
    await this.refreshIndex(auxiliary.toolMeta, auxiliary.toolSummaries, auxiliary.agentInput.position, auxiliary.toolMeta.runtimeInvocationPosition, builder)
    this.childPosition = linkedChildPosition(await this.linkedChildren.replay(this.runningChildIds))
    this.toolMetaPosition = auxiliary.toolMeta.position
    this.toolSummariesPosition = auxiliary.toolSummaries.position
    this.agentInputPosition = auxiliary.agentInput.position
    this.runtimeInvocationPosition = auxiliary.toolMeta.runtimeInvocationPosition
    return this.history
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.toolSummariesReader?.dispose()
  }


  private async replayAuxiliary(): Promise<TranscriptAuxiliarySnapshot> {
    if (!this.toolResultMetaReader || !this.toolSummariesReader || !this.agentInputReader) {
      throw new Error("Externally refreshed transcript projection requires an auxiliary snapshot")
    }
    return {
      agentInput: await this.agentInputReader.replay(),
      toolMeta: await this.toolResultMetaReader.replay(),
      toolSummaries: await this.toolSummariesReader.replay(),
    }
  }

  private async refreshIndex(
    meta: ToolResultDisplayMetaCatchUp,
    toolSummaries: SessionToolSummarySnapshot,
    agentInputPosition: number,
    runtimeInvocationPosition: number,
    builder: BranchHistoryBuilder,
  ): Promise<void> {
    const previous = new Map(this.slots.map((slot) => [slot.id, slot]))
    const runningMetas = await this.replayRunningChildren()
    const slots: DisplaySlot[] = []
    const groups = new Map<string, () => IndexedGroupChildren | Promise<IndexedGroupChildren>>()
    const token = createHash("sha256")
    token.update(JSON.stringify([this.state?.leafId, agentInputPosition, runtimeInvocationPosition, this.branch.map(transcriptEntryKey)]))
    for (const base of this.baseBlocks) {
      const id = blockIdentity(base)
      const toolId = base.kind === "tool" || base.kind === "agentGroup" ? rawToolUseId(base.id) : undefined
      const metaSource = toolId ? meta.sources.get(toolId) : undefined
      const position = metaSource?.position ?? 0
      const old = previous.get(id)
      const slot = old?.base === base && old.position === position ? old : {
        id, base, position, metaSource,
        ...(base.kind === "tool" || base.kind === "agentGroup" ? { readBase: builder.toolBlockReader(base) } : {}),
      }
      slots.push(slot)
      token.update(JSON.stringify([id, position, toolId ? this.runs.get(toolId) : null]))
      if (base.kind !== "agentGroup" && !(base.kind === "tool" && base.name === "code")) continue
      const parent = base.kind === "agentGroup" ? base.toolUseId : rawToolUseId(base.id)
      const childSessionId = linkedChildSessionId(base)
      const settled = base.kind === "agentGroup" && !isAgentInFlight(base.status)
      const context = {
        executionCwd: this.options.executionCwd,
        // A continuation row lists operations that another row lists too, so
        // its child ids carry the row's own id to stay unique in the transcript.
        idSuffix: base.id.slice(rawToolUseId(base.id).length) || (childSessionId ? `#${base.id}` : ""),
        presentation: base.kind === "tool" ? "execute" as const : "container" as const,
      }
      if (childSessionId && settled) {
        // A settled card lists its run's operations, so the run the card
        // states keys them. They are read when the card's operations are
        // read, never for the whole transcript. The child can still record
        // a fact about those operations, such as the interrupted result of an
        // orphaned call that its runner repairs when it attaches, so each read
        // catches up the child. A catch-up with no new fact reads no fact.
        const run = slot.readBase?.run
        token.update(JSON.stringify([childSessionId, run ?? null]))
        groups.set(id, async () => {
          const [childMeta, measured] = await Promise.all([this.readSettledChild(childSessionId), run ? toolSummaries.measure(run) : undefined])
          return childMeta.sessionChildren({ ...context, settledCount: measured?.totalToolCount ?? base.totalToolCount })
        })
        continue
      }
      const childMeta = childSessionId ? runningMetas.get(childSessionId) : undefined
      const parentPosition = childMeta?.position ?? meta.parentPositions.get(parent) ?? 0
      token.update(JSON.stringify([childSessionId ?? parent, parentPosition]))
      const parentContext = settled ? { ...context, settledCount: base.totalToolCount } : context
      const children = childMeta ? childMeta.sessionChildren(parentContext) : meta.children(parent, parentContext)
      if (base.kind === "tool") {
        for (let index = 0; index < children.blockCount; index += 1) slots.push({
          id: children.blockId(index), position: parentPosition, readChild: () => children.readBlock(index),
        })
      }
      else groups.set(id, () => children)
    }
    const consistencyToken = `chat-tree:v2:${token.digest("hex").slice(0, 24)}`
    if (this.history?.consistencyToken === consistencyToken) return
    this.slots = slots
    const indices = new Map(slots.map((slot, index) => [slot.id, index]))
    const entries = indexEntries(slots.map((slot) => slot.id))
    const authoredUserIds = new Set(this.branch.flatMap((entry) => entry.kind === "message" && isAuthoredUserMessage(entry.message) ? [entry.id] : []))
    const openCalls = openTurnCallIds(this.branch)
    this.history = {
      blockCount: slots.length,
      visibleMessageCount: slots.reduce((count, slot) => count + (slot.base && isVisibleMessageBlock(slot.base) ? 1 : 0), 0),
      consistencyToken,
      tipEntryId: this.state?.leafId ?? null,
      visibleUserFilteredIndices: slots.flatMap((slot, index) => slot.base?.kind === "userMessage" && !slot.base.injected && !authoredUserIds.has(slot.base.id) ? [] : [index]),
      openCallIds: new Set(slots.flatMap((slot) => slot.base?.kind === "tool" && openCalls.has(rawToolUseId(slot.base.id)) ? [slot.base.id] : [])),
      indexOf: (id) => indices.get(id) ?? -1,
      indexOfEntry: (entryId) => entries.get(entryId) ?? -1,
      readBlock: (index) => this.materialize(slots[index], meta, toolSummaries),
      groupChildren: async (id) => {
        const group = groups.get(id)
        if (!group) throw new Error(`Missing output group ${id}`)
        return group()
      },
    }
  }

  /** Replays the tool sources of every child session a running card links,
   *  all in one read. A running card's operations grow with its child, so
   *  the child's position keys the transcript. */
  private async replayRunningChildren(): Promise<ReadonlyMap<string, ToolResultDisplayMetaCatchUp>> {
    this.runningChildIds = [...new Set(this.baseBlocks.flatMap((base) => base.kind === "agentGroup" && isAgentInFlight(base.status) ? linkedChildSessionId(base) ?? [] : []))]
    return await this.linkedChildren.replay(this.runningChildIds)
  }

  /** A row states its run summary as the summary's owner measured it. The
   *  rows a window reads together share one read of their runs' histories. */
  private materialize(slot: DisplaySlot | undefined, meta: ToolResultDisplayMetaCatchUp, toolSummaries: SessionToolSummarySnapshot): AnyBlock | Promise<AnyBlock> {
    if (!slot) throw new Error("Transcript block index is out of bounds")
    if (slot.readChild) return slot.readChild()
    const base = slot.base
    if (!base) throw new Error("Transcript slot has no source")
    const readBase = slot.readBase
    if (!readBase) return base
    return memoizeSuccess(this.materialized, slot, async () => {
      const [displayMeta, run] = await Promise.all([meta.readMeta(slot.metaSource), readBase.run ? toolSummaries.measure(readBase.run) : undefined])
      return readBase.read(displayMeta, run)
    })
  }
}

function linkedChildPosition(children: ReadonlyMap<string, ToolResultDisplayMetaCatchUp>): string {
  return [...children.values()].map((snapshot) => snapshot.position).join(":")
}

function linkedChildSessionId(base: AnyBlock): string | undefined {
  return base.kind === "agentGroup" && base.linkUri?.startsWith("flywheel://session/") ? base.linkUri.slice("flywheel://session/".length) : undefined
}

/** A user message that a person or another session wrote, as opposed to a
 *  prompt that Flywheel seeded. A seeded brief from a build before
 *  2026-07-10 carries no author, so it stays hidden from the history of an
 *  agent of a workflow. */
function isAuthoredUserMessage(message: Extract<ConversationEntry, { kind: "message" }>["message"]): boolean {
  return message.kind === "user" && (message.origin === "human" || message.producer?.kind === "human" || message.producer?.kind === "session")
}

/** The provider ids of the calls of the branch's open turn: each call that
 *  has no result and that no turn end closed. */
function openTurnCallIds(branch: readonly ConversationTreeTranscriptEntry[]): ReadonlySet<string> {
  const open = new Set<string>()
  for (const entry of branch) {
    if (entry.kind !== "message") continue
    if (turnEndOfEntry(entry) !== undefined) open.clear()
    const { message } = entry
    if (message.kind === "toolResult") open.delete(message.toolUseId)
    if (message.kind !== "assistant" || typeof message.content === "string") continue
    for (const part of message.content) if (part.type === "tool_use") open.add(part.id)
  }
  return open
}

function branchFromState(state: ConversationTreeProjectionState, conversationId: string): ConversationEntry[] {
  return walkBranchFromLeaf(state.entriesById, state.leafId, (gap) => {
    if (gap.kind === "leaf") {
      throw new ConversationTreeError("unknown_target", `Chat tree ${conversationId} has no entry ${gap.leafEntryId}`)
    }
    throw new ConversationTreeError(
      "missing_parent",
      `Chat tree ${conversationId} entry ${gap.childId} references missing parent ${gap.parentId}`,
    )
  })
}

function isBranchPrefix(previous: readonly ConversationTreeTranscriptEntry[], next: readonly ConversationTreeTranscriptEntry[]): boolean {
  if (previous.length > next.length) return false
  return previous.every((entry, index) => transcriptEntryKey(entry) === transcriptEntryKey(next[index]))
}

function transcriptEntryKey(entry: ConversationTreeTranscriptEntry | undefined): string | undefined {
  return entry?.kind === "degraded"
    ? `degraded:${entry.event.position}:${entry.ordinal}`
    : entry?.id
}

async function runtimeInvocationsByAnchor(
  snapshot: ToolResultDisplayMetaCatchUp,
  conversationId: string,
): Promise<ReadonlyMap<string, readonly ToolExecutionEntry[]>> {
  // Requested together, so every invocation shares one batched source read.
  const read = await Promise.all([...snapshot.runtimeInvocations.values()]
    .filter((source) => source.parentConversationId === conversationId)
    .map(async (source) => ({ anchor: source.parentEntryId, tool: (await snapshot.readChild(source)).tool })))
  const invocations = new Map<string, ToolExecutionEntry[]>()
  for (const { anchor, tool } of read) {
    const group = invocations.get(anchor) ?? []
    group.push(tool)
    invocations.set(anchor, group)
  }
  return invocations
}

function toolUseIdsFromEntries(entries: readonly ConversationTreeTranscriptEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "degraded" || entry.kind !== "message" || entry.message.kind !== "assistant" || typeof entry.message.content === "string") continue
    for (const part of entry.message.content) {
      if (part.type === "tool_use") ids.add(part.id)
    }
  }
  return ids
}
