import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { recoverProjectNotificationHistory } from "../../../../../src/orchestration/modules/project-notifications/recovery.js"

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

    expect(recoverProjectNotificationHistory(dbFile)).toEqual({ discardedFacts: 1 })

    const recovered = createSqliteEventStore(dbFile)
    expect(recovered.countByAggregate("project:notifications")).toBe(0)
    expect(recovered.aggregateSeq("project:notifications")).toBe(-1)
    recovered.close()
  })
})
