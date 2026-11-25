import type { OutputBlockChange, OutputChangeBatch } from "../../../../infra/substrate/output/output-block-delta.js"
import { blockIdentity } from "../../../../protocol/transcript/block-identity.js"
import { parseSessionLink, parseWorkflowLink } from "../../../../protocol/client/session/session-links.js"
import { projectFrontendOutputBlock } from "./frontend-output-blocks.js"
import type { SessionEntry, SessionStore } from "../../../session-store/types.js"
import { runsWorkflowClock } from "../../../session-store/activity.js"
import type { CommandKeeper } from "../../runtime/command-keeper.js"
import type { AnyBlock } from "../../../../infra/substrate/events/output-blocks.js"
import type { StoredFact } from "../../../../infra/substrate/store/event-store-types.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import { recordBackgroundFailure } from "../../../../infra/diagnostics/operation-log.js"
import { probeLoopUnit } from "../../../../infra/diagnostics/event-loop-lag.js"
import type { ProjectedBlockChange, ShippedOutput } from "./shipped-output.js"

const log = Log.create({ service: "output-projection" })

export interface OutputProjection {
  /** Publish output changes currently committed for the requested session.
   *  It waits for the one pass that drains them, never for passes that later
   *  changes start, such as the card refreshes of a child that streams on.
   *  It never rejects: a session whose changes cannot be projected gets a
   *  rebase invalidation in their place. */
  flush(sessionId: string): Promise<void>
  /** States the sessions whose output any client follows (`ShippedOutput.watch`).
   *  An unwatched session's changes are drained and dropped unprojected, so
   *  its card links can be stale; each session the statement adds links its
   *  current blocks again, so a change of a child reaches its card, and
   *  projects once each card not yet bound to its child, whose link can have
   *  landed while no client followed the session. */
  watch(sessionIds: readonly string[]): void
  dispose(): void
}

export interface OutputProjectionDeps {
  readonly projectBlock: (sessionId: string, block: AnyBlock) => Promise<AnyBlock>
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  /** Each retirement of a session's continuation row
   *  (`onPlannedContinuationRetired`), which commits no fact: a card that
   *  read its child as owed reads it again. */
  readonly onContinuationRetired: (listener: (sessionId: string) => void) => () => void
  readonly sessionStore: SessionStore
  readonly keptOutput: Pick<CommandKeeper, "liveOutput">
  /** The one publisher of the output cursor and owner of what the session's
   *  clients hold, shared with every other output publisher. */
  readonly shipped: Pick<ShippedOutput, "ship" | "rebase" | "forget" | "watches" | "watch">
}

/** The session store's output publish path. Output is a projection of the SessionStore --
 *  the same shape the session summary already is (see `frontend-projection.ts`):
 *  runners write blocks into the store, and this observer forwards each session's
 *  drained output changes as one `output.delta` on that session's output cursor.
 *  No runner threads a publisher and no create-path (chat vs workflow, dispatch
 *  vs dispatchWorkflow) can silently skip publishing, because publishing no
 *  longer depends on who wrote the blocks.
 *
 *  The changes are minted at the write site (StructuredOutputBuilder, drained
 *  via `outputSession`/`outputProjector`) instead of reconstructed here by
 *  diffing two full snapshots. This observer projects them into wire form and
 *  hands them to the shipped-output owner, which measures each against the
 *  copy the clients hold and publishes. `drainOutputChanges` degrades to a
 *  resync of the current tail for rare structural rewrites.
 *
 *  Revision-driven, not a Solid computation: output delivery is an app-service
 *  projection, so consumer delivery must never run inside the store's reactive
 *  graph. The session store already emits a synchronous, per-session revision
 *  after each UI-visible mutation; this projection only processes sessions
 *  whose revision moved.
 *
 *  This is not a session-view projection (session-view-projection.ts): those
 *  diff whole per-session views against an emitted baseline, while output
 *  forwards write-site deltas that must ship in order and unconflated. */
