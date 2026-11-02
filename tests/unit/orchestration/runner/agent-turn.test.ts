import { describe, expect, it, mock, spyOn } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { wakeInput, type AgentLoopWakeInput } from "../../../../src/infra/agent-loop-events.js"
import { runAgentTurn } from "../../../../src/orchestration/runner/agent-turn.js"
import { AgentTurnAborted } from "../../../../src/orchestration/runner/agent-turn-types.js"
import type { Agent, AgentRunResult } from "../../../../src/orchestration/agent-runtime/types.js"
import { HandoffCorrectionExhausted } from "../../../../src/orchestration/agent-runtime/errors.js"
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js"
import { applySessionNoticeOperation, type SessionNotice, type SessionNoticeOperation } from "../../../../src/infra/session-notice.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { subscribeSessionRuntimeFacts } from "../../../../src/orchestration/session/create-session-infra.js"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"

type MockRunnerContext = Agent & { sendCalled: Array<string | AgentLoopWakeInput>; endCalled: boolean }

function createMockContext(result: AgentRunResult | Promise<AgentRunResult>): MockRunnerContext {
  const ctx: MockRunnerContext = {
    sendCalled: [],
    endCalled: false,
    send(input: string | AgentLoopWakeInput): void { ctx.sendCalled.push(input) },
    abort(): void {},
    end(): void { ctx.endCalled = true },
    done: Promise.resolve(result),
  }
  return ctx
}

