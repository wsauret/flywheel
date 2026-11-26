import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { JSONRPCMessageSchema, type CallToolResult, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { Redacted } from "effect"

import { openToolListener, type ParkedToolCall, type RegisteredToolServer, type ToolListener } from "../../../../../../src/orchestration/modules/provider-google-antigravity/tools/mcp-server.js"
import type { McpToolDeclaration } from "../../../../../../src/orchestration/modules/provider-google-antigravity/tools/tool-projection.js"

const READ: McpToolDeclaration = { name: "read", description: "Reads a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
const SESSION_KEY = "antigravity.google/conversation_id"

const listeners: ToolListener[] = []
const clients: Client[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const listener of listeners.splice(0)) await listener.close()
})

function openListener(): ToolListener {
  const opened = openToolListener()
  listeners.push(opened)
  return opened
}

/** A park that the test settles, as the bridge settles a call once Flywheel's dispatch has run it. */
function parks() {
  const calls: { readonly call: ParkedToolCall; readonly signal: AbortSignal; readonly settle: (result: CallToolResult) => void }[] = []
  const entered: (() => void)[] = []
  return {
    calls,
    onCall: (call: ParkedToolCall, signal: AbortSignal) => new Promise<CallToolResult>((settle) => {
      calls.push({ call, signal, settle })
      for (const wake of entered.splice(0)) wake()
    }),
    /** Resolves once `count` calls have parked. */
    parked: async (count: number) => { while (calls.length < count) await new Promise<void>((wake) => entered.push(wake)) },
  }
}

/** An MCP client that reaches `server` as the engine does: over HTTP, with the bearer token in every request. */
async function connect(server: Pick<RegisteredToolServer, "url" | "token">, url = server.url): Promise<Client> {
  const client = new Client({ name: "antigravity-client", version: "0.0.0" })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${Redacted.value(server.token)}` } } }))
  return client
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] })

const aborted = (signal: AbortSignal | undefined) => new Promise<void>((released) => {
  if (signal?.aborted === true) released()
  signal?.addEventListener("abort", () => released(), { once: true })
})

/**
 * A POST of `body` to `server` whose head the listener has taken before this resolves: the request asks for
 * `100 Continue`, which the listener sends only once its handler has the request, and the body waits for `send`.
 * No fetch gives that signal, and without it the head can still be in flight when the test moves on.
 */
async function takenPost(server: Pick<RegisteredToolServer, "url" | "token">, body: string) {
  const url = new URL(server.url)
  const continued = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  let received = ""
  const socket = await Bun.connect({
    hostname: url.hostname,
    port: Number(url.port),
    socket: {
      data(_socket, chunk) {
        received += chunk.toString()
        if (received.startsWith("HTTP/1.1 100 Continue\r\n\r\n")) continued.resolve()
      },
      close: () => closed.resolve(),
    },
  })
  socket.write([
    `POST ${url.pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    `Authorization: Bearer ${Redacted.value(server.token)}`,
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "Expect: 100-continue",
    "Connection: close",
    "",
    "",
  ].join("\r\n"))
  await continued.promise
  return {
    /** Sends the body and resolves with the JSON-RPC message of the final response. */
    async send(): Promise<JSONRPCMessage> {
      socket.write(body)
      await closed.promise
      return JSONRPCMessageSchema.parse(JSON.parse(received.slice(received.lastIndexOf("\r\n\r\n") + 4)))
    },
  }
}

