import { describe, expect, test } from "bun:test"

import type { ActiveProfileWatcher, AuthProfileStore } from "../../../../src/infra/auth/store/auth-profile-store.js"
import type { AuthProfileRetirements } from "../../../../src/infra/auth/store/auth-profile-retirements.js"
import { createAuthProfileWatcherOwner, type WatchedCatalogSession } from "../../../../src/orchestration/app-service/auth-profile-watcher-owner.js"
import { subscribeAuthOwners } from "../../../../src/orchestration/app-service/auth-owner-subscription.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createWorkflowRunWriter } from "../../../../src/orchestration/modules/workflows/run-facts.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { seedWorkflowRuns } from "../workflow-host/_workflow-host-fixtures.js"

const temporary = temporaryDirectories()

const DEFAULTS: AuthProfileResolution = {
  id: "Personal",
  persistedId: "Personal",
  displayName: "Personal",
  source: "sticky",
  directory: "/scratch/auth/Personal",
  availableProfiles: [{ id: "Personal", displayName: "Personal" }],
  projectBinding: undefined,
  retirements: {},
}

describe("auth profile watcher owner", () => {
  test("refreshes the exact live-session profile without changing the default selection", async () => {
    const callbacks = new Map<string, () => void>()
    const disposed: string[] = []
    const store = {
      watchCatalog(onChange: () => void): ActiveProfileWatcher {
        callbacks.set("catalog", onChange)
        return { dispose: () => { disposed.push("catalog") } }
      },
      watchAuthFile(directory: string, onChange: () => void): ActiveProfileWatcher {
        callbacks.set(directory, onChange)
        return { dispose: () => { disposed.push(directory) } }
      },
    } satisfies Pick<AuthProfileStore, "watchAuthFile" | "watchCatalog">
    const refreshed: string[] = []
    const stickyProfile = "a"
    const owner = createAuthProfileWatcherOwner({
      store,
      defaultProfile: () => ({ id: stickyProfile, directory: `/profiles/${stickyProfile}`, source: "sticky", retirements: {}, availableProfiles: [{ id: "a" }, { id: "b" }] }),
      sessions: {
        listActive: async () => ({ sessions: [{ id: "session-b", lifecycleState: "active", authProfileId: "b" }] }),
      },
      profileDirectory: (profileId) => `/profiles/${profileId}`,
      refresh: async (profileId) => { refreshed.push(profileId) },
      refreshCatalog: async () => { refreshed.push("catalog") },
      onError: (error) => { throw error },
    })

    await owner.reconcile()
    expect([...callbacks.keys()]).toEqual(["catalog", "/profiles/a", "/profiles/b"])
    callbacks.get("/profiles/b")?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(refreshed).toEqual(["b"])
    callbacks.get("catalog")?.()
    callbacks.get("catalog")?.()
    await owner.reconcile()
    expect(refreshed).toEqual(["b", "catalog"])
    expect(stickyProfile).toBe("a")
    await owner.dispose()
    expect(disposed).toEqual(["catalog", "/profiles/a", "/profiles/b"])
    callbacks.get("catalog")?.()
    expect(refreshed).toEqual(["b", "catalog"])
  })

  test("does not watch a deleted profile still referenced by an active session", async () => {
    const watched: string[] = []
    const disposed: string[] = []
    let availableProfiles: readonly { readonly id: string }[] = [{ id: "a" }, { id: "b" }, { id: "c" }]
    let retirements: AuthProfileRetirements = {}
    const owner = createAuthProfileWatcherOwner({
      store: {
        watchCatalog: () => ({ dispose() {} }),
        watchAuthFile(directory: string): ActiveProfileWatcher {
          watched.push(directory)
          return { dispose: () => { disposed.push(directory) } }
        },
      },
      defaultProfile: () => ({
        id: "a",
        directory: "/profiles/a",
        source: "sticky",
        availableProfiles,
        retirements,
      }),
      sessions: {
        listActive: async () => ({ sessions: [{ id: "session-b", lifecycleState: "active", authProfileId: "b" }] }),
      },
      profileDirectory: (profileId) => {
        if (!availableProfiles.some((profile) => profile.id === profileId)) throw new Error(`profile ${profileId} was deleted`)
        return `/profiles/${profileId}`
      },
      refresh: async () => {},
      refreshCatalog: async () => {},
      onError: (error) => { throw error },
    })

    await owner.reconcile()
    expect(watched).toEqual(["/profiles/a", "/profiles/b"])
    availableProfiles = [{ id: "a" }, { id: "c" }]
    retirements = { b: "c" }
    await owner.reconcile()
    expect(disposed).toEqual(["/profiles/b"])
    expect(watched).toEqual(["/profiles/a", "/profiles/b", "/profiles/c"])
    await owner.dispose()
  })
  test("serializes reconciliations and never opens a watcher after disposal", async () => {
    const listing = Promise.withResolvers<{ sessions: { id: string; lifecycleState: "active"; authProfileId: string }[] }>()
    const started = Promise.withResolvers<void>()
    let listings = 0
    const watched: string[] = []
    const owner = createAuthProfileWatcherOwner({
      store: { watchCatalog: () => ({ dispose() {} }), watchAuthFile(directory) { watched.push(directory); return { dispose() {} } } },
      defaultProfile: () => ({ id: "a", directory: "/profiles/a", source: "sticky", retirements: {}, availableProfiles: [{ id: "a" }, { id: "b" }] }),
      sessions: {
        listActive: async () => { listings++; started.resolve(); return listing.promise },
      },
      profileDirectory: (id) => `/profiles/${id}`,
      refresh: async () => {},
      refreshCatalog: async () => {},
      onError: (error) => { throw error },
    })
    await started.promise
    const queued = owner.reconcile()
    const disposing = owner.dispose()
    listing.resolve({ sessions: [{ id: "session-b", lifecycleState: "active", authProfileId: "b" }] })
    await Promise.all([queued, disposing])
    expect(listings).toBe(1)
    expect(watched).toEqual([])
  })

  test("a session change watches its profile from its own row, never listing every active session, whatever the count", async () => {
    /** Catalog lists made by `changes` session changes while `active` sessions run. */
    const listsPerChange = async (active: number) => {
      const watched: string[] = []
      let listActive = 0
      let listedRows = 0
      const row = (id: string, authProfileId?: string): WatchedCatalogSession => ({ id, lifecycleState: "active", ...(authProfileId === undefined ? {} : { authProfileId }) })
      const rows = Array.from({ length: active }, (_, index) => row(`agent-${index}`))
      const owner = createAuthProfileWatcherOwner({
        store: { watchCatalog: () => ({ dispose() {} }), watchAuthFile(directory) { watched.push(directory); return { dispose() {} } } },
        defaultProfile: () => ({ id: "a", directory: "/profiles/a", source: "sticky", retirements: {}, availableProfiles: [{ id: "a" }, { id: "b" }] }),
        sessions: { listActive: async () => { listActive++; listedRows += rows.length; return { sessions: rows } } },
        profileDirectory: (id) => `/profiles/${id}`,
        refresh: async () => {},
        refreshCatalog: async () => {},
        onError: (error) => { throw error },
      })
      await owner.reconcile()
      let notify: (change: SessionMetadataChange) => void = () => {}
      const settled: Promise<unknown>[] = []
      const unsubscribe = subscribeAuthOwners({
        manager: {
          subscribe: (listener) => { notify = listener; return () => {} },
          listForIds: async (ids) => { listedRows += ids.length; return { sessions: ids.map((id) => row(id, id === "chat-b" ? "b" : undefined)) } },
        },
        onStored: () => () => {},
        runs: { changedRuns: () => new Set() },
        reconcileWorkflow: async () => {},
        reconcileWatchers: owner.reconcile,
        watchSessions: (sessions) => { const watching = owner.watchSessions(sessions); settled.push(watching); return watching },
        publish: () => {},
        reconcileSessions: () => {},
        onError: (error) => { throw error },
      })
      const before = { listActive, listedRows }
      for (const [index] of rows.entries()) notify({ kind: "changed", sessionIds: [`agent-${index}`] })
      notify({ kind: "changed", sessionIds: ["chat-b"] })
      // Each change lists its rows, then queues its watch behind the owner's serial lane.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.all(settled)
      await owner.watchSessions([])
      unsubscribe()
      await owner.dispose()
      return { lists: listActive - before.listActive, rowsPerChange: (listedRows - before.listedRows) / (rows.length + 1), watched }
    }
    const few = await listsPerChange(3)
    const many = await listsPerChange(30)
    expect(many.lists).toBe(0)
    expect(many.rowsPerChange).toBe(few.rowsPerChange)
    // A changed session on another profile is watched from its row.
    expect(many.watched).toEqual(["/profiles/a", "/profiles/b"])
  })
})

