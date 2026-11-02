import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { RuntimeBackgroundLane } from "../../../../src/orchestration/app-service/runtime-background-lane.js"
import { fakeProjections, runtimeSupervisor } from "./app-service-doubles.js"

function lane(overrides: Partial<RuntimeBackgroundLane> = {}): RuntimeBackgroundLane {
  return {
    start() {}, snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    sessionSummaryImmediate: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    waitForTotals: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
    sessionDetail: async () => ({ view: null }), sessionChangeSummary: async () => ({ fileCount: 0, unknownFileMutationGaps: 0 }),
    moduleSnapshot: async () => { throw new Error("unused") },
    transcriptSearch: async () => { throw new Error("unused") }, recall: async () => { throw new Error("unused") }, dispose: async () => {},
    ...overrides,
  }
}

function projection() {
  return {
    snapshot: async () => ({ rows: [], activeRuntimeCount: 0, errors: [] }),
    hasLiveSession: () => false, liveCatalogRow: async () => null, catalogRow: async () => null,
    subscribe: () => () => {}, dispose() {},
  }
}

describe("FlywheelAppService background lane", () => {
  test("detail falls back to background history while budget reads local history", async () => {
    const calls: Array<{ owner: string; sessionId: string }> = []
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      ...projections, projectRoot: tmpdir(), projection: projection(),
      bus: createRuntimeUiBus(), runtimeSupervisor: runtimeSupervisor(),
      historyProjection: {
        ...projections.historyProjection,
        sessionDetail: async (sessionId: string) => { calls.push({ owner: "local", sessionId }); return { view: null } },
      },
      backgroundLane: lane({
        sessionDetail: async ({ sessionId }) => { calls.push({ owner: "background", sessionId }); return { view: null } },
      }),
    })
    await service.query({ type: "sessionDetail", sessionId: "s1" })
    await service.query({ type: "budgetSnapshot", sessionIds: ["s1"] })
    // Held detail is the account publisher's alone, so an executor reads none.
    await expect(service.query({ type: "sessionDetailSnapshot", sessionIds: ["s1"] })).rejects.toThrow("held through the account service")
    expect(calls).toEqual([
      { owner: "local", sessionId: "s1" }, { owner: "background", sessionId: "s1" }, { owner: "local", sessionId: "s1" },
    ])
  })

  test("foreground snapshot does not read or warm background summaries", async () => {
    let summaryReads = 0
    let starts = 0
    const service = createFlywheelAppService({
      ...fakeProjections(), projectRoot: tmpdir(), projection: projection(),
      bus: createRuntimeUiBus(), runtimeSupervisor: runtimeSupervisor(),
      backgroundLane: lane({ start: () => { starts++ }, sessionSummaryImmediate: async () => { summaryReads++; return { rows: [], errors: [], totalsLoading: false, generationSpeeds: {} } } }),
    })

    await service.query({ type: "snapshot" })
    expect({ starts, summaryReads }).toEqual({ starts: 0, summaryReads: 0 })
  })

  test("background warm starts the existing lane but does not run a catalog snapshot", async () => {
    let starts = 0
    let snapshots = 0
    const service = createFlywheelAppService({
      ...fakeProjections(), projectRoot: tmpdir(), projection: projection(),
      bus: createRuntimeUiBus(), runtimeSupervisor: runtimeSupervisor(),
      backgroundLane: lane({ start: () => { starts++ }, snapshot: async () => { snapshots++; return { rows: [], errors: [], totalsLoading: false, generationSpeeds: {} } } }),
    })

    await service.dispatch({ type: "background.warm" })
    await service.dispatch({ type: "background.warm" })
    expect({ starts, snapshots }).toEqual({ starts: 1, snapshots: 0 })
  })

  test("a failed warm remains retryable", async () => {
    let attempts = 0
    const service = createFlywheelAppService({
      ...fakeProjections(), projectRoot: tmpdir(), projection: projection(),
      bus: createRuntimeUiBus(),
      runtimeSupervisor: runtimeSupervisor({ warmChatRunner: async () => { if (++attempts === 1) throw new Error("failed") } }),
      backgroundLane: lane(),
    })

    await expect(service.dispatch({ type: "background.warm" })).rejects.toThrow("failed")
    await service.dispatch({ type: "background.warm" })
    expect(attempts).toBe(2)
  })
})
