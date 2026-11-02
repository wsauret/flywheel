import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createShellState } from "../../../../src/tui/hooks/shell-state"
import type { AnyBlock, QuestionBlock } from "../../../../src/infra/output-blocks"
import type { FrontendEvent, SessionCatalogRow } from "../../../../src/protocol/app-service-types"
import type { StatusView } from "../../../../src/protocol/status-protocol-types"
import { outputCursor } from "../../../../src/protocol/output-protocol-types"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types"
import { createSessionStore } from "../../../../src/orchestration/session-store/store"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { buildShellState, createSessionMetadata, runtime, waitForAssertion } from "./shell-state-harness"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { snapshotResult } from "../../../helpers/session-catalog.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** Re-activation display path: the supervisor opens the shell with the
 *  reconstructed prior history as DISPLAY blocks (openSessionRuntime priorBlocks). The
 *  transcript surface must render that whole conversation through the live output
 *  cache -- no welcome notice, no truncation -- so the live-first visibleRange is
 *  the single read path. */
describe("re-activated chat renders its seeded prior history", () => {
  const contents = (signals: ReturnType<typeof buildShellState>["signals"]) =>
    signals.outputTranscript().visibleRange()?.blocks.map((block) => block.kind === "text" ? block.content : undefined)

  it("shows seeded prior blocks from openSessionRuntime as a complete live transcript", async () => {
    const sessionId = "reactivate-display"
    const prior: AnyBlock[] = [
      { kind: "userMessage", id: "um-1", content: "Output the numbers 1 to 40", timestamp: 1, pending: false, injected: false },
      { kind: "text", id: "answer", content: Array.from({ length: 40 }, (_, i) => String(i + 1)).join("\n"), timestamp: 2 },
    ]

    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))

    await createRoot(async (dispose) => {
      try {
        // The output projection is already observing the store (built here) before
        // the shell opens -- matching the binary, where the runtime projection is
        // running long before a session is re-activated.
        const { signals } = buildShellState(sessionStore)
        // The exact re-activation seed: durable metadata (persisted when the chat
        // was first created) plus a live shell carrying its reconstructed history.
        createSessionMetadata(sessionStore, sessionId, { label: "Reopened Chat" })
        sessionStore.openSessionRuntime({ sessionId, conversationId: "conv-reactivate", description: "Reopened Chat", priorBlocks: prior })
        signals.setForegroundId(sessionId)

        await waitForAssertion(() => {
          const snap = signals.outputTranscript().visibleRange()
          expect(snap?.blocks.length).toBe(2)
          expect(contents(signals)?.[1]?.startsWith("1\n2\n3")).toBe(true)
          // Whole conversation resident: complete window, no notice (hasContent true).
          expect(snap?.window.hasBefore).toBe(false)
          expect(snap?.window.hasAfter).toBe(false)
        })
      } finally {
        dispose()
      }
    })
  })
})

describe("foreground durable chat activation", () => {
  it("replaces a stale durable foreground view with live output when the catalog row turns active", async () => {
    const client = createDurableThenActiveClient()

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          projectRoot: "/scratch/flywheel-test",
          now: () => 1000,
          setTerminalTitle: () => {},
          showToast: () => {},
        })

        await waitForAssertion(() => {
          expect(signals.sessionCatalogRows()[0]?.lifecycleState).toBe("inactive")
        })

        signals.setForegroundId(client.sessionId)

        await waitForAssertion(() => {
          expect(signals.outputTranscript().visibleRange()?.blocks[0]).toMatchObject({ content: "derived history output" })
        })
        expect(signals.sessionState()).toBe("inactive")
        expect(client.outputWindowCalls()).toBe(1)
        const openedWindowCalls = client.outputWindowCalls()

        client.activate()

        await waitForAssertion(() => {
          expect(client.outputWindowCalls()).toBeGreaterThan(openedWindowCalls)
          const block = signals.outputTranscript().visibleRange()?.blocks[0]
          expect(block?.kind === "text" ? block.content : undefined).toBe("live after activation")
        })
      } finally {
        dispose()
      }
    })
  })
})

describe("inactive foreground question hydration", () => {
  it("loads a durable pending question when an inactive session is selected", async () => {
    const client = createDurableThenActiveClient()

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          now: () => 1000,
          projectRoot: "/scratch/flywheel-test",
          setTerminalTitle: () => {},
          showToast: () => {},
        })

        await waitForAssertion(() => {
          expect(signals.sessionCatalogRows()[0]?.lifecycleState).toBe("inactive")
        })
        expect(client.questionSnapshotCalls()).toBe(0)

        signals.setForegroundId(client.sessionId)

        await waitForAssertion(() => {
          expect(signals.pendingQuestion()?.toolUseId).toBe("global-skill-approval")
        })
        expect(client.questionSnapshotCalls()).toBe(1)
      } finally {
        dispose()
      }
    })
  })
})

