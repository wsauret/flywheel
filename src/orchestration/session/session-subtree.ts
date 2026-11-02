import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import type { AsyncEventReadSurface, CorruptEventRowError, StoredFact } from "../../infra/event-store-types.js"
import { heldProjection } from "../../infra/projection-registry.js"
import type { ContentResolver } from "../../infra/tool-content.js"
import { yieldToNextTask } from "../../infra/task-scheduling.js"
import { decodeSessionMetadataFactForReplay, parseSessionMetadataFact } from "./session-metadata-facts.js"
import type { SessionPlacements } from "./session-metadata-store.js"
import { isLaunchedDescendantKind } from "./session-summary-index-sql.js"

/** Where every session of the workspace sits in the launch tree, each
 *  session's kind, and the title that clients show for it. Links only grow:
 *  every producer that moves a child appends the new parent's link in the
 *  same batch, so a moved child counts under both parents. */
export interface SessionLineage {
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly kinds: ReadonlyMap<string, string>
  /** A session's label, or else its name, as its catalog row titles it. */
  readonly titles: ReadonlyMap<string, string>
}

interface LineageDraft {
  children: Map<string, readonly string[]>
  kinds: Map<string, string>
  titles: Map<string, string>
}

function addChild(state: LineageDraft, parentId: string, childId: string): void {
  const children = state.children.get(parentId) ?? []
  if (!children.includes(childId)) state.children.set(parentId, [...children, childId])
}

/** An unreadable fact leaves the lineage as it was: a session whose creation
 *  does not read has no kind, so no ancestor counts its work, and no other
 *  session's tree depends on it. */
function reduceLineage(state: LineageDraft, event: StoredFact): LineageDraft {
  if (event.type === "session.child.linked") {
    const fact = parseProjectionFact(event, parseSessionMetadataFact)
    if (fact.type === "session.child.linked") addChild(state, event.sessionId, fact.payload.childSessionId)
    return state
  }
  const fact = decodeSessionMetadataFactForReplay({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }, event.timestamp)
  if (fact?.type === "session.label.updated") {
    const title = fact.payload.label || fact.payload.name
    if (title) state.titles.set(event.sessionId, title)
  } else if (fact?.type === "session.created") {
    state.kinds.set(event.sessionId, fact.payload.kind)
    const title = fact.payload.label || fact.payload.name
    if (title) state.titles.set(event.sessionId, title)
    const parent = fact.payload.launchedFrom?.parentSessionId
    if (parent) addChild(state, parent, event.sessionId)
  }
  return state
}

/** The one workspace fold of the launch tree. Folded once per reader, then
 *  advanced by the lineage facts committed after its position. */
export function heldSessionLineage(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "session-lineage", () => createEventProjection<LineageDraft>(reader, {
    name: "session-lineage",
    factTypes: ["session.created", "session.child.linked", "session.label.updated"],
    initialState: () => ({ children: new Map(), kinds: new Map(), titles: new Map() }),
    // One copy per catch-up keeps every published lineage immutable, so a
    // reader that holds one can tell a changed tree by identity.
    draft: (state) => ({ children: new Map(state.children), kinds: new Map(state.kinds), titles: new Map(state.titles) }),
    reduce: reduceLineage,
    reduceCorruptRow: (state) => state,
    reduceUnreadableFact: (state) => state,
  }))
}

/** `sessionId` and every session it launched, at any depth, in visit order
 *  with `sessionId` first. Only launched kinds are descendants or
 *  intermediates, so a fork and its subtree stay apart. */
export function sessionSubtree(lineage: SessionLineage, sessionId: string): string[] {
  const members = [sessionId]
  const visited = new Set(members)
  const visit = (parent: string) => {
    for (const child of lineage.children.get(parent) ?? []) {
      if (visited.has(child) || !isLaunchedDescendantKind(lineage.kinds.get(child))) continue
      visited.add(child)
      members.push(child)
      visit(child)
    }
  }
  visit(sessionId)
  return members
}

/** Adds `sessionId` and every session whose subtree holds it to `into`,
 *  walking up through launched kinds only, as `sessionSubtree` walks down.
 *  A session already in `into` was walked, which also ends a cycle. */
export async function addSubtreeOwners(placements: SessionPlacements, sessionId: string, into: Set<string>): Promise<void> {
  let current = sessionId
  while (!into.has(current)) {
    into.add(current)
    const session = await placements.placement(current)
    const parent = session && isLaunchedDescendantKind(session.kind) ? session.launchedFrom?.parentSessionId : undefined
    if (parent === undefined) return
    current = parent
  }
}

/** One fact of a subtree fold, with the content its page carries. */
export type SubtreeRow = { readonly fact: StoredFact | CorruptEventRowError; readonly toolContent: ContentResolver }

export interface SubtreeFold {
  /** Folds every fact of the subtree committed since the last call. Store
   *  failures propagate, and the facts folded before one stay folded. */
  advance(): Promise<void>
  /** The sessions folded so far, the root first. */
  members(): readonly string[]
  /** The lineage that the last advance read, for titles. */
  lineage(): SessionLineage | undefined
}

/** Folds the session facts of `types` of one session and every session it
 *  launched, in workspace position order within each read.
 *
 *  A subtree can hold hundreds of sessions, so one advance costs a fixed
 *  number of requests, whatever the member count: one position capture, the
 *  lineage's catch-up, and one paged read of the facts committed after the
 *  fold's position, for every member at once. A session that joins the tree
 *  folds its own history once, through that position, before the shared
 *  read. A joining session's facts can therefore arrive after later facts
 *  of other members, so `consume` must order what it keeps by position. */
export function createSubtreeFold(reader: AsyncEventReadSurface, sessionId: string, options: {
  readonly types: readonly string[]
  readonly content: "eager" | "deferred"
  readonly consume: (row: SubtreeRow) => void
}): SubtreeFold {
  let members: readonly string[] = [sessionId]
  let lineage: SessionLineage | undefined
  let position = 0
  let folded = false
  async function read(ids: readonly string[], after: number, upper: number): Promise<void> {
    const aggregateIds = ids.map((id) => `session:${id}`)
    let cursor = after
    while (cursor < upper) {
      const page = await reader.readPage({ aggregateIds, types: options.types }, upper, cursor, true, options.content)
      for (const fact of page.facts) options.consume({ fact, toolContent: page.toolContent })
      if (page.continuationPosition === null) return
      cursor = page.continuationPosition
      await yieldToNextTask()
    }
  }
  return {
    async advance() {
      const upper = await reader.capturePosition()
      if (folded && upper <= position) return
      const current = await heldSessionLineage(reader).replay()
      if (current !== lineage) {
        const next = sessionSubtree(current, sessionId)
        const known = new Set(members)
        const joining = next.filter((id) => !known.has(id))
        if (joining.length > 0) await read(joining, 0, position)
        members = next
        lineage = current
      }
      await read(members, position, upper)
      position = upper
      folded = true
    },
    members: () => members,
    lineage: () => lineage,
  }
}
