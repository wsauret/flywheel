import { describe, expect, test } from "bun:test"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { testDirectories } from "../../../helpers/directories.js"
import { HandoffCorrectionExhausted, fromStreamError, isAgentRuntimeError, toFailureReason } from "../../../../src/orchestration/agent-runtime/errors"
import { AllCandidatesExhaustedError, QuotaCoordinationError } from "../../../../src/orchestration/agent-runtime/llm/errors"
import { ThinkingStallError } from "../../../../src/orchestration/agent-runtime/llm/thinking-stall"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types"
import { asModelClient } from "./_model-client"
import type { ProviderErrorCopy } from "../../../../src/infra/llm/provider-error-copy"
import { describeAgentFailure, formatAgentFailure } from "../../../../src/orchestration/agent-runtime/failure-message"
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js"

function makeOptions(overrides?: Partial<AgentOptions>): AgentOptions {
  return {
    model: "claude-haiku-4-5-20251001",
    ...testDirectories("/scratch"),
    onEvent: () => {},
    agentRegistry: new Map(),
    agentsMd: "",
    runtimeSurfaces: {},
    purpose: { kind: "interactive-chat" },
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    ...overrides,
  }
}

describe("typed Effect runtime boundary", () => {
  test("local persistence errors leave provider classification unchanged", () => {
    const error = new PersistenceWriteRefused(129, 128, "publication")
    expect(() => fromStreamError(error)).toThrow(error)
    expect(isAgentRuntimeError(error)).toBe(false)
  })
  test.each(["provider", "persistence"] as const)("%s stream errors retain their owning error channel", async (kind) => {
    const copy: ProviderErrorCopy = { presentation: "provider.rate_limited", title: "Rate limited", message: "The provider throttled this request." }
    const refusal = new PersistenceWriteRefused(129, 128, "publication")
    const runner = newTestRunner(
      makeOptions(),
      async () => asModelClient({
        accessProvider: "anthropic_api" as const,
        modelFamily: "anthropic" as const,
        model: "test",
        contextLimit: 100_000,
        outputLimit: 8_000,
        supportsReasoning: false,
        priceFor() { return { status: "unavailable", reason: "missing-rate-card" } },
        async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
          if (kind === "persistence") throw refusal
          throw new AllCandidatesExhaustedError({ message: "socket dropped", copy, recovery: { kind: "none" } })
        },
      }),
    )

    runner.send("hello")
    if (kind === "persistence") {
      await expect(runner.done).rejects.toBe(refusal)
      return
    }
    const result = await runner.done

    expect(result.terminal).toEqual({ kind: "api_error", message: "socket dropped", copy, recovery: { kind: "none" }, candidatesExhausted: true })
    if (result.terminal.kind !== "api_error") throw new Error("expected api_error")
    expect(describeAgentFailure(result.terminal)).toEqual(copy)
    expect(formatAgentFailure(result.terminal)).toBe("Rate limited: The provider throttled this request.")
  })

  test("thinking stalls are typed runtime errors with public failure mapping", () => {
    const error = new ThinkingStallError({ blockKey: "thinking:0", elapsedMs: 120_000, summary: "partial" })

    expect(isAgentRuntimeError(error)).toBe(true)
    expect(toFailureReason(error)).toEqual({
      kind: "stream_stalled",
      message: "thinking block stalled after 120000ms",
      attribution: { kind: "unattributed" },
    })
  })

  test("quota coordination failures keep their tag through the runtime boundary", () => {
    const error = new QuotaCoordinationError({
      message: "the suppression did not reach the durable authority, so this request cannot be served by another provider: db locked",
      provider: "copilot",
      reason: "db locked",
    })

    expect(isAgentRuntimeError(error)).toBe(true)
    expect(fromStreamError(error)).toBe(error)
    expect(toFailureReason(error)).toEqual({
      kind: "api_error",
      message: "copilot: the suppression did not reach the durable authority, so this request cannot be served by another provider: db locked",
      recovery: { kind: "retry" },
    })
  })

  test("an exhausted handoff correction stays out of the typed runtime channel", () => {
    const exhausted = new HandoffCorrectionExhausted({ message: "handoff failed 3 consecutive attempts" })

    expect(isAgentRuntimeError(exhausted)).toBe(false)
  })
})
