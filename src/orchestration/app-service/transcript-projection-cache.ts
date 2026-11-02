import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { createSessionToolSummaryReader } from "../modules.js"
import type { SessionToolSummaryReader, SessionToolSummarySnapshot, ToolHistorySummary } from "../module-seams.js"
import {
  SessionTranscriptProjection,
  type SessionTranscriptProjectionOptions,
  type TranscriptAuxiliarySnapshot,
  type SessionTranscriptReadView,
} from "../session/conversation/transcript-projection.js"
import type { IndexedTranscript, IndexedGroupChildren } from "../session/conversation/branch-history-builder.js"
import { createToolResultDisplayMetaCursorReader, type ToolDisplaySource, type ToolResultDisplayMetaCatchUp, type ToolResultDisplayMetaCursorReader, type ToolChildRenderContext } from "../session/conversation/tool-result-meta.js"
import type { SessionEntry } from "../session-store/types.js"
import { runsWorkflowClock } from "../session-store/view.js"
import { createAgentInputCursorReader, type AgentInputCursorReader } from "../session/agent-input-projection.js"
import { isAgentInFlight, type AgentGroupBlock, type AnyBlock, type ToolEntry } from "../../infra/output-blocks.js"
import { singleLine } from "../../infra/tools/detail-helpers.js"
import { sessionDisplayName } from "../session/schemas.js"
import { readSessionMetadata } from "../session/session-metadata-store.js"
import { projectToolUse, runFigures } from "../session/conversation/conversation-block-projection.js"
import { rawToolUseId } from "../../protocol/block-identity.js"
import { newestCall } from "../../infra/output/newest-call.js"
import { readSessionDurationFromReader } from "../session/session-duration-projection.js"
import { assignSubagentCards, ownSubagentCard, type SubagentCardAssignment } from "../session/conversation/subagent-card-ownership.js"
import { releaseConversationTreeProjection } from "../session/conversation/conversation-projection.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { memoizeSuccess } from "../../infra/success-memo.js"
import { messageSessionLabel, messageSessionTypeLabel } from "../../protocol/client/message-sender.js"

const MAX_ENTRIES = 8
const IDLE_TTL_MS = 20 * 60 * 1000
const log = Log.create({ service: "transcript-projection-cache" })

type SubagentCall = Parameters<typeof assignSubagentCards>[0][number]
type SubagentCardAssignments = ReadonlyMap<string, SubagentCardAssignment>

interface TranscriptProjection {
  read(auxiliary?: TranscriptAuxiliarySnapshot): Promise<IndexedTranscript | null>
  dispose(): Promise<void>
}

interface TranscriptProjectionCacheDeps {
  readonly sessionStore: { get(sessionId: string): SessionEntry | undefined }
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly projectRoot: string
  readonly now?: () => number
  readonly maxEntries?: number
  readonly idleTtlMs?: number
  readonly createProjection?: (options: SessionTranscriptProjectionOptions) => TranscriptProjection
}

interface ResidentSession {
  readonly sessionId: string
  /** The execution directory resolved for the access that created this resident. */
  readonly executionCwd: string
  readonly auxiliaryReaders: {
    readonly agentInput: AgentInputCursorReader
    readonly toolMeta: ToolResultDisplayMetaCursorReader
    readonly toolSummaries: Required<SessionToolSummaryReader>
  }
  /** Keyed by history scope and conversation id. */
  readonly projections: Map<string, { readonly conversationId: string; readonly projection: TranscriptProjection }>
  /** The subagent children whose residents this session's live cards keep. */
  readonly children: Set<string>
  /** Card ownership, keyed by the tool-meta and tool-summary positions it was
   *  assigned at. It holds the entry of the latest positions only. */
  readonly subagentCards: Map<string, SubagentCardAssignments | Promise<SubagentCardAssignments>>
  lastAccess: number
  /** The reads building this resident now. */
  reads: number
}

