import { describe, expect, it } from "bun:test"
import { accountAuthDir } from "../../../../../src/infra/paths.js"
import type { McpConnection } from "../../../../../src/orchestration/modules/mcp/connection.js"
import { McpNeedsAuthError } from "../../../../../src/orchestration/modules/mcp/errors.js"
import { createMcpManager } from "../../../../../src/orchestration/modules/mcp/manager.js"
import { testDirectories } from "../../../../helpers/directories.js"

const AUTH_DIR = accountAuthDir(testDirectories(process.cwd()).userDataRoot)

function fakeConnection(): McpConnection {
  return {
    instructions: undefined,
    tools: () => [],
    callTool: async () => ({ content: [], isError: false }),
    onClose() {},
    onToolsChanged() {},
    async close() {},
  }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await Promise.resolve()
  expect(settled).toBe(false)
}

describe("MCP manager ready-attempt retirement", () => {
  it("awaits closed connection finalization before starting its replacement", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    let closeCallback = (): void => {}
    let connects = 0
    const first: McpConnection = {
      ...fakeConnection(),
      onClose(callback) { closeCallback = callback },
      close: async () => { closeStarted.resolve(); await closeGate.promise },
    }
    const second = fakeConnection()
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => {
        connects++
        return connects === 1 ? first : second
      },
    })

    await manager.acquire("test")
    closeCallback()
    const replacement = manager.acquire("test")
    await closeStarted.promise

    expect(manager.entries()[0]?.state.tag).toBe("pending")
    expect(connects).toBe(1)
    await expectPending(replacement)

    closeGate.resolve()
    expect(await replacement).toBe(second)
    expect(connects).toBe(2)
    await manager.dispose()
  })

  it("keeps a credential transition authoritative over a stale close callback", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    let closeCallback = (): void => {}
    let connects = 0
    const first: McpConnection = {
      ...fakeConnection(),
      onClose(callback) { closeCallback = callback },
      close: async () => { closeStarted.resolve(); await closeGate.promise },
    }
    const second = fakeConnection()
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => {
        connects++
        return connects === 1 ? first : second
      },
    })
    await manager.acquire("test")

    const credentialUpdate = manager.credentialUpdated("test")
    closeCallback()
    const acquisition = manager.acquire("test")
    await closeStarted.promise

    await expectPending(credentialUpdate)
    await expectPending(acquisition)
    expect(connects).toBe(1)

    closeGate.resolve()
    await credentialUpdate
    expect(await acquisition).toBe(second)
    expect(connects).toBe(2)
    await manager.dispose()
  })

  it("publishes a failed tool refresh only after the old connection settles", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    let toolsChanged: Parameters<McpConnection["onToolsChanged"]>[0] = () => {}
    let connects = 0
    const connection: McpConnection = {
      ...fakeConnection(),
      onToolsChanged(callback) { toolsChanged = callback },
      close: async () => { closeStarted.resolve(); await closeGate.promise },
    }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => { connects++; return connection },
    })
    await manager.acquire("test")

    toolsChanged({ tag: "failure", error: new Error("tool refresh failed") })
    const acquisition = manager.acquire("test")
    await closeStarted.promise

    expect(manager.status()[0]?.status).toBe("pending")
    await expectPending(acquisition)
    expect(connects).toBe(1)

    closeGate.resolve()
    await expect(acquisition).rejects.toThrow("tool refresh failed")
    expect(manager.status()[0]?.status).toBe("failed")
    expect(connects).toBe(1)
    await manager.dispose()
  })

  it("publishes needs-auth only after the old HTTP connection settles", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    const connection: McpConnection = {
      ...fakeConnection(),
      callTool: async () => { throw new McpNeedsAuthError("test") },
      close: async () => { closeStarted.resolve(); await closeGate.promise },
    }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { url: "https://mcp.example", headers: {}, enabled: true } },
      connect: async () => connection,
    })
    const acquired = await manager.acquire("test")

    const call = acquired.callTool({ name: "protected" })
    await closeStarted.promise
    const acquisition = manager.acquire("test")

    expect(manager.status()[0]?.status).toBe("pending")
    await expectPending(call)
    await expectPending(acquisition)

    closeGate.resolve()
    await expect(call).rejects.toThrow("needs authentication")
    await expect(acquisition).rejects.toThrow("needs authentication")
    expect(manager.status()[0]?.status).toBe("needs_auth")
    await manager.dispose()
  })

  it("owns a rejected connection finalizer as an unsafe retirement", async () => {
    let closeCallback = (): void => {}
    const connection: McpConnection = {
      ...fakeConnection(),
      onClose(callback) { closeCallback = callback },
      close: async () => { throw new Error("close failed") },
    }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => connection,
    })
    await manager.acquire("test")

    closeCallback()
    const acquisition = manager.acquire("test")

    await expect(acquisition).rejects.toThrow("MCP attempt retirement failed")
    expect(manager.status()[0]?.status).toBe("failed")
    await expect(manager.dispose()).rejects.toThrow("MCP manager disposal failed")
  })

  it("keeps a registry replacement private until the prior registry retires", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    const next = fakeConnection()
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { old: { command: "old", args: [], env: {}, enabled: true } },
      connect: async ({ config }) => config.command === "old"
        ? { ...fakeConnection(), close: async () => { closeStarted.resolve(); await closeGate.promise } }
        : next,
    })
    await manager.acquire("old")

    const replacement = manager.replaceServers({ next: { command: "next", args: [], env: {}, enabled: true } })
    await closeStarted.promise
    const acquisition = manager.acquire("next")

    expect(manager.entries().map((entry) => entry.name)).toEqual(["old"])
    expect(manager.tools()).toEqual([])
    await expectPending(replacement)
    await expectPending(acquisition)

    closeGate.resolve()
    await replacement
    expect(await acquisition).toBe(next)
    expect(manager.entries().map((entry) => entry.name)).toEqual(["next"])
    await manager.dispose()
  })

  it("retains unsafe cleanup of a registry with failed servers as terminal manager ownership", async () => {
    const candidateReady = Promise.withResolvers<void>()
    let connects = 0
    const unsafe: McpConnection = {
      ...fakeConnection(),
      onClose() { candidateReady.resolve() },
      close: async () => { throw new Error("candidate close failed") },
    }
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { old: { command: "old", args: [], env: {}, enabled: true } },
      connect: async ({ config }) => {
        connects++
        if (config.command === "ready") return unsafe
        if (config.command === "broken") {
          await candidateReady.promise
          throw new Error("candidate startup failed")
        }
        return fakeConnection()
      },
    })
    await manager.acquire("old")

    await manager.replaceServers({
      ready: { command: "ready", args: [], env: {}, enabled: true },
      broken: { command: "broken", args: [], env: {}, enabled: true },
    })
    await expect(manager.replaceServers({ next: { command: "next", args: [], env: {}, enabled: true } })).rejects.toThrow("MCP resource disposal failed")
    const connectsAfterFailure = connects

    await expect(manager.replaceServers({ future: { command: "future", args: [], env: {}, enabled: true } })).rejects.toThrow("MCP resource disposal failed")
    expect(connects).toBe(connectsAfterFailure)
    await expect(manager.dispose()).rejects.toThrow("MCP manager disposal failed")
  })

  it("makes concurrent disposal callers join one connection close", async () => {
    const closeStarted = Promise.withResolvers<void>()
    const closeGate = Promise.withResolvers<void>()
    let closes = 0
    const manager = createMcpManager({
      executionCwd: "/scratch",
      authDir: AUTH_DIR,
      servers: { test: { command: "bun", args: [], env: {}, enabled: true } },
      connect: async () => ({
        ...fakeConnection(),
        close: async () => { closes++; closeStarted.resolve(); await closeGate.promise },
      }),
    })
    await manager.acquire("test")

    const first = manager.dispose()
    const second = manager.dispose()
    await closeStarted.promise

    await expectPending(first)
    await expectPending(second)
    expect(closes).toBe(1)

    closeGate.resolve()
    await first
    await second
    expect(closes).toBe(1)
  })
})
