import { describe, expect, it, mock, spyOn } from "bun:test"
import { createRoot } from "solid-js"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import * as startupTraceModule from "../../../../src/infra/startup-trace.js"
import type { RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeUiSnapshot } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createSessionCatalog } from "../../../../src/tui/hooks/create-session-catalog.js"
import { awaitSnapshot, catalogRow, deferred, fakeAppService, readyCatalogRow, snapshotResult } from "../../../helpers/session-catalog.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

describe("session catalog startup diagnostics", () => {
  it("measures connection wait until the first lane opens, through one subscription", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const fake = fakeAppService([readyCatalogRow("one", "One")])
        const lanes = fakeLanes({ open: false })
        let subscriptions = 0
        createSessionCatalog({
          projectRoot: "/workspace",
          appService: {
            query: fake.service.query,
            subscribe() {
              subscriptions++
              return () => {}
            },
            onLane: lanes.onLane,
          },
        })
        expect(fake.snapshotCalls()).toBe(0)
        expect(log).toHaveBeenCalledTimes(1)
        lanes.open()
        await awaitSnapshot()
        expect(subscriptions).toBe(1)
        expect(fake.snapshotCalls()).toBe(1)
        expect(log.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { connectionWait: { status: "ready", count: 1 }, snapshotRequest: { count: 1 } } })
        dispose()
        expect(log).toHaveBeenCalledTimes(2)
      })
    } finally {
      log.mockRestore()
    }
  })

  it("retains failed snapshot timing when reconnect recovers the initial attempt", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const fake = fakeAppService([readyCatalogRow("one", "One")])
        let fail = true
        const query: typeof fake.service.query = (request) =>
          request.type === "snapshot" && fail ? Promise.reject(new Error("snapshot failed")) : fake.service.query(request)
        createSessionCatalog({ projectRoot: "/workspace", appService: { ...fake.service, query } })
        await awaitSnapshot()
        expect(log).toHaveBeenCalledTimes(1)
        fail = false
        fake.reconnect()
        await awaitSnapshot()
        expect(log.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { snapshotRequest: { status: "failed", count: 2, counts: { failures: 1 } } } })
        dispose()
        expect(log).toHaveBeenCalledTimes(2)
      })
    } finally {
      log.mockRestore()
    }
  })
  it("records only the first snapshot cohort through updates", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    const trace = spyOn(startupTraceModule, "startupTrace").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const fake = fakeAppService([catalogRow("one", "One"), catalogRow("two", "Two")])
        createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
        await awaitSnapshot()
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started"])
        fake.update(readyCatalogRow("one", "One"))
        expect(info).toHaveBeenCalledTimes(1)
        expect(trace).not.toHaveBeenCalled()
        fake.update(readyCatalogRow("two", "Two"))
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
        expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { waitForTotalsPatch: { counts: { requested: 2, ready: 2 } } }, elapsedMs: expect.any(Number) })
        fake.update(readyCatalogRow("one", "One"))
        fake.reconnect()
        await awaitSnapshot()
        dispose()
        expect(info).toHaveBeenCalledTimes(2)
        expect(trace.mock.calls).toEqual([["session list ready"]])
      })
    } finally {
      trace.mockRestore()
      mock.restore()
    }
  })

  it("marks immediate and empty initial catalogs ready exactly once", async () => {
    const trace = spyOn(startupTraceModule, "startupTrace").mockImplementation(() => {})
    try {
      for (const rows of [[], [readyCatalogRow("one", "One")]]) {
        await createRoot(async (dispose) => {
          const fake = fakeAppService(rows)
          createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
          await awaitSnapshot()
          fake.update(readyCatalogRow("one", "One"))
          fake.reconnect()
          await awaitSnapshot()
          dispose()
        })
      }
      expect(trace.mock.calls).toEqual([["session list ready"], ["session list ready"]])
    } finally {
      trace.mockRestore()
    }
  })

  it("records the start before the first snapshot resolves without unknown counts", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const pending = deferred<RuntimeUiSnapshot>()
        const fake = fakeAppService([])
        const query = runtimeQuery({ snapshot: () => pending.promise }, fake.service.query)
        const service = { ...fake.service, query } satisfies Pick<RuntimeClient, "query" | "subscribe">
        createSessionCatalog({ appService: service, projectRoot: "/workspace" })
        await awaitSnapshot()
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started"])
        expect(info.mock.calls[0]?.[0].payload).toMatchObject({ owner: "session-catalog-hydration", context: { projectRoot: "/workspace", pid: String(process.pid) } })
        pending.resolve(snapshotResult([catalogRow("one", "One")], 0))
        await awaitSnapshot()
        dispose()
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
        expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "incomplete" })
      })
    } finally {
      mock.restore()
    }
  })

  it("retires pending initial rows missing from a reconnect snapshot", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    const trace = spyOn(startupTraceModule, "startupTrace").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const fake = fakeAppService([catalogRow("one", "One"), catalogRow("two", "Two")])
        createSessionCatalog({ appService: fake.service, projectRoot: "/workspace" })
        await awaitSnapshot()
        fake.setSessions([readyCatalogRow("one", "One")])
        fake.reconnect()
        await awaitSnapshot()
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
        expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { waitForTotalsPatch: { counts: { requested: 1, ready: 1, removed: 1 } } } })
        fake.reconnect()
        await awaitSnapshot()
        dispose()
        expect(info).toHaveBeenCalledTimes(2)
        expect(trace.mock.calls).toEqual([["session list ready"]])
      })
    } finally {
      trace.mockRestore()
      mock.restore()
    }
  })

  it("reports an initial snapshot failure once and an incomplete disposal", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      await createRoot(async (dispose) => {
        const fake = fakeAppService([])
        const query = runtimeQuery({ snapshot: () => Promise.reject(new Error("snapshot failed")) }, fake.service.query)
        const failing = {
          ...fake.service,
          query,
        }
        createSessionCatalog({ appService: failing, projectRoot: "/workspace" })
        await awaitSnapshot()
        fake.reconnect()
        await awaitSnapshot()
        dispose()
        expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
        expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "incomplete", stages: { snapshotRequest: { status: "failed", count: 2, counts: { failures: 2 } } } })
      })
    } finally {
      mock.restore()
    }
  })
})
