import type { ProjectDirectories } from "../../../../src/infra/directory-authorities.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createRuntimeEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createProjectStateClient } from "../../../../src/orchestration/app-service/project-state-client.js"
import { decodeProjectStateRequest, encodeProjectStateResponseFrame, operationUnits, type ProjectStateResponseFrame } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { createProjectStateSessionsService } from "../../../../src/orchestration/app-service/project-state-sessions.js"
import { createProjectStateService } from "../../../../src/orchestration/app-service/project-state-worker.js"
import { retireRecordedFinalizedToolResultCheckpointPage } from "../../../../src/orchestration/migrations/finalized-tool-result-checkpoints.js"
import { deleteRetiredFamilyChunk, deleteSupersededStep, dropRetiredEventStoreIndexes, incrementalVacuumStep } from "../../../../src/orchestration/session/event-store-maintenance.js"
import { createSessionManager, type SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"

export interface ServedProjectStateOptions {
  /** Lets the writer run maintenance steps on the store. It awaits
   *  `enterCheckpointPage` before each finalized-checkpoint page, so a case
   *  can hold that step. Without this option every maintenance step fails
   *  its request. */
  readonly maintenance?: { readonly enterCheckpointPage: () => Promise<void> }
}

const unexpected = (step: string) => () => { throw new Error(`unexpected ${step}`) }

/** A prepared project whose state is served on this thread as the account
 *  serves it: the store's one writer behind a state client. `requests` lists
 *  the kind of every operation that reached the writer, in order. `close`
 *  closes the client and releases the workspace generation; the caller owns
 *  the directories. */
export function servedProjectState(directories: ProjectDirectories, options: ServedProjectStateOptions = {}) {
  const prepared = prepareWorkspaceState(directories)
  const dbFile = resolveEventStoreDbFile(directories.projectRoot)
  const store = createRuntimeEventStore(dbFile)
  const requests: string[] = []
  let response: ((frame: ProjectStateResponseFrame) => boolean) | undefined
  let stored: ((value: readonly StoredFact[]) => void) | undefined
  let changed: ((value: SessionMetadataChange) => void) | undefined
  const maintenance = options.maintenance
  const service = createProjectStateService({
    reader: store,
    recover: async () => { throw new Error("unexpected recovery") },
    owedRecoveries: () => [],
    settleRecovery: async () => {},
    appendWriteItem: store.writerLane.appendWriteItem,
    pruneSupersededEvents: store.pruneSupersededEvents,
    pruneSupersededKeyedEvents: (aggregate, type, key) => store.pruneSupersededKeyedEvents(aggregate, type, key),
    pruneRetiredFamilyChunk: maintenance ? (eventType) => deleteRetiredFamilyChunk(dbFile, eventType) : unexpected("retired-family prune"),
    dropRetiredIndexes: maintenance ? () => dropRetiredEventStoreIndexes(dbFile).length : unexpected("retired-index drop"),
    pruneSupersededStep: maintenance ? (eventType, positions) => deleteSupersededStep(dbFile, { eventType, positions }) : unexpected("superseded prune"),
    incrementalVacuumStep: maintenance ? (pages) => incrementalVacuumStep(dbFile, pages) : unexpected("incremental vacuum"),
    retireFinalizedCheckpointPage: maintenance
      ? async (plan) => {
        await maintenance.enterCheckpointPage()
        return { kind: "checkpoint-maintenance", ...retireRecordedFinalizedToolResultCheckpointPage(dbFile, plan.afterRowid, plan) }
      }
      : unexpected("checkpoint maintenance"),
    sessions: createProjectStateSessionsService(createSessionManager({ projectRoot: directories.projectRoot, executionCwd: directories.projectRoot, store, writer: store })),
    notifySessionChange: (change) => changed?.(change),
    onStored: store.onStored,
    notifyStored: (events) => stored?.(events),
    close: () => store.close(),
  })
  const state = createProjectStateClient({
    send(request, encoded) {
      const decoded = decodeProjectStateRequest(structuredClone(encoded), request.lane)
      if (!decoded) throw new Error("Invalid state request")
      requests.push(decoded.operation.kind)
      void service.enqueue(decoded.lane, decoded.operation, { bytes: encoded.byteLength, units: operationUnits(decoded.operation) }).then((served) => {
        if (response?.(encodeProjectStateResponseFrame({ id: decoded.id, ...served })) === false) throw new Error("Invalid state response")
      })
    },
    onResponse(listener) { response = listener },
    onClose() {},
    onStored(listener) { stored = listener; return () => { stored = undefined } },
    onSessionChange(listener) { changed = listener; return () => { changed = undefined } },
    close: () => service.close(),
  })
  return {
    state, store, requests,
    async close() { await state.close(); prepared.generation.release() },
  }
}