describe("runAgentTurn", () => {
  it("records a local persistence refusal once in the transcript without provider recovery or a refusal toast", async () => {
    const diagnostic = spyOn(DebugLog, "record")
    const error = new PersistenceWriteRefused(129, 128, "preparation")
    const ctx = createMockContext(Promise.reject(error))
    const notices: SessionNoticeOperation[] = []
    const recover = mock(async () => ({ requestContext: "retry" }))
    const pushSystemMessage = mock((_message: string, _level?: "info" | "error") => {})
    const resilience = { onNotice: (operation: SessionNoticeOperation) => notices.push(operation), recover, pushSystemMessage }
    const result = await runAgentTurn({ createContext: () => ctx, message: "hello", resilience })
    expect(result.terminal).toEqual({ kind: "local_persistence_error", error })
    expect(recover).not.toHaveBeenCalled()
    expect(pushSystemMessage.mock.calls).toEqual([["Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes. No file changes were applied.", "error"]])
    expect(notices.filter((operation) => operation.type === "upsert")).toEqual([])
    expect(ctx.endCalled).toBe(true)
    await runAgentTurn({ createContext: () => createMockContext({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }), message: "done", resilience })
    expect(diagnostic.mock.calls.filter(([record]) => record.type === "runtime.persistence_write.refused")).toHaveLength(1)
    diagnostic.mockRestore()
  })
  it("keeps one transcript explanation after the subscriber observes the refusal before the terminal", async () => {
    const bus = new EventBus()
    const error = new PersistenceWriteRefused(129, 128, "publication")
    const messages: string[] = []
    let notices: readonly SessionNotice[] = []
    const operations: SessionNoticeOperation[] = []
    const onNotice = (operation: SessionNoticeOperation) => {
      operations.push(operation)
      notices = applySessionNoticeOperation(notices, operation)
    }
    bus.subscribeToType("agent.notice.changed", (event) => onNotice(event.data.operation))
    const writer: SessionFactWriter = {
      record: async () => { throw error }, recordBatch: async () => [], recordGuarded: async () => null,
      transaction: async (work) => { work() }, dispose() {},
    }
    const subscription = subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer })
    createEmit(bus)("agent.error.observed", { sessionId: "s", data: { message: "not saved" } })
    await bus.drain()
    expect(subscription.getPersistenceFailure()).toBe(error)
    expect(operations).toEqual([])
    const result = await runAgentTurn({
      createContext: () => createMockContext(subscription.awaitDurableFacts().then(() => ({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }))),
      message: "work", resilience: { onNotice, pushSystemMessage: (message) => messages.push(message) },
    })
    expect(result.terminal.kind).toBe("local_persistence_error")
    expect(notices).toEqual([])
    expect(operations).toEqual([{ type: "resolve-scope", scope: "runner:provider" }])
    expect(messages).toEqual(["Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes. A file change may already be applied. Its durable settlement is unresolved; Flywheel will inspect it during recovery."])
    subscription.unsubscribe()
    await bus.dispose()
  })
  it("returns callback failures with the run's served requests and closes the context once", async () => {
    const callbacks = {
      classifyResult: { classifyResult: () => { throw new Error("callback failed") } },
      onAttemptFailure: { onAttemptFailure: async () => { throw new Error("callback failed") } },
    }
    for (const callback of Object.values(callbacks)) {
      const ctx = createMockContext({ durationMs: 1, servedRequests: 3, terminal: { kind: "stream_stalled", message: "stalled", attribution: { kind: "unattributed" } } })
      let ends = 0
      ctx.end = () => { ends += 1 }
      const result = await runAgentTurn({ createContext: (_attempt, run) => { run.tally.served = 3; return ctx }, message: "start", resilience: {}, ...callback })
      expect(result).toEqual({ durationMs: 0, servedRequests: 3, terminal: { kind: "api_error", message: "callback failed", recovery: { kind: "retry" } } })
      expect(ends).toBe(1)
    }
  })
  it("continues the turn's call budget in each recovered run, also after a run that rejected, and serves its progress to recovery", async () => {
    const prior: number[] = []
    const served: number[] = []
    const runs: Array<{ requests: number; served: number; done: Promise<AgentRunResult> }> = [
      { requests: 2, served: 1, done: Promise.reject(new Error("usage ledger append failed")) },
      { requests: 3, served: 0, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "transient_disconnect", message: "socket closed" } }) },
      { requests: 1, served: 1, done: Promise.resolve({ servedRequests: 1, durationMs: 1, terminal: { kind: "completed" } }) },
    ]
    const result = await runAgentTurn({
      createContext: (_attempt, run) => {
        prior.push(run.priorLLMCalls)
        const next = runs[prior.length - 1]!
        Object.assign(run.tally, { requests: next.requests, served: next.served })
        return createMockContext(next.done)
      },
      message: "work",
      resilience: { recover: async (_failure, servedRequests) => { served.push(servedRequests); return {} } },
    })
    expect(prior).toEqual([0, 2, 5])
    expect(served).toEqual([1, 0])
    expect(result.terminal).toEqual({ kind: "completed" })
  })
  it("preserves an unowned runtime AbortError as an aborted turn and closes once", async () => {
    let ends = 0;
    const result = await runAgentTurn({
      createContext: () => ({ send() {}, abort() {}, end() { ends++; }, done: Promise.reject(new DOMException("aborted", "AbortError")) }),
      message: "continue",
      resilience: {},
    });
    expect(result.terminal).toEqual({ kind: "aborted" });
    expect(ends).toBe(1);
  });
  it("calls createContext and sends the message", async () => {
    const expectedResult: AgentRunResult = { servedRequests: 0, durationMs: 100, terminal: { kind: "completed" } }
    const ctx = createMockContext(expectedResult)
    const createContext = mock(() => ctx)

    const agentResult = await runAgentTurn({
      createContext,
      message: "hello",
      resilience: { setConnectionState: () => {}, pushSystemMessage: () => {} },
    })

    expect(createContext).toHaveBeenCalledTimes(1)
    expect(ctx.sendCalled).toEqual(["hello"])
    expect(ctx.endCalled).toBe(true)
    expect(agentResult).toEqual(expectedResult)
  })

  it("returns transient_disconnect without rebuilding the outer turn", async () => {
    const firstCtx = createMockContext({ servedRequests: 0, durationMs: 50, terminal: { kind: "transient_disconnect", message: "stream died" } })
    const createContextCalls: Array<{ resumeId: string | undefined; isRetry: boolean }> = []
    const resilience = {
      setConnectionState: () => {},
      pushSystemMessage: () => {},
      originalProviderSessionKey: "resume-id",
    }

    const agentResult = await runAgentTurn({
      createContext: ({ providerSessionKey, isRetry }) => {
        createContextCalls.push({ resumeId: providerSessionKey, isRetry })
        return firstCtx
      },
      message: "original",
      resilience,
    })

    expect(agentResult.terminal).toEqual({ kind: "transient_disconnect", message: "stream died" })
    expect(firstCtx.sendCalled).toEqual(["original"])
    expect(createContextCalls).toEqual([{ resumeId: "resume-id", isRetry: false }])
  })

  it("calls ctx.end() even when ctx.done rejects", async () => {
    const ctx = createMockContext(Promise.reject(new Error("stream died")))
    const createContext = mock(() => ctx)

    const agentResult = await runAgentTurn({
      createContext,
      message: "hello",
      resilience: { setConnectionState: () => {}, pushSystemMessage: () => {} },
    })

    expect(ctx.endCalled).toBe(true)
    expect(agentResult.terminal.kind).toBe("api_error")
  })

  it("lets an exhausted handoff correction escape, not as a provider api_error, and still closes the context", async () => {
    const exhausted = new HandoffCorrectionExhausted({ message: "handoff failed 3 consecutive attempts" })
    const ctx = createMockContext(Promise.reject(exhausted))

    const turn = runAgentTurn({ createContext: () => ctx, message: "hello", resilience: {} })

    await expect(turn).rejects.toBe(exhausted)
    expect(ctx.endCalled).toBe(true)
  })

  it("handles AgentTurnAborted from createContext", async () => {
    const createContext = mock(() => { throw new AgentTurnAborted() })

    const agentResult = await runAgentTurn({
      createContext,
      message: "hello",
      resilience: { setConnectionState: () => {}, pushSystemMessage: () => {} },
    })

    expect(agentResult.terminal.kind).toBe("aborted")
  })

  it("applies classifyResult before ending the context", async () => {
    const ctx = createMockContext({ servedRequests: 0, durationMs: 100, terminal: { kind: "completed" } })
    const classifyResult = mock((result: AgentRunResult): AgentRunResult => {
      expect(ctx.endCalled).toBe(false)
      return {
        ...result,
        terminal: { kind: "api_error", message: "sentinel", recovery: { kind: "none" } },
      }
    })

    const agentResult = await runAgentTurn({
      createContext: () => ctx,
      message: "hello",
      resilience: { setConnectionState: () => {}, pushSystemMessage: () => {} },
      classifyResult,
    })

    expect(classifyResult).toHaveBeenCalledTimes(1)
    expect(ctx.endCalled).toBe(true)
    expect(agentResult.terminal).toEqual({ kind: "api_error", message: "sentinel", recovery: { kind: "none" } })
  })

  it("passes terminal failures to resilience", async () => {
    const messages: Array<{ message: string; level: "info" | "error" | undefined }> = []
    const ctx = createMockContext({ servedRequests: 0, durationMs: 0, terminal: { kind: "api_error", message: "401", recovery: { kind: "none" } } })

    await runAgentTurn({
      createContext: () => ctx,
      message: "hi",
      resilience: {
        setConnectionState: () => {},
        pushSystemMessage: (message, level) => { messages.push({ message, level }) },
      },
    })

    expect(messages).toEqual([{ message: "Model request failed. The provider rejected the request. Send a message to retry. Provider detail: 401", level: "error" }])
  })

  it("sends a typed wake so a respawned runner loop starts without a message", async () => {
    const ctx = createMockContext({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })

    await runAgentTurn({
      createContext: () => ctx,
      resilience: { setConnectionState: () => {}, pushSystemMessage: () => {} },
      message: wakeInput(),
    })

    expect(ctx.sendCalled).toEqual([wakeInput()])
  })
})
