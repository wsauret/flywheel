import { describe, expect, mock, spyOn, test } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { createRuntimeSummaryProjection } from "../../../../src/orchestration/app-service/runtime-summary-projection.js"
import type { RuntimeBackgroundSummaryResult } from "../../../../src/protocol/runtime-protocol-schemas.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas.js"

function readyRow(id: string, totalTokens: number): Extract<SessionCatalogRow, { readonly totalsLoading: false }> {
  return {
    id,
    kind: "chat",
    title: id,
    lifecycleState: "inactive",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/workspace",
    totalsLoading: false,
    totalCost: totalTokens / 100,
    totalBilledCost: totalTokens / 200,
    priceUnavailable: false,
    totalTokens,
    contextPercent: 10,
    contextPromptTokens: totalTokens,
    durationMs: 50,
  }
}

function loadingResult(ids: readonly string[]): RuntimeBackgroundSummaryResult {
  return {
    rows: ids.map((id) => ({
      id,
      kind: "chat" as const,
      title: id,
      lifecycleState: "inactive" as const,
      notices: [],
      inputMode: { kind: "chat" as const },
      lastUpdated: "2026-01-01T00:00:00.000Z",
      executionCwd: "/workspace",
      totalsLoading: true as const,
    })),
    errors: [],
    totalsLoading: true,
    generationSpeeds: {},
  }
}

function readyResult(ids: readonly string[], totalTokens = 10): RuntimeBackgroundSummaryResult {
  return { rows: ids.map((id) => readyRow(id, totalTokens)), errors: [], totalsLoading: false, generationSpeeds: {} }
}

function usage(sessionId: string): StoredFact {
  return {
    id: `usage-${sessionId}`,
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "model.usage.measured",
    version: 5,
    timestamp: 1,
    actor: "flywheel",
    payload: {},
    position: 1,
    seq: 1,
  }
}

