import { describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import * as treeSitter from "../../../../src/infra/tree-sitter-parser.js"
import * as abort from "../../../../src/infra/abort.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { availabilityAuthorityDbFile, resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { AVAILABILITY_PROTOCOL_VERSION } from "../../../../src/infra/llm/availability-store.js"
import { disposeSharedProviderAvailability, getSharedProviderAvailability } from "../../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js"
import type { ProviderAvailabilityOwner } from "../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js"
import { QuotaCoordinationError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import type { AgentFactory, AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import * as headlessDeadline from "../../../../src/orchestration/headless/headless-deadline.js"
import type { HeadlessDeadlineController } from "../../../../src/orchestration/headless/headless-deadline.js"
import { runHeadlessTask } from "../../../../src/orchestration/headless/run-headless-task.js"
import { readSessionMetadata } from "../../../../src/orchestration/session/session-metadata-store.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { generationHolders, makeWorkflowDeps } from "./_headless-run-fixtures.js"

const directory = temporaryDirectories()
const launcher = { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) }
const completedAgent: AgentFactory = () => ({ send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }) })

describe("runHeadlessTask ownership", () => {
  test("retires finalized result checkpoints at the canonical flush barrier", async () => {
    const projectRoot = directory("headless-checkpoint-")
    let remaining: number | undefined
    const createAgent: AgentFactory = (options) => {
      const done = Promise.withResolvers<Awaited<ReturnType<AgentFactory>["done"]>>()
      return {
        send() {
          void (async () => {
            if (options.conversation.kind !== "durable-tree") throw new Error("expected durable conversation")
            const conversation = options.conversation
            const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
            try {
              const key = `${conversation.conversationId}:finished-tool`
              store.putInFlight(conversation.sessionId, "finalized-tool-result", key, {
                version: 2, conversationId: conversation.conversationId, toolUseId: "finished-tool", toolName: "read",
                budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "done" }], outcome: "ok",
              })
              const raw = store.readInFlight(conversation.sessionId, "finalized-tool-result")[0]!.raw
              await conversation.append({ kind: "assistant", content: [{ type: "tool_use", id: "finished-tool", name: "read", input: {} }] })
              await conversation.append({ kind: "toolResult", toolUseId: "finished-tool", content: [{ type: "text", text: "done" }] })
              await conversation.flush?.(undefined, [{ kind: "finalized-tool-result", key, expectedRaw: raw }])
              remaining = store.readInFlight(conversation.sessionId, "finalized-tool-result").length
              done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
            } finally { store.close() }
          })().catch(done.reject)
        },
        end() {}, abort() {}, done: done.promise,
      }
    }
    const result = await runHeadlessTask("work", {
      modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
      prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent),
    })
    expect(result.completed).toBe(true)
    expect(remaining).toBe(0)
  })

  test("passes session-owned foreground Bash and recall surfaces to the prompt candidate", async () => {
    const projectRoot = directory("headless-prompt-")
    const captured: AgentOptions[] = []
    const requestCaptures: unknown[] = []
    let tools: readonly string[] | undefined
    const createAgent: AgentFactory = (options) => {
      captured.push(options)
      return {
        send() {
          if (options.conversation.kind === "durable-tree" || options.conversation.kind === "ephemeral") options.conversation.append({
            kind: "assistant",
            content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "headless " }, { type: "tool_use", id: "tool-1", name: "read", input: {} }, { type: "text", text: "complete" }],
          })
          options.lifecycle.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
        },
        end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
      }
    }
    const result = await runHeadlessTask("work", {
      modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
      disabledTools: ["web"], systemPrompt: "literal prompt",
      prepareWorkflowDeps: async (input) => {
        const composition = typeof input.moduleSelection === "function" ? input.moduleSelection() : input.moduleSelection
        tools = composition.contributions.filter((item) => item.domain === "tools").map((item) => item.id)
        requestCaptures.push(input.captureRuntimeConfig(), input.captureRuntimeConfig())
        return makeWorkflowDeps(createAgent)
      },
    })
    const secondResult = await runHeadlessTask("work", { modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false, prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent) })
    expect(secondResult.error).toBeUndefined()
    expect(result.completed).toBe(true)
    expect(captured[0]).toMatchObject({ purpose: { kind: "headless-task", prompt: { kind: "literal", systemPrompt: "literal prompt" } }, lifecycle: { kind: "complete-on-idle", inputSource: expect.anything() } })
    expect(captured[0]?.runtimeSurfaces).toMatchObject({ background: {}, foregroundBashHold: {}, recall: {} })
    expect(captured[1]).toMatchObject({ purpose: { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } }, engineeringDoctrine: false })
    expect(result.finalMessage).toBe("headless complete")
    expect(requestCaptures[0]).toBe(requestCaptures[1])
    expect(result.termination).toEqual({ version: 2, terminal: { kind: "completed" }, deadlineFired: false })
    expect(tools).toBeDefined()
    expect(tools).not.toContain("web")
  })

  test("prepares legacy workspace state before config and event-store startup", async () => {
    const projectRoot = directory("headless-migration-")
    const seeded = prepareWorkspaceState(testDirectories(projectRoot))
    const store = createSqliteEventStore(seeded.dbFile)
    try {
      store.append({ aggregateId: "workflow:malformed", type: "workflow.control.initialized", version: 2, timestamp: 1, actor: "flywheel", sessionId: "malformed", payload: { control: {} } })
    } finally {
      store.close()
      seeded.generation.release()
    }
    let prepared = false
    const result = await runHeadlessTask("work", {
      modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
      prepareWorkflowDeps: async () => { prepared = true; return makeWorkflowDeps(completedAgent) },
    })
    expect(result.error).toBeUndefined()
    expect(result.completed).toBe(true)
    expect(prepared).toBe(true)
    expect(generationHolders(projectRoot)).toEqual([])
  })

  test("closes its owned event store after the runner settles", async () => {
    const projectRoot = testDirectories(directory("headless-owned-store-")).projectRoot
    const dbFile = resolveEventStoreDbFile(projectRoot)
    const order: string[] = []
    const close = Database.prototype.close
    const closing = spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
      if (this.filename === dbFile) order.push("event store closed")
      close.call(this)
    })
    let result
    try {
      result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
        prepareWorkflowDeps: async () => makeWorkflowDeps(() => ({
          send() {}, end() {}, abort() {},
          done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" as const } }).then((value) => { order.push("runner settled"); return value }),
        })),
      })
      expect(result.completed).toBe(true)
      expect(order.at(-1)).toBe("event store closed")
      expect(order.indexOf("runner settled")).toBeGreaterThan(-1)
      expect(order.lastIndexOf("event store closed")).toBeGreaterThan(order.indexOf("runner settled"))
      expect(generationHolders(projectRoot)).toEqual([])
    } finally {
      closing.mockRestore()
    }
    const store = createSqliteEventStore(dbFile)
    try {
      if (!result?.sessionId) throw new Error("task did not publish a session")
      expect(await readSessionMetadata(asAsyncEventReadSurface(store), result.sessionId)).toMatchObject({ kind: "chat", lifecycleState: "inactive" })
    } finally {
      store.close()
    }
  })

  test("opens the durable availability authority before task deps and disposes it after", async () => {
    const projectRoot = directory("headless-availability-")
    const directories = testDirectories(projectRoot)
    let acquired: ProviderAvailabilityOwner | undefined
    let openBeforeDeps = false
    try {
      const result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient, directories, launcher, printErrorsToStderr: false,
        prepareWorkflowDeps: async () => {
          acquired = getSharedProviderAvailability()
          openBeforeDeps = existsSync(availabilityAuthorityDbFile(directories.userDataRoot, AVAILABILITY_PROTOCOL_VERSION))
          return makeWorkflowDeps(completedAgent)
        },
      })
      expect(result.completed).toBe(true)
      expect(openBeforeDeps).toBe(true)
      if (!acquired) throw new Error("task dependencies did not acquire provider availability")
      const disposed = acquired
      expect(() => disposed.forCandidates("default", [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }]).refreshProjection()).toThrow(QuotaCoordinationError)
      expect(getSharedProviderAvailability()).not.toBe(acquired)
      expect(existsSync(availabilityAuthorityDbFile(directories.userDataRoot, AVAILABILITY_PROTOCOL_VERSION))).toBe(true)
    } finally {
      await disposeSharedProviderAvailability()
    }
  })

  test("runs a task again after a provider fault, writes the pause to stderr, and completes", async () => {
    const projectRoot = directory("headless-recovery-")
    const realSleep = abort.abortableSleep
    const pauses: number[] = []
    const sleep = spyOn(abort, "abortableSleep").mockImplementation((ms, signal) => {
      if (ms < 5_000) return realSleep(ms, signal)
      pauses.push(ms)
      return Promise.resolve()
    })
    const stderr: string[] = []
    const write = spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true })
    let runs = 0
    const priorToolCalls: number[] = []
    // The first run records a tool call and its result before the fault, so
    // the recovered run must continue from them, and must hold them once.
    const createAgent: AgentFactory = (options) => {
      runs += 1
      if (options.conversation.kind !== "durable-tree") throw new Error("expected durable conversation")
      const conversation = options.conversation
      priorToolCalls.push(conversation.priorMessages.filter((message) => message.kind === "toolResult" && message.toolUseId === "tool-before-fault").length)
      if (runs > 1) return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" as const } }) }
      const done = (async () => {
        await conversation.append({ kind: "assistant", content: [{ type: "tool_use", id: "tool-before-fault", name: "read", input: {} }] })
        await conversation.append({ kind: "toolResult", toolUseId: "tool-before-fault", content: [{ type: "text", text: "read" }] })
        await conversation.flush?.()
        return { servedRequests: 0, durationMs: 1, terminal: { kind: "api_overloaded" as const, message: "overloaded" } }
      })()
      return { send() {}, end() {}, abort() {}, done }
    }
    try {
      const result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
        prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent),
      })
      expect(result.completed).toBe(true)
      expect(result.termination.terminal).toEqual({ kind: "completed" })
      expect(runs).toBe(2)
      expect(priorToolCalls).toEqual([0, 1])
      expect(pauses).toEqual([5_000])
      expect(stderr.filter((line) => line.includes("Recovering from a provider fault"))).toHaveLength(1)
    } finally {
      write.mockRestore()
      sleep.mockRestore()
    }
  })

  test("a deadline that fires during a capacity wait ends the task at once", async () => {
    const projectRoot = directory("headless-capacity-deadline-")
    let runs = 0
    const createAgent: AgentFactory = () => {
      runs += 1
      const terminal = { kind: "api_error" as const, message: "no capacity", recovery: { kind: "at" as const, atMs: Date.now() + 3_600_000, hold: { kind: "usage_limit", stated: true } as const } }
      return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal }) }
    }
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    const realSleep = abort.abortableSleep
    const capacityWait = Promise.withResolvers<void>()
    const sleep = spyOn(abort, "abortableSleep").mockImplementation((ms, signal) => {
      if (ms >= 60_000) capacityWait.resolve()
      return realSleep(ms, signal)
    })
    // A real deadline also counts setup, whose duration a loaded runner
    // decides. The real deadline arms at once when the capacity wait starts,
    // so it fires inside that wait however long setup took.
    const create = headlessDeadline.createHeadlessDeadline
    let armed: HeadlessDeadlineController | undefined
    const deadline = spyOn(headlessDeadline, "createHeadlessDeadline").mockImplementation(() => ({
      get expired() { return armed?.expired ?? false },
      get expiry() { return armed?.expiry },
      awaitSetup: (operation) => operation,
      awaitActive: async (operation, interrupt) => {
        await Promise.race([operation, capacityWait.promise])
        armed = create(0)
        return await armed.awaitActive(operation, interrupt)
      },
      dispose: () => armed?.dispose(),
    }))
    const startedAt = performance.now()
    try {
      const result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
        prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent),
      })
      expect(result.completed).toBe(false)
      expect(result.termination).toMatchObject({ terminal: { kind: "aborted" }, deadlineFired: true })
      expect(runs).toBe(1)
      expect(performance.now() - startedAt).toBeLessThan(10_000)
    } finally {
      deadline.mockRestore()
      sleep.mockRestore()
      write.mockRestore()
    }
  }, 20_000)

  test("a deadline that fires in setup that nothing races ends the task as aborted", async () => {
    const projectRoot = directory("headless-setup-deadline-")
    let runs = 0
    const createAgent: AgentFactory = (options) => {
      runs += 1
      return completedAgent(options)
    }
    // The real deadline fires at once, and setup passes every raced step, so
    // the deadline is already expired when the turn asks for its context.
    const create = headlessDeadline.createHeadlessDeadline
    const deadline = spyOn(headlessDeadline, "createHeadlessDeadline").mockImplementation(() => {
      const real = create(0)
      return {
        get expired() { return real.expired },
        get expiry() { return real.expiry },
        awaitSetup: (operation) => operation,
        awaitActive: real.awaitActive,
        dispose: real.dispose,
      }
    })
    try {
      const result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient, directories: testDirectories(projectRoot), launcher, printErrorsToStderr: false,
        prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent),
      })
      expect(result.error).toBeUndefined()
      expect(result.termination).toEqual({ version: 2, terminal: { kind: "aborted" }, deadlineFired: true })
      expect(runs).toBe(0)
    } finally {
      deadline.mockRestore()
    }
  })

  test("persists the explicitly captured profile on the headless task session", async () => {
    const projectRoot = directory("headless-profile-")
    const home = directory("headless-profile-home-")
    const directories = { ...testDirectories(projectRoot), accountHome: home, userDataRoot: join(home, ".flywheel") }
    await new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot, env: {} }).create("Headless Work")
    const parserLoad = spyOn(treeSitter, "loadTreeSitterParser").mockRejectedValue(new Error("parser unavailable"))
    try {
      const result = await runHeadlessTask("profile publication", {
        modelsClient: fakeModelsClient, directories, launcher, authProfile: "headless-work", printErrorsToStderr: false,
        prepareWorkflowDeps: async () => ({ ...makeWorkflowDeps(completedAgent), accountHome: home, userDataRoot: directories.userDataRoot }),
      })
      if (!result.completed || !result.sessionId) throw new Error(result.error ?? "task did not publish a session")
      const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
      try {
        expect((await readSessionMetadata(asAsyncEventReadSurface(store), result.sessionId))?.authProfileId).toBe("headless-work")
      } finally {
        store.close()
      }
    } finally {
      parserLoad.mockRestore()
    }
  })
})
