import type { SessionRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createOpenSessionKeeper } from "../../../src/protocol/client/open-session-keeper.js"
import type { Residency } from "../../../src/protocol/client/residency.js"
import type { HeldSessionDetails } from "../../../src/protocol/client/held-session-details.js"

/** What the page holds on the runtime for its awake resident sessions: the
 *  detail of each one and its parent chain, and the runner of each root chat.
 *  The page's tabs are the root chats of its awake residents: each holds its
 *  runner (ARCH-RUNTIME-023). On an open lane a hidden resident stays awake, so a
 *  return finds its runner warm. A lane break makes every hidden resident
 *  dormant, and a dormant resident holds nothing: the page asks for no
 *  runner and reads no detail on its behalf, so a chat that another client
 *  closed while the page could not hear it is not opened again behind the
 *  person. When a connection ends, the runtime keeps its holds for a grace,
 *  so a resident that the page shows again within the grace wakes, holds its
 *  root again, and finds the runner warm. A hidden root whose chat another
 *  client closes on an open lane stays closed while it is hidden, and opens
 *  again when the person shows it: its catalog row turns inactive, and the
 *  keeper activates a shown root whose runner ended. */
export interface ResidentHolds {
  /** The chat at the top of `sessionId`'s parent chain, or undefined while a
   *  link of the chain is unknown. */
  rootOf(sessionId: string): string | undefined
  /** Holds what the awake residents need and releases the rest. It runs
   *  on its own when residents go dormant or wake. */
  sync(): void
  /** Evicts the hidden residents the runtime no longer has: a session the
   *  catalog dropped, or an awake one whose held detail turned null or that
   *  nothing records. A dormant resident holds no detail, so only the catalog
   *  judges it until it wakes. A root that turns inactive stays: a recovery
   *  pauses every live chat and a close elsewhere looks the same in the
   *  catalog, so only a removal the runtime states drops what the page kept.
   *  The shown session leaves through the page's navigation instead. */
  evictGone(): void
  dispose(): void
}

export function createResidentHolds(deps: {
  readonly connection: Pick<RuntimeConnection, "dispatch" | "subscribe" | "onLane">
  readonly residents: Pick<Residency<unknown>, "ids" | "awake" | "onAwakeChange" | "evict">
  readonly children: Pick<HeldSessionDetails, "root" | "lost" | "retainChains">
  /** The listed or held row of a session. */
  readonly rowOf: (sessionId: string) => SessionRow | undefined
  readonly listed: (sessionId: string) => boolean
  readonly known: (sessionId: string) => boolean
  readonly selected: () => string | undefined
  /** True for the selection this page just created, which is its own root
   *  before its detail can say so. */
  readonly created: (sessionId: string) => boolean
  /** Answers once the shown transcript is current on the open lane. */
  readonly focusReady: () => Promise<void>
  /** The passive details that visible child cards hold. Their rows stay
   *  current, but no runner of theirs is opened. */
  readonly passiveDetails: () => readonly string[]
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
}): ResidentHolds {
  const keeper = createOpenSessionKeeper({
    client: deps.connection,
    focusReady: deps.focusReady,
    ended: (id) => deps.rowOf(id)?.lifecycleState === "inactive",
    ...(deps.onDiagnostic === undefined ? {} : { onDiagnostic: deps.onDiagnostic }),
  })
  const served = new Set<string>()
  /** Residents the catalog listed. A listed session the catalog drops was
   *  deleted, and the page must not open it again behind the person. */
  const listedOnce = new Set<string>()

  function rootOf(id: string): string | undefined {
    return deps.children.root(id, deps.rowOf) ?? (deps.created(id) ? id : undefined)
  }

  /** A destination whose chain is still unknown adds no root, and the
   *  session the person left stays resident, so a tap on a child never
   *  releases its parent's runner to claim it again once the child's detail
   *  names it. New roots open before old ones close, so a runner that both
   *  sets share is never released. */
  function sync(): void {
    const ids = deps.residents.awake()
    deps.children.retainChains([...ids, ...deps.passiveDetails()])
    const roots = new Set(ids.flatMap((id) => rootOf(id) ?? []))
    for (const root of roots) if (!served.has(root)) { served.add(root); keeper.open(root) }
    for (const root of served) if (!roots.has(root)) { served.delete(root); keeper.close(root) }
    const selected = deps.selected()
    keeper.focus(selected === undefined ? undefined : rootOf(selected))
  }

  function evictGone(): void {
    let evicted = false
    const kept = new Set<string>()
    const selected = deps.selected()
    const awake = new Set(deps.residents.awake())
    for (const id of deps.residents.ids()) {
      if (deps.listed(id)) listedOnce.add(id)
      const unlisted = listedOnce.has(id) && !deps.listed(id)
      const detailGone = awake.has(id) && (deps.children.lost(id) !== undefined || !deps.known(id))
      if (id !== selected && (unlisted || detailGone)) {
        deps.residents.evict(id)
        evicted = true
        continue
      }
      kept.add(id)
    }
    for (const id of listedOnce) if (!kept.has(id)) listedOnce.delete(id)
    if (evicted) sync()
  }

  const stopAwake = deps.residents.onAwakeChange(sync)

  return {
    rootOf,
    sync,
    evictGone,
    dispose() {
      stopAwake()
      keeper.dispose()
    },
  }
}
