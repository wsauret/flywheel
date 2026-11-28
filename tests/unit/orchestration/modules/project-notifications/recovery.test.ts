import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { recoverNotificationStore, recoverProjectNotificationHistory } from "../../../../../src/orchestration/modules/project-notifications/recovery.js"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("project notification recovery", () => {
  it("discards malformed notification history so a new aggregate starts cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-notification-recovery-"))
    tempRoots.push(root)
    const dbFile = join(root, ".flywheel", "flywheel.sqlite")
    const store = createSqliteEventStore(dbFile)
    store.append({
      aggregateId: "project:notifications",
      type: "project.notification.raised",
      version: 1,
      timestamp: 1_000,
      actor: "system",
      sessionId: "project-notifications",
      payload: {
        sourceId: "runtime:config-warning",
        title: "Configuration needs attention",
        message: "Open Settings.",
        severity: "warning",
        action: null,
        createdAt: 1_000,
        expiresAt: 1_000 + 48 * 60 * 60 * 1_000,
      },
    })
    store.close()

    expect(recoverProjectNotificationHistory(dbFile, "project:notifications")).toEqual({ discardedFacts: 1 })

    const recovered = createSqliteEventStore(dbFile)
    expect(recovered.countByAggregate("project:notifications")).toBe(0)
    expect(recovered.aggregateSeq("project:notifications")).toBe(-1)
    recovered.close()
  })

  // A standalone host keeps its profiles' notifications in the project store,
  // so its startup recovery covers them with the project's own.
  it("retires each malformed aggregate of a store at startup and keeps the sound ones", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-notification-recovery-"))
    tempRoots.push(root)
    const dbFile = join(root, "flywheel.sqlite")
    const store = createSqliteEventStore(dbFile)
    const raised = (aggregateId: string, expiresAfter: number) => store.append({
      aggregateId,
      type: "project.notification.raised",
      version: 1,
      timestamp: 1_000,
      actor: "system",
      sessionId: "project-notifications",
      payload: { sourceId: "runtime:auth-attention:personal:file", title: "Authentication file needs attention", message: "Repair it.", severity: "warning", action: { kind: "open-auth" }, createdAt: 1_000, expiresAt: 1_000 + expiresAfter },
    })
    raised("project:notifications", 48 * 60 * 60 * 1_000)
    raised("profile:personal:notifications", 1)
    store.close()

    expect(recoverNotificationStore(dbFile)).toEqual({ discardedFacts: 1 })

    const recovered = createSqliteEventStore(dbFile)
    expect(recovered.countByAggregate("project:notifications")).toBe(1)
    expect(recovered.countByAggregate("profile:personal:notifications")).toBe(0)
    recovered.close()
  })

  // Bytes that do not decode never block startup or a profile journal's open.
  it("retires an aggregate whose payload does not decode", () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-notification-recovery-"))
    tempRoots.push(root)
    const dbFile = join(root, "flywheel.sqlite")
    const store = createSqliteEventStore(dbFile)
    for (const aggregateId of ["project:notifications", "profile:personal:notifications"]) store.append({
      aggregateId,
      type: "project.notification.raised",
      version: 1,
      timestamp: 1_000,
      actor: "system",
      sessionId: "project-notifications",
      payload: { sourceId: "runtime:config-warning", title: "Configuration needs attention", message: "Open Settings.", severity: "warning", createdAt: 1_000, expiresAt: 1_000 + 48 * 60 * 60 * 1_000 },
    })
    store.close()
    const db = new Database(dbFile)
    db.run("update event set payload = '{{broken' where aggregate_id = 'profile:personal:notifications'")
    db.close()

    expect(recoverProjectNotificationHistory(dbFile, "profile:personal:notifications")).toEqual({ discardedFacts: 1 })
    const again = new Database(dbFile)
    again.run("update event set payload = '{{broken' where aggregate_id = 'project:notifications'")
    again.close()
    expect(recoverNotificationStore(dbFile)).toEqual({ discardedFacts: 1 })

    const recovered = createSqliteEventStore(dbFile)
    expect(recovered.countByAggregate("project:notifications")).toBe(0)
    expect(recovered.countByAggregate("profile:personal:notifications")).toBe(0)
    recovered.close()
  })
})