describe("foreground catalog row updates", () => {
  it("reads no detail for a listed chat, and a catalog rename does not rewrite the ordered transcript cache", async () => {
    const client = createLiveDetailRefetchClient()

    await createRoot(async (dispose) => {
      try {
        const { signals } = createShellState({
          appService: client.appService,
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          projectRoot: "/scratch/flywheel-test",
          now: () => 1000,
          setTerminalTitle: () => {},
          showToast: () => {},
        })

        signals.setForegroundId(client.sessionId)

        await waitForAssertion(() => {
          const block = signals.outputTranscript().visibleRange()?.blocks[0]
          expect(block?.kind === "text" ? block.content : undefined).toBe("seed from ordered snapshot")
        })

        client.publishLiveOutput("newer ordered stream")
        await waitForAssertion(() => {
          const block = signals.outputTranscript().visibleRange()?.blocks[0]
          expect(block?.kind === "text" ? block.content : undefined).toBe("newer ordered stream")
        })

        client.publishCatalogTitle("Renamed chat")

        await waitForAssertion(() => {
          expect(signals.sessionShortTitle()).toBe("Renamed chat")
          expect(client.sessionDetailCalls()).toBe(0)
          const block = signals.outputTranscript().visibleRange()?.blocks[0]
          expect(block?.kind === "text" ? block.content : undefined).toBe("newer ordered stream")
        })
      } finally {
        dispose()
      }
    })
  })
})


type ShellStateAppService = Parameters<typeof createShellState>[0]["appService"]


function createDurableThenActiveClient() {
  const sessionId = "durable-then-active-chat"
  const sequencer = createRuntimeUiPatchSequencer()
  const listeners = new Set<(event: FrontendEvent) => void>()
  let currentRow = testSessionRow(sessionId, "inactive")
  let outputWindowCallCount = 0
  let questionSnapshotCallCount = 0

  const requestQuery = runtimeQuery({
    snapshot: async () => snapshotResult([currentRow], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })),
    outputWindow: async () => {
      outputWindowCallCount += 1
      const content = currentRow.lifecycleState === "active" ? "live after activation" : "derived history output"
      const blocks = [textBlock("live", content)]
      return {
        snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) }),
        totalBlocks: blocks.length,
        visibleMessageCount: 1,
        range: { kind: "ok", consistencyToken: "test:v1", anchor: { kind: "tail" }, window: filledOutputWindow(blocks.length), blocks, streamingToolText: {}, streamingOutputChars: 0 },
      }
    },
    outputRange: async (query) => ({ kind: "ok", consistencyToken: "test:v1", anchor: query.request.anchor, window: emptyOutputWindow(), blocks: [], streamingToolText: {}, streamingOutputChars: 0 }),
    outputGroupChildren: async (query) => ({ groups: query.request.groupBlockIds.map((groupBlockId) => ({ groupBlockId, totalChildren: 0, contentBytes: 0, children: [] })), contentBytes: 0 }),
    statusSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["status"] }) }),
    budgetSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["budget"] }) }),
    workflowViewSnapshot: async () => ({ view: null, snapshotPosition: 0 }),
    questionSnapshot: async (query) => {
      questionSnapshotCallCount += 1
      return {
        views: query.sessionIds.map((id) => ({ sessionId: id, view: globalSkillApprovalQuestion() })),
        snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["question"] }),
      }
    },
    modelAssignments: async () => [],
    modelOptions: async () => [],
    effortOptions: async () => [],
  })
  const appService: ShellStateAppService = {
    dispatch: runtimeDispatch({}),
    ...fakeLanes().client,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    query: requestQuery,
  }

  return {
    sessionId,
    appService,
    activate() {
      currentRow = testSessionRow(sessionId, "active")
      const patch = sequencer.publish({ cursor: sessionCursor(sessionId), payload: { kind: "session.updated", row: currentRow } })
      for (const listener of listeners) listener({ type: "patch", patch })
    },
    outputWindowCalls: () => outputWindowCallCount,
    questionSnapshotCalls: () => questionSnapshotCallCount,
  }
}

