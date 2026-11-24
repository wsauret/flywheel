import { describe, expect, test } from "bun:test"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import type { AccountService } from "../../../../../src/orchestration/app-service/account/account-service.js"
import { AUTOMATIC_CONVERSION_MAX_STORE_BYTES, createProjectStorage, createStorageReclaims, type StorageReclaimHost } from "../../../../../src/orchestration/app-service/account/projects/project-storage.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js"
import type { StorageReclaimOutcome } from "../../../../../src/protocol/store-reclaim.js"
import { createStorageService } from "../../../../../src/orchestration/modules/reclaim-storage/service.js"
import { refusingEventWriter } from "../../../../helpers/event-writer-doubles.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/store/event-store-types.js"
import { canonicalTestDirectory, temporaryDirectories, testDirectories } from "../../../../helpers/directories.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../../../src/orchestration/workspace-state/workspace-state.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { join } from "node:path"
import { Log } from "../../../../../src/infra/diagnostics/log.js"
import type { DebugLogRecordInput } from "../../../../../src/infra/diagnostics/debug-log.js"

const temporary = temporaryDirectories()

const usage = { storeBytes: 4096, reclaimableBytes: 2048, supersededBytes: 0, liveBytes: 2048, incremental: true }

function service(storage: ReturnType<typeof createProjectStorage> | undefined) {
  const published: RuntimeUiPatchInput[] = []
  const notified: NotificationEpisodeInput[] = []
  const created = createStorageService({
    notify: async (episode) => { notified.push(episode) },
    projectionReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: refusingEventWriter({}),
    onStored: () => () => {},
    publish: (input) => { published.push(input); return undefined },
    ...(storage === undefined ? {} : { storage }),
  })
  return { created, published, notified }
}


/** The account's reclaims over a project service whose close, reclaim job,
 *  and reopen the case settles. */
function reclaims() {
  const closes: string[] = []
  const ended = Promise.withResolvers<StorageReclaimOutcome>()
  const reopened = Promise.withResolvers<void>()
  // The hosts the run's reopens made, as an open makes its host while it opens.
  const reopenHosts: StorageReclaimHost[] = []
  const projects: Pick<AccountService<{ dispose(): Promise<void> }>, "closeFor" | "open"> = {
    closeFor: async (root, _reason, _step, work) => { closes.push(root); return work() },
    open: async () => {
      reopenHosts.push(open())
      await reopened.promise
      return { dispose: async () => {} }
    },
  }
  const created = createStorageReclaims({ projects: () => projects, maintenance: { reclaim: () => ended.promise } })
  /** The host one open of the project gets. */
  const open = (): StorageReclaimHost => created.host("/work/alpha", testDirectories("/work/alpha"))
  return { host: open(), open, reopenHosts, closes, ended, reopened }
}

/** A store from an older release, small enough to convert by itself. */
const olderStore = { storeBytes: AUTOMATIC_CONVERSION_MAX_STORE_BYTES - 1, reclaimableBytes: 0, supersededBytes: 0, liveBytes: 4096, incremental: false }

async function capturedLog<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly records: readonly DebugLogRecordInput[] }> {
  const records: DebugLogRecordInput[] = []
  await Log.init({ forward: (record) => { records.push(record) } })
  try {
    return { value: await work(), records }
  } finally {
    await Log.closeGlobal()
  }
}

