import { describe, it, expect } from "bun:test"
import { fileURLToPath } from "node:url"
import { runWithResilience } from "../../../src/orchestration/agent-runtime/agent-resilience.js"
import { workerOutcome } from "../../../src/orchestration/workflow-host/worker-outcome.js"
import type { AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js"
import type { ConnectionState } from "../../../src/infra/output-blocks.js"
import { exhaustedProvidersCopy } from "../../../src/infra/llm/provider-error-copy.js"

describe("workerOutcome", () => {
  it("returns 'completed' when the run completed cleanly", () => {
    expect(workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "completed" } })).toEqual({ output: "completed" })
  })

  it("returns 'context_overflow' for context_overflow", () => {
    expect(workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "context_overflow" } })).toEqual({ output: "context_overflow" })
  })

  it("returns 'failed' for transient_disconnect with the kind and message as the cause", () => {
    expect(workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "transient_disconnect", message: "x" } }))
      .toEqual({ output: "failed", failureKind: "transient_disconnect", failureMessage: "x", failureDetail: "x" })
  })

  it("surfaces an actionable auth message for a provider api_error", () => {
    const outcome = workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "api_error", message: "401 Incorrect API key provided by OpenAI", recovery: { kind: "none" } } })
    if (outcome.output !== "failed") { expect.unreachable(); return }
    expect(outcome.failureMessage).toContain("Authentication failed")
    expect(outcome.failureMessage).toContain("API key was rejected")
  })

  it("frames an unclassified api_error as a failed model request, keeping the raw detail", () => {
    expect(workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "api_error", message: "x", recovery: { kind: "none" } } }))
      .toEqual({ output: "failed", failureKind: "api_error", failureMessage: "Model request failed: x", failureDetail: "x" })
    const copy = exhaustedProvidersCopy([{ provider: "OpenAI", cause: "rate_limit", detail: "slow down", resetsAtMs: undefined }])
    expect(workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind: "api_error", message: "raw aggregate", copy, recovery: { kind: "none" } } }))
      .toEqual({ output: "failed", failureKind: "api_error", failureMessage: "Rate limited: OpenAI: Rate limited. slow down", failureDetail: "raw aggregate" })
  })

  // Every kind that maps to "failed" must carry a cause; an opaque
  // "Worker failed (failed)" is unrepresentable.
  it("gives budget_exhausted, interrupted, and input_closed human-readable causes", () => {
    for (const kind of ["budget_exhausted", "interrupted", "input_closed"] as const) {
      const outcome = workerOutcome({ servedRequests: 0, durationMs: 100, terminal: { kind } })
      if (outcome.output !== "failed") { expect.unreachable(); return }
      expect(outcome.failureKind).toBe(kind)
      expect(outcome.failureMessage.length).toBeGreaterThan(0)
    }
  })
})

