import { expect, mock, spyOn, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { globalConfigFile } from "../../../../src/infra/paths.js"
import type { ReleaseNotice } from "../../../../src/protocol/update-protocol-types.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { createRuntimeConfigProjection } from "../../../../src/orchestration/app-service/runtime-config-projection.js"
import { startReleaseNotice } from "../../../../src/orchestration/update/release-notice.js"
import type { ReleaseNotesFetch } from "../../../../src/orchestration/update/release-notes-summary.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const directory = temporaryDirectories()
const body = "Summary.\n\n## Added\n\n- A feature\n\n## Fixed\n\n- A fix"

async function harness(acknowledged?: string, version: string | null = "0.1.1", fetchImpl: ReleaseNotesFetch = async () => Response.json([{ tag_name: "v0.1.1", body, draft: false, prerelease: false }]), repository = "owner/project") {
  const userDataRoot = directory("release-notice-")
  const configFile = globalConfigFile(userDataRoot)
  writeFileSync(configFile, acknowledged === undefined ? "" : `acknowledged_release_version = "${acknowledged}"\n`, { mode: 0o600 })
  const owner = await createRuntimeConfigOwner({ userDataRoot, watch: false })
  let fire: (() => void) | undefined
  const completed = Promise.withResolvers<ReleaseNotice | undefined>()
  const views: Array<ReleaseNotice | undefined> = []
  const fetchPage = mock(fetchImpl)
  const notice = startReleaseNotice({
    owner,
    currentVersion: version ?? undefined,
    repository,
    fetch: fetchPage,
    scheduler: {
      nowMs: () => 0,
      setTimer(callback, delay) {
        expect(delay).toBe(10_000)
        fire = callback
        return () => { fire = undefined }
      },
    },
    publish(next) {
      views.push(next)
      completed.resolve(next)
    },
  })
  return {
    owner, views, fetchPage, completed: completed.promise,
    start: () => fire?.(),
    scheduled: () => fire !== undefined,
    source: () => readFileSync(configFile, "utf8"),
    dispose: async () => { await notice.dispose(); await owner.dispose() },
  }
}

test("a fresh install records a silent baseline only after the deferred start", async () => {
  const state = await harness()
  try {
    expect(state.source()).toBe("")
    expect(state.fetchPage).not.toHaveBeenCalled()
    state.start()
    await state.owner.refresh()
    expect(state.owner.snapshot().config.acknowledged_release_version).toBe("0.1.1")
    expect(state.source()).toContain('acknowledged_release_version = "0.1.1"')
    expect(state.views.filter(Boolean)).toEqual([])
    expect(state.fetchPage).not.toHaveBeenCalled()
  } finally { await state.dispose() }
})

test.each([
  { running: "0.1.1", tags: ["v0.1.1"], message: "Updated to v0.1.1. Got 1 feature and 1 fix.", url: "https://github.com/owner/project/releases/tag/v0.1.1" },
  { running: "0.1.2", tags: ["v0.1.2", "v0.1.1"], message: "Updated to v0.1.2. Got 2 features and 2 fixes.", url: "https://github.com/owner/project/releases" },
])("the account notice shows counts, follows shared dismissal, and fetches once for $running", async ({ running, tags, message, url }) => {
  const state = await harness("0.1.0", running, async () => Response.json(tags.map((tag_name) => ({ tag_name, body }))))
  const projection = createRuntimeConfigProjection({ owner: state.owner, projectRoot: "/workspace", publish() {} })
  try {
    state.start()
    expect(await state.completed).toEqual({
      version: running,
      message,
      url,
    })
    expect(state.views).toHaveLength(1)
    expect(await projection.mutate({ type: "config.mutate", setting: { id: "acknowledgedReleaseVersion", expected: { kind: "value", value: "0.1.0" }, desired: running } })).toMatchObject({ kind: "committed" })
    expect(projection.view().values.acknowledgedReleaseVersion).toBe(running)
    expect(state.views.at(-1)).toBeUndefined()
    expect(state.source()).toContain(`acknowledged_release_version = "${running}"`)
    expect(state.fetchPage).toHaveBeenCalledTimes(1)
  } finally { await projection.dispose(); await state.dispose() }
})

test("a release lookup that finishes after dismissal cannot restore the notice", async () => {
  const response = Promise.withResolvers<Response>()
  const state = await harness("0.1.0", "0.1.1", async () => response.promise)
  try {
    state.start()
    expect(state.views).toEqual([])
    await state.owner.mutate("acknowledgedReleaseVersion", "0.1.0", "0.1.1")
    expect(state.views.at(-1)).toBeUndefined()
    response.resolve(Response.json([{ tag_name: "v0.1.1", body }]))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.views.filter(Boolean)).toEqual([])
    expect(state.views.at(-1)).toBeUndefined()
  } finally {
    response.resolve(Response.json([]))
    await state.dispose()
  }
})

