import { describe, expect, it } from "bun:test"
import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import { PROVIDER_SETUP_WAIT_MS, providerSetup, settledProviderSetup, type ProviderSetup } from "../../../../src/protocol/client/provider-setup.js"
import { runtimeCallPolicies } from "../../../../src/protocol/runtime-client-deadlines.js"

function view(...providers: ReadonlyArray<Pick<AuthProviderStatus, "group" | "source"> & { readonly expired?: boolean }>) {
  return { providers: providers.map((provider) => ({ expired: false, ...provider })) }
}

describe("providerSetup", () => {
  it("is loading until the runtime publishes the auth view", () => {
    expect(providerSetup(undefined)).toBe("loading")
  })

  it("counts a model provider whose credential can serve as usable", () => {
    expect(providerSetup(view({ group: "model", source: "unconfigured" }, { group: "model", source: "oauth" }))).toBe("usable")
    expect(providerSetup(view({ group: "model", source: "stored_key" }))).toBe("usable")
  })

  it("counts an expired or rejected credential as none, since both need the person in /auth", () => {
    expect(providerSetup(view({ group: "model", source: "oauth", expired: true }))).toBe("none")
    expect(providerSetup(view({ group: "model", source: "invalid" }))).toBe("none")
  })

  it("ignores web providers and providers with no usable configuration", () => {
    expect(providerSetup(view({ group: "web", source: "stored_key" }, { group: "model", source: "misconfigured" }, { group: "model", source: "unconfigured" }))).toBe("none")
  })
})

describe("settledProviderSetup", () => {
  it("waits at most as long as the auth snapshot read itself", () => {
    const policy = runtimeCallPolicies.authStatusSnapshot
    expect(policy._tag === "BestEffort" ? policy.deadlineMs : undefined).toBe(PROVIDER_SETUP_WAIT_MS)
  })

  it("answers a known setup without waiting", async () => {
    let asked = false
    const settled = await settledProviderSetup(() => "none", () => { asked = true; return new Promise(() => {}) })
    expect(settled).toBe("none")
    expect(asked).toBe(false)
  })

  it("answers the setup the auth view brings once it arrives", async () => {
    let setup: ProviderSetup = "loading"
    let arrive = () => {}
    const settling = settledProviderSetup(() => setup, () => new Promise<void>((resolve) => { arrive = resolve }))
    setup = "usable"
    arrive()
    expect(await settling).toBe("usable")
  })

  it("lets the send go unchecked when the auth view does not arrive in time, and stops the wait", async () => {
    let stopped = false
    const settled = await settledProviderSetup(() => "loading", (signal) => {
      signal.addEventListener("abort", () => { stopped = true })
      return new Promise(() => {})
    }, 5)
    expect(settled).toBe("loading")
    expect(stopped).toBe(true)
  })
})
