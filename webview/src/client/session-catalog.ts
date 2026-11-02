import type { RuntimeExecutorState, RuntimeServiceState, SessionCatalogError, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createFamilyIntake } from "../../../src/protocol/client/family-intake.js"
import { mergeCatalogRow } from "../../../src/protocol/client/known-totals.js"
import { sessionCursor, workspaceDomainCursor, type RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"

/** The session catalog as the client holds it: one row per session, fed by
 *  the `session` domain's ordered patches and rebuilt from a snapshot when a
 *  cursor cannot be trusted.
 *
 *  The rows are folded from the patches rather than re-read on each one,
 *  because a snapshot and a patch do not say the same thing. The snapshot is
 *  metadata-only for a session with no live runtime; its line counts, cost, and
 *  duration arrive later, as a `session.updated` patch the background warm
 *  publishes. A client that answered every patch with a fresh snapshot threw
 *  those counts away the moment they arrived, so no closed session ever showed
 *  what it changed. Folding keeps them, and a snapshot rebuild overlays what it
 *  carries on what the client already holds. The ordering, the family baseline
 *  a session created after a read anchors at, and recovery are the shared
 *  family intake's; this file owns the fold only. */
export interface SessionCatalog {
  readonly rows: readonly SessionCatalogRow[]
  /** Sessions whose metadata cannot be read. Never rows: no kind or lifecycle
   *  is known for them. */
  readonly errors: readonly SessionCatalogError[]
  /** True while the catalog records the session, as a row or as an error.
   *  A session whose metadata cannot be read still exists, so a row that
   *  becomes an error is not a delete. */
  records(sessionId: string): boolean
  readonly projectRoot: string | undefined
  readonly runtimeVersion: string | undefined
  /** The runtime's build identifier; null when it names none, undefined before the first snapshot. */
  readonly runtimeBuildId: string | null | undefined
  /** What the runtime states about the process that runs the project's sessions. */
  readonly executor: RuntimeExecutorState
  /** What the runtime states about the account service that serves the project. */
  readonly service: RuntimeServiceState
  /** One authoritative read, for a fresh connection, a lost cursor, or right
   *  after a mutation whose patch is still on its way. A request while a read
   *  is in flight joins it: the patch that follows the mutation carries a
   *  position past the read's, so it lands on top of what the read answers. */
  resnapshot(): Promise<void>
  /** Hands one patch from the `session` cursor family or the `executor` or
   *  `service` workspace cursor to its receiver. */
  accept(patch: RuntimeUiPatch): void
  onChange(listener: () => void): () => void
  dispose(): void
}

export interface SessionCatalogOptions {
  readonly connection: RuntimeConnection
}

const SCOPE = "sessions"

export function createSessionCatalog(options: SessionCatalogOptions): SessionCatalog {
  const listeners = new Set<() => void>()
  let byId = new Map<string, SessionCatalogRow>()
  let rows: readonly SessionCatalogRow[] = []
  let errors: readonly SessionCatalogError[] = []
  let projectRoot: string | undefined
  let runtimeVersion: string | undefined
  let runtimeBuildId: string | null | undefined
  let executor: RuntimeExecutorState = { kind: "serving" }
  let service: RuntimeServiceState = { kind: "serving" }

  const publish = (): void => {
    rows = [...byId.values()]
    for (const listener of listeners) listener()
  }

  const forget = (sessionId: string): void => {
    if (!errors.some((error) => error.sessionId === sessionId)) return
    errors = errors.filter((error) => error.sessionId !== sessionId)
  }

  const intake = createFamilyIntake<typeof SCOPE, Awaited<ReturnType<typeof readSnapshot>>>({
    readTransport: options.connection,
    label: "session catalog",
    accept: (patch) => (patch.cursor.scope === "session" && patch.cursor.domain === "session") || (patch.cursor.scope === "workspace" && (patch.cursor.domain === "executor" || patch.cursor.domain === "service"))
      ? { cursor: patch.cursor, scope: SCOPE }
      : null,
    scopeKey: () => SCOPE,
    globalRecoveryScopes: () => [SCOPE],
    loadSnapshot: () => readSnapshot(),
    applySnapshot(snapshot) {
      const next = new Map<string, SessionCatalogRow>()
      for (const row of snapshot.rows) next.set(row.id, mergeCatalogRow(byId.get(row.id), row))
      byId = next
      errors = snapshot.errors.filter((error) => error.scope === "metadata")
      projectRoot = snapshot.projectRoot
      runtimeVersion = snapshot.runtimeVersion
      runtimeBuildId = snapshot.runtimeBuildId
      executor = snapshot.executor
      service = snapshot.service
      publish()
      return { snapshotPosition: snapshot.snapshotPosition, clearHeld: true, cursors: [...snapshot.rows.map((row) => sessionCursor(row.id)), workspaceDomainCursor("executor"), workspaceDomainCursor("service")] }
    },
    applyPayload(patch) {
      if (patch.payload.kind === "executor.changed") {
        executor = patch.payload.executor
        publish()
        return
      }
      if (patch.payload.kind === "service.changed") {
        service = patch.payload.service
        publish()
        return
      }
      if (patch.cursor.scope !== "session") return
      const sessionId = patch.cursor.sessionId
      if (patch.payload.kind === "session.removed") {
        byId.delete(sessionId)
        forget(sessionId)
        publish()
        return
      }
      if (patch.payload.kind !== "session.added" && patch.payload.kind !== "session.updated") return
      byId.set(sessionId, mergeCatalogRow(byId.get(sessionId), patch.payload.row))
      forget(sessionId)
      publish()
    },
  })

  function readSnapshot() {
    return options.connection.query({ type: "snapshot" })
  }

  return {
    get rows() { return rows },
    get errors() { return errors },
    records: (sessionId) => byId.has(sessionId) || errors.some((error) => error.sessionId === sessionId),
    get projectRoot() { return projectRoot },
    get runtimeVersion() { return runtimeVersion },
    get runtimeBuildId() { return runtimeBuildId },
    get executor() { return executor },
    get service() { return service },
    // A failed read is reported through diagnostics and rejects here; callers
    // await it for ordering, so the rejection is not theirs to handle twice.
    resnapshot: () => intake.resnapshot(SCOPE).catch(() => {}),
    accept(patch) { intake.handle({ type: "patch", patch }) },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      intake.dispose()
      listeners.clear()
    },
  }
}
