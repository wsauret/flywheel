import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, CancelledNotificationSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolRequest, type CallToolResult, type RequestId } from "@modelcontextprotocol/sdk/types.js"
import { Redacted } from "effect"
import { Log } from "../../../infra/log.js"
import type { McpToolCall } from "./stream-map.js"
import { ENGINE_TOOL_SUMMARY, type McpToolDeclaration } from "./tool-projection.js"

const log = Log.create({ service: "provider-google-antigravity" })

/** The `_meta` key in which agy names the engine session (the ACP `sessionId`) of a call. */
const SESSION_ID_KEY = "antigravity.google/conversation_id"
const SERVER_INFO = { name: "runtime", version: "1.0.0" }

/** One `tools/call` that agy sent for the engine session `sessionId`, without agy's own `toolSummary`. */
export interface ParkedToolCall extends McpToolCall {
  readonly sessionId: string
}

export interface ToolServerRegistration {
  /** The tools that the engine lists, from `projectTools`. */
  readonly tools: readonly McpToolDeclaration[]
  /** Answers one call when Flywheel's dispatch has run it. `signal` aborts when agy gives up the call: its HTTP request
   *  ended, it cancelled the request, or the process was unregistered; the result is then sent to no one. */
  readonly onCall: (call: ParkedToolCall, signal: AbortSignal) => Promise<CallToolResult>
}

/** What the engine process needs to reach its tools: the server `url` and the bearer `token` that its MCP
 *  configuration names (`writeLaunchMcpConfig`), and `ready`, which resolves when the engine first lists its tools on
 *  that path and rejects when the process is unregistered before that. */
export interface RegisteredToolServer {
  readonly url: string
  readonly token: Redacted.Redacted<string>
  readonly ready: Promise<void>
}

/**
 * The module-wide tool listener (plan P3): one loopback Streamable HTTP server, with one path and one bearer token for
 * each engine process. Its handlers run no tool: each `tools/call` parks until Flywheel's dispatch answers it.
 */
export interface ToolListener {
  /** Serves `registration` at `/mcp/<processId>`. Throws when `processId` is already registered. */
  register(processId: string, registration: ToolServerRegistration): RegisteredToolServer
  /** Ends the path of `processId`: each call that still waits there ends with an MCP error, and later requests get
   *  401. An unknown id is no error. */
  unregister(processId: string): void
  /** Unregisters every process and stops the listener. */
  close(): Promise<void>
}

interface Registration extends ToolServerRegistration {
  readonly processId: string
  readonly authorization: Buffer
  /** The cancellation of each call that waits on this path, by request id. */
  readonly open: Map<RequestId, AbortController>
  /** Aborts, with the MCP error that ends each call, once the process is unregistered. */
  readonly closed: AbortSignal
  listed(): void
  stop(): void
  summaryDrift: boolean
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest()
}

function authorized(request: Request, registration: Registration): boolean {
  const offered = request.headers.get("authorization")
  return offered !== null && timingSafeEqual(digest(offered), registration.authorization)
}

/**
 * Opens the tool listener on an ephemeral port of 127.0.0.1. A request whose path names no registered process, or
 * whose `Authorization` header is not that process's bearer token, gets 401; a request other than POST gets 405
 * (agy also sends `GET`, and needs no stream from the server). Every POST is a stateless MCP exchange whose JSON
 * response holds the answer.
 */
export function openToolListener(): ToolListener {
  const registrations = new Map<string, Registration>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const registration = registrations.get(new URL(request.url).pathname)
      if (registration === undefined || !authorized(request, registration)) return new Response(null, { status: 401 })
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
      return exchange(request, registration)
    },
  })
  log.info("antigravity tool listener opened", { port: server.port })

  function unregister(processId: string): void {
    const path = toolPath(processId)
    const registration = registrations.get(path)
    if (registration === undefined) return
    registrations.delete(path)
    registration.stop()
    log.info("antigravity tool server unregistered", { processId, openCalls: registration.open.size })
  }

  return {
    register(processId, input) {
      const path = toolPath(processId)
      if (registrations.has(path)) throw new Error(`The engine process ${processId} already has a tool server`)
      const token = randomBytes(32).toString("base64url")
      const ready = Promise.withResolvers<void>()
      // A caller that never awaits `ready` must not see an unhandled rejection.
      void ready.promise.catch(() => {})
      const closed = new AbortController()
      registrations.set(path, {
        ...input,
        processId,
        authorization: digest(`Bearer ${token}`),
        open: new Map(),
        closed: closed.signal,
        listed: () => ready.resolve(),
        stop() {
          const error = new McpError(ErrorCode.ConnectionClosed, "The engine process's tool server was closed")
          ready.reject(error)
          closed.abort(error)
        },
        summaryDrift: false,
      })
      log.info("antigravity tool server registered", { processId, tools: input.tools.length })
      return { url: `http://127.0.0.1:${String(server.port)}${path}`, token: Redacted.make(token), ready: ready.promise }
    },
    unregister,
    async close() {
      for (const registration of registrations.values()) unregister(registration.processId)
      await server.stop(true)
      log.info("antigravity tool listener closed", {})
    },
  }
}

function toolPath(processId: string): string {
  return `/mcp/${encodeURIComponent(processId)}`
}

/** One stateless MCP exchange: a server and a transport that live for this request only. */
async function exchange(request: Request, registration: Registration): Promise<Response> {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => {
    registration.listed()
    return { tools: registration.tools.map((tool) => ({ ...tool })) }
  })
  server.setRequestHandler(CallToolRequestSchema, (call, extra) => parkCall(registration, call.params, extra.requestId, extra.signal))
  // A cancellation arrives in its own request, so it names a call that another exchange parked.
  server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
    const { requestId } = notification.params
    if (requestId !== undefined) registration.open.get(requestId)?.abort()
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  // Closing the server aborts the signal of each handler that still runs.
  const close = () => { void server.close() }
  request.signal.addEventListener("abort", close, { once: true })
  try {
    return await transport.handleRequest(request)
  } finally {
    request.signal.removeEventListener("abort", close)
    close()
  }
}

async function parkCall(registration: Registration, params: CallToolRequest["params"], requestId: RequestId, signal: AbortSignal): Promise<CallToolResult> {
  const sessionId = params._meta?.[SESSION_ID_KEY]
  if (typeof sessionId !== "string") throw new McpError(ErrorCode.InvalidParams, `The call names no engine session (${SESSION_ID_KEY})`)
  const { [ENGINE_TOOL_SUMMARY]: summary, ...args } = params.arguments ?? {}
  // agy strips its `toolSummary` before the call; one that arrives shows that the engine changed this rule.
  if (summary !== undefined && !registration.summaryDrift) {
    registration.summaryDrift = true
    log.warn("antigravity engine sent its tool summary to the tool server", { processId: registration.processId, tool: params.name })
  }
  const cancelled = new AbortController()
  // The park ends when the engine gives the call up or its process is unregistered, also when `onCall` never
  // settles for it. A request that the listener took before the unregister can reach this point after it.
  const givenUp = AbortSignal.any([signal, cancelled.signal, registration.closed])
  if (givenUp.aborted) throw givenUp.reason
  registration.open.set(requestId, cancelled)
  const ended = new Promise<never>((_resolve, reject) => { givenUp.addEventListener("abort", () => reject(givenUp.reason), { once: true }) })
  log.debug("antigravity tool call parked", { processId: registration.processId, sessionId, tool: params.name })
  try {
    return await Promise.race([registration.onCall({ sessionId, name: params.name, arguments: args }, givenUp), ended])
  } finally {
    registration.open.delete(requestId)
  }
}
