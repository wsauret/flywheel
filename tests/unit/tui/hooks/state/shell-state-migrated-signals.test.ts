import { describe, expect, it, jest } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionStore } from "../../../../../src/orchestration/session-store/store"
import { EventReaderService } from "../../../../../src/infra/store/event-store-effect.js"
import { createRuntimeUiPatchSequencer } from "../../../../../src/orchestration/app-service/projections/runtime-ui-patch-sequencer.js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../../src/protocol/runtime/app-service-types.js"
import { commandCatalogCursor } from "../../../../../src/protocol/commands/command-catalog-protocol-types.js"
import { commandUsageCursor } from "../../../../../src/protocol/commands/command-usage-protocol-types.js"
import { gitAiAttributionCursor } from "../../../../../src/protocol/git/git-ai-attribution-protocol-types.js"
import { gitCursor } from "../../../../../src/protocol/git/git-protocol-types.js"
import { PROTOCOL_MODULE_DOMAINS } from "../../../../../src/protocol/modules.js"
import { runtimeConfigCursor } from "../../../../../src/protocol/settings/runtime-config-protocol-types.js"
import type { RuntimeCursorIdentity } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import { createRuntimeConfigCache } from "../../../../../src/tui/hooks/state/runtime/create-runtime-config-cache.js"
import { createShellState } from "../../../../../src/tui/hooks/state/shell-state.js"
import { attachChat, buildShellState, createSessionMetadata, createMockChatRunner, runtime, waitForAssertion } from "./shell-state-harness"
import { temporaryDirectories, canonicalTestDirectory } from "../../../../helpers/directories.js"
import { fakeLanes, LANE_BREAK } from "../../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { configView } from "../../../../helpers/runtime-views.js"
import { countStateRequests, type StateRequestCounter } from "../../../../helpers/state-requests.js"
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

/** A runtime client whose workspace reads answer at the current position of
 *  their cursor, unless a test holds them, and whose other reads never answer. */
function workspaceClient() {
  const sequencer = createRuntimeUiPatchSequencer()
  const lanes = fakeLanes()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const at = (cursor: RuntimeCursorIdentity) => sequencer.snapshotPosition({ kind: "cursor", cursor })
  const heldConfigReads: Array<PromiseWithResolvers<void>> = []
  let holdConfig = false
  let configRevision = 1
  const query = runtimeQuery({
    configSnapshot: async () => {
      if (holdConfig) {
        const read = Promise.withResolvers<void>()
        heldConfigReads.push(read)
        await read.promise
      }
      return { snapshotPosition: at(runtimeConfigCursor()), config: { ...configView(), revision: configRevision } }
    },
    gitSnapshot: async () => ({ snapshotPosition: at(gitCursor()), git: { directories: {} } }),
    gitAiAttributionSnapshot: async () => ({ snapshotPosition: at(gitAiAttributionCursor()), status: { kind: "available" } }),
    commandUsageSnapshot: async () => ({ snapshotPosition: at(commandUsageCursor()), usage: { uses: [] } }),
    commandCatalog: async () => ({ snapshotPosition: at(commandCatalogCursor()), revision: 1, builtInCommands: [], offCommands: [] }),
  }, () => new Promise<never>(() => {}))
  const appService: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane" | "watchOutput"> = {
    ...lanes.client,
    query,
    dispatch() { throw new Error("No mutation expected") },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    appService,
    lanes,
    emit,
    heldConfigReads,
    holdConfigReads(hold: boolean) { holdConfig = hold },
    setConfigRevision(revision: number) { configRevision = revision },
    publish: (patch: Parameters<typeof sequencer.publish>[0]) => emit({ type: "patch", patch: sequencer.publish(patch) }),
  }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
/** Lets every read that has answered land, without a timer, for a test that fakes them. */
const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }
/** The kinds of the reads a counted client made since the last call. */
const readKinds = (counter: StateRequestCounter<object>) => counter.take().flatMap((request) => {
  const [first] = request.args
  return request.method === "query" && typeof first === "object" && first !== null && "type" in first && typeof first.type === "string" ? [first.type] : []
})

describe("whole-view workspace domains are held views", () => {
  it("A failed config read keeps the last view and retries with backoff; a lane break cancels the retry; a new lane reads once", async () => {
    const h = workspaceClient()
    const counter = countStateRequests(h.appService)
    let configReads = 0
    const countConfigReads = () => {
      configReads += readKinds(counter).filter((kind) => kind === "configSnapshot").length
      return configReads
    }
    await createRoot(async (dispose) => {
      jest.useFakeTimers()
      try {
        const config = createRuntimeConfigCache({ appService: counter.reader })
        await flush()
        expect(config.view()?.revision).toBe(1)
        expect(countConfigReads()).toBe(1)

        h.holdConfigReads(true)
        h.publish({ cursor: runtimeConfigCursor(), payload: { kind: "runtime.invalidate", reason: "overflow" } })
        expect(countConfigReads()).toBe(2)
        h.heldConfigReads[0]!.reject(new Error("the runtime could not read its configuration"))
        await flush()
        expect(config.view()?.revision).toBe(1)
        expect(jest.getTimerCount()).toBe(1)

        jest.runOnlyPendingTimers()
        await flush()
        expect(countConfigReads()).toBe(3)
        h.heldConfigReads[1]!.reject(new Error("the runtime could not read its configuration"))
        await flush()
        expect(jest.getTimerCount()).toBe(1)

        h.lanes.end()
        h.emit(LANE_BREAK)
        expect(jest.getTimerCount()).toBe(0)
        expect(countConfigReads()).toBe(3)
        expect(config.view()?.revision).toBe(1)

        h.holdConfigReads(false)
        h.setConfigRevision(2)
        h.lanes.open()
        await flush()
        expect(countConfigReads()).toBe(4)
        expect(config.view()?.revision).toBe(2)
      } finally {
        jest.useRealTimers()
        dispose()
      }
    })
  })

  it("N Git patches over M held workspace domains cause zero reads, and one invalidation causes one read per domain", async () => {
    const heldQueries = [
      "configSnapshot", "gitSnapshot", "gitAiAttributionSnapshot", "commandUsageSnapshot", "commandCatalog", "updateSnapshot", "moduleSnapshot",
      ...PROTOCOL_MODULE_DOMAINS.filter((domain) => domain.scope === "workspace").map((domain) => domain.snapshot.query),
    ].sort()
    const h = workspaceClient()
    const counter = countStateRequests(h.appService)
    const reads = () => readKinds(counter)
    await createRoot(async (dispose) => {
      try {
        const runtimeConfig = createRuntimeConfigCache({ appService: counter.reader })
        const { signals } = createShellState({
          appService: counter.reader, runtimeConfig, now: () => 0, projectRoot: "/scratch/project",
          setTerminalTitle: () => {}, showToast: () => {},
        })
        await settle()
        expect(reads().filter((type) => heldQueries.includes(type)).sort()).toEqual(heldQueries)

        for (let patch = 1; patch <= 20; patch++) h.publish({ cursor: gitCursor(), payload: { kind: "git.changed", git: { directories: { "/scratch/project": { branch: `branch-${patch}` } } } } })
        await settle()
        expect(signals.branch()).toBe("branch-20")
        expect(reads()).toEqual([])

        h.publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } })
        await settle()
        expect(reads().filter((type) => heldQueries.includes(type)).sort()).toEqual(heldQueries)
      } finally {
        dispose()
      }
    })
  })
})
