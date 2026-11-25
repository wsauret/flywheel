import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreReadSurface, type FactQuery } from "../../../../../../src/infra/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../../src/infra/store/sqlite-event-store.js"
import { createSessionManager } from "../../../../../../src/orchestration/session/manager.js"
import { testDirectories } from "../../../../../helpers/directories.js"

export const cleanup: (() => void | Promise<void>)[] = []

/** Closes and removes the fixtures of the case that just ran. Each test file
 *  that imports this module registers it with its own `afterEach`, because a
 *  hook registered here at module load would bind only to the first file that
 *  loaded the module. */
export async function closeFixtures(): Promise<void> {
  for (const dispose of cleanup.splice(0)) await dispose()
}

/** A project store whose reader refuses a fold of the full session metadata
 *  family, which recovery never needs. */
export function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "project-state-recovery-"))
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const writer = asAsyncEventWriter(store)
  const localReader: EventStoreReadSurface = {
    ...store,
    read(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("recovery must not fold the full session metadata family")
      }
      return store.read(query)
    },
    readTolerant(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("recovery must not fold the full session metadata family")
      }
      return store.readTolerant(query)
    },
  }
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, projectionReader: asAsyncEventReadSurface(localReader), writer })
  const reader = asAsyncEventReadSurface(localReader)
  cleanup.push(() => { store.close(); rmSync(projectRoot, { recursive: true, force: true }) })
  return { projectRoot, store, reader, writer, manager, directories: testDirectories(projectRoot) }
}