export function createOutputProjection(deps: OutputProjectionDeps): OutputProjection {
  let disposed = false
  const observedById = new Map<string, { epoch: number; revision: number }>()
  // The rows of a session that read another session, keyed by the session
  // they read: a subagent card shows its child's work, and a message row or
  // a message call names the session it reads by that session's current title.
  const parentsByChild: RowLinks = new Map()
  const rowsByNamedSession: RowLinks = new Map()
  // A subagent card projected before its child is bound carries no session
  // link yet, and a child's facts reach only linked cards. Such a card is
  // re-projected alone when its session links a child, which the same
  // commit binds to the card.
  const unlinkedByParent = new Map<string, RowIndexes>()
  // The live state of each linked child that its subagent card states: the
  // child's clock and its tokens. A child's transcript changes many times a
  // second and leaves its card as it is, so only a change of this state
  // refreshes the card from the store. The child's committed work reaches
  // the card through the stored facts that name the child.
  const childClocks = new Map<string, string | undefined>()
  const { shipped } = deps
  const workBySession = new Map<string, SessionWork>()
  // The state of each workflow agent that its workflow's card reads. An
  // agent's transcript changes many times a second and leaves its card as it
  // is, so only a change of this state refreshes the card. The card's clock
  // ticks in the client from the start time the card states.
  const agentClocks = new Map<string, { readonly workflowId: string; readonly running: boolean }>()

  /** Forgets the parent's card links, all of them or those whose card left its blocks. */
  const clearParent = (sessionId: string, keep?: ReadonlySet<string>): void => {
    unlinkRows(parentsByChild, sessionId, keep)
    unlinkRows(rowsByNamedSession, sessionId, keep)
    const unlinked = unlinkedByParent.get(sessionId)
    if (unlinked && keep) for (const identity of unlinked.keys()) { if (!keep.has(identity)) unlinked.delete(identity) }
    if (!keep || unlinked?.size === 0) unlinkedByParent.delete(sessionId)
  }

  /** Records what the block at absolute `index` of the session's transcript
   *  reads: the child of a card, or a card not yet bound to its child, and
   *  the sessions it names. */
  const linkBlock = (sessionId: string, block: AnyBlock, index: number, identity = blockIdentity(block)): void => {
    for (const namedId of namedSessions(block)) linkRow(rowsByNamedSession, namedId, sessionId, identity, index)
    const child = block.kind === "agentGroup" ? parseSessionLink(block.linkUri)?.sessionId ?? parseWorkflowLink(block.linkUri)?.workflowId : undefined
    if (child !== undefined) {
      linkRow(parentsByChild, child, sessionId, identity, index)
      unlinkedByParent.get(sessionId)?.delete(identity)
    } else if (isUnboundCard(block)) {
      markUnbound(sessionId, identity, index)
    } else {
      unlinkedByParent.get(sessionId)?.delete(identity)
    }
  }

  const markUnbound = (sessionId: string, identity: string, index: number): void => {
    let unlinked = unlinkedByParent.get(sessionId)
    if (!unlinked) { unlinked = new Map(); unlinkedByParent.set(sessionId, unlinked) }
    unlinked.set(identity, index)
  }

  /** The synchronous part of a pass before its awaits: it drains the
   *  session's committed changes, or settles a removed or unchanged session
   *  and returns nothing. */
  const drainSession = (sessionId: string, refreshCards: RowIndexes | undefined): Drained | undefined => {
    const entry = deps.sessionStore.get(sessionId)
    if (!entry) {
      observedById.delete(sessionId)
      shipped.forget(sessionId)
      clearParent(sessionId)
      return undefined
    }

    const revision = deps.sessionStore.revision(sessionId)
    const observed = observedById.get(sessionId)
    // entryEpoch changing under one session id is the coordinate rebase: a
    // re-opened shell defines a fresh absolute block-index baseline
    // (reactivation rebases onto the durable fold), so a client window
    // resident from a prior shell is void. The invalidation ships before the
    // entry's first delta; a brand-new session has no resident window and
    // simply reseeds the tail it was about to render. The epoch, not id
    // residency, marks the event: removal and re-add can coalesce into one
    // observed sync, and a fresh shell restarts its revision counter.
    if (!refreshCards && observed && observed.epoch === entry.entryEpoch && observed.revision === revision) return undefined
    const rebased = observed?.epoch !== entry.entryEpoch
    if (rebased) shipped.rebase(sessionId)
    const baseView = outputView(entry)
    const batch = deps.sessionStore.drainOutputChanges(sessionId)
    // Read with the drain, before any await: a settle's removal must ship in
    // the same delta as its settled block.
    const ownStreamingToolText = entry.streamingToolText
    const { streamingOutputChars } = entry
    observedById.set(sessionId, { epoch: entry.entryEpoch, revision })
    if (batch.fullResync || rebased) clearParent(sessionId, new Set(baseView.blocks.map(blockIdentity)))
    // A rebase makes the clients read the display seed that the entry opened
    // with, such as the assignment that launches a subagent, and no change
    // ships those blocks. They are linked here, so they follow their child
    // and the titles they name as a shipped block does.
    if (rebased && !batch.fullResync) for (const [index, block] of baseView.blocks.entries()) linkBlock(sessionId, block, baseView.sequenceStart + index)
    const changes = refreshCards && !batch.fullResync
      ? { ...batch, changes: [...batch.changes, ...[...refreshCards].flatMap(([identity, index]): OutputBlockChange[] => {
        const found = findLinkedBlock(baseView, identity, index)
        return found ? [{ kind: "upsert", ...found }] : []
      })] }
      : batch
    const kept = changes.fullResync ? [] : lastCopies(changes.changes)
    const rows = changes.fullResync
      ? baseView.blocks.map((block, index) => ({ block, index: baseView.sequenceStart + index }))
      : kept.flatMap((change) => change.kind === "append-content" ? [] : [change])
    // The link of a card's child can commit while the pass awaits the card's
    // projection. The card reads as unbound from the drain on, so that link
    // starts another pass; the ship links the card if its projection was bound.
    for (const { block, index } of rows) if (isUnboundCard(block)) markUnbound(sessionId, blockIdentity(block), index)
    const blocks = rows.map((row) => row.block)
    return { baseView, fullResync: changes.fullResync, kept, blocks, changedTools: changes.changedTools, ownStreamingToolText, streamingOutputChars }
  }

  /** The synchronous part of a pass after its awaits: it records the card
   *  links of the projected blocks and ships the delta. */
  const shipSession = (sessionId: string, drained: Drained, projectedBlocks: ReadonlyMap<AnyBlock, AnyBlock>): void => {
    const { baseView, kept } = drained
    const project = (block: AnyBlock, index: number): AnyBlock => {
      const projected = projectedBlocks.get(block) ?? block
      linkBlock(sessionId, projected, index, blockIdentity(block))
      return projected
    }
    shipped.ship(sessionId, {
      visibleMessageCount: baseView.visibleMessageCount,
      blockCount: baseView.sequenceStart + baseView.blocks.length,
      blocks: drained.fullResync
        ? { kind: "resync", sequenceStart: baseView.sequenceStart, blocks: baseView.blocks.map((block, index) => projectFrontendOutputBlock(project(block, baseView.sequenceStart + index))) }
        : { kind: "changes", changes: kept.map((change) => toWireBlockChange(project, change)) },
      // The keeper's tails pair with the keeper's own drains, so they are read
      // as this ships: a tail it settled during the awaits above stays gone.
      // The session's own entries win.
      streamingToolText: { ...deps.keptOutput.liveOutput(sessionId), ...drained.ownStreamingToolText },
      streamingOutputChars: drained.streamingOutputChars,
      changedTools: drained.changedTools,
    })
  }

  // Each synchronous part is one probed loop unit, so an event-loop stall
  // names the output publish that ran across it. The awaits between them
  // yield the loop and are not part of either unit.
  const syncSession = async (sessionId: string, refreshCards?: RowIndexes): Promise<void> => {
    if (disposed) return
    const drained = probeLoopUnit("output-projection", "drain", () => drainSession(sessionId, refreshCards))
    // No client follows the session: its read after a watch holds what this
    // pass drained, so nothing is projected or shipped.
    if (!drained || !shipped.watches(sessionId)) return
    // Drain before awaiting: writes during projection belong to the next batch.
    // Key by the actual copy, since an insert and a later upsert can share an id.
    const projectedBlocks = new Map<AnyBlock, AnyBlock>()
    for (const block of drained.blocks) {
      projectedBlocks.set(block, await deps.projectBlock(sessionId, block))
    }
    if (disposed) return
    probeLoopUnit("output-projection", "ship", () => shipSession(sessionId, drained, projectedBlocks))
  }

  /** Starts or extends the session's one publish loop. Each pass drains
   *  every change committed before it began, so a change waits for at most
   *  the pass after the one now running. */
  const schedule = (sessionId: string, cards?: RowIndexes): SessionWork | undefined => {
    if (disposed) return undefined
    const existing = workBySession.get(sessionId)
    if (existing) {
      existing.pending = true
      for (const [identity, index] of cards ?? []) existing.cards.set(identity, index)
      return existing
    }
    const work: SessionWork = { pending: true, cards: new Map(cards), started: 0, waiters: [] }
    workBySession.set(sessionId, work)
    void Promise.resolve().then(async () => {
      try {
        while (work.pending) {
          if (disposed) break
          work.pending = false
          work.started += 1
          const refresh = work.cards
          work.cards = new Map()
          try {
            await syncSession(sessionId, refresh.size > 0 ? refresh : undefined)
          } catch (error) {
            invalidate(sessionId, error)
          }
          settle(work, work.started)
        }
      } finally {
        workBySession.delete(sessionId)
        settle(work, Number.POSITIVE_INFINITY)
      }
    })
    return work
  }
  const flush = (sessionId: string): Promise<void> => {
    const work = schedule(sessionId)
    if (!work) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    work.waiters = [...work.waiters, { pass: work.started + 1, resolve }]
    return promise
  }
  // A failed sync has already drained its batch, so the clients' windows now
  // miss those changes. The rebase makes them reseed from the store, and flush
  // still resolves: callers such as the idle status use it to order their own
  // publishes, and must not fail with it.
  const invalidate = (sessionId: string, error: unknown): void => {
    recordBackgroundFailure(log, "publish output", { sessionId }, error)
    if (!disposed) shipped.rebase(sessionId)
  }
  /** The workflow whose card a runtime change of `sessionId` moves, if any. */
  const movedWorkflowCard = (sessionId: string): string | undefined => {
    const entry = deps.sessionStore.get(sessionId)
    const known = agentClocks.get(sessionId)
    if (entry?.kind !== "workflow-agent") {
      agentClocks.delete(sessionId)
      return known?.running === true ? known.workflowId : undefined
    }
    const running = runsWorkflowClock(entry)
    agentClocks.set(sessionId, { workflowId: entry.workflowId, running })
    return known?.running === running ? undefined : entry.workflowId
  }
  /** The child whose subagent cards a runtime change of `sessionId` moves:
   *  a linked child whose clock or tokens changed, or whose state no earlier
   *  change has stated. */
  const movedSubagentCard = (sessionId: string): string | undefined => {
    if (!parentsByChild.has(sessionId)) {
      childClocks.delete(sessionId)
      return undefined
    }
    const entry = deps.sessionStore.get(sessionId)
    const clock = entry && `${entry.streamingStartedAt}:${entry.accumulatedActiveMs}:${entry.tokens}`
    const moved = !childClocks.has(sessionId) || childClocks.get(sessionId) !== clock
    childClocks.set(sessionId, clock)
    return moved ? sessionId : undefined
  }
  /** The workflow of an agent whose facts were stored: its card reads its
   *  agents' usage and turn ends. */
  const storedWorkflowCard = (sessionId: string): string | undefined => {
    const entry = deps.sessionStore.get(sessionId)
    return entry?.kind === "workflow-agent" ? entry.workflowId : undefined
  }
  /** Re-projects the rows that read the `linked` sessions, the rows that
   *  name the `renamed` sessions by their titles, and the unbound cards of
   *  the `relinked` sessions. */
  const refreshParents = (linked: Iterable<string | undefined>, renamed: Iterable<string> = [], relinked: Iterable<string> = []): void => {
    const cardsByParent = new Map<string, RowIndexes>()
    const add = (parentId: string, rows: RowIndexes): void => {
      let cards = cardsByParent.get(parentId)
      if (!cards) { cards = new Map(); cardsByParent.set(parentId, cards) }
      for (const [identity, index] of rows) cards.set(identity, index)
    }
    const collect = (links: RowLinks, linkedIds: Iterable<string | undefined>): void => {
      for (const linkedId of linkedIds) {
        for (const [parentId, rows] of (linkedId === undefined ? undefined : links.get(linkedId)) ?? []) add(parentId, rows)
      }
    }
    collect(parentsByChild, linked)
    collect(rowsByNamedSession, renamed)
    for (const parentId of relinked) {
      const unlinked = unlinkedByParent.get(parentId)
      if (unlinked) add(parentId, unlinked)
    }
    for (const [parentId, cards] of cardsByParent) if (shipped.watches(parentId)) schedule(parentId, cards)
  }

  const sync = (changed?: ReadonlySet<string>): void => {
    if (disposed) return
    if (changed !== undefined) {
      for (const sessionId of changed) schedule(sessionId)
      refreshParents([...changed].flatMap((id) => [movedSubagentCard(id), movedWorkflowCard(id)]))
      return
    }
    const active = new Set<string>()
    for (const sessionId of deps.sessionStore.allIds()) {
      active.add(sessionId)
      schedule(sessionId)
    }

    for (const sessionId of observedById.keys()) {
      if (active.has(sessionId)) continue
      schedule(sessionId)
    }
  }

  sync()
  const unsubscribe = deps.sessionStore.onChange(sync, "output-protocol")
  const unsubscribeStored = deps.onStored((events) => {
    const sessionIds = new Set(events.map((event) => event.sessionId))
    const renamed = new Set(events.flatMap((event) => event.type === SESSION_TITLE_FACT_TYPE ? [event.sessionId] : []))
    const relinked = new Set(events.flatMap((event) => event.type === CHILD_LINKED_FACT_TYPE ? [event.sessionId] : []))
    refreshParents([...sessionIds].flatMap((id) => [id, storedWorkflowCard(id)]), renamed, relinked)
  })
  const unsubscribeRetired = deps.onContinuationRetired((sessionId) => { refreshParents([sessionId]) })
  return {
    flush,
    watch(sessionIds) {
      for (const sessionId of shipped.watch(sessionIds)) {
        const entry = deps.sessionStore.get(sessionId)
        if (!entry) continue
        const { blocks, sequenceStart } = outputView(entry)
        clearParent(sessionId, new Set(blocks.map(blockIdentity)))
        for (const [index, block] of blocks.entries()) linkBlock(sessionId, block, sequenceStart + index)
        // A card can have missed its child's link while no client followed
        // its session, so each card that reads as unbound projects once.
        const unlinked = unlinkedByParent.get(sessionId)
        if (unlinked) schedule(sessionId, unlinked)
      }
    },
    dispose() {
      disposed = true
      unsubscribe()
      unsubscribeStored()
      unsubscribeRetired()
      parentsByChild.clear()
      rowsByNamedSession.clear()
      unlinkedByParent.clear()
      childClocks.clear()
      agentClocks.clear()
      observedById.clear()
      workBySession.clear()
    },
  }
}

