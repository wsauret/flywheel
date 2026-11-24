import { describe, it, expect } from "bun:test"
import { authErrorCopy, expiredSignInMessage } from "../../../../../src/infra/llm/errors/auth-error.js"

const text = (copy: ReturnType<typeof authErrorCopy>) => copy === undefined ? undefined : `${copy.problem} ${copy.guidance}`

describe("authErrorCopy", () => {
  it("returns the actionable explanation without echoing the raw provider text", () => {
    const copy = text(authErrorCopy("401 Incorrect API key provided. See https://platform.openai.com"))
    expect(copy).toContain("API key was rejected")
    expect(copy).not.toContain("Provider response")
  })

  it("never names a provider from the error text, which names the SDK rather than the account", () => {
    expect(text(authErrorCopy("401 Incorrect API key provided. See https://platform.openai.com"))).toContain("The model provider's API key was rejected")
    expect(text(authErrorCopy("invalid x-api-key"))).toContain("The model provider's API key was rejected")
  })

  it("names the provider that served the request, even when the text names another one", () => {
    expect(authErrorCopy("401 Incorrect API key provided. See https://platform.openai.com", { name: "QA Stub", credential: "api_key" })).toEqual({
      kind: "credential",
      problem: "The QA Stub API key was rejected. This is a configuration problem, not a connection error.",
      guidance: "Verify a valid API key is configured for QA Stub and retry.",
    })
  })

  it("explains expired ChatGPT OAuth as a reconnect problem", () => {
    const copy = text(authErrorCopy("ChatGPT sign-in is required before this model request can continue. Run /auth and select ChatGPT when you are ready."))
    expect(copy).toContain("ChatGPT sign-in is required")
    expect(copy).toContain("Run /auth and reconnect ChatGPT")
  })

  it("states OpenRouter age confirmation as an account setting, with its link once and no credential advice", () => {
    const url = "https://openrouter.ai/settings/preferences"
    const copy = authErrorCopy(`403 This model requires you to complete the following before use: 18+ age confirmation. Confirm at ${url}.`)
    expect(copy?.kind).toBe("account_setting")
    expect(text(copy)?.split(url).length).toBe(2)
    expect(text(copy)).not.toContain("/auth")
  })

  it("returns undefined for non-auth errors so callers keep their own text", () => {
    expect(authErrorCopy("rate limited")).toBeUndefined()
    expect(authErrorCopy("Output overflow")).toBeUndefined()
    expect(authErrorCopy("stream closed before completion")).toBeUndefined()
  })
})

describe("expiredSignInMessage", () => {
  it("names the provider and the sign-in action", () => {
    expect(expiredSignInMessage("ChatGPT")).toBe("ChatGPT sign-in expired. Run /auth and reconnect ChatGPT.")
  })
})