function createLiveDetailRefetchClient() {
  const sessionId = "live-detail-refetch-chat"
  const row = testSessionRow(sessionId, "active")
  const sequencer = createRuntimeUiPatchSequencer()
  const listeners = new Set<(event: FrontendEvent) => void>()
  let sessionDetailCallCount = 0

  const requestQuery = runtimeQuery({
    snapshot: async () => snapshotResult([row], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })),
    sessionDetailSnapshot: async () => {
      sessionDetailCallCount += 1
      return {
        snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] }),
        views: [{ sessionId, view: {
          source: "live",
          id: sessionId,
          kind: "chat",
          conversationId: "conv-live-refetch",
          streamingToolText: {},
          row,
          status: testStatusView,
          budget: testBudgetView,
        } }],
      }
    },
    outputWindow: async () => {
      const blocks = [textBlock("seed", "seed from ordered snapshot")]
      return {
        snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) }),
        totalBlocks: blocks.length,
        visibleMessageCount: 1,
        range: { kind: "ok", consistencyToken: "test:v1", anchor: { kind: "tail" }, window: filledOutputWindow(blocks.length), blocks, streamingToolText: {}, streamingOutputChars: 0 },
      }
    },
    outputRange: async (query) => ({ kind: "ok", consistencyToken: "test:v1", anchor: query.request.anchor, window: emptyOutputWindow(), blocks: [], streamingToolText: {}, streamingOutputChars: 0 }),
    outputGroupChildren: async (query) => ({ groups: query.request.groupBlockIds.map((groupBlockId) => ({ groupBlockId, totalChildren: 0, contentBytes: 0, children: [] })), contentBytes: 0 }),
    statusSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: testStatusView })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["status"] }) }),
    budgetSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: testBudgetView })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["budget"] }) }),
    workflowViewSnapshot: async () => ({ view: null, snapshotPosition: 0 }),
    questionSnapshot: async (query) => ({ views: query.sessionIds.map((id) => ({ sessionId: id, view: null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["question"] }) }),
    modelAssignments: async () => [],
    modelOptions: async () => [],
    effortOptions: async () => [],
  })
  const appService: ShellStateAppService = {
    dispatch: runtimeDispatch({}),
    ...fakeLanes().client,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    query: requestQuery,
  }

  return {
    sessionId,
    appService,
    publishCatalogTitle(title: string) {
      const patch = sequencer.publish({
        cursor: sessionCursor(sessionId),
        payload: { kind: "session.updated", row: { ...row, title, shortTitle: title } },
      })
      for (const listener of listeners) listener({ type: "patch", patch })
    },
    publishLiveOutput(content: string) {
      const patch = sequencer.publish({
        cursor: outputCursor(sessionId),
        payload: {
          kind: "output.delta",
          delta: {
            visibleMessageCount: 1,
            truncateTo: 0,
            blocks: [{ kind: "upsert", index: 0, blockId: "text:stream", block: textBlock("stream", content) }],
          },
        },
      })
      for (const listener of listeners) listener({ type: "patch", patch })
    },
    sessionDetailCalls: () => sessionDetailCallCount,
  }
}

function testSessionRow(id: string, lifecycleState: "active" | "inactive"): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title: "Loaded Chat",
    lifecycleState,
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/scratch/flywheel-test",
    totalsLoading: true,
  }
}

function textBlock(id: string, content: string): AnyBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function globalSkillApprovalQuestion(): QuestionBlock {
  return {
    kind: "question",
    toolUseId: "global-skill-approval",
    questions: [{
      question: "Apply this global skill change?",
      choices: [
        { kind: "option", choiceId: "approve", label: "Approve the global skill change" },
        { kind: "option", choiceId: "reject", label: "Reject the global skill change" },
        { kind: "freeform", label: "Other" },
      ],
      multiSelect: false,
    }],
    timestamp: 1,
  }
}


const testStatusView: StatusView = {
  activity: "absent",
  activityStartedAt: null,
  settledOutputPosition: null,
  connectionState: "connected",
  activeBackgroundCommands: [],
  activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
  waitingOnBackgroundWork: false,
  replyWaits: [],
  activeSubagentCount: 0,
  startedAt: 0,
  streamingStartedAt: null,
  accumulatedActiveMs: 0,
  compactionStartedAt: null,
} as const

const testBudgetView = {
  totalsLoading: false,
  tokens: 0,
  cost: 0,
  contextPercent: 0,
  contextPromptTokens: 0,
  billedCost: 0,
  priceUnavailable: false,
} as const

function emptyOutputWindow() {
  return { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 }
}

function filledOutputWindow(blocks: number) {
  return {
    startBlockIndex: 0,
    endBlockIndex: blocks - 1,
    hasBefore: false,
    hasAfter: false,
    contentBytes: blocks * 64,
  }
}
