import { describe, it, expect } from "bun:test"
import { authErrorCopy, authErrorHeadline } from "../../../../src/infra/llm/auth-error.js"

describe("authErrorHeadline", () => {
  it("returns the actionable explanation without echoing the raw provider text", () => {
    const headline = authErrorHeadline("401 Incorrect API key provided. See https://platform.openai.com")
    expect(headline).toContain("API key was rejected")
    expect(headline).not.toContain("Provider response")
  })

  it("never names a provider from the error text, which names the SDK rather than the account", () => {
    expect(authErrorHeadline("401 Incorrect API key provided. See https://platform.openai.com")).toContain("The model provider's API key was rejected")
    expect(authErrorHeadline("invalid x-api-key")).toContain("The model provider's API key was rejected")
  })

  it("explains expired ChatGPT OAuth as a reconnect problem", () => {
    const headline = authErrorHeadline("ChatGPT sign-in is required before this model request can continue. Run /auth and select ChatGPT when you are ready.")
    expect(headline).toContain("ChatGPT sign-in is required")
    expect(headline).toContain("Run /auth and reconnect ChatGPT")
  })

  it("states OpenRouter age confirmation as an account setting, with its link once and no credential advice", () => {
    const url = "https://openrouter.ai/settings/preferences"
    const headline = authErrorHeadline(`403 This model requires you to complete the following before use: 18+ age confirmation. Confirm at ${url}.`)
    expect(headline?.startsWith("Account confirmation required: ")).toBe(true)
    expect(headline?.split(url).length).toBe(2)
    expect(headline).not.toContain("/auth")
  })

  it("returns undefined for non-auth errors so callers keep their own text", () => {
    expect(authErrorHeadline("rate limited")).toBeUndefined()
    expect(authErrorHeadline("Output overflow")).toBeUndefined()
    expect(authErrorHeadline("stream closed before completion")).toBeUndefined()
  })
})

describe("authErrorCopy", () => {
  it("names the provider that served the request, even when the text names another one", () => {
    expect(authErrorCopy("401 Incorrect API key provided. See https://platform.openai.com", { name: "QA Stub", credential: "api_key" })).toEqual({
      kind: "credential",
      problem: "The QA Stub API key was rejected. This is a configuration problem, not a connection error.",
      guidance: "Verify a valid API key is configured for QA Stub and retry.",
    })
  })
})
