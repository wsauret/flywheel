import { describe, expect, test } from "bun:test"

import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import { awaitsSettlement, initialLoginStep, loginConfirmation, loginOutcome, loginSettlement } from "../../../../src/protocol/client/auth-login.js"

/** The login flow's decisions, held to the shapes the runtime answers with, so
 *  a client never asks for a key from a browser provider or waits on a login
 *  that already completed. */

function provider(accounts: number, loginMethod: AuthProviderStatus["loginMethod"] = "device-code"): AuthProviderStatus {
  return {
    providerId: "copilot",
    kind: "subscription",
    source: accounts > 0 ? "oauth" : "unconfigured",
    expired: false,
    modelCapable: true,
    loginMethod,
    statusRank: 1,
    group: "model",
    displayName: "GitHub Copilot",
    accounts: Array.from({ length: accounts }, (_, index) => ({
      instanceId: `instance-${index}`,
      accountCorrelationId: `account-${index}`,
      identity: `person${index}@example.com`,
      displayLabel: `Account ${index}`,
      expired: false,
      source: "oauth" as const,
    })),
  }
}

describe("initialLoginStep", () => {
  test("a provider with no account adds one without asking", () => {
    expect(initialLoginStep(provider(0))).toEqual({ kind: "working", provider: provider(0) })
  })

  test("a provider whose one account is signed out reconnects that account", () => {
    const one = provider(1)
    const lapsed = { ...one, accounts: one.accounts.map((account) => ({ ...account, expired: true })) }
    const step = initialLoginStep(lapsed)
    expect(step.kind).toBe("working")
    expect(step.kind === "working" ? step.instanceId : undefined).toBe("instance-0")
  })

  // "Add or reconnect" on a working account must reach the add path, or the
  // person can never connect a second account of that provider.
  test("a provider whose one account works asks whether to add another", () => {
    expect(initialLoginStep(provider(1)).kind).toBe("choose-account")
  })

  test("a provider with several accounts asks which one", () => {
    expect(initialLoginStep(provider(2)).kind).toBe("choose-account")
  })
})

describe("loginOutcome", () => {
  const current = provider(1)

  test("a key provider asks for the key and keeps the account it is for", () => {
    const outcome = loginOutcome({ kind: "needs_key", providerId: "copilot", displayName: "GitHub Copilot", hint: "Paste the token" }, current, "instance-0")
    expect(outcome).toEqual({ kind: "step", step: { kind: "needs-key", provider: current, hint: "Paste the token", instanceId: "instance-0" } })
  })

  test("a device-code provider shows the code and the page", () => {
    const outcome = loginOutcome({ kind: "device_code", operationId: "op-1", providerId: "copilot", userCode: "ABCD-1234", verificationUri: "https://example.test/device" }, current, undefined)
    expect(outcome.kind).toBe("step")
    if (outcome.kind !== "step") return
    expect(outcome.step.kind).toBe("device-code")
    expect(awaitsSettlement(outcome.step)).toBe(true)
  })

  test("a device-code provider whose link carries the code shows no code", () => {
    const outcome = loginOutcome({ kind: "device_code", operationId: "op-1", providerId: "supergrok", verificationUri: "https://example.test/device?user_code=X" }, current, undefined)
    expect(outcome).toEqual({ kind: "step", step: { kind: "device-code", provider: current, operationId: "op-1", verificationUri: "https://example.test/device?user_code=X" } })
  })

  test("a flow's pre-flight question becomes a step that holds the operation", () => {
    const prompt = { message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true }
    const outcome = loginOutcome({ kind: "prompt", operationId: "op-3", providerId: "copilot", prompt }, current, undefined)
    expect(outcome).toEqual({ kind: "step", step: { kind: "prompt", provider: current, operationId: "op-3", prompt } })
    expect(outcome.kind === "step" && awaitsSettlement(outcome.step)).toBe(true)
  })

  test("a browser provider hands over the page and waits", () => {
    const outcome = loginOutcome({ kind: "browser", operationId: "op-2", providerId: "copilot", authorizeUri: "https://example.test/auth" }, current, undefined)
    expect(outcome.kind === "step" && outcome.step.kind === "browser" && outcome.step.authorizeUri).toBe("https://example.test/auth")
  })

  test("completed, unsupported, and failed end the flow with a verdict", () => {
    expect(loginOutcome({ kind: "completed", providerId: "copilot" }, current, undefined).kind).toBe("connected")
    const unsupported = loginOutcome({ kind: "unsupported", providerId: "copilot", detail: "no flow" }, current, undefined)
    expect(unsupported).toEqual({ kind: "failed", provider: current, message: "no flow" })
    const failed = loginOutcome({ kind: "failed", providerId: "copilot", message: "denied" }, current, undefined)
    expect(failed).toEqual({ kind: "failed", provider: current, message: "denied" })
  })
})

describe("loginSettlement", () => {
  const auth = { providers: [], warnings: [], profile: { id: "p", displayName: "Personal", source: "default" as const, availableProfiles: [] }, subscriptionSpendConsent: { kind: "unavailable" as const, profileId: "p", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." as const } }

  test("only the exact operation settles the wait", () => {
    const completed = { kind: "completed" as const, operationId: "op-1", providerId: "copilot" }
    expect(loginSettlement({ ...auth, settlement: completed }, "op-1")).toEqual(completed)
    expect(loginSettlement({ ...auth, settlement: { ...completed, operationId: "op-2" } }, "op-1")).toBe(undefined)
    expect(loginSettlement(auth, "op-1")).toBe(undefined)
    expect(loginSettlement(undefined, "op-1")).toBe(undefined)
  })

  test("the runtime's question after sign-in becomes a step of its own operation that still waits for the end (PI-MODEL-038)", () => {
    const target = { providerId: "copilot", displayName: "GitHub Copilot" }
    const confirmation = { kind: "confirmation" as const, operationId: "op-1", providerId: "copilot", message: "Replace?" }
    const step = loginConfirmation({ ...auth, confirmation }, target, "op-1")
    expect(step).toEqual({ kind: "confirm", provider: target, operationId: "op-1", message: "Replace?" })
    expect(awaitsSettlement(step)).toBe(true)
    expect(loginConfirmation({ ...auth, confirmation }, target, "op-2")).toBe(undefined)
    expect(loginConfirmation(auth, target, "op-1")).toBe(undefined)
  })

  test("only a step that left the client waits for a settlement", () => {
    expect(awaitsSettlement({ kind: "working", provider: provider(0) })).toBe(false)
    expect(awaitsSettlement(undefined)).toBe(false)
  })
})
