import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreAppend, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"
import { createPapercutCountProjection } from "../../../../src/orchestration/modules/papercuts/protocol.js"
import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import { composeModuleProtocolRuntimes } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { papercutsModule } from "../../../../src/orchestration/modules/papercuts.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

const stores: LocalSqliteEventStore[] = []
const directories: string[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function openStores() {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-papercut-projection-"))
  directories.push(directory)
  const file = join(directory, "events.sqlite")
  const primary = createSqliteEventStore(file)
  const secondary = createSqliteEventStore(file)
  stores.push(primary, secondary)
  return { primary, secondary }
}

function recorded(sessionId: string, observation = "Only durable facts own this text"): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`,
    type: "papercut.recorded",
    version: 1,
    timestamp: Date.now(),
    actor: "agent",
    sessionId,
    payload: {
      observation,
      conversationId: `conversation-${sessionId}`,
      modelRequestId: `request-${sessionId}`,
      toolUseId: `tool-${sessionId}`,
    },
  }
}

function disposed(recordedFactId: string): EventStoreAppend {
  return {
    aggregateId: "project:papercuts",
    type: "papercut.disposed",
    version: 1,
    timestamp: Date.now(),
    actor: "agent",
    sessionId: "disposing-session",
    payload: { recordedFactId, disposition: "fixed", disposingSessionId: "disposing-session" },
  }
}

function sink() {
  const sequencer = createRuntimeUiPatchSequencer()
  const patches: RuntimeUiPatch[] = []
  return {
    patches,
    publish(input: RuntimeUiPatchInput): RuntimeUiPatch {
      const patch = sequencer.publish(input)
      patches.push(patch)
      return patch
    },
  }
}

describe("papercut count projection", () => {
  test("subscribes before replay and deduplicates records and dispositions at the boundary", async () => {
    const { primary } = openStores()
    const output = sink()
    const projection = createPapercutCountProjection({
      reader: asAsyncEventReadSurface(primary),
      onStored: (listener) => {
        const unsubscribe = primary.onStored(listener)
        const item = primary.append(recorded("boundary"))
        primary.append(disposed(item.id))
        return unsubscribe
      },
      publish: output.publish,
    })

    expect(await projection.snapshot()).toEqual({ undisposedCount: 0 })
    expect(output.patches).toEqual([])
    projection.dispose()
  })

  test("publishes same-connection commits in order and ignores rollback, unrelated facts, and unchanged counts", async () => {
    const { primary } = openStores()
    const output = sink()
    const projection = createPapercutCountProjection({ reader: asAsyncEventReadSurface(primary), onStored: primary.onStored, publish: output.publish })

    const first = primary.append(recorded("first"))
    primary.append({ ...recorded("other"), type: "session.created", payload: {} })
    expect(() => primary.transaction(() => {
      primary.append(recorded("rolled-back"))
      throw new Error("rollback")
    })).toThrow("rollback")
    primary.transaction(() => {
      const transient = primary.append(recorded("transient"))
      primary.append(disposed(transient.id))
    })
    primary.append(disposed(first.id))

    await projection.snapshot()
    expect(output.patches.map((patch) => patch.payload)).toEqual([
      { kind: "papercuts.changed", papercuts: { undisposedCount: 1 } },
      { kind: "papercuts.changed", papercuts: { undisposedCount: 0 } },
    ])
    expect(output.patches.every((patch) => JSON.stringify(patch).includes("Only durable facts own this text") === false)).toBe(true)
    projection.dispose()
  })

  test("a committed fact the backlog cannot fold is recorded at ERROR, whether it arrives before or after construction", async () => {
    const { primary } = openStores()
    const misplaced = { ...recorded("misplaced"), aggregateId: "project:elsewhere" }
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const projection = createPapercutCountProjection({
        reader: asAsyncEventReadSurface(primary),
        onStored: (listener) => {
          const unsubscribe = primary.onStored(listener)
          primary.append(misplaced)
          return unsubscribe
        },
        publish: sink().publish,
      })
      primary.append(misplaced)
      // bun test fails the running test on an unhandled rejection.
      await Bun.sleep(0)

      const failures = record.mock.calls.map(([input]) => input)
        .filter((input) => typeof input.payload === "object" && input.payload !== null && "message" in input.payload && input.payload.message === "papercut count update failed")
      const unfoldable = expect.objectContaining({ type: "log.error", payload: expect.objectContaining({ error: expect.stringContaining("papercut.recorded must belong to its session aggregate") }) })
      expect(failures).toEqual([unfoldable, unfoldable])
      projection.dispose()
    } finally {
      mock.restore()
    }
  })

  test("a commit with no papercut fact reads nothing", async () => {
    const { primary } = openStores()
    primary.append(recorded("before"))
    const readsAfter: number[] = []
    const reader = {
      ...primary,
      read: (query?: Parameters<LocalSqliteEventStore["read"]>[0]) => {
        readsAfter.push(query?.afterPosition ?? 0)
        return primary.read(query)
      },
    }
    const projection = createPapercutCountProjection({ reader: asAsyncEventReadSurface(reader), onStored: primary.onStored, publish: sink().publish })
    expect(await projection.snapshot()).toEqual({ undisposedCount: 1 })
    readsAfter.length = 0

    for (const index of [1, 2, 3, 4, 5]) primary.append({ ...recorded(`other-${index}`), type: "session.created", payload: {} })
    // Every pushed fold settles in microtasks, and the timer runs after all of them.
    await Bun.sleep(0)

    expect(readsAfter).toEqual([])
    expect(await projection.snapshot()).toEqual({ undisposedCount: 1 })
    projection.dispose()
  })

  test("snapshot catches a second connection up without rescanning prior facts", async () => {
    const { primary, secondary } = openStores()
    const output = sink()
    const projection = createPapercutCountProjection({ reader: asAsyncEventReadSurface(primary), onStored: primary.onStored, publish: output.publish })
    const first = primary.append(recorded("first"))
    await projection.snapshot()
    const readsAfter: number[] = []
    const reader = {
      ...primary,
      read: (query?: Parameters<LocalSqliteEventStore["read"]>[0]) => {
        readsAfter.push(query?.afterPosition ?? 0)
        return primary.read(query)
      },
    }
    projection.dispose()
    const observed = createPapercutCountProjection({ reader: asAsyncEventReadSurface(reader), onStored: primary.onStored, publish: output.publish })
    const external = secondary.append(recorded("external"))

    expect(await observed.snapshot()).toEqual({ undisposedCount: 2 })
    expect(readsAfter).toEqual([0])
    expect(output.patches.at(-1)?.payload).toEqual({ kind: "papercuts.changed", papercuts: { undisposedCount: 2 } })
    expect(first.position).toBeLessThan(external.position)

    secondary.append(recorded("later"))
    expect(await observed.snapshot()).toEqual({ undisposedCount: 3 })
    // Catch-up resumes from the last folded position: prior facts are not rescanned.
    expect(readsAfter.at(-1)).toBe(external.position)
    observed.dispose()
  })
})

describe("papercut app-service query", () => {
  test("the module's protocol runtime reconciles external commits before anchoring the papercut cursor", async () => {
    const { primary, secondary } = openStores()
    const bus = createRuntimeUiBus()
    const sessionStore = fakeSessionStore(new Map())
    const manager = fakeManager()
    const projections = fakeProjections()
    const configView = { ...projections.config.view(), diagnostics: [] }
    const moduleProtocol = composeModuleProtocolRuntimes([papercutsModule], {
      eventStore: asAsyncEventReadSurface(primary), sessionStore, definitions: repoDefinitions(), onStored: primary.onStored, publish: bus.publish, snapshotPosition: bus.snapshotPosition,
      projectionReader: asAsyncEventReadSurface(primary),
      eventWriter: asAsyncEventWriter(primary),
      manager,
      hasLiveSession: () => false,
      background: async () => { throw new Error("The papercuts domain reads no background history") },
      modules: NO_MODULE_SERVICES,
      interruptSession: async () => false,
    }, () => [papercutsModule.id])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ sessionStore, manager, projectRoot: "/workspace" }),
      projectRoot: "/workspace",
      runtimeSupervisor: runtimeSupervisor(),
      bus,
      ...projections,
      moduleProtocol,
      config: { ...projections.config, view: () => configView, refresh: async () => configView },
    })
    secondary.append(recorded("external"))

    await expect(service.query({ type: "papercutCountSnapshot" })).resolves.toEqual({
      papercuts: { undisposedCount: 1 },
      snapshotPosition: 1,
    })
    moduleProtocol.dispose()
    await bus.clear()
  })
})
