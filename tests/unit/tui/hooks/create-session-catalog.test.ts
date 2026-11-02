import { describe, expect, it } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import type { AttachedRuntimeClient, FrontendEvent, RuntimeChatDefault, SessionCatalogError } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeUiSnapshot } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { RuntimeIdentity } from "../../../../src/protocol/client/runtime-identity.js"
import { createSessionCatalog as createCatalog, resolveCatalogRows } from "../../../../src/tui/hooks/create-session-catalog.js"

import { awaitSnapshot, catalogRow, deferred, fakeAppService, readyCatalogRow, snapshotResult } from "../../../helpers/session-catalog.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function createSessionCatalog(deps: Omit<Parameters<typeof createCatalog>[0], "projectRoot"> & { projectRoot?: string }) {
  return createCatalog({ projectRoot: "/workspace", ...deps })
}

describe("createSessionCatalog (TUI protocol cache)", () => {
  it("counts every catalog row: the runtime lists sessions only, never a child", async () => {
    await createRoot(async (dispose) => {
      const chat = { ...catalogRow("chat", "Chat"), childSessionIds: ["child"] }
      const otherChat = catalogRow("other-chat", "Other chat")
      const fake = fakeAppService([chat, otherChat])
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })

      await awaitSnapshot()
      expect(catalog.rows()).toHaveLength(2)
      dispose()
    })
  })

  it("applies a contiguous chat default patch atomically", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([], [], { kind: "model", model: "openai/gpt-5", effort: "low" })
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
      const observed: RuntimeChatDefault[] = []
      createEffect(() => {
        observed.push(catalog.chatDefault())
      })
      await awaitSnapshot()

      fake.changeChatDefault({ kind: "model", model: "anthropic/claude-opus-4", effort: "high" })

      expect(catalog.chatDefault()).toEqual({ kind: "model", model: "anthropic/claude-opus-4", effort: "high" })
      expect(observed).not.toContainEqual({ kind: "model", model: "anthropic/claude-opus-4", effort: "low" })
      dispose()
    })
  })

  it("seeds the executor state from the snapshot and follows each executor patch", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([])
      fake.setExecutor({ kind: "recovery_failed", cause: "some commands it started did not stop" })
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
      await awaitSnapshot()
      expect(catalog.executor()).toEqual({ kind: "recovery_failed", cause: "some commands it started did not stop" })
      fake.changeExecutor({ kind: "restarting", since: 3, cause: "stopped by signal SIGKILL" })
      expect(catalog.executor()).toEqual({ kind: "restarting", since: 3, cause: "stopped by signal SIGKILL" })
      fake.changeExecutor({ kind: "serving" })
      expect(catalog.executor()).toEqual({ kind: "serving" })
      dispose()
    })
  })

  it("seeds the account service's report from the snapshot and follows each service patch", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([])
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
      await awaitSnapshot()
      expect(catalog.service()).toEqual({ kind: "serving" })
      fake.changeService({ kind: "crash_loop", cause: "the hub stopped" })
      expect(catalog.service()).toEqual({ kind: "crash_loop", cause: "the hub stopped" })
      fake.changeService({ kind: "serving" })
      expect(catalog.service()).toEqual({ kind: "serving" })
      dispose()
    })
  })

  it("shows the attached service's identity before the catalog snapshot, then the identity each snapshot states", async () => {
    await createRoot(async (dispose) => {
      const snapshot = deferred<RuntimeUiSnapshot>()
      const fake = fakeAppService([])
      const query = runtimeQuery({ snapshot: () => snapshot.promise }, fake.service.query)
      const attachedIdentity = Promise.resolve<RuntimeIdentity | undefined>({ version: "0.0.10", buildId: "3029f1abdeadbeef" })
      const catalog = createSessionCatalog({ appService: { ...fake.service, query }, projectRoot: "/workspace", attachedIdentity })
      await awaitSnapshot()
      expect(catalog.runtimeIdentity()).toEqual({ version: "0.0.10", buildId: "3029f1abdeadbeef" })
      expect(catalog.catalogReady()).toBe(false)

      snapshot.resolve({ ...snapshotResult([], 0), runtimeVersion: "0.0.11", runtimeBuildId: "4ab0cdef01234567" })
      await awaitSnapshot()
      expect(catalog.catalogReady()).toBe(true)
      expect(catalog.runtimeIdentity()).toEqual({ version: "0.0.11", buildId: "4ab0cdef01234567" })
      dispose()
    })
  })

  it("holds no runtime identity without an attach or a snapshot and follows the backend across reconnects", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([])
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
      expect(catalog.runtimeIdentity()).toBeUndefined()
      await awaitSnapshot()
      expect(catalog.runtimeIdentity()).toEqual({ version: "test", buildId: null })

      fake.setRuntimeIdentity({ runtimeVersion: "0.0.10", runtimeBuildId: "3029f1abdeadbeef" })
      fake.reconnect()
      await awaitSnapshot()
      expect(catalog.runtimeIdentity()).toEqual({ version: "0.0.10", buildId: "3029f1abdeadbeef" })
      dispose()
    })
  })

  it("releases catalog lookup only when the first complete snapshot is applied", async () => {
    await createRoot(async (dispose) => {
      const snapshot = deferred<RuntimeUiSnapshot>()
      const fake = fakeAppService([])
      const query = runtimeQuery({ snapshot: () => snapshot.promise }, fake.service.query)
      const catalog = createSessionCatalog({ appService: { ...fake.service, query }, projectRoot: "/workspace" })
      const observed: Array<{ ready: boolean; rows: readonly string[] }> = []
      createEffect(() => {
        observed.push({ ready: catalog.catalogReady(), rows: catalog.rows().map((row) => row.id) })
      })
      expect(catalog.catalogReady()).toBe(false)

      catalog.seed(catalogRow("seed", "Seeded"))
      fake.update(readyCatalogRow("patched", "Patched"))
      expect(catalog.catalogReady()).toBe(false)

      snapshot.resolve(snapshotResult([catalogRow("snapshot", "Snapshot")], 0))
      await awaitSnapshot()
      expect(catalog.catalogReady()).toBe(true)
      expect(observed.filter(({ ready }) => ready)).toEqual([{ ready: true, rows: ["snapshot"] }])

      fake.update(readyCatalogRow("snapshot", "Ready totals"))
      expect(catalog.catalogReady()).toBe(true)
      dispose()
    })
  })

  it("keeps the resident chat default through gaps and reconnects until each replacement snapshot lands", async () => {
    await createRoot(async (dispose) => {
      const resident = { kind: "model", model: "openai/gpt-5", effort: "medium" as const } satisfies RuntimeChatDefault
      const canonical = { kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" as const } satisfies RuntimeChatDefault
      const fake = fakeAppService([], [], resident)
      const catalog = createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
      await awaitSnapshot()

      fake.setChatDefault(canonical)
      fake.skipThenChangeChatDefault(canonical)
      expect(catalog.chatDefault()).toEqual(resident)

      await awaitSnapshot()
      expect(catalog.chatDefault()).toEqual(canonical)

      const nextResident = { kind: "model", model: "openai/gpt-5.1", effort: "low" as const } satisfies RuntimeChatDefault
      const nextCanonical = { kind: "model", model: "anthropic/claude-opus-4", effort: "max" as const } satisfies RuntimeChatDefault
      fake.changeChatDefault(nextResident)
      fake.setChatDefault(nextCanonical)
      fake.reconnect()
      expect(catalog.chatDefault()).toEqual(nextResident)

      await awaitSnapshot()
      expect(catalog.chatDefault()).toEqual(nextCanonical)
      dispose()
    })
  })

  it("defers the connected snapshot off the synchronous subscription path", async () => {
    await createRoot(async (dispose) => {
      const sequencer = createRuntimeUiPatchSequencer()
      let snapshotCalls = 0
      const query = runtimeQuery({ snapshot: async () => {
        snapshotCalls += 1
        return snapshotResult([catalogRow("chat-1", "Deferred")], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] }))
      } })
      const lanes = fakeLanes()
      const service = {
        query,
        subscribe: () => () => {},
        onLane: lanes.onLane,
      } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

      const catalog = createSessionCatalog({ appService: service })

      expect(snapshotCalls).toBe(0)
      expect(catalog.rows()).toHaveLength(0)
      await awaitSnapshot()
      expect(snapshotCalls).toBe(1)
      expect(catalog.row("chat-1")?.title).toBe("Deferred")
      dispose()
    })
  })

  it("seeds from the app-service snapshot and applies ordered catalog row patches", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "First")])
      const { row: read, rows } = createSessionCatalog({ appService: fake.service })

      await awaitSnapshot()
      expect(read("chat-1")?.title).toBe("First")
      expect(rows()).toHaveLength(1)

      fake.update(catalogRow("chat-1", "Renamed"))
      expect(read("chat-1")?.title).toBe("Renamed")

      fake.add(catalogRow("chat-2", "Second"))
      expect(read("chat-2")?.title).toBe("Second")
      expect(rows()).toHaveLength(2)

      fake.remove("chat-1")
      expect(read("chat-1")).toBeUndefined()
      expect(rows()).toHaveLength(1)

      dispose()
    })
  })

  it("keeps known totals under a loading row until a ready row replaces them", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "First")])
      const { row: read } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()

      fake.update(readyCatalogRow("chat-1", "First", { diffStats: { added: 1, modified: 2, removed: 3 } }))
      expect(read("chat-1")?.totalCost).toBe(1.25)

      fake.update(catalogRow("chat-1", "Renamed"))
      expect(read("chat-1")).toEqual(readyCatalogRow("chat-1", "Renamed", { diffStats: { added: 1, modified: 2, removed: 3 } }))

      fake.update(readyCatalogRow("chat-1", "First", {
        totalCost: 2.5, totalTokens: 900, durationMs: 12000, contextPercent: 20,
        diffStats: { added: 4, modified: 5, removed: 6 },
      }))
      expect(read("chat-1")?.totalCost).toBe(2.5)
      expect(read("chat-1")?.diffStats).toEqual({ added: 4, modified: 5, removed: 6 })

      dispose()
    })
  })

  it("reconciles patches in place: stable row identity, leaf-level invalidation, omitted non-stat fields deleted", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([{ ...catalogRow("chat-1", "First"), shortTitle: "F" }])
      const { row: read } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()

      // Subscribers of an unchanged leaf must not re-run on an unrelated patch:
      // the streaming patch rate makes whole-row invalidation a render stall.
      let identityRuns = 0
      let titleRuns = 0
      createEffect(() => { void read("chat-1"); identityRuns += 1 })
      createEffect(() => { void read("chat-1")?.title; titleRuns += 1 })
      expect(identityRuns).toBe(1)
      expect(titleRuns).toBe(1)

      const before = read("chat-1")
      fake.update({ ...catalogRow("chat-1", "Renamed"), shortTitle: "F" })
      expect(read("chat-1")?.title).toBe("Renamed")
      // The row proxy keeps its identity, so row-existence subscribers stay quiet.
      expect(read("chat-1")).toBe(before)
      expect(identityRuns).toBe(1)
      expect(titleRuns).toBe(2)

      // A leaf update that changes nothing visible must not invalidate title readers.
      fake.update(readyCatalogRow("chat-1", "Renamed", { shortTitle: "F", totalTokens: 100 }))
      expect(titleRuns).toBe(2)

      // A non-stat optional field omitted by the fresh row is deleted (stats are
      // sparse by contract and survive; shortTitle is not a stat).
      fake.update(catalogRow("chat-1", "Renamed"))
      expect(read("chat-1")?.shortTitle).toBeUndefined()

      dispose()
    })
  })


  it("applies a duplicate removal in order instead of resnapshotting (delete publishes twice)", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "First"), catalogRow("chat-2", "Second")])
      const { row: read, rows } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()
      fake.update(readyCatalogRow("chat-2", "Second"))

      // Receiver robustness: a duplicate removal on one cursor must chain in
      // order (a no-op), never classify as a gap that rebuilds the whole
      // catalog from the stat-less metadata snapshot.
      fake.remove("chat-1")
      fake.remove("chat-1")
      await awaitSnapshot()

      expect(fake.snapshotCalls()).toBe(1)
      expect(rows()).toHaveLength(1)
      expect(read("chat-1")).toBeUndefined()
      expect(read("chat-2")?.totalCost).toBe(1.25)
      expect(read("chat-2")?.totalTokens).toBe(500)
      dispose()
    })
  })

  it("keeps known totals through a reconnect whose snapshot is still loading them", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "First")])
      const { row: read } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()
      fake.update(readyCatalogRow("chat-1", "First"))

      fake.setSessions([catalogRow("chat-1", "First"), catalogRow("chat-2", "Second")])
      fake.reconnect()
      await awaitSnapshot()

      expect(read("chat-1")).toEqual(readyCatalogRow("chat-1", "First"))
      expect(read("chat-2")).toEqual(catalogRow("chat-2", "Second"))
      dispose()
    })
  })

  it("discards and rebuilds the cache from a fresh snapshot when the runtime reconnects (gap)", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "Original")])
      const { row: read } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()
      fake.update(catalogRow("chat-1", "Stale local edit"))

      // The runtime moves on while we are not looking; the next snapshot is the
      // source of truth, rebuilt without touching any SessionStore.
      fake.setSessions([catalogRow("chat-1", "Authoritative"), catalogRow("chat-9", "New")])
      fake.reconnect()
      await awaitSnapshot()

      expect(read("chat-1")?.title).toBe("Authoritative")
      expect(read("chat-9")?.title).toBe("New")

      dispose()
    })
  })

  it("applies snapshot cache/order replacements atomically for observed rows", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "First"), catalogRow("chat-2", "Second")])
      const catalog = createSessionCatalog({ appService: fake.service })
      const observed: string[][] = []
      createEffect(() => {
        observed.push(catalog.rows().map((row) => row.id))
      })

      await awaitSnapshot()
      expect(observed.at(-1)).toEqual(["chat-1", "chat-2"])

      fake.setSessions([catalogRow("chat-2", "Second")])
      fake.reconnect()
      await awaitSnapshot()

      expect(catalog.rows().map((row) => row.id)).toEqual(["chat-2"])
      expect(observed.at(-1)).toEqual(["chat-2"])
      dispose()
    })
  })

  it("rebuilds from a snapshot when an ordered patch gap is detected", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService([catalogRow("chat-1", "Original")])
      const { row: read } = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()

      fake.setSessions([catalogRow("chat-1", "Authoritative")])
      fake.skipThenUpdate(catalogRow("chat-1", "Skipped live patch"))
      await awaitSnapshot()

      expect(read("chat-1")?.title).toBe("Authoritative")
      dispose()
    })
  })

  it("discards a stale async snapshot that resolves after a newer rebuild", async () => {
    await createRoot(async (dispose) => {
      const requests: ReturnType<typeof deferred<RuntimeUiSnapshot>>[] = []
      let listener: (event: FrontendEvent) => void = () => {}
      const query = runtimeQuery({ snapshot: () => {
        const pending = deferred<RuntimeUiSnapshot>()
        requests.push(pending)
        return pending.promise
      } })
      const lanes = fakeLanes()
      const service = {
        query,
        subscribe: (next: (event: FrontendEvent) => void) => {
          listener = next
          return () => { listener = () => {} }
        },
        onLane: lanes.onLane,
      } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
      const { row: read } = createSessionCatalog({ appService: service })
      await awaitSnapshot()

      lanes.end()
      listener?.(LANE_BREAK)
      lanes.open()
      await awaitSnapshot()
      requests[1]!.resolve(snapshotResult([catalogRow("chat-1", "New")], 20))
      await awaitSnapshot()
      requests[0]!.resolve(snapshotResult([catalogRow("chat-1", "Old")], 10))
      await awaitSnapshot()

      expect(read("chat-1")?.title).toBe("New")
      dispose()
    })
  })

  it("keeps seeded errors through row and totals patches until an authoritative snapshot replaces them", async () => {
    await createRoot(async (dispose) => {
      const brokenError: SessionCatalogError = { sessionId: "broken", scope: "metadata", reason: "bad fact" }
      const fake = fakeAppService([catalogRow("chat-1", "First")], [brokenError])
      const catalog = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()
      expect(catalog.errors()).toEqual([brokenError])

      fake.add(catalogRow("broken", "Repaired"))
      fake.update(readyCatalogRow("broken", "Repaired"))
      expect(catalog.errors()).toEqual([brokenError])
      expect(catalog.row("broken")?.title).toBe("Repaired")

      fake.setSessions([readyCatalogRow("broken", "Repaired")])
      fake.setErrors([])
      fake.reconnect()
      await awaitSnapshot()
      expect(catalog.errors()).toEqual([])
      dispose()
    })
  })

  it("clears a seeded error entry when the corrupt session is removed", async () => {
    await createRoot(async (dispose) => {
      const brokenError: SessionCatalogError = { sessionId: "broken", scope: "metadata", reason: "bad fact" }
      const fake = fakeAppService([], [brokenError])
      const catalog = createSessionCatalog({ appService: fake.service })
      await awaitSnapshot()
      expect(catalog.errors()).toEqual([brokenError])

      fake.remove("broken")
      expect(catalog.errors()).toEqual([])
      dispose()
    })
  })

  it("maps the order onto cache rows in order", () => {
    const first = catalogRow("chat-1", "First")
    const second = catalogRow("chat-2", "Second")
    const rows = resolveCatalogRows(["chat-2", "chat-1"], { "chat-1": first, "chat-2": second })
    expect(rows).toEqual([second, first])
  })

  it("throws InvariantViolation when the order references an id absent from the cache", () => {
    const present = catalogRow("chat-1", "First")
    let caught: unknown
    try {
      resolveCatalogRows(["chat-1", "chat-ghost"], { "chat-1": present })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected InvariantViolation")
    expect(caught.kind).toBe("orphan-event")
    expect(caught.aggregateId).toBe("chat-ghost")
  })

  it("unsubscribes on cleanup", () => {
    const fake = fakeAppService([])
    createRoot((dispose) => {
      createSessionCatalog({ appService: fake.service })
      expect(fake.isSubscribed()).toBe(true)
      dispose()
    })
    expect(fake.isSubscribed()).toBe(false)
  })
})