/** The fact that changes a session's title, which a row that names the
 *  session shows. */
const SESSION_TITLE_FACT_TYPE = "session.label.updated"

/** The fact that places a new child under the session that launched it. It
 *  commits with the binding of the child's run to the launching call, so a
 *  card not yet bound reads its child from that commit on. */
const CHILD_LINKED_FACT_TYPE = "session.child.linked"

/** A subagent call whose card no child is bound to yet. */
function isUnboundCard(block: AnyBlock): boolean {
  return block.kind === "tool" && block.name === "subagent" && (block.status === "pending" || block.status === "streaming")
}

/** The sessions a row names by their titles: the sender of a message, the
 *  recipient of a message call, and the recipients of a card's message calls. */
function namedSessions(block: AnyBlock): readonly string[] {
  if (block.kind === "userMessage") return block.from ? [block.from.sessionId] : []
  if (block.kind === "tool") return block.targetSessionId === undefined ? [] : [block.targetSessionId]
  if (block.kind === "agentGroup") return block.children.flatMap((child) => child.targetSessionId === undefined ? [] : [child.targetSessionId])
  return []
}

/** The rows of one session by identity, each with the absolute index it had
 *  when it was last linked. */
type RowIndexes = Map<string, number>

/** Rows that read another session: by the session read, then by the session
 *  whose transcript holds the row, those rows. */
