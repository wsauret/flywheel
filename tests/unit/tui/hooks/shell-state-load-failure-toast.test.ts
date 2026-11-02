import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createShellState } from "../../../../src/tui/hooks/shell-state.js"
import type { FrontendEvent, FrontendOutputBlock, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { snapshotResult } from "../../../helpers/session-catalog.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

type ShellStateAppService = Parameters<typeof createShellState>[0]["appService"]

type Toast = { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }

const unavailableOutput = { title: "Session output cannot be repaired", message: "This session was saved with an older Flywheel output format, and the data needed to rebuild it is no longer available.", diagnostic: "raw schema diagnostic" } as const

async function waitForAssertion(assert: () => void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 100; i++) {
    try {
      assert()
      return
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

describe("foreground load failure toasts", () => {
  it("surfaces unloadable foreground sessions as toasts", async () => {
    const client = createMissingDetailClient()
    const toasts: Toast[] = []

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          projectRoot: "/scratch/flywheel-test",
          now: () => 1000,
          setTerminalTitle: () => {},
          showToast: (toast) => { toasts.push(toast) },
        })

        await waitForAssertion(() => {
          expect(signals.sessionCatalogRows()[0]?.id).toBe(client.knownSessionId)
        })

        signals.setForegroundId("missing-1")
        await waitForAssertion(() => {
          expect(toasts).toEqual([{ message: "Session no longer exists", variant: "error", duration: 7000 }])
        })


        signals.setForegroundId("missing-2")
        await waitForAssertion(() => {
          expect(toasts).toHaveLength(2)
        })

        // A listed chat reads its row from the catalog and holds no detail.
        signals.setForegroundId(client.knownSessionId)
        await waitForAssertion(() => {
          expect(signals.sessionKind()).toBe("chat")
        })
        expect(client.sessionDetailCalls(client.knownSessionId)).toBe(0)

        signals.setForegroundId("missing-1")
        await waitForAssertion(() => {
          expect(toasts).toHaveLength(3)
        })
      } finally {
        dispose()
      }
    })
  })

  it("surfaces durable transcript open failures as toasts", async () => {
    const client = createMissingDetailClient({ outputError: new Error("scrollback read failed") })
    const toasts: Toast[] = []

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          projectRoot: "/scratch/flywheel-test",
          now: () => 1000,
          setTerminalTitle: () => {},
          showToast: (toast) => { toasts.push(toast) },
          // Initial opens use the same bounded recovery lane as background repair;
          // collapse its existing injectable schedule so exhaustion is deterministic.
          transcriptRecoveryBackoff: { baseMs: 0, maxMs: 0, factor: 1, random: () => 0 },
        })

        await waitForAssertion(() => {
          expect(signals.sessionCatalogRows()[0]?.id).toBe(client.knownSessionId)
        })

        signals.setForegroundId(client.knownSessionId)

        await waitForAssertion(() => {
          expect(client.outputWindowCalls()).toBe(4)
        })
        await Promise.resolve()
        expect(toasts).toEqual([{ message: "scrollback read failed", variant: "error", duration: 7000 }])
      } finally {
        dispose()
      }
    })
  })

  it("presents unavailable durable transcript state as a transient toast", async () => {
    const client = createMissingDetailClient({ outputUnavailable: true })
    const toasts: Toast[] = []

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          projectRoot: "/scratch/flywheel-test",
          now: () => 1000,
          setTerminalTitle: () => {},
          showToast: (toast) => { toasts.push(toast) },
        })

        await waitForAssertion(() => {
          expect(signals.sessionCatalogRows()[0]?.id).toBe(client.knownSessionId)
        })

        signals.setForegroundId(client.knownSessionId)

        await waitForAssertion(() => {
          expect(toasts).toEqual([{
            message: "Session output cannot be repaired. This session was saved with an older Flywheel output format, and the data needed to rebuild it is no longer available.",
            variant: "error",
            duration: 7000,
          }])
        })
      } finally {
        dispose()
      }
    })
  })

  it("hydrates the budget cache for an inactive foreground session", async () => {
    const budget = { totalsLoading: false as const, tokens: 250, cost: 12, billedCost: 5, priceUnavailable: false, contextPercent: 40, contextPromptTokens: 2_000 };
    const client = createMissingDetailClient({ budget });

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          now: () => 1_000,
          projectRoot: "/scratch/flywheel-test",
          setTerminalTitle: () => {},
          showToast: () => {},
        });
        await waitForAssertion(() => expect(signals.sessionCatalogRows()[0]?.id).toBe(client.knownSessionId));

        signals.setForegroundId(client.knownSessionId);

        await waitForAssertion(() => expect(signals.budgetView(client.knownSessionId)).toEqual(budget));
      } finally {
        dispose();
      }
    });
  });

})
function createMissingDetailClient(opts: {
  readonly active?: boolean
  readonly initialStatus?: StatusView
  readonly outputBlocks?: readonly FrontendOutputBlock[]
  readonly outputError?: Error
  readonly outputUnavailable?: boolean
  readonly budget?: BudgetView
} = {}) {
  const knownSessionId = "known-chat"
  const knownRow = testSessionRow(knownSessionId, opts.active ? "active" : "inactive")
  const sequencer = createRuntimeUiPatchSequencer()
  const detailCalls = new Map<string, number>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  let outputWindowCalls = 0
  let status = opts.initialStatus ?? null

  const knownView = { source: "durable" as const, id: knownSessionId, kind: "chat" as const, conversationId: "conv-known", row: knownRow, status: testStatusView, budget: testBudgetView }
  const requestQuery = runtimeQuery({
    snapshot: async () => snapshotResult([knownRow], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })),
    sessionDetail: async (query) => {
      detailCalls.set(query.sessionId, (detailCalls.get(query.sessionId) ?? 0) + 1)
      return { view: query.sessionId === knownSessionId ? knownView : null }
    },
    sessionDetailSnapshot: async (query) => ({
      views: query.sessionIds.map((sessionId) => {
        detailCalls.set(sessionId, (detailCalls.get(sessionId) ?? 0) + 1)
        return { sessionId, view: sessionId === knownSessionId ? knownView : null }
      }),
      snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] }),
    }),
    outputWindow: async (query) => {
      outputWindowCalls += 1
      if (opts.outputError) throw opts.outputError
      if (opts.outputUnavailable) return { snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(knownSessionId) }), totalBlocks: 0, visibleMessageCount: 0, range: { kind: "unavailable", consistencyToken: null, anchor: query.request.range.anchor, window: emptyOutputWindow(), unavailable: unavailableOutput } }
      const blocks = opts.outputBlocks ?? []
      return { snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(knownSessionId) }), totalBlocks: blocks.length, visibleMessageCount: blocks.filter((block) => block.kind === "text" || block.kind === "userMessage").length, range: { kind: "ok", consistencyToken: "test:v1", anchor: query.request.range.anchor, window: blocks.length > 0 ? filledOutputWindow(blocks.length) : emptyOutputWindow(), blocks, streamingToolText: {}, streamingOutputChars: 0 } }
    },
    outputRange: async (query) => {
      if (opts.outputUnavailable) return { kind: "unavailable", consistencyToken: null, anchor: query.request.anchor, window: emptyOutputWindow(), unavailable: unavailableOutput }
      const blocks = opts.outputBlocks ?? []
      return { kind: "ok", consistencyToken: "test:v1", anchor: query.request.anchor, window: blocks.length === 0 ? emptyOutputWindow() : filledOutputWindow(blocks.length), blocks, streamingToolText: {}, streamingOutputChars: 0 }
    },
    outputGroupChildren: async (query) => ({ groups: query.request.groupBlockIds.map((groupBlockId) => ({ groupBlockId, totalChildren: 0, contentBytes: 0, children: [] })), contentBytes: 0 }),
    statusSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: status })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["status"] }) }),
    budgetSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: opts.budget ?? null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["budget"] }) }),
    workflowViewSnapshot: async () => ({ view: null, snapshotPosition: 0 }),
    questionSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["question"] }) }),
    modelAssignments: async () => [],
    modelOptions: async () => [],
    effortOptions: async () => [],
  })
  const dispatch = runtimeDispatch({ "session_detail.release": async () => ({ ok: true }) })
  const appService: ShellStateAppService = {
    ...fakeLanes().client,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    query: requestQuery,
    dispatch,
  }

  return {
    knownSessionId,
    appService,
    sessionDetailCalls: (sessionId: string) => detailCalls.get(sessionId) ?? 0,
    outputWindowCalls: () => outputWindowCalls,
    liveStatus(next: StatusView) {
      status = next
      const event = { type: "patch", patch: sequencer.publish({ cursor: statusCursor(knownSessionId), payload: { kind: "status.updated", status: next } }) } as const
      for (const listener of listeners) listener(event)
    },
  }
}