describe("the storage module service", () => {
  test("publishes the whole view each time the kernel reports usage, and reads nothing itself", () => {
    const storage = createProjectStorage("/scratch/absent/.flywheel/flywheel.sqlite", { start: () => "started", claimAutomaticTry: () => false, last: () => undefined, takeAnnouncement: () => undefined })
    const { created, published } = service(storage)
    expect(created.view()).toEqual({ usage: null, lastReclaim: null })

    storage.report(usage)

    expect(published).toEqual([{ cursor: { scope: "workspace", domain: "reclaim_storage" }, payload: { kind: "reclaim_storage.changed", storage: { usage: { storeBytes: 4096, reclaimableBytes: 2048 }, lastReclaim: null } } }])
    created.dispose()
    storage.report(usage)
    expect(published).toHaveLength(1)
  })

  test("a second start while the run has not reopened the project runs nothing more, and the reopened project announces the outcome once", async () => {
    const run = reclaims()
    expect(run.host.start("command")).toBe("started")
    expect(run.host.start("command")).toBe("running")
    run.ended.resolve({ kind: "reclaimed", beforeBytes: 4 * 1024 ** 3, afterBytes: 1024 ** 3, rowsDeleted: 3 })
    await Bun.sleep(1)
    expect(run.host.start("command")).toBe("running")
    expect(run.closes).toEqual(["/work/alpha"])
    run.reopened.resolve()
    await Bun.sleep(1)

    const storage = createProjectStorage("/scratch/absent/.flywheel/flywheel.sqlite", run.host)
    const reopened = service(storage)
    reopened.created.start?.()
    reopened.created.start?.()
    expect(reopened.notified).toEqual([{ type: "raise", occurrence: expect.objectContaining({ title: "Storage reclaimed", message: "Reclaimed 3.0 GiB: 4.0 GiB to 1.0 GiB" }) }])
    const again = service(storage)
    again.created.start?.()
    expect(again.notified).toEqual([])
    expect(run.host.start("command")).toBe("started")
  })

  test("the call that starts a run is answered before the project closes, so the close never cuts the answer", async () => {
    const run = reclaims()
    const answered = Promise.resolve().then(() => run.host.start("command"))
    expect(await answered).toBe("started")
    for (let turn = 0; turn < 16; turn++) await Promise.resolve()
    expect(run.closes).toEqual([])
    await Bun.sleep(1)
    expect(run.closes).toEqual(["/work/alpha"])
  })

  test("an idle project converts a small store from an older release once per open through the command's run, with no notification", async () => {
    const run = reclaims()
    const storage = createProjectStorage(join(temporary("flywheel-storage-convert-"), "flywheel.sqlite"), run.host)
    storage.report(olderStore)

    const { value: converted, records } = await capturedLog(async () => {
      const started = storage.convertIfSmall()
      expect(storage.convertIfSmall()).toBe(false)
      run.ended.resolve({ kind: "reclaimed", beforeBytes: olderStore.storeBytes, afterBytes: 1024 ** 3, rowsDeleted: 0 })
      run.reopened.resolve()
      await Bun.sleep(1)
      return started
    })

    expect(converted).toBe(true)
    expect(run.closes).toEqual(["/work/alpha"])
    expect(records.filter((record) => record.type === "log.info").map((record) => record.payload)).toEqual([
      expect.objectContaining({ message: "storage reclaim done", trigger: "automatic", beforeBytes: olderStore.storeBytes, afterBytes: 1024 ** 3, durationMs: expect.any(Number) }),
    ])
    // The open the run's reopen made shows the run and announces nothing.
    const reopenHost = run.reopenHosts[0]
    if (!reopenHost) throw new Error("the run did not reopen the project")
    const reopened = createProjectStorage(join(temporary("flywheel-storage-reopened-"), "flywheel.sqlite"), reopenHost)
    const view = service(reopened)
    view.created.start?.()
    expect(view.notified).toEqual([])
    expect(view.created.view().lastReclaim).toMatchObject({ outcome: { kind: "reclaimed" } })
    // That open tries no conversion of its own, so a refused run never loops.
    reopened.report(olderStore)
    expect(reopened.convertIfSmall()).toBe(false)
    expect(run.closes).toHaveLength(1)
    // A later open of the project tries again.
    const later = createProjectStorage(join(temporary("flywheel-storage-later-"), "flywheel.sqlite"), run.open())
    later.report(olderStore)
    expect(later.convertIfSmall()).toBe(true)
    expect(run.closes).toHaveLength(2)
  })

  test.each([
    ["a store at 2 GiB", { ...olderStore, storeBytes: AUTOMATIC_CONVERSION_MAX_STORE_BYTES }],
    ["a store already in incremental mode", { ...olderStore, incremental: true }],
    ["a disk short of the space a VACUUM needs", { ...olderStore, liveBytes: Number.MAX_SAFE_INTEGER / 4 }],
  ])("no conversion starts for %s, and the open tries none again", (_case, declined) => {
    const run = reclaims()
    const storage = createProjectStorage(join(temporary("flywheel-storage-convert-"), "flywheel.sqlite"), run.host)
    storage.report(declined)
    expect(storage.convertIfSmall()).toBe(false)
    storage.report(olderStore)
    expect(storage.convertIfSmall()).toBe(false)
    expect(run.closes).toEqual([])
  })

  test("the preview counts the superseded bytes the last idle plan reported, without planning them itself", () => {
    const projectRoot = canonicalTestDirectory(temporary("flywheel-storage-preview-"))
    prepareWorkspaceState(testDirectories(projectRoot)).generation.release()
    const storage = createProjectStorage(resolveEventStoreDbFile(projectRoot), undefined)
    // The store holds superseded rows that only the reported plan counts.
    storage.report({ ...usage, supersededBytes: 3 * 1024 ** 3 })

    const preview = storage.preview()

    // A fresh store has no free pages and no retired rows.
    expect(preview?.reclaimableBytes).toBe(3 * 1024 ** 3)
    expect(storage.usage()?.supersededBytes).toBe(3 * 1024 ** 3)
  })

  test("refuses the command where no account service serves the project", () => {
    expect(service(undefined).created.reclaim()).toMatchObject({ ok: false })
    expect(service(undefined).created.preview()).toBeNull()
  })
})
