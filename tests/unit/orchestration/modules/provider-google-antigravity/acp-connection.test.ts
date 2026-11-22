import { describe, expect, test } from "bun:test"
import {
  AcpConnectionClosed,
  AcpRequestError,
  openAcpConnection,
  type AcpRefusedAgentRequest,
} from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/connection.js"
import type { AcpSessionNotification } from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/schema.js"

/** A fake `agy acp` on the other end of the pipes: the test writes its stdout
 *  lines and reads the frames the connection wrote to its stdin. */
function fakeAgent(options: { readonly maxFrameChars?: number; readonly allowedTools?: ReadonlySet<string> } = {}) {
  const written: unknown[] = []
  let stdinEnded = false
  let heldFlush: Promise<number> | undefined
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  const notifications: AcpSessionNotification[] = []
  const refused: AcpRefusedAgentRequest[] = []
  const connection = openAcpConnection({
    stdin: {
      write: (chunk) => {
        for (const line of chunk.split("\n").filter(Boolean)) written.push(JSON.parse(line))
        return chunk.length
      },
      flush: () => heldFlush ?? 0,
      end: () => {
        stdinEnded = true
        return 0
      },
    },
    stdout,
    onNotification: (notification) => notifications.push(notification),
    onAgentRequestRefused: (request) => refused.push(request),
    limits: options.maxFrameChars === undefined ? undefined : { maxFrameChars: options.maxFrameChars },
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
  })
  return {
    connection,
    written,
    notifications,
    refused,
    stdinEnded: () => stdinEnded,
    stdout,
    /** Makes every flush wait, as when agy stops reading its stdin, until the
     *  returned release runs. */
    holdFlush: () => {
      let release!: () => void
      heldFlush = new Promise((resolve) => {
        release = () => {
          heldFlush = undefined
          resolve(0)
        }
      })
      return release
    },
    send: (frame: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
    sendRaw: (text: string) => controller.enqueue(encoder.encode(text)),
    sendBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    endStdout: () => controller.close(),
    /** Lets the connection's read loop drain what the test enqueued. */
    settle: () => Bun.sleep(1),
  }
}

const promptResult = (id: number, text: string) => ({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: text.length, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: text.length + 1 } } })

