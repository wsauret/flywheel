import { describe, it, expect } from "bun:test"
import { createRunnerContext } from "../src/orchestration/runner-context"
import type { Engine, EngineResult, EngineRunner, RunnerOptions } from "../src/orchestration/engines/core/types"
import type { UserEventToolResult } from "../src/infra/ndjson-event-types"

interface FakeRunnerHandle {
  runner: EngineRunner
  resolveDone: (result: EngineResult) => void
  rejectDone: (err: unknown) => void
  sendCalls: string[]
  abortCalls: number
  endCalls: number
  toolResultCalls: UserEventToolResult[]
  drainCalls: number
  drainReturn: string[] | null
}

interface FakeEngineOptions {
  withSendToolResult?: boolean
  withDrainPendingInputs?: boolean
  drainReturn?: string[]
}

function createFakeEngine(fakeOptions: FakeEngineOptions = {}): { engine: Engine; handles: FakeRunnerHandle[] } {
  const handles: FakeRunnerHandle[] = []

  const engine: Engine = {
    metadata: {
      id: "fake",
      name: "Fake",
      defaultModel: "test",
      description: "test fake engine",
    } as Engine["metadata"],
    createRunner(_options: RunnerOptions): EngineRunner {
      let resolveDone!: (result: EngineResult) => void
      let rejectDone!: (err: unknown) => void
      const done = new Promise<EngineResult>((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      })

      const handle: FakeRunnerHandle = {
        runner: null as unknown as EngineRunner,
        resolveDone,
        rejectDone,
        sendCalls: [],
        abortCalls: 0,
        endCalls: 0,
        toolResultCalls: [],
        drainCalls: 0,
        drainReturn: fakeOptions.drainReturn ?? null,
      }

      const runner: EngineRunner = {
        send(text: string) { handle.sendCalls.push(text) },
        abort() { handle.abortCalls++ },
        end() { handle.endCalls++ },
        done,
      }

      if (fakeOptions.withSendToolResult) {
        runner.sendToolResult = (toolResult) => { handle.toolResultCalls.push(toolResult) }
      }

      if (fakeOptions.withDrainPendingInputs) {
        runner.drainPendingInputs = () => {
          handle.drainCalls++
          return handle.drainReturn ?? []
        }
      }

      handle.runner = runner
      handles.push(handle)
      return runner
    },
  }

  return { engine, handles }
}

function baseOptions(): RunnerOptions {
  return {
    model: "test",
    cwd: "/tmp",
    onEvent: () => {},
  }
}

describe("createRunnerContext", () => {
  it("ctx.done resolves with the underlying runner's EngineResult", async () => {
    const { engine, handles } = createFakeEngine()
    const ctx = createRunnerContext({ engine, ...baseOptions() })

    expect(handles.length).toBe(1)
    handles[0]!.resolveDone({ durationMs: 42, sessionId: "abc" })

    await expect(ctx.done).resolves.toEqual({ durationMs: 42, sessionId: "abc" })
  })

  it("ctx.done carries result.failure for aborted / api_error / budget_exhausted runners", async () => {
    for (const failure of [
      { kind: "aborted" } as const,
      { kind: "api_error", message: "boom" } as const,
      { kind: "budget_exhausted" } as const,
    ]) {
      const { engine, handles } = createFakeEngine()
      const ctx = createRunnerContext({ engine, ...baseOptions() })
      handles[0]!.resolveDone({ durationMs: 5, failure })
      const result = await ctx.done
      expect(result.failure?.kind).toBe(failure.kind)
    }
  })

  it("ctx.done rejects when the underlying runner rejects", async () => {
    const { engine, handles } = createFakeEngine()
    const ctx = createRunnerContext({ engine, ...baseOptions() })
    handles[0]!.rejectDone(new Error("subprocess died"))

    await expect(ctx.done).rejects.toThrow("subprocess died")
  })

  it("send / abort / end forward to the underlying runner", () => {
    const { engine, handles } = createFakeEngine()
    const ctx = createRunnerContext({ engine, ...baseOptions() })

    ctx.send("hello")
    ctx.send("world")
    ctx.abort()
    ctx.abort()
    ctx.end()

    expect(handles[0]!.sendCalls).toEqual(["hello", "world"])
    expect(handles[0]!.abortCalls).toBe(2)
    expect(handles[0]!.endCalls).toBe(1)
  })

  it("drainPendingInputs returns the runner's drained queue or [] when absent", () => {
    const withDrain = createFakeEngine({ withDrainPendingInputs: true, drainReturn: ["msg-1", "msg-2"] })
    const ctxWith = createRunnerContext({ engine: withDrain.engine, ...baseOptions() })
    expect(ctxWith.drainPendingInputs()).toEqual(["msg-1", "msg-2"])
    expect(withDrain.handles[0]!.drainCalls).toBe(1)

    const withoutDrain = createFakeEngine({ withDrainPendingInputs: false })
    const ctxWithout = createRunnerContext({ engine: withoutDrain.engine, ...baseOptions() })
    expect(ctxWithout.drainPendingInputs()).toEqual([])
  })

  it("sendToolResult is present only when the runner supports it, and forwards through", () => {
    const withEngine = createFakeEngine({ withSendToolResult: true })
    const withCtx = createRunnerContext({ engine: withEngine.engine, ...baseOptions() })
    expect(typeof withCtx.sendToolResult).toBe("function")

    const toolResult: UserEventToolResult = { type: "tool_result", tool_use_id: "call-1", content: "ok" }
    withCtx.sendToolResult!(toolResult)
    expect(withEngine.handles[0]!.toolResultCalls).toEqual([toolResult])

    const withoutCtx = createRunnerContext({ engine: createFakeEngine({ withSendToolResult: false }).engine, ...baseOptions() })
    expect(withoutCtx.sendToolResult).toBeUndefined()
  })

  it("each context exposes a distinct done promise so callers can guard on identity", async () => {
    // The wrapper's job is to expose a stable identity per spawn; the caller
    // (chat-session) guards stale completions by comparing `state.runner === thisCtx`.
    const { engine: engineA, handles: handlesA } = createFakeEngine()
    const { engine: engineB, handles: handlesB } = createFakeEngine()

    const ctxA = createRunnerContext({ engine: engineA, ...baseOptions() })
    const ctxB = createRunnerContext({ engine: engineB, ...baseOptions() })

    expect(ctxA).not.toBe(ctxB)
    expect(ctxA.done).not.toBe(ctxB.done)

    handlesA[0]!.resolveDone({ durationMs: 1, failure: { kind: "aborted" } })
    handlesB[0]!.resolveDone({ durationMs: 2 })

    const [aResult, bResult] = await Promise.all([ctxA.done, ctxB.done])
    expect(aResult.failure?.kind).toBe("aborted")
    expect(bResult.failure).toBeUndefined()
  })
})