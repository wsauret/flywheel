import { describe, expect, test } from "bun:test"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import type { AccountService } from "../../../../../src/orchestration/app-service/account-service.js"
import { createProjectStorage, createStorageReclaims } from "../../../../../src/orchestration/app-service/project-storage.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js"
import type { StorageReclaimOutcome } from "../../../../../src/protocol/store-reclaim.js"
import { createStorageService } from "../../../../../src/orchestration/modules/reclaim-storage/service.js"
import { refusingEventWriter } from "../../../../helpers/event-writer-doubles.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { canonicalTestDirectory, temporaryDirectories, testDirectories } from "../../../../helpers/directories.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { prepareWorkspaceState } from "../../../../../src/orchestration/workspace-state.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"

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
  const projects: Pick<AccountService<{ dispose(): Promise<void> }>, "closeFor" | "open"> = {
    closeFor: async (root, _reason, _step, work) => { closes.push(root); return work() },
    open: async () => { await reopened.promise; return { dispose: async () => {} } },
  }
  const created = createStorageReclaims({ projects: () => projects, maintenance: { reclaim: () => ended.promise } })
  return { host: created.host("/work/alpha", testDirectories("/work/alpha")), closes, ended, reopened }
}

describe("the storage module service", () => {
  test("publishes the whole view each time the kernel reports usage, and reads nothing itself", () => {
    const storage = createProjectStorage("/scratch/absent/.flywheel/flywheel.sqlite", { start: () => "started", last: () => undefined, takeAnnouncement: () => undefined })
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
    expect(run.host.start()).toBe("started")
    expect(run.host.start()).toBe("running")
    run.ended.resolve({ kind: "reclaimed", beforeBytes: 4 * 1024 ** 3, afterBytes: 1024 ** 3, rowsDeleted: 3 })
    await Bun.sleep(1)
    expect(run.host.start()).toBe("running")
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
    expect(run.host.start()).toBe("started")
  })

  test("the call that starts a run is answered before the project closes, so the close never cuts the answer", async () => {
    const run = reclaims()
    const answered = Promise.resolve().then(() => run.host.start())
    expect(await answered).toBe("started")
    for (let turn = 0; turn < 16; turn++) await Promise.resolve()
    expect(run.closes).toEqual([])
    await Bun.sleep(1)
    expect(run.closes).toEqual(["/work/alpha"])
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
