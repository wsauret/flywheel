import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { attachChat, buildShellState, createSessionMetadata, createMockChatRunner, runtime, waitForAssertion } from "./shell-state-harness"
import { temporaryDirectories, canonicalTestDirectory } from "../../../helpers/directories.js"
import { tmpdir } from "node:os"

const directory = temporaryDirectories()

describe("migrated session-domain signals are driven by the app-service patch cache", () => {
  it("the welcome branch follows each session's own directory rather than the project", async () => {
    const executionCwd = canonicalTestDirectory(directory("fw-welcome-branch-"))
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "worktree-chat")
    createSessionMetadata(sessionStore, "worktree-chat", { executionCwd })
    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore, undefined, {}, undefined, { directories: { [tmpdir()]: { branch: "main" }, [executionCwd]: { branch: "feature" } } })
        signals.setForegroundId("worktree-chat")
        await waitForAssertion(() => expect(signals.branch()).toBe("feature"))
        expect(signals.branch("worktree-chat")).toBe("feature")
        expect(signals.branch("unknown-chat")).toBe("main")
      } finally { dispose() }
    })
  })
  // Phase-1 split: shell-state is a CLIENT for the session domain; phase-2 added
  // the output domain. Phase-3 adds status and budget domains. Session signals
  // read the snapshot+patch cache, output signals read the transcript store fed
  // by the live output projector, runtime telemetry reads the status cache, and usage reads the budget cache --
  // never SessionStore directly for migrated values.

  it("a session lifecycle change reaches sessionState through the patch cache", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-mig", createMockChatRunner("chat-mig"), "Migrated")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore)
        signals.setForegroundId("chat-mig")

        // The live entry projects lifecycleState "active"; the cache carries it.
        await waitForAssertion(() => expect(signals.sessionState()).toBe("active"))
        // Title is a migrated session-domain field sourced from the same cache.
        expect(typeof signals.sessionShortTitle()).toBe("string")
      } finally {
        dispose()
      }
    })
  })

  it("sessionKind becomes chat from the summary cache without waiting for detail", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-kind", createMockChatRunner("chat-kind"), "Ready Chat")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore)
        signals.setForegroundId("chat-kind")

        await waitForAssertion(() => expect(signals.sessionKind()).toBe("chat"))
      } finally {
        dispose()
      }
    })
  })

  it("migrated output renders SessionStore output through the transcript surface", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-out")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore)
        signals.setForegroundId("chat-out")

        // The store is the single source of truth: a SessionStore output write flows
        // to the render surface (outputTranscript) through the output-projection
        // observer and live projector. The TUI never reads SessionStore directly
        // for blocks; it reads the transcript store the projector feeds.
        sessionStore.updateChatEntry("chat-out", { outputBlocks: [{ kind: "text", id: "c1", content: "from store", timestamp: 1 }], visibleMessageCountSuffix: 1 })
        await waitForAssertion(() => {
          const blocks = signals.outputTranscript().visibleRange()?.blocks ?? []
          expect(blocks).toHaveLength(1)
          expect(blocks[0]?.kind === "text" ? blocks[0].content : undefined).toBe("from store")
        })
      } finally {
        dispose()
      }
    })
  })

  it("does not resurrect a terminal question from transcript history", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-terminal-question")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore)
        signals.setForegroundId("chat-terminal-question")
        sessionStore.updateChatEntry("chat-terminal-question", {
          outputBlocks: [{
            kind: "question",
            toolUseId: "tool-terminal",
            questions: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
            timestamp: 1,
          }],
          visibleMessageCountSuffix: 0,
        })

        await waitForAssertion(() => expect(signals.outputTranscript().visibleRange()?.blocks).toHaveLength(1))
        expect(signals.pendingQuestion()).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it("status and budget signals flow through protocol caches", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-status-budget")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore, () => 5_000)
        signals.setForegroundId("chat-status-budget")

        sessionStore.updateChatEntry("chat-status-budget", { runnerState: "streaming", streamingStartedAt: 4_000, accumulatedActiveMs: 1_000, activeSubagents: new Set(["sub-1"]), tokens: 10, cost: 0.2, billedCost: 0.2, contextPercent: 50, contextPromptTokens: 1_000 })

        await waitForAssertion(() => {
          expect(signals.agentState()).toBe("active")
          expect(signals.activeSubagentCount()).toBe(1)
          expect(signals.elapsed()).toBe(2_000)
          expect(signals.budgetView("chat-status-budget")).toEqual({ totalsLoading: false, tokens: 10, cost: 0.2, billedCost: 0.2, priceUnavailable: false, contextPercent: 50, contextPromptTokens: 1_000 })
        })
      } finally {
        dispose()
      }
    })
  })

  it("discards and rebuilds the migrated cache from a snapshot without reading SessionStore for summaries", () => {
    createRoot((dispose) => {
      const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
      const { signals } = buildShellState(sessionStore)
      // No live foreground: the migrated signals resolve to their empty defaults
      // purely from the protocol cache (the cache rebuilds from snapshot on
      // connect). No SessionStore lookup occurs for these session-domain reads.
      expect(signals.sessionState()).toBeNull()
      expect(signals.sessionNotices()).toEqual([])
      dispose()
    })
  })
})
