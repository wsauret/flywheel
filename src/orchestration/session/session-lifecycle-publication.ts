import type { AsyncEventStateReadSurface, AsyncEventWriter, GuardedAppendResult, GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { ensureSessionDir } from "../../infra/paths.js"
import { pruneSupersededWorkflowViewFacts } from "../../workflows/view/view-store.js"
import { removeOwnerPid, writeOwnerPid } from "./pid-lock.js"
import { pruneSupersededFileReviewFacts } from "./session-change-review.js"
import { buildSessionMetadataAppend, type LifecycleTransitionResult } from "./session-metadata-store.js"
import type { ReplayedSession } from "./schemas.js"
import type { SessionLifecycleState } from "./types.js"

const log = Log.create({ service: "session.manager" })

interface SessionLifecycleMetadata {
  transitionLifecycle(id: string, to: SessionLifecycleState): Promise<LifecycleTransitionResult>
  appendGuardedFacts(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
}

interface SessionLifecyclePublicationDeps {
  readonly projectRoot: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly metadata: SessionLifecycleMetadata
  readonly read: (id: string) => Promise<ReplayedSession | null>
  readonly notifyChanged: (sessionIds: readonly string[]) => void
}

export interface SessionLifecyclePublication {
  readonly updateLifecycleState: (id: string, newState: SessionLifecycleState) => Promise<void>
  readonly publishActivation: (id: string, facts: readonly GuardedEventStoreAppend[]) => Promise<void>
}

/** Owns lifecycle publication, including atomic activation facts, the process-local owner marker, close maintenance, and catalog change signals. */
export function createSessionLifecyclePublication(deps: SessionLifecyclePublicationDeps): SessionLifecyclePublication {
  function installOwner(id: string): void {
    ensureSessionDir(id, deps.projectRoot)
    writeOwnerPid(id, deps.projectRoot)
  }

  async function maintainClosedSession(id: string): Promise<void> {
    removeOwnerPid(id, deps.projectRoot)
    // Pruning is best-effort: a failure must not reverse a committed lifecycle
    // transition. Superseded rows remain safe and the next close retries.
    try {
      await pruneSupersededWorkflowViewFacts(deps.reader, deps.writer, id)
    } catch (err) {
      log.warn("workflow view prune on close failed", { sessionId: id, error: err instanceof Error ? err.message : String(err) })
    }
    try {
      await pruneSupersededFileReviewFacts(deps.writer, id)
    } catch (err) {
      log.warn("file review prune on close failed", { sessionId: id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function updateLifecycleState(id: string, newState: SessionLifecycleState): Promise<void> {
    const result = await deps.metadata.transitionLifecycle(id, newState)
    switch (result.kind) {
      case "missing":
        throw new Error(`Session not found: ${id}`)
      case "invalid":
        throw new Error(`Invalid state transition: ${result.from} -> ${result.to}`)
      case "noop":
        // A hard-killed owner leaves active metadata with a dead owner.pid.
        // Reactivation must still transfer the ephemeral owner marker.
        if (newState === "active") installOwner(id)
        return
      case "transitioned":
        if (newState === "active") installOwner(id)
        else if (newState === "inactive") await maintainClosedSession(id)
        deps.notifyChanged([id])
        return
    }
  }

  /** A caller whose activation rests on a read of the session guards its
   *  first fact with the sequence that read saw; the batch continues from it,
   *  so any commit after that read refuses the activation. Without that guard
   *  the batch continues from the sequence read here. */
  async function publishActivation(id: string, facts: readonly GuardedEventStoreAppend[]): Promise<void> {
    const existing = await deps.read(id)
    if (!existing) throw new Error(`Session not found: ${id}`)
    if (existing.lifecycleState !== "inactive") {
      throw new Error(`Invalid state transition: ${existing.lifecycleState} -> active`)
    }
    const firstExpectedSeq = facts[0]?.expectedSeq ?? await deps.reader.aggregateSeq(`session:${id}`) + 1
    const now = new Date().toISOString()
    const result = await deps.metadata.appendGuardedFacts([
      ...facts.map((fact, index) => ({ ...fact, expectedSeq: firstExpectedSeq + index })),
      {
        ...buildSessionMetadataAppend(id, {
          type: "session.lifecycle.changed",
          version: 1,
          actor: "flywheel",
          payload: { lifecycleState: "active", activatedAt: now, lastUpdated: now },
        }),
        expectedSeq: firstExpectedSeq + facts.length,
      },
    ])
    if (result.kind === "conflict") throw new Error(`Session ${id} changed during activation`, { cause: result.conflict })
    installOwner(id)
    deps.notifyChanged([id])
  }

  return { updateLifecycleState, publishActivation }
}
