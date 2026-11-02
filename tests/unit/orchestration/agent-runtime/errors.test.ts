import { describe, it, expect } from "bun:test"
import {
  type AgentRuntimeError,
  ContentRefused,
  fromStreamError,
  StreamStalled,
  toFailureReason,
} from "../../../../src/orchestration/agent-runtime/errors.js"
import { ContentRefusedError, ProviderRequestValidationError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { normalizeProviderAttemptFailure, ProviderAuthenticationError } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"

describe("toFailureReason stream_stalled provider attribution", () => {
  it("carries an attributed stalled provider", () => {
    const reason = toFailureReason(new StreamStalled({
      message: "OpenAI stream idle timeout",
      attribution: { kind: "provider", provider: "chatgpt" },
    }))

    expect(reason).toEqual({ kind: "stream_stalled", message: "OpenAI stream idle timeout", attribution: { kind: "provider", provider: "chatgpt" } })
  })

})

describe("content refusal on the runtime channel", () => {
  it("keeps the refused part, the provider reason, and the provider's original message, and fails as an api_error", () => {
    const original = "400 messages.2.content.1.tool_result.content.1.image.source.base64: The image was specified using the image/png media type, but the image appears to be a image/jpeg image"
    const part = { toolUseId: "toolu_b", partIndex: 1, kind: "image" as const }
    const refused = new ContentRefusedError("anthropic", new Error(original), {
      reason: "The image was specified using the image/png media type, but the image appears to be a image/jpeg image",
      part,
    })

    const typed = fromStreamError(refused)

    expect(typed).toBeInstanceOf(ContentRefused)
    if (!(typed instanceof ContentRefused)) return
    expect(typed.message).toBe(original)
    expect(typed.reason).toBe(refused.reason)
    expect(typed.part).toEqual(part)
    expect(toFailureReason(typed)).toEqual({ kind: "api_error", message: original, recovery: { kind: "none" } })
  })
})

describe("the recovery of a failed request", () => {
  const recoveryOf = (error: AgentRuntimeError) => {
    const reason = toFailureReason(error)
    return reason.kind === "api_error" ? reason.recovery : undefined
  }

  it("lets a later run retry an unknown failure, and never a request the provider rejected or a login that was declined", () => {
    expect(recoveryOf(fromStreamError(new Error("unexpected end of the response")))).toEqual({ kind: "retry" })
    expect(recoveryOf(fromStreamError(new ProviderRequestValidationError("anthropic", "tool_use ids must be unique")))).toEqual({ kind: "none" })
    expect(recoveryOf(fromStreamError(new ProviderAuthenticationError("login declined")))).toEqual({ kind: "none" })
  })

  it("decides from the normalized failure when an outer error wraps the request rejection", () => {
    const wrapped = new Error("request failed", { cause: new ProviderRequestValidationError("anthropic", "tool_use ids must be unique") })
    expect(recoveryOf(fromStreamError(wrapped))).toEqual({ kind: "retry" })
    expect(recoveryOf(fromStreamError(normalizeProviderAttemptFailure(wrapped)))).toEqual({ kind: "none" })
  })
})
