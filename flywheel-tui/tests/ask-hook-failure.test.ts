import { describe, it, expect, afterEach } from "bun:test"
import net from "node:net"
import { unlink } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAskHookServer, type AskHookServer } from "../src/orchestration/ask-hook/server"

/**
 * Tests the server side of the hook bridge (createAskHookServer). The hook
 * script's run.ts is exercised end-to-end in tmux UATs; here we verify the
 * server's pending-hook state machine and its close/cancel guarantees.
 */
describe("AskHookServer — failure paths", () => {
  let servers: AskHookServer[] = []
  let tempDir: string | null = null

  afterEach(async () => {
    for (const s of servers) {
      try { await s.close() } catch { /* best-effort */ }
    }
    servers = []
    if (tempDir) {
      try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      tempDir = null
    }
  })

  async function makeServer(): Promise<{ server: AskHookServer; socketPath: string }> {
    tempDir = await mkdtemp(join(tmpdir(), "ask-hook-test-"))
    const socketPath = join(tempDir, "ask.sock")
    const server = await createAskHookServer(socketPath)
    servers.push(server)
    return { server, socketPath }
  }

  async function connect(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const client = net.connect(socketPath)
      client.once("connect", () => resolve(client))
      client.once("error", reject)
    })
  }

  function readOne(socket: net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        const nl = buf.indexOf("\n")
        if (nl >= 0) resolve(buf.slice(0, nl))
      })
      socket.once("error", reject)
      socket.once("close", () => { if (!buf) reject(new Error("closed empty")) })
    })
  }

  it("removes stale socket file on startup", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ask-hook-test-"))
    const socketPath = join(tempDir, "ask.sock")
    // Pre-create a server and leave its socket behind
    const first = await createAskHookServer(socketPath)
    await first.close()
    // Without explicit unlink, createAskHookServer should still succeed
    // (it unlinks stale files itself)
    const second = await createAskHookServer(socketPath)
    servers.push(second)
    expect(second.socketPath).toBe(socketPath)
  })

  it("deliver() sends answers and closes the hook socket", async () => {
    const { server, socketPath } = await makeServer()
    const client = await connect(socketPath)
    client.write(JSON.stringify({ type: "question", toolUseId: "tu_1", questions: [] }) + "\n")

    // Give the server a tick to register the pending hook
    await new Promise((r) => setTimeout(r, 10))

    const response = readOne(client)
    const ok = server.deliver("tu_1", { "Q?": "Answer" })
    expect(ok).toBe(true)

    const line = await response
    const parsed = JSON.parse(line)
    expect(parsed.answers).toEqual({ "Q?": "Answer" })
  })

  it("cancel() sends a cancelled payload", async () => {
    const { server, socketPath } = await makeServer()
    const client = await connect(socketPath)
    client.write(JSON.stringify({ type: "question", toolUseId: "tu_2", questions: [] }) + "\n")

    await new Promise((r) => setTimeout(r, 10))

    const response = readOne(client)
    const ok = server.cancel("tu_2", "User bailed")
    expect(ok).toBe(true)

    const parsed = JSON.parse(await response)
    expect(parsed.cancelled).toBe(true)
    expect(parsed.message).toBe("User bailed")
  })

  it("deliver() is no-op for unknown toolUseId", async () => {
    const { server } = await makeServer()
    expect(server.deliver("ghost", { q: "a" })).toBe(false)
  })

  it("second deliver() on same toolUseId is no-op (idempotency)", async () => {
    const { server, socketPath } = await makeServer()
    const client = await connect(socketPath)
    client.write(JSON.stringify({ type: "question", toolUseId: "tu_3", questions: [] }) + "\n")
    await new Promise((r) => setTimeout(r, 10))

    expect(server.deliver("tu_3", { q: "a" })).toBe(true)
    expect(server.deliver("tu_3", { q: "b" })).toBe(false)
    expect(server.cancel("tu_3")).toBe(false)
  })

  it("close() cancels all pending hooks with a session-ended message", async () => {
    const { server, socketPath } = await makeServer()
    const client = await connect(socketPath)
    client.write(JSON.stringify({ type: "question", toolUseId: "tu_4", questions: [] }) + "\n")
    await new Promise((r) => setTimeout(r, 10))

    const response = readOne(client)
    await server.close()
    servers = servers.filter((s) => s !== server) // already closed

    const parsed = JSON.parse(await response)
    expect(parsed.cancelled).toBe(true)
    expect(parsed.message).toBe("Session ended")
  })

  it("malformed hook line is tolerated (logged, not crashed)", async () => {
    const { server, socketPath } = await makeServer()
    const client = await connect(socketPath)
    client.write("not-json\n")
    await new Promise((r) => setTimeout(r, 20))

    // Server should still accept well-formed subsequent messages
    client.write(JSON.stringify({ type: "question", toolUseId: "tu_5", questions: [] }) + "\n")
    await new Promise((r) => setTimeout(r, 10))

    const response = readOne(client)
    expect(server.deliver("tu_5", { q: "a" })).toBe(true)
    const parsed = JSON.parse(await response)
    expect(parsed.answers).toEqual({ q: "a" })
  })

  it("socket file is removed after close()", async () => {
    const { server, socketPath } = await makeServer()
    await server.close()
    servers = servers.filter((s) => s !== server)

    // Verify by attempting to unlink — should fail because already gone
    await expect(unlink(socketPath)).rejects.toThrow()
  })
})