describe("ACP connection", () => {
  test("concurrent requests answered in reverse order each resolve with their own result", async () => {
    const agent = fakeAgent()
    const first = agent.connection.request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "a" }] })
    const second = agent.connection.request("session/prompt", { sessionId: "s2", prompt: [{ type: "text", text: "bbb" }] })
    await agent.settle()
    expect(agent.written).toMatchObject([{ id: 1, method: "session/prompt" }, { id: 2, method: "session/prompt" }])
    agent.send(promptResult(2, "bbb"))
    agent.send(promptResult(1, "a"))
    expect((await first).usage?.inputTokens).toBe(1)
    expect((await second).usage?.inputTokens).toBe(3)
    await agent.connection.close()
  })

  test("stdout that ends rejects the pending request with the close reason and settles closed once", async () => {
    const agent = fakeAgent()
    const pending = agent.connection.request("session/new", { cwd: "/scratch/ws", mcpServers: [] })
    await agent.settle()
    agent.endStdout()
    const error = await pending.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AcpConnectionClosed)
    expect(error).toMatchObject({ close: { kind: "ended" } })
    const close = await agent.connection.closed
    expect(close.reason).toEqual({ kind: "ended" })
    expect(await agent.connection.close()).toBe(close)
    await agent.settle()
    expect(agent.stdinEnded()).toBe(true)
    await expect(agent.connection.request("session/new", { cwd: "/scratch/ws", mcpServers: [] })).rejects.toBeInstanceOf(AcpConnectionClosed)
  })

  test("a line over the frame limit fails the connection without waiting for its newline", async () => {
    const agent = fakeAgent({ maxFrameChars: 64 })
    const pending = agent.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "flywheel", version: "0.0.0" },
    })
    agent.sendRaw(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(100)}`)
    const close = await agent.connection.closed
    expect(close.reason).toEqual({ kind: "frame-too-large", limitChars: 64 })
    expect(await pending.catch((cause: unknown) => cause)).toMatchObject({ close: { kind: "frame-too-large" } })
  })

  test("an agent permission request is answered with an error and reported as refused", async () => {
    const agent = fakeAgent()
    agent.send({
      jsonrpc: "2.0",
      id: "1",
      method: "session/request_permission",
      params: { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
    })
    await agent.settle()
    expect(agent.refused).toEqual([{ method: "session/request_permission", sessionId: "s1" }])
    expect(agent.written).toEqual([{ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Flywheel does not serve session/request_permission" } }])
    expect((await agent.connection.close()).unserved.refusedAgentRequests).toBe(1)
  })

  // The request as agy 1.5.14 sends it for a call of an MCP tool.
  const permissionRequest = (name: string, options: readonly unknown[] = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]) => ({
    jsonrpc: "2.0",
    id: "1",
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { sessionUpdate: "tool_call", toolCallId: "t1", name, args: { text: "hi" }, status: "pending", kind: "other", title: `Run ${name}`, rawInput: { text: "hi" } },
      options,
    },
  })
  const refusal = { jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Flywheel does not serve session/request_permission" } }

  test("a permission request for a tool of Flywheel's own MCP server is allowed once", async () => {
    const agent = fakeAgent({ allowedTools: new Set(["mcp_runtime_echo"]) })
    agent.send(permissionRequest("mcp_runtime_echo"))
    await agent.settle()
    expect(agent.written).toEqual([{ jsonrpc: "2.0", id: "1", result: { outcome: { outcome: "selected", optionId: "allow" } } }])
    expect(agent.refused).toEqual([])
  })

  test.each([
    ["a tool of another MCP server", permissionRequest("mcp_other_echo")],
    ["a built-in agy tool", permissionRequest("list_resources")],
    ["no allow_once option", permissionRequest("mcp_runtime_echo", [{ optionId: "allow", name: "Allow", kind: "allow_always" }])],
    ["an unknown shape", { jsonrpc: "2.0", id: "1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [] } }],
  ])("a permission request is refused for %s", async (_case, frame) => {
    const agent = fakeAgent({ allowedTools: new Set(["mcp_runtime_echo"]) })
    agent.send(frame)
    await agent.settle()
    expect(agent.written).toEqual([refusal])
    expect(agent.refused).toEqual([{ method: "session/request_permission", sessionId: "s1" }])
  })

  test("a session update of an unknown kind reaches the observer as unknown and the connection stays open", async () => {
    const agent = fakeAgent()
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "plan_v9", entries: [] } } })
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } })
    await agent.settle()
    expect(agent.notifications).toEqual([
      { sessionId: "s1", update: { sessionUpdate: "unknown", reportedKind: "plan_v9" } },
      { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    ])
    const close = await agent.connection.close()
    expect(close.reason).toEqual({ kind: "closed" })
    expect(close.unserved.unknownUpdates).toBe(1)
  })

  test("a known update that lacks a field Flywheel reads fails the connection closed", async () => {
    const agent = fakeAgent()
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", status: "pending", title: "Run x" } } })
    expect((await agent.connection.closed).reason).toEqual({ kind: "malformed", frame: "session/update" })
    expect(agent.notifications).toEqual([])
  })

  test("a result without its method's shape fails the connection and settles the request with that reason", async () => {
    const agent = fakeAgent()
    const pending = agent.connection.request("session/new", { cwd: "/scratch/ws", mcpServers: [] })
    await agent.settle()
    agent.send({ jsonrpc: "2.0", id: 1, result: { configOptions: [] } })
    expect(await pending.catch((cause: unknown) => cause)).toMatchObject({ close: { kind: "malformed", frame: "session/new result" } })
    expect((await agent.connection.closed).reason).toEqual({ kind: "malformed", frame: "session/new result" })
  })

  test("a JSON-RPC error answer rejects with its code", async () => {
    const agent = fakeAgent()
    const pending = agent.connection.request("session/set_model", { sessionId: "s1", modelId: "bigctx" })
    await agent.settle()
    agent.send({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown model ID: bigctx" } })
    const error = await pending.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AcpRequestError)
    expect(error).toMatchObject({ code: -32602 })
    await agent.connection.close()
  })

  test("an aborted request writes nothing more and its late answer is dropped", async () => {
    const agent = fakeAgent()
    const abort = new AbortController()
    const pending = agent.connection.request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "a" }] }, abort.signal)
    await agent.settle()
    abort.abort(new Error("stop"))
    await expect(pending).rejects.toThrow("stop")
    await agent.connection.notify("session/cancel", { sessionId: "s1" })
    agent.send(promptResult(1, "a"))
    await agent.settle()
    expect(agent.written).toMatchObject([{ id: 1, method: "session/prompt" }, { method: "session/cancel", params: { sessionId: "s1" } }])
    expect((await agent.connection.close()).unserved.unmatchedResponses).toBe(1)
  })

  test("a request that settles while it waits in the write queue is never written, and a queued notification still drains", async () => {
    const agent = fakeAgent()
    const release = agent.holdFlush()
    const first = agent.connection.request("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "a" }] })
    const abort = new AbortController()
    const aborted = agent.connection.request("session/prompt", { sessionId: "s2", prompt: [{ type: "text", text: "b" }] }, abort.signal)
    const rejected = agent.connection.request("session/set_model", { sessionId: "s1", modelId: "m" })
    const cancel = agent.connection.notify("session/cancel", { sessionId: "s1" })
    abort.abort(new Error("stop"))
    await expect(aborted).rejects.toThrow("stop")
    agent.sendRaw("not json\n")
    expect(await rejected.catch((cause: unknown) => cause)).toMatchObject({ close: { kind: "malformed" } })
    await expect(first).rejects.toBeInstanceOf(AcpConnectionClosed)
    release()
    await cancel
    await agent.settle()
    expect(agent.written).toMatchObject([{ id: 1, method: "session/prompt" }, { method: "session/cancel" }])
    expect(agent.stdinEnded()).toBe(true)
  })

  test("close settles while agy does not read its stdin, and releases stdout", async () => {
    const agent = fakeAgent()
    agent.holdFlush()
    const pending = agent.connection.request("session/new", { cwd: "/scratch/ws", mcpServers: [] }).catch((cause: unknown) => cause)
    expect((await agent.connection.close()).reason).toEqual({ kind: "closed" })
    expect(await pending).toBeInstanceOf(AcpConnectionClosed)
    await agent.settle()
    expect(agent.stdout.locked).toBe(false)
  })

  test("a frame that arrives in the same turn as close is not passed on", async () => {
    const agent = fakeAgent()
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } } })
    const close = agent.connection.close()
    await agent.settle()
    expect((await close).reason).toEqual({ kind: "closed" })
    expect(agent.notifications).toEqual([])
  })

  test.each([
    ["a record that stdout ends inside", (agent: ReturnType<typeof fakeAgent>) => {
      agent.sendRaw(`{"jsonrpc":"2.0","method":"session/up`)
      agent.endStdout()
    }],
    ["a frame with an invalid UTF-8 byte", (agent: ReturnType<typeof fakeAgent>) => {
      agent.sendBytes(new Uint8Array([...new TextEncoder().encode(`{"jsonrpc":"2.0","method":"x","params":"`), 0xff, ...new TextEncoder().encode(`"}\n`)]))
    }],
  ])("%s fails the connection as malformed", async (_name, emit) => {
    const agent = fakeAgent()
    emit(agent)
    expect((await agent.connection.closed).reason).toMatchObject({ kind: "malformed" })
  })
})