test.each(["offline", "timeout"])("%s release notes keep the release name and a release-list link", async (failure) => {
  const expiry = new AbortController()
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(expiry.signal)
  const state = await harness("0.1.0", "0.1.1", async (_url, init) => {
    if (failure === "offline") throw new TypeError("offline")
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }))
  })
  try {
    state.start()
    expect(timeout.mock.calls[0]?.[0]).toBeGreaterThan(0)
    expect(timeout.mock.calls[0]?.[0]).toBeLessThanOrEqual(5_000)
    if (failure === "timeout") {
      expect(state.views).toEqual([])
      expiry.abort(new DOMException("release notes timed out", "TimeoutError"))
    }
    expect(await state.completed).toEqual({ version: "0.1.1", message: "Updated to v0.1.1.", url: "https://github.com/owner/project/releases" })
    expect(state.views).toHaveLength(1)
  } finally { await state.dispose(); timeout.mockRestore() }
})

test.each(["0.1.1", "0.1.2"])("an acknowledged or older running release stays silent against %s", async (acknowledged) => {
  const state = await harness(acknowledged)
  try {
    state.start()
    await state.owner.refresh()
    expect(state.views).toEqual([])
    expect(state.fetchPage).not.toHaveBeenCalled()
    expect(state.source()).toContain(acknowledged)
  } finally { await state.dispose() }
})

test("a source run schedules and writes nothing", async () => {
  const state = await harness(undefined, null)
  try {
    expect(state.scheduled()).toBe(false)
    expect(state.source()).toBe("")
    expect(state.views).toEqual([])
    expect(state.fetchPage).not.toHaveBeenCalled()
  } finally { await state.dispose() }
})

test("disposal cancels deferred work, aborts an in-flight lookup, and joins it without publication", async () => {
  const state = await harness()
  await state.dispose()
  expect(state.scheduled()).toBe(false)
  expect(state.source()).toBe("")
  expect(state.fetchPage).not.toHaveBeenCalled()

  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | undefined
  const active = await harness("0.1.0", "0.1.1", async (_url, init) => {
    signal = init.signal ?? undefined
    return response.promise
  })
  active.start()
  let disposed = false
  const disposal = active.dispose().then(() => { disposed = true })
  try {
    expect(signal?.aborted).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(disposed).toBe(false)
    response.resolve(Response.json([{ tag_name: "v0.1.1", body }]))
    await disposal
    expect(disposed).toBe(true)
    expect(active.views).toEqual([])
  } finally {
    response.resolve(Response.json([]))
    await disposal
  }
})

test("an invalid repository cannot publish an unvalidated link", async () => {
  const state = await harness("0.1.0", "0.1.1", async () => { throw new TypeError("offline") }, "owner/project\nuntrusted")
  try {
    state.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.views).toEqual([])
    expect(state.fetchPage).not.toHaveBeenCalled()
  } finally { await state.dispose() }
})