describe("the Antigravity tool listener", () => {
  test("serves each process its own tools on its own path, ready at its first listing, and parks each call until it is settled", async () => {
    const tools = openListener()
    const p = parks()
    const q = parks()
    const serverP = tools.register("process-p", { tools: [READ], onCall: p.onCall })
    const serverQ = tools.register("process-q", { tools: [], onCall: q.onCall })
    expect(serverP.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/process-p$/u)
    expect(Redacted.value(serverP.token)).not.toBe(Redacted.value(serverQ.token))

    let ready = false
    void serverP.ready.then(() => { ready = true })
    const clientP = await connect(serverP)
    expect(clientP.getServerCapabilities()).toEqual({ tools: {} })
    expect(ready).toBe(false)
    expect((await clientP.listTools()).tools).toEqual([READ])
    await serverP.ready

    const callS = clientP.callTool({ name: "read", arguments: { path: "a.ts", toolSummary: "File read" }, _meta: { [SESSION_KEY]: "session-s" } })
    await p.parked(1)
    expect(p.calls[0]?.call).toEqual({ sessionId: "session-s", name: "read", arguments: { path: "a.ts" } })

    const clientQ = await connect(serverQ)
    const callT = clientQ.callTool({ name: "bash", arguments: {}, _meta: { [SESSION_KEY]: "session-t" } })
    await q.parked(1)
    expect(q.calls[0]?.call.sessionId).toBe("session-t")

    q.calls[0]?.settle(text("from q"))
    expect(await callT).toEqual(text("from q"))
    p.calls[0]?.settle(text("ok"))
    expect(await callS).toEqual(text("ok"))
  })

  test("answers 401 to a request with the wrong token or on another process's path, and parks nothing", async () => {
    const tools = openListener()
    const p = parks()
    const serverP = tools.register("process-p", { tools: [READ], onCall: p.onCall })
    const serverQ = tools.register("process-q", { tools: [READ], onCall: parks().onCall })
    const post = (url: string, token: string) => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: {}, _meta: { [SESSION_KEY]: "session-s" } } }),
    })
    expect((await post(serverP.url, "wrong")).status).toBe(401)
    expect((await post(serverQ.url, Redacted.value(serverP.token))).status).toBe(401)
    expect((await post(serverP.url.replace("process-p", "process-x"), Redacted.value(serverP.token))).status).toBe(401)
    expect((await fetch(serverP.url, { headers: { Authorization: `Bearer ${Redacted.value(serverP.token)}` } })).status).toBe(405)
    expect(p.calls).toEqual([])
  })

  test("ends a waiting call with an MCP error when its process is unregistered, and refuses the path afterwards", async () => {
    const tools = openListener()
    const p = parks()
    const server = tools.register("process-p", { tools: [READ], onCall: p.onCall })
    const client = await connect(server)
    const call = client.callTool({ name: "read", arguments: { path: "a.ts" }, _meta: { [SESSION_KEY]: "session-s" } })
    await p.parked(1)

    // A call whose request the listener took before the unregister and whose body arrives after it.
    const late = await takenPost(server, JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "read", arguments: {}, _meta: { [SESSION_KEY]: "session-s" } } }))

    tools.unregister("process-p")
    await expect(call).rejects.toThrow("The engine process's tool server was closed")
    expect(p.calls[0]?.signal.aborted).toBe(true)
    expect(await late.send()).toMatchObject({ id: 9, error: { message: expect.stringContaining("The engine process's tool server was closed") } })
    expect(p.calls).toHaveLength(1)
    await expect(connect(server)).rejects.toThrow()
  })

  test("rejects the readiness of a process that is unregistered before it listed its tools", async () => {
    const tools = openListener()
    const server = tools.register("process-p", { tools: [READ], onCall: parks().onCall })
    tools.unregister("process-p")
    await expect(server.ready).rejects.toThrow("The engine process's tool server was closed")
  })

  test("releases a park when the engine gives up its HTTP request or cancels the call", async () => {
    const tools = openListener()
    const p = parks()
    const server = tools.register("process-p", { tools: [READ], onCall: p.onCall })
    const abandoned = new AbortController()
    const request = fetch(server.url, {
      method: "POST",
      signal: abandoned.signal,
      headers: { Authorization: `Bearer ${Redacted.value(server.token)}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read", arguments: {}, _meta: { [SESSION_KEY]: "session-s" } } }),
    })
    await p.parked(1)
    abandoned.abort()
    await expect(request).rejects.toThrow()
    await aborted(p.calls[0]?.signal)

    const client = await connect(server)
    const cancelled = new AbortController()
    const call = client.callTool({ name: "read", arguments: {}, _meta: { [SESSION_KEY]: "session-s" } }, undefined, { signal: cancelled.signal })
    await p.parked(2)
    cancelled.abort()
    await expect(call).rejects.toThrow()
    await aborted(p.calls[1]?.signal)
  })
})