type RowLinks = Map<string, Map<string, RowIndexes>>

function linkRow(links: RowLinks, linkedId: string, sessionId: string, identity: string, index: number): void {
  let sessions = links.get(linkedId)
  if (!sessions) { sessions = new Map(); links.set(linkedId, sessions) }
  let rows = sessions.get(sessionId)
  if (!rows) { rows = new Map(); sessions.set(sessionId, rows) }
  rows.set(identity, index)
}

/** Forgets the rows of `sessionId`, all of them or those not in `keep`. */
function unlinkRows(links: RowLinks, sessionId: string, keep: ReadonlySet<string> | undefined): void {
  for (const [linkedId, sessions] of links) {
    const rows = sessions.get(sessionId)
    if (rows && keep) for (const identity of rows.keys()) { if (!keep.has(identity)) rows.delete(identity) }
    if (!keep || rows?.size === 0) sessions.delete(sessionId)
    if (sessions.size === 0) links.delete(linkedId)
  }
}

/** The linked row `identity` of the view and its absolute index. The row is
 *  read at the index its link recorded, and the view is searched only when
 *  a block inserted before the row moved it. A row that left the view gives
 *  nothing. */
function findLinkedBlock(view: ReturnType<typeof outputView>, identity: string, index: number): { readonly index: number; readonly block: AnyBlock } | undefined {
  const recorded = view.blocks[index - view.sequenceStart]
  if (recorded && blockIdentity(recorded) === identity) return { index, block: recorded }
  const found = view.blocks.findIndex((block) => blockIdentity(block) === identity)
  const block = view.blocks[found]
  return block ? { index: view.sequenceStart + found, block } : undefined
}

