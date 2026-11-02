import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { backgroundCursor } from "../../protocol/background-index-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"
import type { SessionStore } from "../session-store/types.js"
import type { SessionPlacements } from "../session/session-metadata-store.js"
import type { WorkflowPlacements } from "../module-seams.js"

const log = Log.create({ service: "background-index-publisher" })

/** The command records of a session change its own rows. */
const COMMAND_FACT_TYPE = "tool.background_command.recorded"
/** The metadata facts of a descendant that change its row in every ancestor index. */
const TREE_FACT_TYPES: ReadonlySet<string> = new Set(["session.lifecycle.changed", "session.label.updated"])
/** The facts that change the child list of the session they land on, which
 *  its own index and every ancestor index show. */
const CHILD_LIST_FACT_TYPES: ReadonlySet<string> = new Set(["session.child.linked", "session.child.unlinked"])
/** A chain of parents longer than this is a damaged tree, not a deep one. */
const MAX_DEPTH = 32

export interface BackgroundIndexPublisherDeps {
  /** Where workflows sit in the tree. The publisher passes it every stored batch. */
  readonly workflowPlacements: WorkflowPlacements
  /** Where sessions sit in the tree. The publisher passes it every stored batch. */
  readonly sessionPlacements: SessionPlacements
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => void
  /** The run facts of a child, which the installed child-session history owns. */
  readonly childRunFactTypes: readonly string[]
  /** The live registries of the sessions a runner here holds. */
  readonly sessionStore: Pick<SessionStore, "onChange" | "get" | "allIds">
  /** The word that the commands the executor's keeper holds for a session changed. */
  readonly onKeptChange: (listener: (sessionId: string) => void) => () => void
  /** The word that the reply waits of a session changed. */
  readonly onReplyWaitsChange: (listener: (sessionId: string) => void) => () => void
}

/** Invalidates each session index whose rows changed. Commands belong to
 *  their own session; descendant rows also belong to every ancestor index.
 *  Clients read again only while they show the index. */
export function createBackgroundIndexPublisher(deps: BackgroundIndexPublisherDeps) {
  const childRunFacts = new Set(deps.childRunFactTypes)
  // The live work each session showed last, as ids, so a store change that
  // leaves it alone publishes nothing.
  const liveIds = new Map<string, string>()

  async function addAncestors(sessionId: string, affected: Set<string>): Promise<void> {
    let current = sessionId
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const session = await deps.sessionPlacements.placement(current)
      if (!session) return
      const parent = session.launchedFrom?.parentSessionId
      if (parent === undefined) return
      affected.add(parent)
      current = parent
    }
  }

  function publishFor(descendants: Iterable<string>, sessions: Iterable<string> = [], workflows: Iterable<string> = []): void {
    const ids = [...descendants]
    const own = [...sessions]
    const runs = [...workflows]
    if (ids.length === 0 && own.length === 0 && runs.length === 0) return
    void (async () => {
      const affected = new Set<string>()
      for (const workflowId of runs) {
        const parent = await deps.workflowPlacements.parent(workflowId)
        if (parent === undefined) continue
        affected.add(parent)
        await addAncestors(parent, affected)
      }
      for (const sessionId of own) {
        if (await deps.sessionPlacements.placement(sessionId)) affected.add(sessionId)
      }
      for (const sessionId of ids) {
        await addAncestors(sessionId, affected)
      }
      for (const sessionId of affected) deps.publish({ cursor: backgroundCursor(sessionId), payload: { kind: "background.changed" } })
    })().catch((error: unknown) => { recordBackgroundFailure(log, "background index publication", { sessions: ids.length + own.length }, error) })
  }

  const stopStored = deps.onStored((events) => {
    const descendants = new Set<string>()
    const own = new Set<string>()
    const workflows = new Set<string>()
    deps.sessionPlacements.observe(events)
    deps.workflowPlacements.observe(events)
    for (const event of events) {
      if (event.type === COMMAND_FACT_TYPE) own.add(event.sessionId)
      else if (CHILD_LIST_FACT_TYPES.has(event.type)) {
        own.add(event.sessionId)
        descendants.add(event.sessionId)
      } else if (event.aggregateId === workflowAggregateId(event.sessionId)) workflows.add(event.sessionId)
      else if (TREE_FACT_TYPES.has(event.type) || childRunFacts.has(event.type)) {
        descendants.add(event.sessionId)
      }
    }
    publishFor(descendants, own, workflows)
  })
  const stopStore = deps.sessionStore.onChange((changed) => {
    const touched: string[] = []
    for (const sessionId of changed ?? deps.sessionStore.allIds()) {
      const ids = (deps.sessionStore.get(sessionId)?.activeBackgroundCommands ?? []).map((command) => command.id).join("\n")
      if ((liveIds.get(sessionId) ?? "") === ids) continue
      if (ids === "") liveIds.delete(sessionId)
      else liveIds.set(sessionId, ids)
      touched.push(sessionId)
    }
    publishFor(touched, touched)
  }, "background-index")
  // Kept commands mark only the command rows of their own session as held.
  const stopKept = deps.onKeptChange((sessionId) => { publishFor([], [sessionId]) })
  // A chat's own wait is no row of its index; only a descendant's wait is.
  const stopWaits = deps.onReplyWaitsChange((sessionId) => {
    void deps.sessionPlacements.placement(sessionId).then((session) => {
      if (session && session.kind !== "chat") publishFor([sessionId])
    }).catch((error: unknown) => { recordBackgroundFailure(log, "background index publication", { sessions: 1 }, error) })
  })
  return {
    dispose(): void {
      stopStored()
      stopStore()
      stopKept()
      stopWaits()
      liveIds.clear()
    },
  }
}
