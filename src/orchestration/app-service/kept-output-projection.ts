import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import type { CommandKeeper, KeptOutputChange } from "./command-keeper.js"
import type { OutputSequence } from "./output-sequence.js"
import { projectFrontendOutputBlock } from "./frontend-output-blocks.js"
import type { ProjectedBlockChange, ShippedOutput } from "./shipped-output.js"

const log = Log.create({ service: "kept-output-projection" })

export interface KeptOutputProjectionDeps {
  readonly keeper: Pick<CommandKeeper, "onLiveOutput" | "drainLiveOutput" | "liveOutput">
  /** Includes the durable final block for every settlement notified before this read. */
  readonly readSequence: (sessionId: string) => Promise<OutputSequence | null>
  readonly projectSettled: (sessionId: string, change: Extract<KeptOutputChange, { kind: "settled" }>) => void
  /** The owner of what the session's clients hold, shared with the session
   *  store's output projection. */
  readonly shipped: Pick<ShippedOutput, "ship" | "forget" | "watches">
}

/** Publishes keeper growth and replaces settled tails with final blocks in the
 *  same delta. The keeper's tails are the whole streaming map it ships: a
 *  runner that takes a kept command receives its tail, and the keeper releases
 *  it, so no tool is in both maps. Disposal stops pending reads from publishing. */
export function createKeptOutputProjection(deps: KeptOutputProjectionDeps) {
  let disposed = false
  const pending = new Map<string, Set<string>>()
  const unsubscribe = deps.keeper.onLiveOutput((sessionId, change) => {
    if (disposed) return
    const existing = pending.get(sessionId)
    const settled = existing ?? new Set<string>()
    if (change.kind === "settled") {
      deps.projectSettled(sessionId, change)
      settled.add(change.toolUseId)
    }
    if (existing) return
    pending.set(sessionId, settled)
    void Promise.resolve().then(async () => {
      if (disposed) return
      // No client follows the session: its read after a watch holds what
      // this pass drains, so nothing is read, projected, or shipped.
      if (!deps.shipped.watches(sessionId)) {
        deps.keeper.drainLiveOutput(sessionId)
        pending.delete(sessionId)
        return
      }
      if (settled.size === 0) {
        const changedTools = deps.keeper.drainLiveOutput(sessionId)
        pending.delete(sessionId)
        deps.shipped.ship(sessionId, { streamingToolText: deps.keeper.liveOutput(sessionId), changedTools })
        return
      }
      let sequence: OutputSequence | null
      let blocks: ProjectedBlockChange[]
      let count: number
      do {
        if (disposed) return
        count = settled.size
        sequence = await deps.readSequence(sessionId)
        if (disposed || !sequence) return
        const current = sequence
        blocks = await Promise.all(Array.from(settled, async (toolUseId) => {
          const direct = current.indexOf(`tool:${toolUseId}`)
          const index = direct === -1 ? current.indexOfEntry(toolUseId) : direct
          const block = projectFrontendOutputBlock(await current.readBlock(index))
          return { kind: "upsert" as const, index, blockId: blockIdentity(block), block }
        }))
        if (disposed) return
        // A settlement during either read can queue a removal against an
        // older sequence. Re-read before draining so its final block ships
        // with it. No await separates this check from the drain below, so a
        // later settlement finds no pending pass and starts its own.
      } while (count !== settled.size)
      const changedTools = deps.keeper.drainLiveOutput(sessionId)
      pending.delete(sessionId)
      const streamingToolText = deps.keeper.liveOutput(sessionId)
      deps.shipped.ship(sessionId, {
        visibleMessageCount: sequence.visibleMessageCount,
        blockCount: sequence.blockCount,
        blocks: { kind: "changes", changes: blocks },
        streamingToolText,
        changedTools,
      })
      // The session's last kept command settled, so the copies of its final
      // blocks are released. A runner that holds the session still publishes
      // correctly, because a change without a copy ships whole.
      if (Object.keys(streamingToolText).length === 0) deps.shipped.forget(sessionId)
    }).catch((err: unknown) => {
      log.warn("a kept command's live output could not be published", { sessionId, error: errorMessage(err) })
    }).finally(() => { if (pending.get(sessionId) === settled) pending.delete(sessionId) })
  })
  return {
    dispose() {
      disposed = true
      unsubscribe()
      pending.clear()
    },
  }
}
