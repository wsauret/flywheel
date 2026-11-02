import { describe, it, expect } from "bun:test"

describe("agent runtime typed errors (T1)", () => {
  it("toFailureReason maps each typed error to the correct AgentFailureReason variant", async () => {
    const { ContextOverflow, OutputOverflow, ApiError, TransientDisconnect, StreamStalled, ApiOverloaded, AgentAborted, toFailureReason } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    expect(toFailureReason(new ContextOverflow())).toEqual({ kind: "context_overflow" })
    expect(toFailureReason(new OutputOverflow())).toEqual({ kind: "output_overflow" })
    expect(toFailureReason(new ApiError({ message: "x", recovery: { kind: "none" } }))).toEqual({ kind: "api_error", message: "x", recovery: { kind: "none" } })
    expect(toFailureReason(new TransientDisconnect({ message: "y" }))).toEqual({ kind: "transient_disconnect", message: "y" })
    expect(toFailureReason(new StreamStalled({ message: "s", attribution: { kind: "unattributed" } }))).toEqual({ kind: "stream_stalled", message: "s", attribution: { kind: "unattributed" } })
    expect(toFailureReason(new ApiOverloaded({ message: "z" }))).toEqual({ kind: "api_overloaded", message: "z" })
    expect(toFailureReason(new AgentAborted())).toEqual({ kind: "aborted" })
  })

})

describe("agent runtime error mapping (T2)", () => {
  it("fromStreamError maps ContextLengthExceededError to ContextOverflow", async () => {
    const { ContextLengthExceededError } = await import("../../../../../src/orchestration/agent-runtime/llm/errors.js")
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new ContextLengthExceededError())
    expect(err._tag).toBe("ContextOverflow")
  })

  it("fromStreamError maps OutputLengthExceededError to OutputOverflow", async () => {
    const { OutputLengthExceededError } = await import("../../../../../src/orchestration/agent-runtime/llm/errors.js")
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new OutputLengthExceededError())
    expect(err._tag).toBe("OutputOverflow")
  })

  it("fromStreamError maps LlmStreamError kind=overload to ApiOverloaded", async () => {
    const { LlmStreamError } = await import("../../../../../src/orchestration/agent-runtime/llm/errors.js")
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new LlmStreamError("overloaded", "overload"))
    expect(err._tag).toBe("ApiOverloaded")
    expect(err.message).toBe("overloaded")
  })

  it("fromStreamError maps LlmStreamError kind=transient to TransientDisconnect", async () => {
    const { LlmStreamError } = await import("../../../../../src/orchestration/agent-runtime/llm/errors.js")
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new LlmStreamError("stream error", "transient"))
    expect(err._tag).toBe("TransientDisconnect")
  })

  it("fromStreamError maps post-start idle timeouts to StreamStalled", async () => {
    const { StreamIdleTimeoutError } = await import("../../../../../src/orchestration/agent-runtime/llm/errors.js")
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new StreamIdleTimeoutError("stream idle", "idle"))
    expect(err._tag).toBe("StreamStalled")
  })

  it("fromStreamError maps unknown Error to ApiError", async () => {
    const { fromStreamError } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const err = fromStreamError(new Error("something broke"))
    expect(err._tag).toBe("ApiError")
    expect(err.message).toBe("something broke")
  })

})

describe("agent resilience with typed errors (T3)", () => {
  it("stream stalls stop after one wire invocation", async () => {
    const { runWithResilience } = await import("../../../../../src/orchestration/agent-runtime/agent-resilience.js")
    const { fromStreamError, toFailureReason } = await import("../../../../../src/orchestration/agent-runtime/errors.js")
    const { withStreamAttempt } = await import("../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js")
    const { ThinkingStallError } = await import("../../../../../src/orchestration/agent-runtime/llm/thinking-stall.js")
    const recoveryAttempts: boolean[] = []
    let attempts = 0
    const result = await runWithResilience(
      async (state) => {
        recoveryAttempts.push(state.isRetry)
        attempts++
        try {
          for await (const _event of withStreamAttempt(async function* (): AsyncGenerator<never> {
            throw new ThinkingStallError({ blockKey: "thinking:0", elapsedMs: 120_000, summary: "partial" })
          }, {})) {
            void _event
          }
          return { servedRequests: 0, durationMs: 50, terminal: { kind: "completed" as const } }
        } catch (error) {
          return { servedRequests: 0, durationMs: 50, terminal: toFailureReason(fromStreamError(error)) }
        }
      },
      {
        setConnectionState: () => {},
        pushSystemMessage: () => {},
      },
    )

    expect(attempts).toBe(1)
    expect(recoveryAttempts).toEqual([false])
    expect(result.terminal).toMatchObject({
      kind: "stream_stalled",
      attribution: { kind: "unattributed" },
    })
  })

  it("budget_exhausted is a clean terminal — no retry", async () => {
    const { runWithResilience } = await import("../../../../../src/orchestration/agent-runtime/agent-resilience.js")
    const states: string[] = []
    const result = await runWithResilience(
      () => Promise.resolve({ servedRequests: 0, durationMs: 50, terminal: { kind: "budget_exhausted" as const } }),
      {
        setConnectionState: (s) => { states.push(s) },
        pushSystemMessage: () => {},
      },
    )
    expect(result.terminal).toEqual({ kind: "budget_exhausted" })
    expect(states).toEqual(["connected"])
  })

  it("ContextOverflow is terminal — no retry", async () => {
    const { runWithResilience } = await import("../../../../../src/orchestration/agent-runtime/agent-resilience.js")
    const states: string[] = []
    const messages: string[] = []
    const result = await runWithResilience(
      () => Promise.resolve({ servedRequests: 0, durationMs: 50, terminal: { kind: "context_overflow" as const } }),
      {
        setConnectionState: (s) => { states.push(s) },
        pushSystemMessage: (msg) => { messages.push(msg) },
      },
    )
    expect(result.terminal.kind).toBe("context_overflow")
    expect(messages[0]).toContain("Context window exceeded")
  })

  it("publishes terminal failure once without reconnect side effects", async () => {
    const { runWithResilience } = await import("../../../../../src/orchestration/agent-runtime/agent-resilience.js")
    const states: string[] = []
    const messages: string[] = []
    let attempt = 0
    await runWithResilience(
      () => Promise.resolve(attempt++ < 3
        ? { servedRequests: 0, durationMs: 50, terminal: { kind: "transient_disconnect" as const, message: "timeout" } }
        : { servedRequests: 0, durationMs: 100, terminal: { kind: "completed" as const } },
      ),
      {
        setConnectionState: (s) => { states.push(s) },
        pushSystemMessage: (msg) => { messages.push(msg) },
      },
    )
    expect(attempt).toBe(1)
    expect(states).toEqual(["connected"])
    expect(messages).toHaveLength(1)
    expect(messages[0]).not.toContain("Reconnecting")
  })

  it("final result maps to AgentRunResult with correct AgentFailureReason", async () => {
    const { runWithResilience } = await import("../../../../../src/orchestration/agent-runtime/agent-resilience.js")
    const result = await runWithResilience(
      () => Promise.resolve({ servedRequests: 0, durationMs: 50, terminal: { kind: "api_error" as const, message: "401", recovery: { kind: "none" } } }),
      {
        setConnectionState: () => {},
        pushSystemMessage: () => {},
      },
    )
    expect(result.terminal).toEqual({ kind: "api_error", message: "401", recovery: { kind: "none" } })
  })
})
