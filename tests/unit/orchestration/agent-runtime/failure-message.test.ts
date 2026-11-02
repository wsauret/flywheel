import { describe, expect, it } from "bun:test"
import { exhaustedProvidersCopy } from "../../../../src/infra/llm/provider-error-copy.js"
import { blockedFailureRecord, describeAgentFailure, formatAgentFailure } from "../../../../src/orchestration/agent-runtime/failure-message.js"
import { PersistenceWriteRefused, type PersistenceWriteStage } from "../../../../src/infra/event-store-types.js"

describe("describeAgentFailure", () => {
  it("describes the known file stage without provider guidance", () => {
    const cases: [PersistenceWriteStage | undefined, string][] = [
      [undefined, ""],
      ["preparation", " No file changes were applied."],
      ["publication", " A file change may already be applied. Its durable settlement is unresolved; Flywheel will inspect it during recovery."],
      ["final-result", " The file changes already settled. Their final tool result could not be saved."],
    ]
    for (const [stage, suffix] of cases) {
      const reason = { kind: "local_persistence_error", error: new PersistenceWriteRefused(129, 128, stage) } as const
      expect(blockedFailureRecord(describeAgentFailure(reason))).toBe(
        `Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes.${suffix}`,
      )
    }
  })
  it("names provider setup when no model provider is set up", () => {
    const copy = describeAgentFailure({ kind: "model_unavailable", missing: "provider", message: "No captured provider catalog maps \"powerful\" to a wire model id." })
    expect(copy.title).toBe("No model provider")
    expect(copy.guidance).toContain("/auth")
    expect(copy.guidance).not.toContain("/model")
    expect(copy.action).toEqual({ label: "Set up providers", command: "/auth" })
  })

  it("names a model switch when providers exist but none offers the model", () => {
    const copy = describeAgentFailure({ kind: "model_unavailable", missing: "offering", message: "No captured provider catalog maps \"x\" to a wire model id." })
    expect(copy.title).toBe("Model unavailable")
    expect(copy.action?.command).toBe("/model")
  })

  it("says the account's model access is still being checked and to try again in a moment, with no setup or model switch", () => {
    const reason = { kind: "model_unavailable", missing: "access", message: "No captured provider catalog maps \"powerful\" to a wire model id." } as const
    expect(blockedFailureRecord(describeAgentFailure(reason))).toBe(
      "Model access still being checked. Flywheel is still checking which models your provider account can use. Try again in a moment; the chat does not send the message again by itself.",
    )
    expect(formatAgentFailure(reason)).not.toContain("wire model id")
  })
})

describe("formatAgentFailure", () => {
  it("renders an actionable headline for an auth api_error", () => {
    const msg = formatAgentFailure({ kind: "api_error", message: "401 Incorrect API key provided by OpenAI", recovery: { kind: "none" } })
    expect(msg).toContain("Authentication failed")
  })

  it("falls back to an extracted detail for unclassified api_errors", () => {
    expect(formatAgentFailure({ kind: "api_error", message: "something odd happened", recovery: { kind: "none" } })).toBe("Model request failed: something odd happened")
  })

  it("renders ChatGPT OAuth failures as auth failures", () => {
    const msg = formatAgentFailure({
      kind: "api_error",
      message: "ChatGPT sign-in is required before this model request can continue. Run /auth and select ChatGPT when you are ready.", recovery: { kind: "none" }
    })
    expect(msg).toContain("Authentication failed")
    expect(msg).toContain("ChatGPT sign-in is required")
  })

  it("preserves OpenRouter age-confirmation guidance instead of blaming the API key", () => {
    const msg = formatAgentFailure({
      kind: "api_error",
      message: "403 This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences.", recovery: { kind: "none" }
    })
    expect(msg).toContain("OpenRouter")
    expect(msg).toContain("18+ age confirmation")
    expect(msg).toContain("https://openrouter.ai/settings/preferences")
    expect(msg).not.toContain("API key was rejected")
  })

  it("passes through transient_disconnect messages verbatim", () => {
    expect(formatAgentFailure({ kind: "transient_disconnect", message: "stream closed" })).toBe("stream closed")
  })

  it("passes api_overloaded messages through verbatim (humanized by the resilience exhaustion path)", () => {
    const exhausted = "Persistent provider overload after 10 recovery attempts: Overloaded"
    expect(formatAgentFailure({ kind: "api_overloaded", message: exhausted })).toBe(exhausted)
  })

  it("keeps the whole provider detail in the prose a workflow step records as its failure", () => {
    const detail = `automatic recheck failed ${"y".repeat(500)}`
    expect(formatAgentFailure({ kind: "transient_disconnect", message: detail })).toBe(detail)
    const copy = exhaustedProvidersCopy([
      { provider: "first", cause: "quota", detail: "x".repeat(400), resetsAtMs: undefined },
      { provider: "ChatGPT", cause: "connection", detail, resetsAtMs: undefined },
    ])
    expect(formatAgentFailure({ kind: "api_error", message: "no access provider can run", copy, recovery: { kind: "none" } })).toEndWith(`ChatGPT: Connection lost. ${detail}`)
  })

  it("labels structured terminal kinds", () => {
    expect(formatAgentFailure({ kind: "context_overflow" })).toBe("Context window exceeded")
    expect(formatAgentFailure({ kind: "output_overflow" })).toBe("Output overflow")
    expect(formatAgentFailure({ kind: "aborted" })).toBe("Aborted")
  })
})
