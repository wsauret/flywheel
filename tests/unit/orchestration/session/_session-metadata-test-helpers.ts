import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { ensureSessionDir, resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { deleteSessionArtifacts } from "../../../../src/orchestration/session/session-artifacts.js"
import { buildSessionMetadataAppend, createSessionMetadataStore } from "../../../../src/orchestration/session/session-metadata-store.js"
import type { ReplayedSession, Session } from "../../../../src/orchestration/session/schemas.js"

export function makeMetadataStore(
  baseDir: string,
  store: EventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir)),
): ReturnType<typeof createSessionMetadataStore> {
  return createSessionMetadataStore({
    reader: asAsyncEventReadSurface(store),
    writer: asAsyncEventWriter(store),
  })
}

export async function createStoredSession(data: Session, baseDir: string, id?: string, store?: EventStore): Promise<string> {
  const ownedStore = store ?? createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  const metadata = makeMetadataStore(baseDir, ownedStore)
  try {
    const sessionId = id ?? metadata.allocateId()
    ensureSessionDir(sessionId, baseDir)
    return await metadata.create(data, sessionId)
  } finally {
    if (!store) ownedStore.close()
  }
}

export async function readStoredSession(id: string, baseDir: string, store?: EventStore): Promise<ReplayedSession | null> {
  const ownedStore = store ?? createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  try {
    return await makeMetadataStore(baseDir, ownedStore).read(id)
  } finally {
    if (!store) ownedStore.close()
  }
}

export async function listStoredSessions(baseDir: string, store?: EventStore): Promise<readonly { id: string; data: ReplayedSession }[]> {
  const ownedStore = store ?? createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  try {
    return (await makeMetadataStore(baseDir, ownedStore).list()).entries
  } finally {
    if (!store) ownedStore.close()
  }
}

/** Mirrors SessionManager.delete in miniature: the unconditional
 *  `session.deleted` tombstone through the metadata store's transactional
 *  append, then artifact removal. */
export async function deleteStoredSession(id: string, baseDir: string, store?: EventStore): Promise<void> {
  const ownedStore = store ?? createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  try {
    await makeMetadataStore(baseDir, ownedStore).appendFacts([buildSessionMetadataAppend(id, {
      type: "session.deleted",
      version: 1,
      actor: "flywheel",
      payload: { lastUpdated: new Date().toISOString() },
    })])
  } finally {
    if (!store) ownedStore.close()
  }
  deleteSessionArtifacts(id, baseDir)
}

export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12)
}
