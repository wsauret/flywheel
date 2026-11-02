import { describe, expect, mock, test } from "bun:test"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import { createMcpAuthenticationService } from "../../../../../src/orchestration/modules/mcp/authentication.js"

const LAUNCHER: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("not used")),
  adoptOwned: () => Promise.reject(new Error("not used")),
  open: () => LAUNCHER,
  close: async () => ({ settled: true }),
}

function authorization(order: string[], complete: () => Promise<void> = async () => { order.push("complete") }) {
  return {
    url: "https://identity.example/secret",
    redirectUrl: "http://127.0.0.1/callback",
    complete,
    close: async () => { order.push("close") },
  }
}

describe("MCP authentication service", () => {
  test("owns authorization, browser handoff, completion, close, and refresh in order", async () => {
    const order: string[] = []
    const manager = {
      authorize: mock(async () => { order.push("authorize"); return authorization(order) }),
      credentialUpdated: mock(async () => { order.push("refresh") }),
    }
    const service = createMcpAuthenticationService({
      manager,
      launcher: LAUNCHER,
      openUrl: async (launcher, url) => {
        expect(launcher).toBe(LAUNCHER)
        expect(url).toBe("https://identity.example/secret")
        order.push("open")
        return true
      },
    })

    await service.authenticate("work")

    expect(manager.authorize).toHaveBeenCalledWith("work")
    expect(order).toEqual(["authorize", "open", "complete", "close", "refresh"])
  })

  test("closes without refresh when completion fails", async () => {
    const order: string[] = []
    const service = createMcpAuthenticationService({
      manager: {
        authorize: async () => authorization(order, async () => { order.push("complete"); throw new Error("credential secret") }),
        credentialUpdated: async () => { order.push("refresh") },
      },
      launcher: LAUNCHER,
      openUrl: async () => { order.push("open"); return true },
    })

    await expect(service.authenticate("work")).rejects.toThrow("credential secret")
    expect(order).toEqual(["open", "complete", "close"])
  })

  test("closes without completion or refresh when browser handoff fails", async () => {
    const order: string[] = []
    const service = createMcpAuthenticationService({
      manager: {
        authorize: async () => authorization(order),
        credentialUpdated: async () => { order.push("refresh") },
      },
      launcher: LAUNCHER,
      openUrl: async () => { order.push("open"); return false },
    })

    await expect(service.authenticate("work")).rejects.toThrow("Browser handoff failed")
    expect(order).toEqual(["open", "close"])
  })
})
