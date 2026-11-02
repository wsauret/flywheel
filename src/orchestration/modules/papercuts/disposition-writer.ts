import { readCapturedFacts, type AsyncGuardedEventAppender, type AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { parsePapercutFact, type PapercutDisposition } from "./facts.js"
import { PAPERCUT_FACT_TYPES, projectPapercutBacklog } from "./backlog.js"
import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"

const PAPERCUT_AGGREGATE_ID = "project:papercuts"

type PapercutDispositionResult = { readonly kind: "disposed" } | { readonly kind: "already-disposed" }

export interface PapercutDispositionWriter {
  dispose(input: {
    readonly recordedFactId: string
    readonly disposition: PapercutDisposition
    readonly disposingSessionId: string
  }): Promise<PapercutDispositionResult>
}

export const papercutDispositionRuntime = moduleRuntimeHandle<PapercutDispositionWriter>("papercuts")
export const papercutDispositionService = moduleServiceHandle<{ writer: PapercutDispositionWriter; dispose(): Promise<void> }>("papercuts")

interface PapercutDispositionWriterDeps {
  readonly store: AsyncEventStateReadSurface
  readonly writer: AsyncGuardedEventAppender
}

/** Appends one terminal disposition under the project papercut aggregate's optimistic sequence guard. */
export function createPapercutDispositionWriter(deps: PapercutDispositionWriterDeps): PapercutDispositionWriter {
  return {
    dispose: async (input) => {
      for (;;) {
        // Capture the guard before history so a disposition committed during the read cannot bypass it.
        const expectedSeq = await deps.store.aggregateSeq(PAPERCUT_AGGREGATE_ID) + 1
        const events = await readCapturedFacts(deps.store, { types: PAPERCUT_FACT_TYPES })
        const targetWasRecorded = events.some((event) => event.id === input.recordedFactId && event.type === "papercut.recorded")
        const targetWasDisposed = events.some((event) => {
          const fact = parsePapercutFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
          return fact.type === "papercut.disposed" && fact.payload.recordedFactId === input.recordedFactId
        })
        if (targetWasDisposed) return { kind: "already-disposed" }
        if (!targetWasRecorded) throw new Error(`Unknown live papercut: ${input.recordedFactId}`)

        const projection = projectPapercutBacklog(events)
        if (!projection.live.some((entry) => entry.recordedFactId === input.recordedFactId)) return { kind: "already-disposed" }
        const result = await deps.writer.appendGuarded({
            aggregateId: PAPERCUT_AGGREGATE_ID,
            type: "papercut.disposed",
            version: 1,
            timestamp: Date.now(),
            actor: "agent",
            sessionId: input.disposingSessionId,
            payload: {
              recordedFactId: input.recordedFactId,
              disposition: input.disposition,
              disposingSessionId: input.disposingSessionId,
            },
            expectedSeq,
        })
        if (result.kind === "stored") return { kind: "disposed" }
      }
    },
  }
}