/** One session's publish loop: whether a change waits for another pass, the
 *  cards that pass refreshes, how many passes began, and each flush waiting
 *  for the pass that drains what it asked for. */
interface SessionWork {
  pending: boolean
  cards: RowIndexes
  started: number
  waiters: readonly { readonly pass: number; readonly resolve: () => void }[]
}

function settle(work: SessionWork, completed: number): void {
  const done = work.waiters.filter((waiter) => waiter.pass <= completed)
  if (done.length === 0) return
  work.waiters = work.waiters.filter((waiter) => waiter.pass > completed)
  for (const waiter of done) waiter.resolve()
}

/** What one pass drained, held across the awaits that project its blocks. */
interface Drained {
  readonly baseView: ReturnType<typeof outputView>
  readonly fullResync: boolean
  readonly kept: readonly OutputBlockChange[]
  readonly blocks: readonly AnyBlock[]
  readonly changedTools: OutputChangeBatch["changedTools"]
  readonly ownStreamingToolText: SessionEntry["streamingToolText"]
  readonly streamingOutputChars: number
}

function outputView(entry: SessionEntry) {
  return {
    blocks: entry.outputBlocks(),
    sequenceStart: entry.outputSequenceStart,
    visibleMessageCount: entry.visibleMessageCountPrefix + entry.visibleMessageCountSuffix,
  }
}

