import { describe, expect, it } from "bun:test"
import type { Agent, AgentRunResult } from "../../../../../../src/orchestration/agent-runtime/types.js"
import { createAgentHost } from "../../../../../../src/orchestration/agent-runtime/runner/turn-host/host.js"
import { newTestRunner } from "../../../../../helpers/agent-runner.js"
import { makeOptions } from "../../_runner-options.js"

function completedRunner(messages: string[]): Agent {
  return {
    send(message): void { if (typeof message === "string") messages.push(message) },
    abort(): void {},
    done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
  }
}

function createPreparingHost() {
  const preparationStarted = Promise.withResolvers<void>()
  let attempts = 0
  const host = createAgentHost<{ model: string }>({
    createRunner: () => ({
      send(): void {},
      abort(): void {},
      interruptGeneration(): boolean { return false },
      done: Promise.resolve({ servedRequests: 0, durationMs: ++attempts, terminal: { kind: "completed" as const } }),
    }),
  })
  return {
    host,
    preparationStarted: preparationStarted.promise,
    attempts: () => attempts,
    run: (signal?: AbortSignal) => host.runTurn({
      createContextOptions: () => {
        preparationStarted.resolve()
        return new Promise<{ model: string }>(() => {})
      },
      message: "hello",
      resilience: signal ? { signal } : {},
    }),
  }
}

