import { describe, expect, it } from "bun:test"

import { EventBus } from "../../../../src/infra/event-bus"
import { createChatRunnerLifecycle } from "../../../../src/orchestration/chat/runner-lifecycle"
import { ChatSessionState } from "../../../../src/orchestration/chat/types"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import {
  askUserStub,
  createTestChatSessionDeps,
  makeMemoryTreeWriter,
  outputSessionStub,
} from "./_chat-session-agent-runtime-fixtures"
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../../src/orchestration/modules"
import type { ModuleChatObserverContext } from "../../../../src/orchestration/module-seams"

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  // The turn pipeline runs as a forked Effect fiber; a macrotask lets its
  // scheduler reach the post-createContext send before assertions.
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const turnEnded = { handoffWritten: false, turnCount: 1 }
const parked = { ...turnEnded, activeBackgroundCount: 0, parkedOnBackgroundWork: false, waitRequested: false, userResumeRequired: false, park: "idle" as const }

/** A parked loop reduced to its lifecycle callbacks: each `send` ends the
 *  turn and parks, and each queued input it consumes opens a logical turn. */
function makeLifecycle(setup: {
  endTurnFailure?: Error
  exitBeforeLifecycle?: boolean
  disableExperiments?: boolean
} = {}) {
  const phases: string[] = []
  const treeWriter = makeMemoryTreeWriter()
  const trackedWriter = {
    ...treeWriter,
    beginTurn: () => { phases.push("begin") },
    endTurn: async () => {
      phases.push("end")
      if (setup.endTurnFailure) throw setup.endTurnFailure
    },
  }
  const resolvers: Array<(result: AgentRunResult) => void> = []
  const runnerOptions: AgentOptions[] = []
  const createAgent = (options: AgentOptions): Agent => {
    runnerOptions.push(options)
    const runAbort = new AbortController()
    const done = new Promise<AgentRunResult>((resolve) => { resolvers.push(resolve) })
    const park = async (): Promise<void> => {
      await options.lifecycle.onTurnEnded?.(turnEnded)
      await options.lifecycle.onTurnParked?.(parked)
      while (await options.lifecycle.inputSource?.prepareWaitForInput?.(runAbort.signal).commit()) {
        options.lifecycle.onLogicalTurnStarted?.({ origin: "user", reason: "queued_input" })
        await options.lifecycle.onTurnEnded?.(turnEnded)
        await options.lifecycle.onTurnParked?.(parked)
      }
    }
    return {
      send() {
        if (setup.exitBeforeLifecycle) resolvers.at(-1)?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
        else void park().catch(() => {})
      },
      end() {},
      abort() {
        runAbort.abort()
        resolvers.at(-1)?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      },
      done,
    }
  }
  let experimentObserverInstalled = false
  const catalog = SHIPPED_MODULES.map((module) => module.id !== "experiments" ? module : {
    ...module,
    observers: module.observers.map((entry) => ({
      ...entry,
      observer: (context: ModuleChatObserverContext) => {
        experimentObserverInstalled = true
        return entry.observer(context)
      },
    })),
  })
  const deps = createTestChatSessionDeps({
    sessionId: "session-tree-phase",
    createAgent,
    treeWriter: trackedWriter,
    moduleSelection: () => composeFirstPartyModules(catalog, setup.disableExperiments ? ["experiments"] : []),
  })
  const state = new ChatSessionState(undefined, () => {})
  const lifecycle = createChatRunnerLifecycle({
    deps,
    eventBus: new EventBus(),
    session: outputSessionStub("session-tree-phase"),
    applyNestedStoredFact: () => {},
    state,
    askUser: askUserStub(),
    setConnectionState() {},
    awaitDurableFacts: async () => {},
    installModuleObserver: (observer) => { observer?.onEvent?.({ type: "text" }) },
  })
  return { lifecycle, phases, runnerOptions, experimentObserverInstalled }
}

describe("chat runner lifecycle owns the tree writer's turn phase", () => {
  it("opens the phase for every logical turn and closes it when the loop parks", async () => {
    const { lifecycle, phases, runnerOptions } = makeLifecycle()

    lifecycle.enqueueInput("first")
    await flushMicrotasks()
    expect(runnerOptions).toHaveLength(1)
    // The runner's first turn opens at context creation; the completed turn's
    // end drains and idles the writer, and the park finds nothing left to do.
    expect(phases).toEqual(["begin", "end", "end"])

    // A message to the parked runner is consumed by the same loop: it opens a
    // turn without a new runner and the park closes it again.
    lifecycle.enqueueInput("second")
    await flushMicrotasks()
    expect(runnerOptions).toHaveLength(1)
    expect(phases).toEqual(["begin", "end", "end", "begin", "end", "end"])
  })

  it("rejects logical-turn durability when the save point fails", async () => {
    const failure = new Error("save point failed")
    const { lifecycle } = makeLifecycle({ endTurnFailure: failure })

    lifecycle.enqueueInput("first")
    await expect(lifecycle.awaitLogicalTurnDurability()).rejects.toBe(failure)
  })

  it("settles logical-turn durability when the runner exits before lifecycle callbacks", async () => {
    const { lifecycle, phases } = makeLifecycle({ exitBeforeLifecycle: true })

    lifecycle.enqueueInput("first")
    await lifecycle.awaitLogicalTurnDurability()

    expect(phases).toEqual(["begin", "end"])
  })

  it("constructs the module-owned chat observer only when experiments is enabled", () => {
    expect(makeLifecycle().experimentObserverInstalled).toBe(true)
    expect(makeLifecycle({ disableExperiments: true }).experimentObserverInstalled).toBe(false)
  })
})