/** One drain can write the same block many times: a streaming tool row
 *  refines as its input arrives, a subagent card changes with every child
 *  operation. Every upsert carries the whole block, so a block's last upsert
 *  already holds what its earlier upserts and appends wrote, and only the
 *  changes after it add anything. An insert stays: it makes the slot the
 *  upsert replaces, and shifts the blocks after it. Adjacent appends to one
 *  block that continue each other ship as one append. */
function lastCopies(changes: readonly OutputBlockChange[]): readonly OutputBlockChange[] {
  const lastUpsert = new Map<string, number>()
  for (const [index, change] of changes.entries()) if (change.kind === "upsert") lastUpsert.set(changeIdentity(change), index)
  const kept: OutputBlockChange[] = []
  for (const [index, change] of changes.entries()) {
    if (change.kind !== "insert" && index < (lastUpsert.get(changeIdentity(change)) ?? index)) continue
    const previous = kept.at(-1)
    if (change.kind === "append-content" && previous?.kind === "append-content" && changeIdentity(previous) === changeIdentity(change) && previous.contentOffset + previous.text.length === change.contentOffset) {
      kept[kept.length - 1] = { ...previous, text: previous.text + change.text }
    } else kept.push(change)
  }
  return kept
}

function changeIdentity(change: OutputBlockChange): string {
  return blockIdentity(change.kind === "append-content" ? change.identity : change.block)
}

function toWireBlockChange(project: (block: AnyBlock, index: number) => AnyBlock, change: OutputBlockChange): ProjectedBlockChange {
  if (change.kind === "insert" || change.kind === "upsert") {
    const wire = projectFrontendOutputBlock(project(change.block, change.index))
    return { kind: change.kind, index: change.index, blockId: blockIdentity(wire), block: wire }
  }
  return { kind: "append-content", index: change.index, blockId: blockIdentity(change.identity), contentOffset: change.contentOffset, text: change.text }
}
