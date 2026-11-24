import { expect, spyOn, test } from "bun:test"
import { Log } from "../../../../../src/infra/diagnostics/log.js"
import { createSqliteEventStore } from "../../../../../src/infra/store/sqlite-event-store.js"
import { asAsyncEventWriter, asAsyncEventReadSurface } from "../../../../../src/infra/store/event-store-types.js"
import { createProjectNotificationJournal } from "../../../../../src/orchestration/modules/project-notifications/journal.js"
import { createProjectNotificationPublisher } from "../../../../../src/orchestration/modules/project-notifications/publisher.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const warning = { sourceId: "auth:openai", title: "Authentication needed", message: "Sign in.", severity: "warning" as const, action: { kind: "open-auth" } as const }
const usageWarning = { sourceId: "usage:anthropic", title: "Usage warning", message: "Review usage.", severity: "alert" as const, action: { kind: "open-usage" } as const }

test("publishes local and reconciled facts once in aggregate order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notification-publisher-"))
  const file = join(directory, "events.sqlite")
  const local = createSqliteEventStore(file)
  const external = createSqliteEventStore(file)
  const patches: RuntimeUiPatchInput[] = []
  let tick = () => {}
  const journal = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(local), writer: asAsyncEventWriter(local), sessionId: "local", now: () => 10 })
  const publisher = createProjectNotificationPublisher({
    journal,
    onStored: local.onStored,
    publish: (patch) => patches.push(patch),
    schedule: (reconcile) => { tick = reconcile; return () => {} },
  })
  try {
    const episode = await journal.raise(warning)
    await publisher.settled()
    expect(patches.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised"])
    external.appendGuarded({ aggregateId: "project:notifications", type: "project.notification.dismissed", version: 1, timestamp: 11, actor: "system", sessionId: "external", payload: { sourceId: warning.sourceId, episodeId: episode.id }, expectedSeq: 1 })
    tick()
    tick()
    await publisher.settled()
    expect(patches.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed"])

    // A raise committed through another connection's journal reaches this
    // runtime only when it reconciles, and then its own projection shows it.
    const producer = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(external), writer: asAsyncEventWriter(external), sessionId: "external", now: () => 12 })
    await producer.raise(usageWarning)
    expect(patches.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed"])
    tick()
    await publisher.settled()
    expect(patches.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed", "project_notifications.raised"])
    expect(journal.projection().visible.map((visible) => visible.sourceId)).toEqual([usageWarning.sourceId])
  } finally {
    publisher.closeAdmission()
    await publisher.settled()
    local.close()
    external.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("keeps one failure and a count while reads keep failing, and records each failure episode once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notification-publisher-"))
  const file = join(directory, "events.sqlite")
  const local = createSqliteEventStore(file)
  const external = createSqliteEventStore(file)
  const warn = spyOn(Log.create({ service: "project-notification-publisher" }), "warn").mockImplementation(() => {})
  const patches: RuntimeUiPatchInput[] = []
  let tick = () => {}
  const journal = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(local), writer: asAsyncEventWriter(local), sessionId: "local", now: () => 10 })
  const failure = new TypeError("journal read failed")
  // The first read and the next 100 polls fail.
  let failingReads = 101
  const publisher = createProjectNotificationPublisher({
    journal: { ...journal, reconcile: () => (failingReads-- > 0 ? Promise.reject(failure) : journal.reconcile()) },
    onStored: local.onStored,
    publish: (patch) => patches.push(patch),
    schedule: (reconcile) => { tick = reconcile; return () => {} },
  })
  try {
    for (let poll = 0; poll < 100; poll++) tick()
    const producer = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(external), writer: asAsyncEventWriter(external), sessionId: "external", now: () => 11 })
    await producer.raise(warning)
    await publisher.reconcile()
    failingReads = 1
    tick()
    await expect(publisher.settled()).rejects.toThrow(expect.objectContaining({ message: "Notification publication failed 102 times", cause: failure }))

    expect(patches.map((patch) => patch.payload.kind)).toEqual(["project_notifications.raised"])
    // The recovered publication ends the first episode with its count, so the
    // failure after it records in full again.
    expect(warn.mock.calls).toEqual([
      ["notification publication failed", { errorType: "TypeError" }],
      ["notification publication failures repeated", { count: 100, windowMs: expect.any(Number) }],
      ["notification publication failed", { errorType: "TypeError" }],
    ])
  } finally {
    warn.mockRestore()
    publisher.closeAdmission()
    await publisher.settled().catch(() => {})
    local.close()
    external.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
