import { createOrderedLane } from "../../infra/ordered-lane.js"
import type { SessionToolSummaryReader, SessionToolSummarySnapshot, ToolHistorySummary } from "../module-seams.js"

interface PendingHistoryUpdate {
  position: number
  readonly changes: Map<string, ToolHistorySummary | undefined>
}
interface OwnedSummary {
  readonly owner: number
  readonly summary: ToolHistorySummary
}

/** Merge installed owners' retained histories. A replay publishes all owners'
 * deltas together after validating exclusive ownership. Failed replays retain
 * admitted deltas because a source may consume its changed ids on the next read.
 * Stable reads visit owners only; advancing reads visit only changed tool ids.
 * Disposing it disposes every owner's reader. */
export function createModuleToolHistoryReader(readers: readonly SessionToolSummaryReader[]): Required<SessionToolSummaryReader> {
  const summaries = new Map<string, ToolHistorySummary>()
  const owners = new Map<string, number>()
  const positions = new Map<number, number>()
  // The latest snapshot of each owner, whose measurement states its runs.
  const measures = new Map<number, SessionToolSummarySnapshot["measure"]>()
  const pending = new Map<number, PendingHistoryUpdate>()
  let position = 0
  // Each replay reports the changes since the replay before it, so every call
  // runs its own replay in order and no caller joins another caller's replay.
  const replays = createOrderedLane()
  const replay = async (): Promise<SessionToolSummarySnapshot> => {
    for (const [index, source] of readers.entries()) {
      const snapshot = await source.replay()
      measures.set(index, snapshot.measure)
      const admitted = pending.get(index)
      const previous = admitted?.position ?? positions.get(index)
      if (previous === snapshot.position) continue
      if (previous !== undefined && snapshot.position < previous) throw new Error("Module history position moved backwards")
      const update = admitted ?? { position: snapshot.position, changes: new Map<string, ToolHistorySummary | undefined>() }
      const ids = previous === undefined ? snapshot.summaries.keys() : snapshot.changedToolUseIds
      for (const id of ids) update.changes.set(id, snapshot.summaries.get(id))
      update.position = snapshot.position
      pending.set(index, update)
    }
    const changedToolUseIds = new Set<string>()
    const changes = new Map<string, OwnedSummary | undefined>()
    // Resolve removals before claims so ownership transfers are independent of
    // catalog order. No published map or cursor changes until all claims agree.
    for (const [index, update] of pending) {
      for (const id of update.changes.keys()) {
        changedToolUseIds.add(id)
        if (owners.get(id) === index) changes.set(id, undefined)
      }
    }
    for (const [index, update] of pending) {
      for (const [id, summary] of update.changes) {
        if (summary === undefined) continue
        const owner = changes.has(id) ? changes.get(id)?.owner : owners.get(id)
        if (owner !== undefined) throw new Error(`More than one module owns tool history ${id}`)
        changes.set(id, { owner: index, summary })
      }
    }
    for (const [id, value] of changes) {
      if (value) { owners.set(id, value.owner); summaries.set(id, value.summary) }
      else { owners.delete(id); summaries.delete(id) }
    }
    for (const [index, update] of pending) {
      position += update.position - (positions.get(index) ?? 0)
      positions.set(index, update.position)
    }
    pending.clear()
    return { position, summaries, changedToolUseIds, measure }
  }
  /** Each summary is measured by the owner that published it. */
  async function measure(summary: ToolHistorySummary, live?: boolean): Promise<ToolHistorySummary> {
    const owner = owners.get(summary.toolUseId)
    const ownerMeasure = owner === undefined ? undefined : measures.get(owner)
    return ownerMeasure ? ownerMeasure(summary, live) : summary
  }
  return {
    replay: () => replays.run(replay),
    dispose: () => { for (const reader of readers) reader.dispose?.() },
  }
}
