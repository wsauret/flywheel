import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectStateScheduler, createProjectStateService } from "../../../../src/orchestration/app-service/project-state-worker.js"
import { decodeProjectStateRequest, encodeProjectStateRequest, encodeProjectStateResponseFrame, operationUnits, type ProjectStateLane, type ProjectStateOperation, type ProjectStateResponseFrame, type ProjectStateResult } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { createProjectStateClient } from "../../../../src/orchestration/app-service/project-state-client.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreReadSurface, type FactQuery, type StoredFact } from "../../../../src/infra/event-store-types.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { deleteRetiredFamilyChunk, dropRetiredEventStoreIndexes } from "../../../../src/orchestration/session/event-store-maintenance.js"
import { testDirectories } from "../../../helpers/directories.js"
import { openProjectState, recoverOwedSessions } from "../../../helpers/project-recovery.js"

export const cleanup: (() => Promise<void>)[] = []

/** Enqueues one operation on a state scheduler or service, admitted at its
 *  encoded size, and answers what was served. */
export function served(target: Pick<ReturnType<typeof createProjectStateScheduler>, "enqueue">, lane: ProjectStateLane, operation: ProjectStateOperation) {
  return target.enqueue(lane, operation, { bytes: encodeProjectStateRequest({ id: 1, lane, operation }).byteLength, units: operationUnits(operation) })
}

export async function enqueue(target: Pick<ReturnType<typeof createProjectStateScheduler>, "enqueue">, lane: ProjectStateLane, operation: ProjectStateOperation): Promise<ProjectStateResult> {
  return (await served(target, lane, operation)).result
}

/** Closes and removes the fixtures of the case that just ran. Each test file
 *  that imports this module registers it with its own `afterEach`, because a
 *  hook registered here at module load would bind only to the first file that
 *  loaded the module. */
export async function closeFixtures(): Promise<void> {
  for (const close of cleanup.splice(0)) await close()
}

export async function fixture(
  observeRecovery: (interruptedSessionIds: readonly string[]) => Promise<void> = async () => {},
  seed: ((input: {
    readonly store: ReturnType<typeof createSqliteEventStore>
    readonly reader: EventStoreReadSurface
    readonly manager: ReturnType<typeof openProjectState>["manager"]
    readonly directory: string
  }) => Promise<void>) | undefined = undefined,
  rejectFullMetadataReads = false,
  startupPredecessorPids: readonly number[] = [],
  options: { readonly commitWindow?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "state-worker-"))
  const path = join(directory, "events.sqlite")
  const store = createSqliteEventStore(path)
  const reader: EventStoreReadSurface = {
    ...store,
    read(query: FactQuery = {}) {
      if (rejectFullMetadataReads && !query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("state worker must not fold the full session metadata family")
      }
      return store.read(query)
    },
    readTolerant(query: FactQuery = {}) {
      if (rejectFullMetadataReads && !query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("state worker must not fold the full session metadata family")
      }
      return store.readTolerant(query)
    },
  }
  const writer = asAsyncEventWriter(store)
  const writerLane = createEventStoreWriterLane(store)
  const directories = testDirectories(directory)
  const state = openProjectState({ directories, reader: asAsyncEventReadSurface(reader), writer, predecessorPids: startupPredecessorPids })
  const { manager, sessions } = state
  await seed?.({ store, reader, manager, directory })
  await recoverOwedSessions(state, "ownerless")
  const sessionListeners = new Set<(change: SessionMetadataChange) => void>()
  const storedNotifications: (readonly StoredFact[])[] = []
  let stagingError: Error | undefined
  let stagingGate: Promise<void> | undefined
  const storedListeners = new Set<(events: readonly StoredFact[]) => void>()
  const detachListeners = new Set<() => void>()
  const closeListeners = new Set<(reason: string) => void>()
  let dropNextStored = false
  let failNextStored = false
  const service = createProjectStateService({
    reader,
    recover: async (interruptedSessionIds) => {
      await recoverOwedSessions(state, "closed-generation", interruptedSessionIds)
      await observeRecovery(interruptedSessionIds)
    },
    owedRecoveries: () => [],
    settleRecovery: async () => {},
    appendWriteItem: async (item) => {
      if (item.sessionContentNodes) await stagingGate
      if (item.sessionContentNodes && stagingError) throw new Error(stagingError.message, { cause: stagingError })
      return writerLane.appendWriteItem(item)
    },
    pruneSupersededEvents: (...args) => store.pruneSupersededEvents(...args),
    pruneSupersededKeyedEvents: (...args) => store.pruneSupersededKeyedEvents(...args),
    pruneRetiredFamilyChunk: (eventType) => deleteRetiredFamilyChunk(path, eventType),
    dropRetiredIndexes: () => dropRetiredEventStoreIndexes(path).length,
    retireFinalizedCheckpointPage: async (plan) => ({
      kind: "checkpoint-maintenance",
      ...(await import("../../../../src/orchestration/migrations/finalized-tool-result-checkpoints")).retireRecordedFinalizedToolResultCheckpointPage(path, plan.afterRowid, plan),
    }),
    sessions,
    notifySessionChange: (change) => { for (const listener of sessionListeners) listener(change) },
    onStored: store.onStored,
    notifyStored: (events) => {
      if (failNextStored) {
        failNextStored = false
        throw new Error("port closed")
      }
      storedNotifications.push(events)
      if (dropNextStored) {
        dropNextStored = false
        return
      }
      for (const listener of storedListeners) listener(structuredClone(events))
    },
    close: async () => {
      await writerLane.dispose()
      store.close()
    },
  })
  let receive: ((frame: ProjectStateResponseFrame) => boolean) | undefined
  const client = createProjectStateClient({
    send(request, encoded) {
      const decoded = decodeProjectStateRequest(structuredClone(encoded), request.lane)
      if (!decoded) throw new Error("invalid request")
      void service.enqueue(decoded.lane, decoded.operation, { bytes: encoded.byteLength, units: operationUnits(decoded.operation) }).then((answer) => {
        if (receive?.(encodeProjectStateResponseFrame({ id: request.id, ...answer })) === false) throw new Error("invalid response")
      })
    },
    onResponse(listener) { receive = listener },
    onClose(listener) { closeListeners.add(listener) },
    onSessionChange(listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    onStored(listener) { storedListeners.add(listener); return () => { storedListeners.delete(listener) } },
    onDetach(listener) { detachListeners.add(listener) },
    close: () => service.close(),
  }, { commitWindow: options.commitWindow })
  cleanup.push(async () => {
    try { await client.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  return { store, reader, manager, service, client, path, directory, storedNotifications,
    failContentStaging(error: Error) { stagingError = error },
    /** Holds every evidence staging, and so the commit notification that
     *  stages, until `gate` settles. */
    holdContentStaging(gate: Promise<void>) { stagingGate = gate },
    /** Loses the next commit notification on its way to the client. */
    dropNextStored() { dropNextStored = true },
    /** Fails the next commit notification as it is sent. */
    failNextStored() { failNextStored = true },
    /** Reports a lost transport to the client. */
    detach() { for (const listener of detachListeners) listener() },
    /** Reports a closed transport to the client, which never comes back. */
    closeTransport(reason: string) { for (const listener of closeListeners) listener(reason) },
  }
}