describe("runtime summary projection", () => {
  test("settles an empty initial admission and stays silent for later sessions", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => readyResult(ids),
        waitForTotals: async (ids) => readyResult(ids),
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })
    try {
      await projection.admit([])
      expect(log.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(log.mock.calls[1]?.[0].payload).toMatchObject({
        outcome: "ready",
        stages: { publication: { counts: { requested: 0, ready: 0, loading: 0 } } },
      })
      await projection.admit(["later"])
      await projection.settled()
      expect(projection.view("later")).toMatchObject({ totalsLoading: false })
      projection.dispose()
      expect(log).toHaveBeenCalledTimes(2)
    } finally {
      projection.dispose()
      log.mockRestore()
    }
  })

  test("aggregates overlapping admissions without extending the initial cohort", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const first = Promise.withResolvers<RuntimeBackgroundSummaryResult>()
    const second = Promise.withResolvers<RuntimeBackgroundSummaryResult>()
    let calls = 0
    const projection = createRuntimeSummaryProjection({
      background: { sessionSummaryImmediate: () => ++calls === 1 ? first.promise : second.promise, waitForTotals: async (ids) => readyResult(ids) },
      sessionPlacements: { placement: async () => null, observe: () => {} }, onStored: () => () => {},
    })
    try {
      const initial = projection.admit(["one", "two"])
      const overlapping = projection.admit(["one", "later"])
      second.resolve(readyResult(["one", "later"]))
      await overlapping
      expect(log).toHaveBeenCalledTimes(1)
      first.resolve(readyResult(["one", "two"]))
      await initial
      expect(log).toHaveBeenCalledTimes(2)
      expect(log.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { immediateRead: { count: 2, counts: { sessions: 4 } }, publication: { counts: { requested: 2, ready: 2 } } } })
    } finally {
      projection.dispose()
      log.mockRestore()
    }
  })
  test("logs one initial cohort across delayed replay and stays silent after settlement", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const replay = Promise.withResolvers<RuntimeBackgroundSummaryResult>()
      const projection = createRuntimeSummaryProjection({
        context: { projectRoot: "/workspace" },
        background: {
          sessionSummaryImmediate: async (ids) => loadingResult(ids),
          waitForTotals: async () => replay.promise,
        },
        sessionPlacements: { placement: async () => null, observe: () => {} },
        onStored: () => () => {},
      })
      await projection.admit(["one", "two"])
      expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started"])
      replay.resolve(readyResult(["one", "two"]))
      await projection.settled()
      expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", context: { projectRoot: "/workspace", pid: String(process.pid) }, stages: { publication: { counts: { requested: 2, ready: 2, loading: 0 } } }, elapsedMs: expect.any(Number) })
      await projection.admit(["one"])
      projection.dispose()
      expect(info).toHaveBeenCalledTimes(2)
    } finally {
      mock.restore()
    }
  })

  test("logs ready on the first admission and bounds failed initial replay", async () => {
    const info = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const readyProjection = createRuntimeSummaryProjection({
        background: { sessionSummaryImmediate: async (ids) => readyResult(ids), waitForTotals: async (ids) => readyResult(ids) },
        sessionPlacements: { placement: async () => null, observe: () => {} }, onStored: () => () => {},
      })
      await readyProjection.admit(["ready"])
      readyProjection.dispose()
      expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready" })
      info.mockClear()
      const failed = createRuntimeSummaryProjection({
        background: {
          sessionSummaryImmediate: async (ids) => loadingResult(ids),
          waitForTotals: async () => { throw new Error("failure") },
        },
        sessionPlacements: { placement: async () => null, observe: () => {} }, onStored: () => () => {},
      })
      await failed.admit(["loading"])
      await failed.settled()
      await failed.admit(["loading"])
      await failed.settled()
      failed.dispose()
      expect(info.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(info.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "incomplete", stages: { totalsWait: { status: "failed", count: 2 }, publication: { counts: { failures: 2, loading: 1 } } } })
    } finally {
      mock.restore()
    }
  })

  test("holds loading views immediately, joins one replay, and publishes complete replacements", async () => {
    let listener: ((events: readonly StoredFact[]) => void) | undefined
    let releaseReplay: (() => void) | undefined
    let replayCalls = 0
    let ready = false
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => ready ? readyResult(ids, 20) : loadingResult(ids),
        waitForTotals: async (ids) => {
          replayCalls++
          await new Promise<void>((resolve) => { releaseReplay = resolve })
          ready = true
          return readyResult(ids, 20)
        },
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: (next) => { listener = next; return () => { listener = undefined } },
    })

    void projection.admit(["one", "two"])
    expect(projection.view("one")).toEqual({ totalsLoading: true })
    expect(projection.view("two")).toEqual({ totalsLoading: true })
    await Bun.sleep(0)
    expect(replayCalls).toBe(1)
    releaseReplay?.()
    await projection.settled()

    expect(projection.view("one")).toEqual({ totalsLoading: false, row: readyRow("one", 20) })
    expect(projection.view("two")).toEqual({ totalsLoading: false, row: readyRow("two", 20) })
    listener?.([])
    projection.dispose()
  })

  test("a relevant child commit retains held child and ancestor totals until replay completes", async () => {
    const replay = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let listener: ((events: readonly StoredFact[]) => void) | undefined
    let totalTokens = 10
    let stale = false
    const reads: string[] = []
    const requests: string[][] = []
    const updates: string[][] = []
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => {
          requests.push([...ids])
          return stale ? loadingResult(ids) : readyResult(ids, totalTokens)
        },
        waitForTotals: async (ids) => {
          started.resolve()
          await replay.promise
          stale = false
          return readyResult(ids, totalTokens)
        },
      },
      sessionPlacements: {
        observe: () => {},
        placement: async (id) => {
          reads.push(id)
          const common = {
            label: id,
            lastUpdated: "2026-01-01T00:00:00.000Z",
            lifecycleState: "inactive" as const,
            executionCwd: "/workspace",
          }
          const session: ReplayedSession = id === "child"
            ? { ...common, kind: "subagent", command: "subagent", conversationId: "child-conversation", launchedFrom: { parentSessionId: "parent", toolUseId: "tool-1" } }
            : { ...common, kind: "chat", command: "chat", conversationId: "parent-conversation" }
          return session
        },
      },
      onStored: (next) => { listener = next; return () => { listener = undefined } },
    })
    projection.subscribe((ids) => { updates.push([...ids]) })
    await projection.admit(["child", "parent", "unrelated"])
    await projection.settled()
    updates.length = 0
    totalTokens = 30
    stale = true

    listener?.([usage("child")])
    expect(projection.view("child")).toEqual({ totalsLoading: false, row: readyRow("child", 10) })
    await started.promise
    expect(reads).toEqual(["child", "parent"])
    expect(updates).toEqual([])
    expect(projection.view("parent")).toEqual({ totalsLoading: false, row: readyRow("parent", 10) })
    replay.resolve()
    await projection.settled()
    expect(new Set(updates.flat())).toEqual(new Set(["child", "parent"]))
    expect(requests).toEqual([
      ["child", "parent", "unrelated"],
      ["child", "parent"],
    ])
    expect(projection.view("parent")).toEqual({ totalsLoading: false, row: readyRow("parent", 30) })
    projection.dispose()
  })

  test("a stream summary on a nested child refreshes only that child, and usage beside it still reaches the ancestors", async () => {
    const requests: string[][] = []
    const reads: string[] = []
    const common = { lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, executionCwd: "/workspace" }
    const sessions = new Map<string, ReplayedSession>([
      ["root", { ...common, label: "root", kind: "chat", command: "chat", conversationId: "root-conversation" }],
      ["child", { ...common, label: "child", kind: "subagent", command: "subagent", conversationId: "child-conversation", launchedFrom: { parentSessionId: "root", toolUseId: "tool-child" } }],
      ["grandchild", { ...common, label: "grandchild", kind: "subagent", command: "subagent", conversationId: "grandchild-conversation", launchedFrom: { parentSessionId: "child", toolUseId: "tool-grandchild" } }],
    ])
    let listener: ((events: readonly StoredFact[]) => void) | undefined
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => { requests.push([...ids].sort()); return readyResult(ids) },
        waitForTotals: async (ids) => readyResult(ids),
      },
      sessionPlacements: { observe: () => {}, placement: async (id) => { reads.push(id); return sessions.get(id) ?? null } },
      onStored: (next) => { listener = next; return () => { listener = undefined } },
    })
    const refreshed = async (events: readonly StoredFact[]) => {
      requests.length = 0
      reads.length = 0
      listener?.(events)
      for (let turn = 0; turn < 10; turn++) await Bun.sleep(0)
      await projection.settled()
      return { requests: [...requests], reads: [...reads] }
    }
    const streamSummary = (sessionId: string): StoredFact => ({ ...usage(sessionId), id: `stream-${sessionId}`, type: "model.stream.summary.recorded", version: 3 })
    try {
      await projection.admit(["root", "child", "grandchild"])
      expect(await refreshed([streamSummary("grandchild")])).toEqual({ requests: [["grandchild"]], reads: [] })
      expect((await refreshed([streamSummary("grandchild"), usage("grandchild")])).requests).toEqual([["child", "grandchild", "root"]])
    } finally {
      projection.dispose()
    }
  })

  test("a held chat refreshes for usage in its workflow descendants and never for its fork", async () => {
    let totalTokens = 10
    // The order in which the projection fed and read the placement owner.
    const placementCalls: string[] = []
    const requests: string[][] = []
    const common = { lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" as const, executionCwd: "/workspace" }
    const sessions = new Map<string, ReplayedSession>([
      ["parent", { ...common, label: "parent", kind: "chat", command: "chat", conversationId: "parent-conversation" }],
      ["fork", { ...common, label: "fork", kind: "chat", command: "chat", conversationId: "fork-conversation", launchedFrom: { parentSessionId: "parent" } }],
      ["workflow", { ...common, label: "workflow", kind: "workflow", command: "workflow", workflowDefinitionId: "fixture", launchedFrom: { parentSessionId: "parent", toolUseId: "tool-workflow" } }],
      ["agent", { ...common, label: "agent", kind: "subagent", command: "subagent", conversationId: "agent-conversation", launchedFrom: { parentSessionId: "workflow", toolUseId: "tool-agent" } }],
    ])
    let listener: ((events: readonly StoredFact[]) => void) | undefined
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => { requests.push([...ids]); return readyResult(ids, totalTokens) },
        waitForTotals: async (ids) => readyResult(ids, totalTokens),
      },
      sessionPlacements: {
        observe: () => { placementCalls.push("observe") },
        placement: async (id) => { placementCalls.push("read"); return sessions.get(id) ?? null },
      },
      onStored: (next) => { listener = next; return () => { listener = undefined } },
    })
    const refreshed = async (sessionId: string) => {
      requests.length = 0
      totalTokens += 10
      listener?.([usage(sessionId)])
      for (let turn = 0; turn < 10; turn++) await Bun.sleep(0)
      await projection.settled()
      return requests
    }
    try {
      await projection.admit(["parent"])
      expect(await refreshed("workflow")).toEqual([["parent"]])
      expect(projection.view("parent")).toEqual({ totalsLoading: false, row: readyRow("parent", 20) })
      expect(await refreshed("agent")).toEqual([["parent"]])
      expect(projection.view("parent")).toEqual({ totalsLoading: false, row: readyRow("parent", 30) })
      // The owner serves repeated usage without a durable read only when it
      // observes each batch before the walk reads it.
      placementCalls.length = 0
      expect(await refreshed("agent")).toEqual([["parent"]])
      expect(placementCalls).toEqual(["observe", "read", "read", "read"])
      expect(await refreshed("fork")).toEqual([])
    } finally {
      projection.dispose()
    }
  })

  test("a failed replay remains loading and retries on the next read", async () => {
    let attempts = 0
    let ready = false
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => ready ? readyResult(ids) : loadingResult(ids),
        waitForTotals: async (ids) => {
          attempts++
          if (attempts === 1) throw new Error("replay failed")
          ready = true
          return readyResult(ids)
        },
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })

    await projection.admit(["retry"])
    await projection.settled()
    expect(projection.view("retry")).toEqual({ totalsLoading: true })
    await projection.admit(["retry"])
    await projection.settled()
    expect(attempts).toBe(2)
    expect(projection.view("retry")).toEqual({ totalsLoading: false, row: readyRow("retry", 10) })
    projection.dispose()
  })

  test("an admission whose read is interrupted or fails settles loading, and the next admission retries", async () => {
    const reads: (Error | RuntimeBackgroundSummaryResult)[] = [
      new DOMException("Runtime background call interrupted", "AbortError"),
      new Error("summary index unavailable"),
    ]
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => {
          const next = reads.shift() ?? readyResult(ids)
          if (next instanceof Error) throw next
          return next
        },
        waitForTotals: async (ids) => readyResult(ids),
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })

    await projection.admit(["held"])
    expect(projection.view("held")).toEqual({ totalsLoading: true })
    await projection.admit(["held"])
    expect(projection.view("held")).toEqual({ totalsLoading: true })
    await projection.admit(["held"])
    expect(projection.view("held")).toEqual({ totalsLoading: false, row: readyRow("held", 10) })
    projection.dispose()
  })

  test("an admission whose subscriber throws settles, still reaches every other subscriber, and records the failure at ERROR", async () => {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    const projection = createRuntimeSummaryProjection({
      background: { sessionSummaryImmediate: async (ids) => readyResult(ids), waitForTotals: async (ids) => readyResult(ids) },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })
    const heard: string[] = []
    projection.subscribe(() => { throw new Error("catalog publish failed") })
    projection.subscribe((sessionIds) => { heard.push(...sessionIds) })
    try {
      await projection.admit(["held"])
      expect(heard).toEqual(["held"])
      expect(record.mock.calls.map(([input]) => input).filter((input) => input.type === "log.error")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ message: "runtime summary subscriber failed", sessions: 1, error: "catalog publish failed" }) }),
      ])
    } finally {
      projection.dispose()
      mock.restore()
    }
  })

  test("the next public admission observes an independent writer without a local stored event", async () => {
    const replay = Promise.withResolvers<void>()
    let tokens = 10
    let stale = false
    const projection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async (ids) => stale ? loadingResult(ids) : readyResult(ids, tokens),
        waitForTotals: async (ids) => {
          await replay.promise
          stale = false
          return readyResult(ids, tokens)
        },
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })
    await projection.admit(["independent"])
    expect(projection.view("independent")).toEqual({ totalsLoading: false, row: readyRow("independent", 10) })

    tokens = 40
    stale = true
    await projection.admit(["independent"])
    expect(projection.view("independent")).toEqual({ totalsLoading: false, row: readyRow("independent", 10) })
    replay.resolve()
    await projection.settled()
    expect(projection.view("independent")).toEqual({ totalsLoading: false, row: readyRow("independent", 40) })
    projection.dispose()
  })
})