describe("auth owner subscription", () => {
  /** Subscribes the auth owners over `workflows` registered runs. Run reads go through a counted
   *  reader, and every workflow reconciliation resolves its run. */
  const subscribe = async (workflows: number) => {
    const dir = temporary("flywheel-auth-owner-runs-")
    const { store, base, manager } = await seedWorkflowRuns(dir, Array.from({ length: workflows }, () => "Personal"))
    const { reader, take } = countStateRequests(base)
    const runs = createWorkflowRunReader(reader)
    let lists = 0
    const owner = createWorkflowAuthOwner({
      reader: { ...runs, list: () => { lists++; return runs.list() }, listOpen: () => { lists++; return runs.listOpen() } },
      writer: createWorkflowRunWriter(base, (...args) => manager.commitWorkflow(...args)),
      profiles: { inspect: () => DEFAULTS },
      userDataRoot: "/scratch",
      onSelected: async () => {},
    })
    // Startup resolves every run, and persists the profile that wf-0 took
    // from the defaults, before the subscription starts.
    expect(await owner.list()).toHaveLength(workflows)
    const reconciled: string[] = []
    const resolutions: Promise<unknown>[] = []
    let notify: (change: SessionMetadataChange) => void = () => {}
    const unsubscribe = subscribeAuthOwners({
      manager: {
        subscribe: (listener) => { notify = listener; return () => {} },
        listForIds: async (ids) => ({ sessions: ids.map((id): WatchedCatalogSession => ({ id, lifecycleState: "active" })) }),
      },
      onStored: store.onStored,
      runs,
      reconcileWorkflow: async (workflowId) => {
        reconciled.push(workflowId)
        const resolution = owner.resident(workflowId)
        resolutions.push(resolution)
        await resolution
      },
      reconcileWatchers: async () => {},
      watchSessions: async () => {},
      publish: () => {},
      reconcileSessions: () => {},
      onError: (error) => { throw error },
    })
    take()
    lists = 0
    /** The run reads, lists, and reconciled workflows since the last call. */
    const cost = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.all(resolutions)
      const spent = { reads: take().length, lists, reconciled: [...reconciled] }
      lists = 0
      reconciled.length = 0
      return spent
    }
    const close = () => { unsubscribe(); store.close() }
    return { notify, cost, close, writer: createWorkflowRunWriter(base, (...args) => manager.commitWorkflow(...args)) }
  }

  test("N session changes over M workflow runs (M of 2 and 200) issue zero run reads and list no run", async () => {
    const sessionChanges = async (workflows: number) => {
      const owners = await subscribe(workflows)
      try {
        for (let index = 0; index < 20; index++) owners.notify({ kind: "changed", sessionIds: [`agent-${index}`] })
        owners.notify({ kind: "deleted", sessionId: "agent-0" })
        return await owners.cost()
      } finally {
        owners.close()
      }
    }
    const nothing = { reads: 0, lists: 0, reconciled: [] }
    expect(await sessionChanges(2)).toEqual(nothing)
    expect(await sessionChanges(200)).toEqual(nothing)
  })

  test("A stored fact of one workflow reconciles that workflow only, with one read", async () => {
    const rename = async (workflows: number) => {
      const owners = await subscribe(workflows)
      try {
        expect(await owners.writer.update("wf-1", (current) => ({ ...current, label: "Renamed" }), "user")).toBe(true)
        return await owners.cost()
      } finally {
        owners.close()
      }
    }
    const one = { reads: 1, lists: 0, reconciled: ["wf-1"] }
    expect(await rename(2)).toEqual(one)
    expect(await rename(200)).toEqual(one)
  })
})
