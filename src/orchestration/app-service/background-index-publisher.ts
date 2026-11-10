import { parseProjectionFact } from "../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { backgroundCursor, type SessionBackgroundWorkResult } from "../../protocol/background-index-protocol-types.js"
import type { RuntimePosition, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"
import { workflowPlacements } from "../module-catalog.js"
import type { WorkflowPlacements } from "../module-seams.js"
import type { SessionStore } from "../session-store/types.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import { onReplyWaitsChanged, readReplyWaitViews } from "../session/reply-waits.js"
import { parseStoredSessionRuntimeFact } from "../../infra/runtime-fact-parser.js"
import type { RuntimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import { createBackgroundIndex, type BackgroundIndex, type BackgroundIndexDeps, type BackgroundIndexPart, type BackgroundIndexTree } from "./background-index.js"

const log = Log.create({ service: "background-index-owner" })

/** The command records of a session change its own command rows. */
const COMMAND_FACT_TYPE = "tool.background_command.recorded"
/** The metadata facts of a subagent that change its own row. */
const CHILD_FACT_TYPES: ReadonlySet<string> = new Set(["session.lifecycle.changed", "session.label.updated"])
/** The facts that change the child list of the session they land on. */
const CHILD_LIST_FACT_TYPES: ReadonlySet<string> = new Set(["session.child.linked", "session.child.unlinked"])
/** The root's facts that can record a Stop of a workflow's launching call. */
const CALL_RESULT_FACT_TYPES: ReadonlySet<string> = new Set(["tool.result.recorded", "workflow.tool_result.corrected"])

export interface BackgroundIndexOwnerDeps {
  readonly index: Pick<BackgroundIndex, "tree">
  /** Where workflows sit in the tree. The owner passes it every stored batch. */
  readonly workflowPlacements: WorkflowPlacements
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => void
  /** The position of the newest patch published on a cursor. */
  readonly snapshotPosition: (anchor: RuntimeReadAnchor) => RuntimePosition
  /** The run facts of a child, which the installed child-session history owns. */
  readonly childRunFactTypes: readonly string[]
  /** The live registries of the sessions a runner here holds. */
  readonly sessionStore: Pick<SessionStore, "onChange" | "get" | "allIds">
  /** The word that the commands the executor's keeper holds for a session changed. */
  readonly onKeptChange: (listener: (sessionId: string) => void) => () => void
  /** The word that the reply waits of a session changed. */
  readonly onReplyWaitsChange: (listener: (sessionId: string) => void) => () => void
}

/** The background indexes that clients follow, held in memory
 *  (ARCH-PROTOCOL-069). */
export interface BackgroundIndexOwner {
  /** The rows of `sessionId` and the position they include. The first read
   *  of a session builds its index, and the owner holds it from then on.
   *  Rejects when the build fails, so a client never reads an empty index
   *  for one it could not read. */
  snapshot(sessionId: string): Promise<SessionBackgroundWorkResult>
  /** No client follows `sessionId` any more (the account's
   *  `background.release`): the owner lets its index go. */
  release(sessionId: string): void
  dispose(): void
}

/** What changed, routed to each held index. */
type Change =
  | { readonly kind: "fact"; readonly event: StoredFact }
  /** The live commands of a session changed, those of `toolUseIds`. */
  | { readonly kind: "live"; readonly sessionId: string; readonly toolUseIds: ReadonlySet<string> }
  /** The commands the executor's keeper holds for a session changed. */
  | { readonly kind: "kept"; readonly sessionId: string }
  | { readonly kind: "waits"; readonly sessionId: string }
  /** The session that launched a workflow, as placements read it now. */
  | { readonly kind: "placement"; readonly workflowId: string; readonly parentId: string | undefined }

interface HeldIndex {
  readonly rootId: string
  readonly tree: BackgroundIndexTree
  /** The changes that arrived while the tree was built, routed once it is. */
  backlog: Change[] | undefined
  failure?: unknown
  /** The parts to read again, by key, so a burst of changes reads each once. */
  readonly dirty: Map<string, BackgroundIndexPart>
  scheduled: boolean
  /** Runs the build, the updates, and the snapshots one after another, so
   *  a snapshot's position covers exactly the patches its rows include. */
  queue: Promise<void>
}

/** Holds the background index of each session a client follows, built once,
 *  and advances it by each change: a stored fact, a change of a runner's live
 *  commands or of the keeper's, and a change of a reply wait. Each change
 *  reads again only the parts of the index it touches, and the owner
 *  publishes each row that changed, whole, or its removal. */
export function createBackgroundIndexOwner(deps: BackgroundIndexOwnerDeps): BackgroundIndexOwner {
  const held = new Map<string, HeldIndex>()
  const childRunFacts = new Set(deps.childRunFactTypes)
  // The live commands each session showed last, by tool use id, so a store
  // change that leaves them alone reads nothing.
  const liveCommands = new Map<string, ReadonlyMap<string, string>>()

  function current(index: HeldIndex): boolean {
    return held.get(index.rootId) === index
  }

  function enqueue<T>(index: HeldIndex, task: () => Promise<T>): Promise<T> {
    const result = index.queue.then(task)
    index.queue = result.then(() => {}, () => {})
    return result
  }

  function mark(index: HeldIndex, part: BackgroundIndexPart): void {
    const key = "sessionId" in part ? `${part.kind}:${part.sessionId}` : "workflowId" in part ? `${part.kind}:${part.workflowId}` : part.kind
    index.dirty.set(key, mergedPart(index.dirty.get(key), part))
    if (index.scheduled) return
    index.scheduled = true
    void enqueue(index, async () => {
      index.scheduled = false
      const parts = [...index.dirty.values()]
      index.dirty.clear()
      try {
        for (const next of parts) {
          if (!current(index)) return
          await index.tree.update(next)
        }
      } catch (error) {
        fail(index, error)
      }
    })
  }

  /** A part that could not be read leaves the index unknown: the owner lets
   *  it go and tells clients to read it again, which builds it again. */
  function fail(index: HeldIndex, error: unknown): void {
    if (!current(index)) return
    held.delete(index.rootId)
    recordBackgroundFailure(log, "background index update", { sessionId: index.rootId }, error)
    deps.publish({ cursor: backgroundCursor(index.rootId), payload: { kind: "runtime.invalidate", reason: "overflow" } })
  }

  /** Routes one change. A change that cannot be read is recorded and skipped,
   *  so it never holds back the changes after it. */
  function route(index: HeldIndex, change: Change): void {
    if (index.backlog) {
      index.backlog.push(change)
      return
    }
    try {
      routeChange(index, change)
    } catch (error) {
      recordBackgroundFailure(log, "background index routing", { sessionId: index.rootId, change: change.kind }, error)
    }
  }

  function routeChange(index: HeldIndex, change: Change): void {
    const { tree } = index
    switch (change.kind) {
      case "fact": return routeFact(index, change.event)
      case "live":
        if (tree.role(change.sessionId) === undefined) return
        mark(index, { kind: "commands", sessionId: change.sessionId, toolUseIds: change.toolUseIds })
        for (const childId of tree.childrenLaunchedBy(change.sessionId, change.toolUseIds)) mark(index, { kind: "child", sessionId: childId })
        return
      case "kept":
        // The keeper's word names no command: the update reads only the rows
        // whose command it took up or let go.
        if (tree.role(change.sessionId) !== undefined) mark(index, { kind: "commands", sessionId: change.sessionId, toolUseIds: new Set() })
        return
      case "waits":
        // A root's own wait is no row of its index; only a subagent's wait is.
        if (tree.role(change.sessionId) === "child") mark(index, { kind: "child", sessionId: change.sessionId })
        return
      case "placement":
        // A workflow the root launched, or one adopted away from it.
        if ((change.parentId === index.rootId) !== tree.hasWorkflow(change.workflowId)) mark(index, { kind: "launches" })
        return
    }
  }

  function routeFact(index: HeldIndex, event: StoredFact): void {
    const { tree } = index
    const sessionId = event.sessionId
    const role = tree.role(sessionId)
    if (tree.hasWorkflow(sessionId)) mark(index, { kind: "workflow", workflowId: sessionId })
    else if (event.type === COMMAND_FACT_TYPE) {
      const fact = parseProjectionFact(event, parseStoredSessionRuntimeFact)
      if (role !== undefined && fact.type === COMMAND_FACT_TYPE) mark(index, { kind: "commands", sessionId, toolUseIds: new Set([fact.payload.toolUseId]) })
    } else if (CHILD_LIST_FACT_TYPES.has(event.type)) {
      if (role !== undefined) mark(index, { kind: "children", sessionId })
    } else if (CHILD_FACT_TYPES.has(event.type) || childRunFacts.has(event.type)) {
      if (role === "child") mark(index, { kind: "child", sessionId })
    } else if (role === "root" && CALL_RESULT_FACT_TYPES.has(event.type)) {
      // A stored result decodes in its stored shape: a large result's text is
      // a content reference, which this reader never loads.
      const fact = parseProjectionFact(event, parseStoredSessionRuntimeFact)
      if (fact.type !== "tool.result.recorded" && fact.type !== "workflow.tool_result.corrected") return
      const outcome = fact.payload.outcome
      const workflowId = tree.callResult(fact.payload.toolUseId, outcome === "stopped" ? "person" : outcome === "cancelled" ? "agent" : undefined)
      if (workflowId !== undefined) mark(index, { kind: "workflow", workflowId })
    }
  }

  function routeAll(change: Change): void {
    for (const index of held.values()) route(index, change)
  }

  const stopStored = deps.onStored((events) => {
    deps.workflowPlacements.observe(events)
    if (held.size === 0) return
    const workflows = new Set<string>()
    for (const event of events) {
      if (event.aggregateId === workflowAggregateId(event.sessionId)) workflows.add(event.sessionId)
      routeAll({ kind: "fact", event })
    }
    for (const workflowId of workflows) {
      void deps.workflowPlacements.parent(workflowId).then(
        (parentId) => { routeAll({ kind: "placement", workflowId, parentId }) },
        (error: unknown) => { recordBackgroundFailure(log, "background index routing", { workflowId }, error) },
      )
    }
  })
  const stopStore = deps.sessionStore.onChange((changed) => {
    for (const sessionId of changed ?? deps.sessionStore.allIds()) {
      const commands = new Map((deps.sessionStore.get(sessionId)?.activeBackgroundCommands ?? []).map((command) => [command.toolUseId, `${command.id}\n${command.model ?? ""}\n${command.effort ?? ""}\n${command.roleSessionId ?? ""}`]))
      const previous = liveCommands.get(sessionId) ?? new Map<string, string>()
      const toolUseIds = new Set([...commands.keys(), ...previous.keys()].filter((toolUseId) => commands.get(toolUseId) !== previous.get(toolUseId)))
      if (toolUseIds.size === 0) continue
      if (commands.size === 0) liveCommands.delete(sessionId)
      else liveCommands.set(sessionId, commands)
      routeAll({ kind: "live", sessionId, toolUseIds })
    }
  }, "background-index")
  const stopKept = deps.onKeptChange((sessionId) => { routeAll({ kind: "kept", sessionId }) })
  const stopWaits = deps.onReplyWaitsChange((sessionId) => { routeAll({ kind: "waits", sessionId }) })

  function hold(rootId: string): HeldIndex {
    const index: HeldIndex = {
      rootId,
      tree: deps.index.tree(rootId, {
        updated: (row) => { if (current(index)) deps.publish({ cursor: backgroundCursor(rootId), payload: { kind: "background.row.updated", row } }) },
        removed: (rowId) => { if (current(index)) deps.publish({ cursor: backgroundCursor(rootId), payload: { kind: "background.row.removed", rowId } }) },
      }),
      backlog: [], dirty: new Map(), scheduled: false, queue: Promise.resolve(),
    }
    held.set(rootId, index)
    void enqueue(index, async () => {
      try {
        await index.tree.build()
      } catch (error) {
        index.failure = error
        if (current(index)) held.delete(rootId)
        return
      }
      const backlog = index.backlog ?? []
      index.backlog = undefined
      for (const change of backlog) route(index, change)
    })
    return index
  }

  return {
    snapshot(sessionId) {
      const index = held.get(sessionId) ?? hold(sessionId)
      return enqueue(index, async () => {
        if (index.failure !== undefined) throw index.failure
        return { snapshotPosition: deps.snapshotPosition({ kind: "cursor", cursor: backgroundCursor(sessionId) }), rows: [...index.tree.rows.values()] }
      })
    },
    release(sessionId) {
      if (held.delete(sessionId)) log.info("background index released", { sessionId, held: held.size })
    },
    dispose() {
      stopStored()
      stopStore()
      stopKept()
      stopWaits()
      held.clear()
      liveCommands.clear()
    },
  }
}

/** One part that covers both marks of the same part: command rows join
 *  their named calls, and a mark that names no call reads every row. */
function mergedPart(marked: BackgroundIndexPart | undefined, part: BackgroundIndexPart): BackgroundIndexPart {
  if (marked?.kind !== "commands" || part.kind !== "commands") return part
  if (marked.toolUseIds === undefined || part.toolUseIds === undefined) return { kind: "commands", sessionId: part.sessionId }
  return { ...part, toolUseIds: marked.toolUseIds.union(part.toolUseIds) }
}

/** The background indexes of a runtime over one project store: the live work
 *  comes from the runners `sessionStore` holds and the commands the
 *  executor's keeper holds, and the reply waits from the waits the sessions
 *  store. `dispose` ends the publication. */
export function composeBackgroundIndex(deps: {
  readonly reader: AsyncEventStateReadSurface
  readonly readSession: BackgroundIndexDeps["readSession"]
  readonly onStored: BackgroundIndexOwnerDeps["onStored"]
  readonly publish: BackgroundIndexOwnerDeps["publish"]
  readonly snapshotPosition: BackgroundIndexOwnerDeps["snapshotPosition"]
  readonly sessionStore: BackgroundIndexOwnerDeps["sessionStore"]
  readonly onKeptChange: BackgroundIndexOwnerDeps["onKeptChange"]
}): BackgroundIndexOwner {
  return createBackgroundIndexOwner({
    ...deps,
    index: createBackgroundIndex({
      reader: deps.reader,
      readSession: deps.readSession,
      liveCommands: (sessionId) => deps.sessionStore.get(sessionId)?.activeBackgroundCommands ?? [],
      replyWaits: (sessionId) => readReplyWaitViews(deps.reader, async (id) => await deps.readSession(id) ?? null, sessionId),
    }),
    workflowPlacements: workflowPlacements(deps.reader),
    childRunFactTypes: installedChildSessionHistory().factTypes,
    onReplyWaitsChange: (listener) => onReplyWaitsChanged(deps.reader, listener),
  })
}
