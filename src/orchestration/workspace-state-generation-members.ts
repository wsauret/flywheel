import { SESSION_ARTIFACT_ROOTS } from "./session/session-artifacts.js"

export const EVENT_STORE_MEMBER = "flywheel.sqlite"

/** Primary state and every rebuildable database belong to one source generation. */
export const DATABASE_MEMBERS = [
  EVENT_STORE_MEMBER,
  "flywheel.sqlite-wal",
  "flywheel.sqlite-shm",
  "session-summary.sqlite",
  "session-summary.sqlite-wal",
  "session-summary.sqlite-shm",
  "conversation-search.sqlite",
  "conversation-search.sqlite-wal",
  "conversation-search.sqlite-shm",
  "projection-folds.sqlite",
  "projection-folds.sqlite-wal",
  "projection-folds.sqlite-shm",
] as const

/** Sidecars that the readonly event-store epoch probe can recreate during SQLite recovery. */
export const DATABASE_SIDECARS = ["flywheel.sqlite-wal", "flywheel.sqlite-shm"] as const

/** Every entry of `.flywheel` that belongs to one state generation. */
export const GENERATION_MEMBERS: readonly string[] = [...DATABASE_MEMBERS, ...SESSION_ARTIFACT_ROOTS]