export interface TranscriptProjectionCache {
  /** Shared live and retained row projection. Child operations and metrics
   * come from the linked session, never parent-attributed copies. A row that
   * names another session names it by that session's current display name. */
  projectBlock(sessionId: string, block: AnyBlock): Promise<AnyBlock>
  /** The operations of a card, each named as `projectBlock` names a row. */
  projectGroupChildren(children: IndexedGroupChildren): IndexedGroupChildren
  read(sessionId: string, conversationId: string, executionCwd: string): Promise<IndexedTranscript | null>
  createSessionReader(sessionId: string, executionCwd: string): SessionTranscriptReadView
  children(sessionId: string, parentToolUseId: string, context: ToolChildRenderContext): Promise<IndexedGroupChildren>
  /** Drops the session's resident, the conversation trees it read, and the
   *  residents of the subagent children its cards kept, unless a child is
   *  itself in the session store. The owner of a runner calls it when the
   *  runner closes. A later read builds the session again. */
  release(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

/** A session in the session store keeps its resident until it leaves the
 * store and its owner releases it. Eight other residents bound retained
 * transcript block arrays, and the idle window avoids replay churn while a
 * user switches between recent sessions. A resident that a read builds is
 * kept until the read ends, and the end of a read counts as its access: a
 * cold read of a large session under load can pass a client's deadline, the
 * runtime finishes that read regardless, and the client's retry then finds
 * what the read built rather than starting it again. An unref'd timer ends
 * the idle window even when no read comes, so an idle resident never
 * outlives it by more than the timer's delay and never keeps the process
 * alive. Dropping a resident drops the conversation trees it read and its
 * children's residents with it. */
export function createTranscriptProjectionCache(deps: TranscriptProjectionCacheDeps): TranscriptProjectionCache {
  const projectionReader = deps.projectionReader
  const now = deps.now ?? (() => Date.now())
  const maxEntries = deps.maxEntries ?? MAX_ENTRIES
  const idleTtlMs = deps.idleTtlMs ?? IDLE_TTL_MS
  const createProjection = deps.createProjection ?? ((options) => new SessionTranscriptProjection(options))
  const residents = new Map<string, ResidentSession>()
  /** The card fields of each subagent call, keyed by its source. A replay
   *  replaces the source of every tool that gained a fact, so an unchanged
   *  call is read from the store once, not on every live update. */
  const subagentCalls = new WeakMap<ToolDisplaySource, SubagentCall | Promise<SubagentCall>>()
  let disposePromise: Promise<void> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  /** Arms the one idle timer for the earliest resident that can expire. A
   *  resident in the session store is exempt, and it can leave the store
   *  without a call here, so while only such residents remain the timer
   *  looks again one idle window later. */
  function scheduleIdleSweep(): void {
    if (idleTimer !== undefined || disposePromise || residents.size === 0) return
    const at = now()
    let expiresAt = at + idleTtlMs
    for (const resident of residents.values()) {
      if (deps.sessionStore.get(resident.sessionId) === undefined) expiresAt = Math.min(expiresAt, resident.lastAccess + idleTtlMs)
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      const before = residents.size
      void evict().then(
        () => { if (residents.size < before) log.debug("idle transcript residents released", { released: before - residents.size, remaining: residents.size }) },
        (error: unknown) => { log.warn("idle transcript resident release failed", { error: errorMessage(error) }) },
      ).finally(scheduleIdleSweep)
    }, Math.max(0, expiresAt - at))
    idleTimer.unref?.()
  }

  async function read(sessionId: string, conversationId: string, executionCwd: string): Promise<IndexedTranscript | null> {
    return createSessionReader(sessionId, executionCwd, "session").readConversation(conversationId)
  }

  /** Every conversation the returned reader reads shares one resident and one
   *  auxiliary snapshot, taken at its first call. Nothing starts before that
   *  call, so a failure always reaches a caller that awaits it. */
  function createSessionReader(sessionId: string, executionCwd: string, historyScope: "session" | "conversation" = "conversation"): SessionTranscriptReadView {
    if (disposePromise) throw new Error("Transcript projection cache is disposed")
    let query: Promise<{ resident: ResidentSession; auxiliary: TranscriptAuxiliarySnapshot }> | undefined
    function readSnapshot(): Promise<{ resident: ResidentSession; auxiliary: TranscriptAuxiliarySnapshot }> {
      query ??= getResident(sessionId, executionCwd).then((resident) => building(resident, async () => {
        const [agentInput, toolMeta, toolSummaries] = await Promise.all([
          resident.auxiliaryReaders.agentInput.replay(),
          resident.auxiliaryReaders.toolMeta.replay(),
          resident.auxiliaryReaders.toolSummaries.replay(),
        ])
        return { resident, auxiliary: { agentInput, toolMeta, toolSummaries } }
      }))
      return query
    }
    async function readConversation(conversationId: string): Promise<IndexedTranscript | null> {
      const { resident, auxiliary } = await readSnapshot()
      if (disposePromise) throw new Error("Transcript projection cache is disposed")
      const key = `${historyScope}:${conversationId}`
      let held = resident.projections.get(key)
      if (!held) {
        held = { conversationId, projection: createProjection({ conversationId, sessionId, store: deps.reader, projectionReader, executionCwd: resident.executionCwd, auxiliarySource: "external", historyScope }) }
        resident.projections.set(key, held)
      }
      const projection = held.projection
      const history = await building(resident, () => projection.read(auxiliary))
      if (history === null) {
        try {
          await held.projection.dispose()
        } finally {
          if (resident.projections.get(key) === held) resident.projections.delete(key)
          releaseConversationTreeProjection(projectionReader, conversationId)
        }
      }
      await evict()
      return history
    }
    return {
      readAgentInput: async () => (await readSnapshot()).auxiliary.agentInput,
      readConversation,
    }
  }

  async function getResident(sessionId: string, executionCwd: string): Promise<ResidentSession> {
    const existing = residents.get(sessionId)
    if (existing && existing.executionCwd !== executionCwd) await removeResident(existing)
    return ensureResident(sessionId, executionCwd)
  }

  function ensureResident(sessionId: string, executionCwd: string): ResidentSession {
    let resident = residents.get(sessionId)
    if (!resident) {
      resident = {
        sessionId,
        executionCwd,
        auxiliaryReaders: {
          agentInput: createAgentInputCursorReader(projectionReader, sessionId),
          toolMeta: createToolResultDisplayMetaCursorReader(deps.reader, sessionId),
          toolSummaries: createSessionToolSummaryReader(projectionReader, sessionId),
        },
        projections: new Map(),
        children: new Set(),
        subagentCards: new Map(),
        lastAccess: now(),
        reads: 0,
      }
      residents.set(sessionId, resident)
      scheduleIdleSweep()
    } else {
      touch(resident)
    }
    return resident
  }

  /** Marks the access of a resident the cache still holds. A read that ends
   *  after its resident was released never brings that resident back. */
  function touch(resident: ResidentSession): void {
    if (residents.get(resident.sessionId) !== resident) return
    resident.lastAccess = now()
    residents.delete(resident.sessionId)
    residents.set(resident.sessionId, resident)
  }

  /** Runs one read that builds `resident`, which eviction keeps until the
   *  read ends. The end of the read is the resident's access. */
  async function building<T>(resident: ResidentSession, work: () => Promise<T>): Promise<T> {
    touch(resident)
    resident.reads += 1
    try {
      return await work()
    } finally {
      resident.reads -= 1
      touch(resident)
    }
  }

  async function evict(): Promise<void> {
    const at = now()
    for (const [sessionId, resident] of residents) {
      const overCapacity = residents.size > maxEntries
      const idle = resident.lastAccess + idleTtlMs <= at
      if (!overCapacity && !idle) break
      if (resident.reads > 0 || deps.sessionStore.get(sessionId) !== undefined) continue
      await removeResident(resident)
    }
  }

  async function release(sessionId: string): Promise<void> {
    const resident = residents.get(sessionId)
    if (resident) await removeResident(resident)
  }

  /** Removes the resident before its projections settle, so a read that
   *  starts meanwhile builds a new one rather than reusing a disposed one. */
  async function removeResident(resident: ResidentSession): Promise<void> {
    if (residents.get(resident.sessionId) === resident) residents.delete(resident.sessionId)
    resident.auxiliaryReaders.toolSummaries.dispose()
    const held = [...resident.projections.values()]
    resident.projections.clear()
    for (const { conversationId } of held) releaseConversationTreeProjection(projectionReader, conversationId)
    const finishedChildren = [...resident.children].flatMap((childSessionId) => {
      const child = residents.get(childSessionId)
      return child && deps.sessionStore.get(childSessionId) === undefined ? [child] : []
    })
    const results = await Promise.allSettled([
      ...held.map(({ projection }) => projection.dispose()),
      ...finishedChildren.map(removeResident),
    ])
    const rejected = results.find((result) => result.status === "rejected")
    if (rejected) throw rejected.reason
  }

  async function dispose(): Promise<void> {
    clearTimeout(idleTimer)
    idleTimer = undefined
    disposePromise ??= disposeResidents()
    return disposePromise
  }

  async function disposeResidents(): Promise<void> {
    const results = await Promise.allSettled([...residents.values()].map(removeResident))
    residents.clear()
    const rejected = results.find((result) => result.status === "rejected")
    if (rejected) throw rejected.reason
  }

  async function children(sessionId: string, parentToolUseId: string, context: ToolChildRenderContext): Promise<IndexedGroupChildren> {
    if (disposePromise) throw new Error("Transcript projection cache is disposed")
    const resident = await getResident(sessionId, context.executionCwd)
    const source = await building(resident, () => resident.auxiliaryReaders.toolMeta.replay())
    const indexed = source.children(parentToolUseId, context)
    await evict()
    return indexed
  }

  /** Assigns every subagent call of one snapshot to its card. Projections
   *  that run together share one assignment pass and one batched read of the
   *  calls that are not cached yet. */
  function subagentAssignments(resident: ResidentSession, meta: ToolResultDisplayMetaCatchUp, toolSummaries: SessionToolSummarySnapshot) {
    const key = `${meta.position}:${toolSummaries.position}`
    if (!resident.subagentCards.has(key)) resident.subagentCards.clear()
    return memoizeSuccess(resident.subagentCards, key, async () => {
      const calls = await Promise.all([...meta.sources.values()].flatMap((candidate) => candidate.toolName !== "subagent" ? [] : memoizeSuccess(subagentCalls, candidate, async () => {
        const candidateTool = (await meta.readChild(candidate)).tool
        const candidateInput = candidateTool.input
        return {
          cardId: candidate.toolUseId,
          toolUseId: candidate.toolUseId,
          kind: candidateInput?.kind,
          ...(typeof candidateInput?.session_id === "string" ? { target: `flywheel://session/${candidateInput.session_id}` } : {}),
          accepted: candidateTool.status === "completed",
        }
      })))
      return assignSubagentCards(calls, toolSummaries.summaries)
    })
  }

  /** A row that names another session, a message by its sender or a message
   *  call by its recipient, names it by the session's title now, the name
   *  every other surface shows. The row was built with the name recorded at
   *  sending, which the model read, and which a quick title or a later rename
   *  can since have replaced. That name stands only when the session's
   *  metadata is gone, as for a deleted session. */
  async function currentSessionLabel(namedSessionId: string, recorded: string): Promise<{ readonly name: string; readonly typeLabel?: string }> {
    const session = await readSessionMetadata(projectionReader, namedSessionId)
    if (!session) return { name: recorded }
    const name = sessionDisplayName({ id: namedSessionId, session })
    if (session.kind === "chat") return { name, typeLabel: messageSessionTypeLabel("chat") }
    if (session.kind === "workflow-agent") return { name }
    if (session.kind === "workflow") return { name, typeLabel: messageSessionTypeLabel(session.workflowDefinitionId, true) }
    const { parentSessionId, toolUseId } = session.launchedFrom
    if (toolUseId === undefined) return { name: recorded }
    const resident = ensureResident(parentSessionId, deps.projectRoot)
    const summary = (await building(resident, () => resident.auxiliaryReaders.toolSummaries.replay())).summaries.get(toolUseId)
    return summary?.agentType ? { name, typeLabel: messageSessionTypeLabel(summary.agentType) } : { name: recorded }
  }

  async function nameTarget(row: ToolEntry): Promise<ToolEntry> {
    if (row.targetSessionId === undefined) return row
    const label = await currentSessionLabel(row.targetSessionId, row.presentation.detail)
    const detail = singleLine(messageSessionLabel(label.name, label.typeLabel)) || row.presentation.detail
    return detail === row.presentation.detail ? row : {
      ...row, presentation: { ...row.presentation, detail },
      ...(row.sentence === undefined ? {} : { sentence: { ...row.sentence, detail } }),
    }
  }

  async function nameSessions(block: AnyBlock): Promise<AnyBlock> {
    if (block.kind === "userMessage" && block.from) {
      const label = await currentSessionLabel(block.from.sessionId, block.from.name)
      return label.name === block.from.name && label.typeLabel === block.from.typeLabel ? block : { ...block, from: { ...block.from, ...label } }
    }
    if (block.kind === "tool") return nameTarget(block)
    if (block.kind === "agentGroup" && block.children.some((child) => child.targetSessionId !== undefined)) {
      return { ...block, children: await Promise.all(block.children.map(nameTarget)) }
    }
    return block
  }

  function projectGroupChildren(indexed: IndexedGroupChildren): IndexedGroupChildren {
    return { ...indexed, readBlock: async (index) => nameTarget(await indexed.readBlock(index)) }
  }

  async function projectBlock(sessionId: string, block: AnyBlock): Promise<AnyBlock> {
    return nameSessions(await projectCard(sessionId, block))
  }

  async function projectCard(sessionId: string, block: AnyBlock): Promise<AnyBlock> {
    if (block.kind !== "agentGroup" && !(block.kind === "tool" && block.name === "subagent")) return block
    const resident = ensureResident(sessionId, deps.projectRoot)
    const [toolSummarySnapshot, meta] = await Promise.all([
      resident.auxiliaryReaders.toolSummaries.replay(),
      resident.auxiliaryReaders.toolMeta.replay(),
    ])
    const summaries = toolSummarySnapshot.summaries
    const toolUseId = block.kind === "agentGroup" ? block.toolUseId : rawToolUseId(block.id)
    let group: AnyBlock = block
    const source = meta.sources.get(toolUseId)
    const [tool, assignments] = await Promise.all([
      source ? meta.readChild(source).then((child) => child.tool) : undefined,
      subagentAssignments(resident, meta, toolSummarySnapshot),
    ])
    const input = tool?.input
    const assignment = assignments.get(toolUseId)
    // A workflow's launch is acknowledged at once, and no runtime event tells
    // the parent's builder what the workflow does next. Until the launching
    // call settles the card, the card states the workflow's own state from
    // its summary, as a reopened transcript does. A paused card is the
    // summary's too: no launching call settles a workflow as paused.
    const workflowRun = block.kind === "agentGroup" && block.containerKind === "workflow" && (isAgentInFlight(block.status) || block.status === "paused") ? summaries.get(toolUseId) : undefined
    const run = assignment?.run ?? workflowRun
    if (block.kind === "tool" && (!assignment || !input)) return block
    if (assignment && input) {
      // The card states the figures its run's history measures.
      const measured = await toolSummarySnapshot.measure(assignment.run)
      const projected = projectToolUse({ type: "tool_use", id: toolUseId, name: "subagent", input }, block.id, block.timestamp, resident.executionCwd, measured, undefined, undefined)
      group = projected.kind === "agentGroup" ? ownSubagentCard(projected, assignment) : projected
    } else if (block.kind === "agentGroup" && workflowRun) {
      const live = workflowRun.memberSessionIds?.some(id => {
        const entry = deps.sessionStore.get(id)
        return entry !== undefined && runsWorkflowClock(entry)
      }) ?? false
      group = stateWorkflowCard(block, await toolSummarySnapshot.measure(workflowRun, live), live)
    }
    if (group.kind !== "agentGroup" || !group.linkUri?.startsWith("flywheel://session/")) return group
    const childSessionId = group.linkUri.slice("flywheel://session/".length)
    if (!isAgentInFlight(group.status)) {
      const linkUri = group.linkUri
      const latest = [...summaries.values()].findLast((summary) => summary.linkUri === linkUri)
      if (latest !== run) return group
      const duration = (await readSessionDurationFromReader(projectionReader, childSessionId)).accumulatedActiveMs
      return duration > 0 ? { ...group, duration } : group
    }
    const child = deps.sessionStore.get(childSessionId)
    resident.children.add(childSessionId)
    // The builder's and the history's figures are wall time or an earlier
    // run's time, so the card drops them and states only the child's clock.
    const { duration: _claimed, ...card } = group
    const live = { ...(await childActiveTime(childSessionId, child)), ...(child ? { totalTokens: child.tokens } : {}) }
    // A workflow card draws its plan from its outline, never the tool calls
    // inside the workflow, so it reads no tool rows of the child.
    if (card.containerKind === "workflow") return { ...card, children: [], ...live }
    const indexed = (await ensureResident(childSessionId, resident.executionCwd).auxiliaryReaders.toolMeta.replay()).sessionChildren({
      executionCwd: resident.executionCwd, idSuffix: `#${group.id}`, presentation: "container",
    })
    const newest = indexed.blockCount > 0 ? await nameTarget(await indexed.readBlock(indexed.blockCount - 1)) : undefined
    const activity = newest === undefined ? undefined : newestCall([newest])
    return {
      ...card,
      totalToolCount: indexed.totalCount,
      // The publisher indexes the newest call's named-session dependency here.
      // The wire projection removes this row after it selects the activity.
      children: newest === undefined ? [] : [newest],
      ...(activity === undefined ? {} : { activity }),
      ...live,
    }
  }

  /** A running card's time, from the child's own clock: the settled active
   *  time, and the start of the open episode only while the child streams.
   *  The child's header timer reads the same two figures, so the card and the
   *  child's own view agree. A child no runner holds has no open episode: its
   *  recorded active time is all there is, so the card never ticks from a
   *  start it does not know. */
  async function childActiveTime(childSessionId: string, child: { readonly accumulatedActiveMs: number; readonly streamingStartedAt: number | null } | undefined): Promise<{ duration?: number; activeStartedAt?: number }> {
    const duration = child?.accumulatedActiveMs ?? (await readSessionDurationFromReader(projectionReader, childSessionId)).accumulatedActiveMs
    return {
      ...(duration > 0 ? { duration } : {}),
      ...(child !== undefined && child.streamingStartedAt !== null ? { activeStartedAt: child.streamingStartedAt } : {}),
    }
  }

  return { read, createSessionReader, children, projectBlock, projectGroupChildren, release, dispose }
}

/** A workflow card with the state and the counts its workflow's summary
 *  states. The summary reads only durable evidence, so a live turn of the
 *  workflow wins over a summary that still reads interrupted: a Resume
 *  records its continuation before the agent's first reply, and the card must
 *  not show the resumed agent as paused while it runs. The parent's builder
 *  never sees the workflow's own operations and tokens, so the card takes
 *  them from the summary in every state; a running card replaces them with
 *  the live run's. The card is in flight or paused by the summary, never by
 *  a failure, so only a pause has details to drop. */
function stateWorkflowCard(card: AgentGroupBlock, run: ToolHistorySummary, live: boolean): AgentGroupBlock {
  const counted = { ...card, ...runFigures(run) }
  let base: AgentGroupBlock = counted
  if (counted.status === "paused") {
    const { pausedBy: _pausedBy, ...unpaused } = counted
    base = { ...unpaused, status: "pending" }
  }
  if (run.status === "error") return { ...base, status: "error", failure: run.failure }
  // A step can run while its workflow has no open episode, such as after a
  // Resume before the running commit. The card then states no start: the
  // wire schema rejects a start key that holds undefined.
  if (live && (run.status === "active" || run.status === "paused")) {
    return { ...base, status: "active", duration: run.duration ?? 0, ...(run.activeStartedAt === undefined ? {} : { activeStartedAt: run.activeStartedAt }) }
  }
  if (run.status === "paused") return { ...base, status: "paused", pausedBy: run.pausedBy }
  return { ...base, status: run.status }
}
