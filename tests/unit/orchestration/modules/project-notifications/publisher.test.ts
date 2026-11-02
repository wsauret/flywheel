import { expect, test } from "bun:test"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventAppender, asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { createProjectNotificationJournal } from "../../../../../src/orchestration/modules/project-notifications/journal.js"
import { createProjectNotificationPublisher } from "../../../../../src/orchestration/modules/project-notifications/publisher.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
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
  const journal = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(local), writer: asAsyncEventAppender(local), sessionId: "local", now: () => 10 })
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
    const producer = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(external), writer: asAsyncEventAppender(external), sessionId: "external", now: () => 12 })
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
