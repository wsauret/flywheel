import { describe, expect, test } from "bun:test"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { createTaskProgressWriter } from "../../../../src/orchestration/headless/task-progress.js"

async function collectProgress(emitEvents: (emit: ReturnType<typeof createEmit>) => void): Promise<string[]> {
  const bus = new EventBus()
  const lines: string[] = []
  bus.subscribe(createTaskProgressWriter((line) => lines.push(line)).event, {
    deliveryClass: "diagnostic",
  })
  emitEvents(createEmit(bus))
  await bus.drain()
  await bus.dispose()
  return lines.map((line) => line.replace(/^\[\+\d+s\] /, ""))
}

describe("createTaskProgressWriter", () => {
  test("writes bounded runtime progress without tool input", async () => {
    const lines = await collectProgress((emit) => {
      emit("agent.provider_response.started", { sessionId: "session", data: {} })
      emit("tool.input.completed", {
        sessionId: "session",
        data: { content: [], tool_use: { id: "tool-1", name: "bash", input: { secret: "must-not-appear" } } },
      })
      emit("tool.result.recorded", {
        sessionId: "session",
        data: { tool_use_id: "tool-1", content: [{ type: "text", text: "failed" }], is_error: true },
      })
      emit("model.usage.measured", {
        sessionId: "session",
        data: { usage_entry: { attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.1, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" }, budget_stream_id: "session" },
      })
      emit("agent.error.observed", { sessionId: "session", data: { message: "provider failed ".repeat(1_000) } })
      emit("model.turn.completed", { sessionId: "session", data: {} })
    })

    expect(lines).toEqual([
      "request #1",
      "tool bash",
      "tool result: error",
      "usage out=20 cache=5",
      "error observed",
      "response completed",
    ])
    expect(lines.join("\n")).not.toContain("must-not-appear")
    expect(lines.join("\n")).not.toContain("provider failed")
  })

  test("writes bounded workflow queue and step progress", async () => {
    const lines = await collectProgress((emit) => {
      emit("workflow.run.initialized", { sessionId: "session", data: { attemptIds: ["one", "two"] } })
      emit("workflow.attempt.started", { sessionId: "session", data: { attemptId: "one", agentName: "Build" } })
      emit("workflow.attempt.completed", { sessionId: "session", data: { attemptId: "one", agentName: "Build", resultSummary: "sensitive summary" } })
      emit("workflow.attempt.failed", { sessionId: "session", data: { attemptId: "two", agentName: "Test", reason: "failed safely" } })
      emit("workflow.attempt.interrupted", { sessionId: "session", data: { attemptId: "four", agentName: "Ship", reason: "shutdown" } })
      emit("workflow.run.paused", { sessionId: "session", data: { reason: "operator", attemptsCompleted: 1 } })
      emit("workflow.run.failed", { sessionId: "session", data: { reason: "worker", attemptsCompleted: 1 } })
      emit("workflow.run.completed", { sessionId: "session", data: { attemptsCompleted: 2 } })
    })

    expect(lines).toEqual([
      "workflow initialized attempts=2",
      "agent started: Build",
      "agent completed: Build",
      "agent failed: Test: failed safely",
      "agent interrupted: Ship: shutdown",
      "workflow paused after=1: operator",
      "workflow failed after=1: worker",
      "workflow completed attempts=2",
    ])
    expect(lines.join("\n")).not.toContain("sensitive summary")
  })

  test("ignores adjacent streaming events", async () => {
    const lines = await collectProgress((emit) => {
      emit("tool.input.delta", { sessionId: "session", data: { tool_use_id: "tool-1", partial_json: "secret" } })
      emit("model.content.delta", { sessionId: "session", data: { delta: { type: "text_delta", text: "secret" } } })
    })

    expect(lines).toEqual([])
  })

  test("streams each new line of a running command once, across a shifting tail", async () => {
    const lines = await collectProgress((emit) => {
      const output = (text: string) => emit("tool.execution_output.delta", { sessionId: "session", data: { tool_use_id: "tool-1", output: text } })
      output("tick 1\n")
      output("tick 1\ntick")
      output("tick 1\ntick 2\ntick 3\n")
      output("tick 3\ntick 4\n")
    })

    expect(lines).toEqual(["  | tick 1", "  | tick 2", "  | tick 3", "  | tick 4"])
  })

  test("prints settled usage and failed provider requests that never reach the bus", () => {
    const lines: string[] = []
    const progress = createTaskProgressWriter((line) => lines.push(line.replace(/^\[\+\d+s\] /, "")))
    const entry = { attemptId: "00000000-0000-4000-8000-000000000002", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 10, output: 7, cacheRead: 3, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.1, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" } as const
    progress.usage(entry)
    progress.usage(entry)
    progress.audit({
      type: "model.response_received",
      version: 3,
      actor: "provider",
      payload: {
        requestId: "request-1",
        identity: { providerSessionKey: "provider-1", conversationId: "conversation-1" },
        turn: 1,
        outcome: "fatal_error",
        durationMs: 12,
        error: { tag: "APIConnectionError", message: "secret detail must not appear" },
      },
    })

    expect(lines).toEqual(["usage out=7 cache=3", "request failed: fatal_error (APIConnectionError)"])
  })
})
