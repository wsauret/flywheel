import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { assertNoNetworkRequests } from "../../helpers/network-guard.js"

// The preload installs the guard for every test process. Each case here takes
// the report itself, so the preload's own check after the case finds it empty.
describe("unit test network guard", () => {
  test("refuses a remote request and reports it with the test file and the caller", async () => {
    await expect(fetch("https://example.invalid/catalog.json", { method: "post" }))
      .rejects.toThrow("Unit tests must not reach the network: POST https://example.invalid/catalog.json")
    expect(() => new WebSocket("wss://example.invalid/device")).toThrow("Unit tests must not reach the network: WEBSOCKET wss://example.invalid/device")

    let report = ""
    try {
      assertNoNetworkRequests()
    } catch (error) {
      report = String(error)
    }
    const filename = join("tests", "unit", "helpers", "network-guard.test.ts")
    expect(report).toContain(`POST https://example.invalid/catalog.json from ${filename}`)
    expect(report).toContain(`WEBSOCKET wss://example.invalid/device from ${filename}`)
    expect(report).toContain(`(${filename}:`)
    expect(assertNoNetworkRequests).not.toThrow()
  })

  test("lets a request to this machine through", async () => {
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("served locally") })
    expect(await (await fetch(server.url)).text()).toBe("served locally")
  })
})