describe("runWithResilience", () => {
  function ok(providerSessionKey?: string): AgentRunResult {
    return { servedRequests: 0, durationMs: 100, providerSessionKey, terminal: { kind: "completed" } }
  }
  function makeDeps() {
    const states: ConnectionState[] = []
    const messages: string[] = []
    return {
      states,
      messages,
      deps: {
        setConnectionState: (s: ConnectionState) => { states.push(s) },
        pushSystemMessage: (msg: string) => { messages.push(msg) },
      },
    }
  }

  it("returns final provider failures after one runner invocation", async () => {
    const failures: AgentRunResult["terminal"][] = [
      { kind: "api_error", message: "quota exhausted", recovery: { kind: "none" } },
      { kind: "api_overloaded", message: "overloaded" },
      { kind: "transient_disconnect", message: "stream timeout" },
      { kind: "api_error", message: "unknown provider failure", recovery: { kind: "none" } },
    ]
    for (const terminal of failures) {
      const { states, deps } = makeDeps()
      let runs = 0
      const result = await runWithResilience(async () => {
        runs += 1
        return { servedRequests: 0, durationMs: 50, terminal }
      }, deps)
      expect(runs).toBe(1)
      expect(result.terminal).toEqual(terminal)
      expect(states).toEqual(["connected"])
    }
  })

  it("runs the turn again while the caller's recovery asks, and publishes only the failure it declines", async () => {
    const { messages, states, deps } = makeDeps()
    const attempts: unknown[] = []
    const asked: string[] = []
    const result = await runWithResilience(async (attempt) => {
      attempts.push(attempt)
      return { servedRequests: 0, durationMs: 1, terminal: { kind: "stream_stalled", message: `stalled ${attempts.length}`, attribution: { kind: "unattributed" } } }
    }, {
      ...deps,
      originalProviderSessionKey: "conversation",
      recover: async (failure) => {
        asked.push(failure.kind === "stream_stalled" ? failure.message : failure.kind)
        return asked.length < 3 ? { requestContext: "Continue where you left off." } : null
      },
    })
    expect(attempts).toEqual([
      { isRetry: false, providerSessionKey: "conversation" },
      { isRetry: true, providerSessionKey: "conversation", requestContext: "Continue where you left off." },
      { isRetry: true, providerSessionKey: "conversation", requestContext: "Continue where you left off." },
    ])
    expect(asked).toEqual(["stalled 1", "stalled 2", "stalled 3"])
    expect(result.terminal).toMatchObject({ kind: "stream_stalled", message: "stalled 3" })
    expect(messages).toHaveLength(1)
    expect(states).toEqual(["connected"])
  })

  it("returns the success of a recovered turn, and an abort during recovery ends the turn as aborted", async () => {
    const { messages, deps } = makeDeps()
    let runs = 0
    const recovered = await runWithResilience(async () => {
      runs += 1
      return runs === 1 ? { servedRequests: 0, durationMs: 1, terminal: { kind: "api_overloaded", message: "busy" } } : ok()
    }, { ...deps, recover: async () => ({}) })
    expect(runs).toBe(2)
    expect(recovered.terminal.kind).toBe("completed")
    expect(messages).toEqual([])

    const controller = new AbortController()
    let stopped = 0
    const aborted = await runWithResilience(async () => {
      stopped += 1
      return { servedRequests: 0, durationMs: 1, terminal: { kind: "api_overloaded", message: "busy" } }
    }, { ...deps, signal: controller.signal, recover: async () => { controller.abort(); return {} } })
    expect(stopped).toBe(1)
    expect(aborted.terminal.kind).toBe("aborted")
  })

  it("does not reconnect on aborted", async () => {
    const { states, deps } = makeDeps()
    let runs = 0
    const result = await runWithResilience(() => {
      runs += 1
      return Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "aborted" } })
    }, deps)
    expect(runs).toBe(1)
    expect(result.terminal.kind).toBe("aborted")
    expect(states).toEqual([])
  })

  it("publishes context overflow as terminal without claiming to reconnect", async () => {
    const { messages, states, deps } = makeDeps()
    await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "context_overflow" } }),
      deps,
    )
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain("Context window exceeded")
    expect(messages[0]).not.toContain("Reconnecting")
    expect(states).toEqual(["connected"])
  })

  it("respects AbortSignal before invoking the runner", async () => {
    const { deps } = makeDeps()
    const ac = new AbortController()
    ac.abort()
    let runs = 0
    const result = await runWithResilience(
      () => {
        runs += 1
        return Promise.resolve(ok())
      },
      { ...deps, signal: ac.signal },
    )
    expect(runs).toBe(0)
    expect(result.terminal.kind).toBe("aborted")
  })

  it("preserves abort after a runner settles", async () => {
    const { states, deps } = makeDeps()
    const ac = new AbortController()
    let runs = 0
    const result = await runWithResilience(
      () => {
        runs++
        ac.abort()
        return Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" as const } })
      },
      { ...deps, signal: ac.signal },
    )
    expect(runs).toBe(1)
    expect(result.terminal.kind).toBe("aborted")
    expect(states).toEqual([])
  })

  it("returns result and restores 'connected' on success (clears prior 'down' state)", async () => {
    const { states, messages, deps } = makeDeps()
    const result = await runWithResilience(() => Promise.resolve(ok("s1")), deps)
    expect(result.providerSessionKey).toBe("s1")
    expect(states).toEqual(["connected"])
    expect(messages).toEqual([])
  })
})

describe("describeAgentFailure (via runWithResilience pushSystemMessage)", () => {
  it("formats output_overflow truthfully and returns the connection to idle", async () => {
    const states: ConnectionState[] = []
    const messages: { text: string; level?: "info" | "error" }[] = []
    const result = await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "output_overflow" } }),
      {
        setConnectionState: (s) => { states.push(s) },
        pushSystemMessage: (text, level) => { messages.push({ text, level }) },
      },
    )
    expect(result.terminal.kind).toBe("output_overflow")
    expect(states[states.length - 1]).toBe("connected")
    const last = messages[messages.length - 1]
    expect(last?.text).toBe("Output limit exceeded. The model response exceeded the output limit. Ask for a smaller result or split the request.")
    expect(last?.level).toBe("error")
  })

  it("does not frame a non-connection api_error as a connection failure", async () => {
    const messages: { text: string; level?: "info" | "error" }[] = []
    await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "api_error", message: "400 invalid_request_error: image exceeds maximum dimensions", recovery: { kind: "none" } } }),
      {
        setConnectionState: () => {},
        pushSystemMessage: (text, level) => { messages.push({ text, level }) },
      },
    )
    const last = messages[messages.length - 1]
    expect(last?.text).toContain("Model request failed")
    expect(last?.text).toContain("Provider detail: 400 invalid_request_error")
    expect(last?.text).not.toContain("connect")
    expect(last?.level).toBe("error")
  })

  it("surfaces an actionable, retry-oriented message for a transient upstream 520", async () => {
    const messages: { text: string; level?: "info" | "error" }[] = []
    await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "api_error", message: "520 status code (no body)", recovery: { kind: "none" } } }),
      {
        setConnectionState: () => {},
        pushSystemMessage: (text, level) => { messages.push({ text, level }) },
      },
    )
    const last = messages[messages.length - 1]
    expect(last?.text).toContain("520")
    expect(last?.text).toContain("Send a message to retry")
    expect(last?.text).not.toBe("Failed to connect to model provider: 520 status code (no body)")
    expect(last?.level).toBe("error")
  })
})

describe("agent-resilience module boundaries", () => {
  it("has zero imports from chat-session, chat-types, agent-callback, or step-runner", async () => {
    const source = await Bun.file(
      fileURLToPath(new URL("../../../src/orchestration/agent-runtime/agent-resilience.ts", import.meta.url)),
    ).text()
    expect(source).not.toContain("chat-session")
    expect(source).not.toContain("chat-types")
    expect(source).not.toContain("agent-callback")
    expect(source).not.toContain("step-runner")
  })

})