describe("runner host", () => {
  it("creates and runs one context", async () => {
    const messages: string[] = []
    const host = createAgentHost<{ model: string }>({ createRunner: () => completedRunner(messages) })

    const result = await host.runTurn({
      createContextOptions: () => ({ model: "test", executionCwd: "/scratch", projectRoot: "/scratch", userDataRoot: "/scratch", accountHome: "/scratch", promptKind: "chat", runtimeSurfaces: {} }),
      message: "hello",
      resilience: {},
    })

    expect(messages).toEqual(["hello"])
    expect(result).toEqual({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } } satisfies AgentRunResult)
  })

  it("returns aggregate provider failure after one context", async () => {
    let attempts = 0
    const createRunner = (): Agent => {
      const terminal = attempts++ === 0
        ? { kind: "api_overloaded", message: "busy" } as const
        : { kind: "completed" } as const
      return {
        send(): void {},
        abort(): void {},
        done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal }),
      }
    }
    const host = createAgentHost<{ model: string }>({ createRunner })

    const result = await host.runTurn({
      createContextOptions: () => ({ model: "test", executionCwd: "/scratch", projectRoot: "/scratch", userDataRoot: "/scratch", accountHome: "/scratch", promptKind: "chat", runtimeSurfaces: {} }),
      message: "hello",
      resilience: {},
    })

    expect(result.terminal.kind).toBe("api_overloaded")
    expect(attempts).toBe(1)
  })

  it("targets interruption, abort, and settlement at the active generation", async () => {
    let resolveDone: ((result: AgentRunResult) => void) | undefined
    const runnerCreated = Promise.withResolvers<void>()
    const calls: string[] = []
    const createRunner = (): Agent => {
      runnerCreated.resolve()
      return {
        send(): void {},
        abort(): void { calls.push("abort") },
        interruptGeneration(): boolean { calls.push("interrupt"); return true },
        done: new Promise((resolve) => { resolveDone = resolve }),
      }
    }
    const host = createAgentHost<{ model: string }>({ createRunner })
    const running = host.runTurn({
      createContextOptions: () => ({ model: "test", executionCwd: "/scratch", projectRoot: "/scratch", userDataRoot: "/scratch", accountHome: "/scratch", promptKind: "chat" }),
      message: "hello",
      resilience: {},
    })
    await runnerCreated.promise

    expect(host.generationState).toBe("active")
    expect(host.interruptGeneration()).toBe(true)
    host.abortGeneration()
    let settled = false
    void host.settle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveDone?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await running
    await host.settle()
    expect(host.generationState).toBe("idle")
    expect(calls).toEqual(["interrupt", "abort"])
  })

  it("cancels pending preparation when no model context can accept interruption", async () => {
    const recovery = createPreparingHost()
    const turnResult = Promise.withResolvers<AgentRunResult>()
    const lease = recovery.host.reserveTurn()
    if (!lease) throw new Error("expected a turn lease")
    recovery.host.startTurn(lease, async () => { turnResult.resolve(await recovery.run(lease.signal)) })

    await recovery.preparationStarted
    const interrupted = recovery.host.interruptGeneration()
    if (!interrupted) recovery.host.interruptTurn()
    await recovery.host.settle()

    expect(interrupted).toBe(true)
    expect(await turnResult.promise).toMatchObject({ terminal: { kind: "aborted" } })
    expect(recovery.attempts()).toBe(0)
  })

  it("aborts pending preparation without a chat turn lease", async () => {
    const recovery = createPreparingHost()
    const running = recovery.run()

    await recovery.preparationStarted
    recovery.host.abortGeneration()

    expect(await running).toMatchObject({ terminal: { kind: "aborted" } })
    expect(recovery.attempts()).toBe(0)
  })

  it("does not create a runner after interruption during context construction", async () => {
    const contextOptions = Promise.withResolvers<{ model: string }>()
    let runnersCreated = 0
    const host = createAgentHost<{ model: string }>({
      createRunner: () => {
        runnersCreated += 1
        return {
          send(): void {},
          abort(): void {},
          done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
        }
      },
    })
    const running = host.runTurn({
      createContextOptions: () => contextOptions.promise,
      message: "hello",
      resilience: {},
    })
    await Promise.resolve()

    expect(host.interruptGeneration()).toBe(true)
    const settledBeforeRelease = await Promise.race([
      running.then(() => true),
      Bun.sleep(5).then(() => false),
    ])
    contextOptions.resolve({ model: "test" })

    expect(await running).toMatchObject({ terminal: { kind: "aborted" } })
    expect(settledBeforeRelease).toBe(true)
    expect(runnersCreated).toBe(0)
  })

  it("preserves a settled provider failure when interrupted during its durable flush", async () => {
    const flushStarted = Promise.withResolvers<void>()
    const releaseFlush = Promise.withResolvers<void>()
    let attempts = 0
    const host = createAgentHost<{ model: string }>({
      createRunner: () => {
        const terminal = attempts++ === 0
          ? { kind: "api_error" as const, message: "provider failed", recovery: { kind: "none" as const } }
          : { kind: "completed" as const }
        return {
          send(): void {},
          abort(): void {},
          interruptGeneration(): boolean { return true },
          done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal }),
        }
      },
    })
    const running = host.runTurn({
      createContextOptions: () => ({ model: "test" }),
      message: "hello",
      resilience: {},
      onAttemptFailure: async () => {
        flushStarted.resolve()
        await releaseFlush.promise
      },
    })

    await flushStarted.promise
    const interrupted = host.interruptGeneration()
    releaseFlush.resolve()

    expect(interrupted).toBe(true)
    expect(await running).toMatchObject({ terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } })
    expect(attempts).toBe(1)
  })

  it("A real LiveAgent that was never sent anything settles done after abort, and the host can start the next generation", async () => {
    const options = { model: "test", executionCwd: "/scratch", projectRoot: "/scratch", userDataRoot: "/scratch", accountHome: "/scratch", promptKind: "chat" }
    const messages: string[] = []
    const runners: Agent[] = []
    const host = createAgentHost<typeof options>({
      createRunner: () => {
        const runner = runners.length === 0
          ? newTestRunner(makeOptions(), () => { throw new Error("no model request is expected") })
          : completedRunner(messages)
        runners.push(runner)
        return runner
      },
    })

    const failed = await host.runTurn({
      createContextOptions: () => options,
      onContextCreated: () => { throw new Error("callback failed") },
      message: "hello",
      resilience: {},
    })
    expect(failed).toMatchObject({ terminal: { kind: "api_error", message: "callback failed", recovery: { kind: "retry" } } })
    expect(await runners[0]!.done).toMatchObject({ terminal: { kind: "aborted" } })
    await host.settle()
    expect(host.generationState).toBe("idle")

    const next = await host.runTurn({ createContextOptions: () => options, message: "again", resilience: {} })
    expect(next.terminal).toEqual({ kind: "completed" })
    expect(messages).toEqual(["again"])
  })
})
