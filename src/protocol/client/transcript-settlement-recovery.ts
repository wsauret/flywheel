import type { RuntimePosition } from "../runtime-ui-protocol-types.js"
import type { OutputRangeAnchor } from "../transcript-protocol-types.js"

/** Coalesces settlement requirements over serialized resident-window reads.
 * Numeric requirements use anchored coverage; opaque barriers need a fresh
 * tail proof, which never replaces a detached reader's presentation. */
export function createTranscriptSettlementRecovery<Window extends { readonly settlementRecovery: string | undefined }>(options: {
  readonly disposed: () => boolean
  readonly atTail: () => boolean
  readonly appliedOutputPosition: () => RuntimePosition | null
  readonly enqueue: (operation: () => Promise<void>) => Promise<void>
  readonly anchor: () => OutputRangeAnchor
  readonly accepts: (window: Window) => boolean
  readonly reset: () => void
  readonly read: (anchor: OutputRangeAnchor, purpose: "window" | "proof") => Promise<Window | undefined>
  readonly install: (window: Window, reason?: "merge") => void
  readonly merge: (window: Window) => boolean
  readonly changed: () => void
}) {
  let requested: string | RuntimePosition | undefined
  let covered: string | undefined
  let pending = false

  return {
    get requestedBarrier() { return typeof requested === "string" ? requested : undefined },
    get coveredBarrier() { return covered },
    recordTailProof(barrier: string | undefined) { covered = barrier },
    dispose() { requested = undefined; covered = undefined },
    recover(nextRequirement: string | RuntimePosition): void {
      if (options.disposed() || nextRequirement === requested) return
      requested = nextRequirement
      if (pending) return
      pending = true
      void options.enqueue(async () => {
        try {
          for (;;) {
            const requirement = requested
            if (options.disposed() || requirement === undefined) return
            const position = options.appliedOutputPosition()
            if (typeof requirement === "string"
              ? requirement === covered
              : position !== null && position >= requirement) return
            const anchor = options.anchor()
            const anchored = anchor.kind === "residentSpan"
            const attached = options.atTail() && !anchored
            if (attached || anchored) options.reset()
            let tail = await options.read(anchor, attached || anchored ? "window" : "proof")
            if (!tail) return
            if (!options.accepts(tail)) continue
            if (anchored) {
              options.install(tail, "merge")
              if (typeof requirement !== "string") {
                if (requested === requirement) return
                continue
              }
              tail = await options.read({ kind: "tail" }, "proof")
              if (!tail) return
            }
            if (!attached || !options.atTail()) {
              covered = tail.settlementRecovery
              options.changed()
              if (requested === requirement) return
              continue
            }
            if (!options.merge(tail)) options.install(tail)
            if (requested === requirement) return
          }
        } finally { pending = false }
      })
    },
  }
}
