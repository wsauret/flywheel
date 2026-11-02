import { describe, expect, it } from "bun:test"
import { runWithResilience } from "../../../src/orchestration/agent-runtime/agent-resilience.js"
import type { AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js"
import type { SessionNoticeOperation } from "../../../src/infra/session-notice.js"
import { createProjectNotificationSink } from "../../../src/orchestration/modules/project-notifications/sink.js"

function ok(providerSessionKey?: string): AgentRunResult {
  return { servedRequests: 0, durationMs: 100, providerSessionKey, terminal: { kind: "completed" } }
}

describe("runWithResilience notices", () => {
  it("publishes no outage notice while a runner is active", async () => {
    const noticeOperations: SessionNoticeOperation[] = []
    let markSecondAttemptStarted = (): void => {}
    let finishSecondAttempt = (_result: AgentRunResult): void => {}
    const secondAttemptStarted = new Promise<void>((resolve) => { markSecondAttemptStarted = resolve })
    const secondAttemptResult = new Promise<AgentRunResult>((resolve) => { finishSecondAttempt = resolve })

    const resultPromise = runWithResilience(
      () => {
        markSecondAttemptStarted()
        return secondAttemptResult
      },
      {
        setConnectionState: () => {},
        pushSystemMessage: () => {},
        onNotice: (operation) => { noticeOperations.push(operation) },
      },
    )

    await secondAttemptStarted

    expect(noticeOperations).toEqual([])

    finishSecondAttempt(ok("s2"))
    const result = await resultPromise
    expect(result.terminal).toEqual({ kind: "completed" })
  })

  it("surfaces a terminal stall without restarting the runner", async () => {
    const noticeOperations: SessionNoticeOperation[] = []
    const systemMessages: string[] = []
    const states: string[] = []
    const requestContexts: Array<string | undefined> = []

    const result = await runWithResilience(
      (attempt) => {
        requestContexts.push(attempt.requestContext)
        return Promise.resolve<AgentRunResult>({ servedRequests: 0,
          durationMs: 50,
          terminal: { kind: "stream_stalled", message: "idle timeout", attribution: { kind: "unattributed" } },
        })
      },
      {
        setConnectionState: (state) => { states.push(state) },
        pushSystemMessage: (message) => { systemMessages.push(message) },
        onNotice: (operation) => { noticeOperations.push(operation) },
      },
    )

    expect(requestContexts).toEqual([undefined])
    expect(states).not.toContain("reconnecting")
    expect(result.terminal).toMatchObject({ kind: "stream_stalled" })
    expect(noticeOperations.filter((operation) => operation.type === "upsert")).toEqual([])
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]).toContain("Model response stalled")
  })

  it("reports overload once without a reconnect notice", async () => {
    const noticeOperations: SessionNoticeOperation[] = []
    const messages: string[] = []
    let attempt = 0
    const result = await runWithResilience(
      () => {
        attempt++
        if (attempt === 1) {
          return Promise.resolve<AgentRunResult>({ servedRequests: 0,
            durationMs: 50,
            terminal: { kind: "api_overloaded", message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
          })
        }
        return Promise.resolve(ok("s2"))
      },
      {
        setConnectionState: () => {},
        pushSystemMessage: (message) => { messages.push(message) },
        onNotice: (operation) => { noticeOperations.push(operation) },
      },
    )

    expect(attempt).toBe(1)
    expect(result.terminal.kind).toBe("api_overloaded")
    expect(noticeOperations).toEqual([{ type: "resolve-scope", scope: "runner:provider" }])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("Overloaded")
    expect(messages[0]).not.toContain('{"type"')
  })

  it("bounds a long provider detail where the transcript shows it", async () => {
    const messages: string[] = []
    await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 50, terminal: { kind: "transient_disconnect", message: "z".repeat(1000) } }),
      { setConnectionState: () => {}, pushSystemMessage: (message: string) => { messages.push(message) } },
    )
    expect(messages.at(-1)).toContain(`Provider detail: ${"z".repeat(400)}...`)
    expect(messages.at(-1)).not.toContain("z".repeat(401))
  })

  it("reports final overload in the transcript without a progress notice", async () => {
    const noticeOperations: SessionNoticeOperation[] = []
    const systemMessages: string[] = []
    const overloaded = (): AgentRunResult => ({ servedRequests: 0,
      durationMs: 50,
      terminal: { kind: "api_overloaded", message: "Overloaded" },
    })
    const deps = {
      setConnectionState: () => {},
      pushSystemMessage: (message: string) => { systemMessages.push(message) },
      onNotice: (operation: SessionNoticeOperation) => { noticeOperations.push(operation) },
    }

    const exhausted = await runWithResilience(() => Promise.resolve(overloaded()), deps)
    expect(exhausted.terminal.kind).toBe("api_overloaded")
    expect(noticeOperations.at(-1)).toEqual({ type: "resolve-scope", scope: "runner:provider" })
    expect(noticeOperations.filter((operation) => operation.type === "upsert")).toEqual([])
    expect(systemMessages.at(-1)).toContain("Provider overloaded.")
    expect(systemMessages.at(-1)).toContain("/model")
    expect(systemMessages.at(-1)).toContain("Provider detail: Overloaded")
  })

  it("records a terminal auth api_error as one complete transcript message, leaving no notice behind", async () => {
    const noticeOperations: SessionNoticeOperation[] = []
    const systemMessages: string[] = []
    const result = await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0,
        durationMs: 10,
        terminal: { kind: "api_error", message: "401 Incorrect API key provided by OpenAI", recovery: { kind: "none" } },
      }),
      {
        setConnectionState: () => {},
        pushSystemMessage: (message: string) => { systemMessages.push(message) },
        onNotice: (operation) => { noticeOperations.push(operation) },
      },
    )

    expect(result.terminal.kind).toBe("api_error")
    // The terminal exit resolves any progress notice and upserts nothing:
    // the transcript message is the one surface, guidance included.
    expect(noticeOperations).toEqual([{ type: "resolve-scope", scope: "runner:provider" }])
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]).toContain("Authentication failed.")
    expect(systemMessages[0]).toContain("/auth")
  })

  it("keeps the full guidance in the system message when no notice channel exists", async () => {
    const systemMessages: string[] = []
    await runWithResilience(
      () => Promise.resolve<AgentRunResult>({ servedRequests: 0,
        durationMs: 10,
        terminal: { kind: "api_error", message: "429 usage limit reached", recovery: { kind: "none" } },
      }),
      {
        setConnectionState: () => {},
        pushSystemMessage: (message: string) => { systemMessages.push(message) },
      },
    )
    expect(systemMessages).toHaveLength(1)
    expect(systemMessages[0]).toContain("Out of credits")
    expect(systemMessages[0]).toContain("/model")
  })
})

describe("project notification sink", () => {
  it("closes admission when durable settlement starts", async () => {
    const operations: string[] = []
    const activeSources = new Set(["accepted"])
    const sink = createProjectNotificationSink({
      journal: {
        raise: async () => { throw new Error("raise is not used") },
        resolve: async (sourceId) => { operations.push(sourceId) },
        activeSourceIds: async () => new Set(activeSources),
      },
    })

    void sink.apply({ type: "resolve", sourceId: "accepted" })
    await sink.settled()
    void sink.apply({ type: "resolve", sourceId: "rejected" }).catch(() => {})
    await Promise.resolve()

    expect(operations).toEqual(["accepted"])
  })
})