function testSessionRow(id: string, lifecycleState: SessionCatalogRow["lifecycleState"]): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title: "Known Chat",
    lifecycleState,
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-05-22T00:00:00.000Z",
    executionCwd: "/scratch/flywheel-test",
    totalsLoading: true,
  }
}

const testStatusView: StatusView = {
  activity: "absent",
  activityStartedAt: null,
  settledOutputPosition: null,
  connectionState: "connected" as const,
  activeBackgroundCommands: [],
  activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
  waitingOnBackgroundWork: false,
  replyWaits: [],
  activeSubagentCount: 0,
  startedAt: 0,
  streamingStartedAt: null,
  accumulatedActiveMs: 0,
  compactionStartedAt: null,
}

const testBudgetView = {
  totalsLoading: false as const,
  tokens: 0,
  cost: 0,
  contextPercent: 0,
  contextPromptTokens: 0,
  billedCost: 0,
  priceUnavailable: false,
}



function emptyOutputWindow() {
  return { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, estimatedRows: 0, contentBytes: 0 }
}

function filledOutputWindow(blocks: number) {
  return {
    startBlockIndex: 0,
    endBlockIndex: blocks - 1,
    hasBefore: false,
    hasAfter: false,
    estimatedRows: blocks,
    contentBytes: blocks,
  }
}
