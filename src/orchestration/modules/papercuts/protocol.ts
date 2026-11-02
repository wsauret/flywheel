import type { AsyncEventReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { papercutsProtocol, type RuntimePapercutCountView } from "../../../protocol/modules/papercuts.js"
import { workspaceDomainCursor, type RuntimeUiPatch, type RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { createPapercutBacklogProjection, PAPERCUT_FACT_TYPES } from "./backlog.js"

const papercutCursor = () => workspaceDomainCursor("papercuts")
const PAPERCUT_FACT_TYPE_SET: ReadonlySet<string> = new Set(PAPERCUT_FACT_TYPES)
const log = Log.create({ service: "papercuts-protocol" })

/** The module's protocol runtime. The snapshot reconciles other connections'
 *  commits before the cursor position is read, so the position covers the count. */
export function createPapercutsProtocol(services: ModuleProtocolServices): ModuleProtocolRuntime<typeof papercutsProtocol> {
  const projection = createPapercutCountProjection({ reader: services.projectionReader, onStored: services.onStored, publish: services.publish })
  return {
    serve: {
      papercutCountSnapshot: async () => ({ papercuts: await projection.snapshot(), snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: papercutCursor() }) }),
    },
    mutate: {},
    dispose: projection.dispose,
  }
}

export interface PapercutCountProjection {
  snapshot(): Promise<RuntimePapercutCountView>
  dispose(): void
}

export interface PapercutCountProjectionDeps {
  readonly reader: AsyncEventReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
}

/** Owns the live count derived from the durable workspace papercut backlog.
 * Construction subscribes before replay. Only a commit that carries a papercut
 * fact reaches the backlog, so other commits read nothing. Snapshot reconciles
 * commits made by other SQLite connections before returning its complete count view. */
export function createPapercutCountProjection(deps: PapercutCountProjectionDeps): PapercutCountProjection {
  let projection: ReturnType<typeof createPapercutBacklogProjection> | undefined
  let queued: StoredFact[] = []
  let publishedCount = 0
  let disposed = false

  function publishChanged(count: number): void {
    if (count === publishedCount) return
    publishedCount = count
    deps.publish({ cursor: papercutCursor(), payload: { kind: "papercuts.changed", papercuts: { undisposedCount: count } } })
  }

  async function applyStored(events: readonly StoredFact[]): Promise<void> {
    const papercutFacts = events.filter((event) => PAPERCUT_FACT_TYPE_SET.has(event.type))
    if (disposed || papercutFacts.length === 0) return
    if (!projection) {
      queued.push(...papercutFacts)
      return
    }
    let count = projection.snapshot().count
    for (const event of papercutFacts) count = (await projection.apply(event)).count
    publishChanged(count)
  }

  // Nothing awaits a pushed fold; a fact the backlog cannot fold is recorded.
  const recordFoldFailure = (error: unknown): void => { recordBackgroundFailure(log, "papercut count update", {}, error) }
  const unsubscribe = deps.onStored((events) => { void applyStored(events).catch(recordFoldFailure) })
  try {
    projection = createPapercutBacklogProjection(deps.reader)
    for (const event of queued) void projection.apply(event).catch(recordFoldFailure)
    queued = []
    publishedCount = projection.snapshot().count
  } catch (error) {
    unsubscribe()
    throw error
  }

  return {
    async snapshot() {
      const count = (await projection?.replay())?.count ?? 0
      publishChanged(count)
      return { undisposedCount: count }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      queued = []
    },
  }
}
