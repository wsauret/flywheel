import { expect, spyOn, test } from "bun:test"
import { Log } from "../../../../../src/infra/diagnostics/log.js"
import { createSqliteEventStore } from "../../../../../src/infra/substrate/store/sqlite-event-store.js"
import { asAsyncEventWriter, asAsyncEventReadSurface } from "../../../../../src/infra/substrate/store/event-store-types.js"
import { createProjectNotificationJournal } from "../../../../../src/orchestration/modules/project-notifications/journal.js"
import { createProjectNotificationPublisher } from "../../../../../src/orchestration/modules/project-notifications/publisher.js"
import type { ProjectNotificationPatchPayload } from "../../../../../src/protocol/modules/project-notifications.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const warning = { sourceId: "auth:openai", title: "Authentication needed", message: "Sign in.", severity: "warning" as const, action: { kind: "open-auth" } as const }
const usageWarning = { sourceId: "usage:anthropic", title: "Usage warning", message: "Review usage.", severity: "alert" as const, action: { kind: "open-usage" } as const }

test("hands each subscriber local and reconciled facts once in aggregate order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notification-publisher-"))
  const file = join(directory, "events.sqlite")
  const local = createSqliteEventStore(file)
  const external = createSqliteEventStore(file)
  const patches: ProjectNotificationPatchPayload[] = []
  let tick = () => {}
  const journal = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(local), writer: asAsyncEventWriter(local), sessionId: "local", now: () => 10 })
  const publisher = createProjectNotificationPublisher({
    journal,
    onStored: local.onStored,
    schedule: (reconcile) => { tick = reconcile; return () => {} },
  })
  publisher.subscribe((payload) => patches.push(payload))
  try {
    const episode = await journal.raise(warning)
    await publisher.settled()
    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised"])
    external.appendGuarded({ aggregateId: "project:notifications", type: "project.notification.dismissed", version: 1, timestamp: 11, actor: "system", sessionId: "external", payload: { sourceId: warning.sourceId, episodeId: episode.id }, expectedSeq: 1 })
    tick()
    tick()
    await publisher.settled()
    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed"])

    // A raise committed through another connection's journal reaches this
    // runtime only when it reconciles, and then its own projection shows it.
    const producer = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(external), writer: asAsyncEventWriter(external), sessionId: "external", now: () => 12 })
    await producer.raise(usageWarning)
    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed"])
    tick()
    await publisher.settled()
    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised", "project_notifications.dismissed", "project_notifications.raised"])
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
  const patches: ProjectNotificationPatchPayload[] = []
  let tick = () => {}
  const journal = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(local), writer: asAsyncEventWriter(local), sessionId: "local", now: () => 10 })
  const failure = new TypeError("journal read failed")
  // The first catch-up succeeds, and the next 101 polls fail.
  let caughtUp = false
  let failingReads = 101
  const publisher = createProjectNotificationPublisher({
    journal: { ...journal, reconcile: () => (caughtUp && failingReads-- > 0 ? Promise.reject(failure) : journal.reconcile().finally(() => { caughtUp = true })) },
    onStored: local.onStored,
    schedule: (reconcile) => { tick = reconcile; return () => {} },
  })
  publisher.subscribe((payload) => patches.push(payload))
  try {
    await publisher.settled()
    for (let poll = 0; poll < 101; poll++) tick()
    const producer = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(external), writer: asAsyncEventWriter(external), sessionId: "external", now: () => 11 })
    await producer.raise(warning)
    await publisher.reconcile()
    failingReads = 1
    tick()
    await expect(publisher.settled()).rejects.toThrow(expect.objectContaining({ message: "Notification publication failed 102 times", cause: failure }))

    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised"])
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

// A project that starts to show a profile the host held no journal of reads
// that profile's history from its snapshot, so the catch-up repeats none of
// it as patches.
test("the first catch-up of retained history publishes nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notification-publisher-"))
  const store = createSqliteEventStore(join(directory, "events.sqlite"))
  const writer = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), sessionId: "writer", now: () => 10 })
  await writer.raise(warning)
  await writer.resolve(warning.sourceId)
  const patches: ProjectNotificationPatchPayload[] = []
  const journal = createProjectNotificationJournal({ aggregateId: "project:notifications", reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), sessionId: "local", now: () => 10 })
  const publisher = createProjectNotificationPublisher({ journal, onStored: store.onStored, schedule: () => () => {} })
  publisher.subscribe((payload) => patches.push(payload))
  try {
    await publisher.reconcile()
    expect(patches).toEqual([])
    expect(journal.projection().episodes).toHaveLength(1)
    await journal.raise(usageWarning)
    await publisher.settled()
    expect(patches.map((payload) => payload.kind)).toEqual(["project_notifications.raised"])
  } finally {
    publisher.closeAdmission()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
