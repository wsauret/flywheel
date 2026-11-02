import type { PersistentRead, PersistentSpool } from "./persistent-spool.js"
import type { PersistentLaunchData } from "./persistent-subprocess.js"
import { errorMessage } from "./error-message.js"
import type { PersistentProcessClient, PersistentProcessManager, PersistentProcessRecord, PersistentStopResult } from "./persistent-process-manager.js"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "./internal-process-channel.js"
import { Log } from "./log.js"
import { DeadlineExceeded, withDeadline } from "./with-deadline.js"

interface UnknownFields {
  readonly [key: string]: unknown
}

type BridgeRequest =
  | { readonly id: number; readonly operation: "launch"; readonly args: readonly [readonly string[], PersistentLaunchData | undefined] }
  | { readonly id: number; readonly operation: "list"; readonly args: readonly [] }
  | { readonly id: number; readonly operation: "read"; readonly args: readonly [string, "stdout" | "stderr", number, number] }
  | { readonly id: number; readonly operation: "stop" | "release"; readonly args: readonly [string] }

type BridgeValue = PersistentProcessRecord | readonly PersistentProcessRecord[] | PersistentRead | PersistentStopResult | undefined
type BridgeOperationResult = Promise<BridgeValue>
type BridgeReply = { readonly id: number; readonly ok: true; readonly value: BridgeValue } | { readonly id: number; readonly ok: false; readonly error: string }
type ReplyParser<T> = (value: unknown) => T

const log = Log.create({ service: "persistent-process-bridge" })
const DEFAULT_REQUEST_DEADLINE_MS = 10_000
const LAUNCH_NOT_AUTHORIZED = "persistent process launch is not authorized"

function logBridgeProgress(message: string, fields: { readonly operation: BridgeRequest["operation"]; readonly [key: string]: unknown }): void {
  if (fields.operation === "launch") log.info(message, fields)
  else log.debug(message, fields)
}

export interface PersistentProcessBridgeServerOptions {
  readonly manager: PersistentProcessManager
  readonly port?: MessagePort
  readonly endpoint?: InternalProcessEndpoint<unknown, unknown>
  /** Reads the host's effective launch policy at the moment of each launch request. A rejection denies the launch. */
  readonly allowLaunch: () => Promise<boolean>
}

/** Serves one ephemeral runtime generation from the process-lifetime manager. The host awaits launch authority for each launch request. Closing the bridge joins its in-flight operations, including pending launch admissions, before it closes the manager client and endpoint; a launch whose admission settles after close never starts. */
export function servePersistentProcessBridge(options: PersistentProcessBridgeServerOptions): () => Promise<void> {
  const endpoint = bridgeEndpoint(options)
  const client = options.manager.client()
  const activeOperations = new Set<Promise<void>>()
  let lastRequestId = 0
  let closed = false
  let closePromise: Promise<void> | null = null
  let unsubscribeMessage = (): void => {}
  let unsubscribeClose = (): void => {}
  const reply = (message: BridgeReply, operation: BridgeRequest["operation"], startedAtMs: number): void => {
    if (closed) return
    try {
      void endpoint.send(message).catch(() => {
        log.warn("host reply failed", { operation, requestId: message.id, durationMs: Date.now() - startedAtMs })
      })
      logBridgeProgress("host reply posted", { operation, requestId: message.id, ok: message.ok, durationMs: Date.now() - startedAtMs })
    } catch {
      log.warn("host reply failed", { operation, requestId: message.id, durationMs: Date.now() - startedAtMs })
    }
  }
  const onMessage = (data: unknown): void => {
    const request = decodeRequest(data)
    if (!request) {
      log.error("host received invalid request")
      return
    }
    if (request.id <= lastRequestId) {
      log.warn("host ignored non-increasing request ID", { requestId: request.id })
      return
    }
    lastRequestId = request.id
    const startedAtMs = Date.now()
    logBridgeProgress("host request received", { operation: request.operation, requestId: request.id })
    if (closed) return
    const operation = serve(request, startedAtMs)
    activeOperations.add(operation)
    void operation.then(() => { activeOperations.delete(operation) })
  }
  const admitLaunch = async (requestId: number): Promise<boolean> => {
    try {
      if (await options.allowLaunch()) return true
    } catch {
      log.warn("host launch policy check failed", { requestId })
    }
    log.warn("host denied persistent process launch", { requestId })
    return false
  }
  // Every operation other than launch dispatches before the first await, so the
  // manager sees those requests in arrival order. Launch alone waits for policy.
  const serve = async (request: BridgeRequest, startedAtMs: number): Promise<void> => {
    if (request.operation === "launch") {
      if (!(await admitLaunch(request.id))) {
        reply({ id: request.id, ok: false, error: LAUNCH_NOT_AUTHORIZED }, request.operation, startedAtMs)
        return
      }
      if (closed) {
        log.info("host refused persistent process launch admitted after close", { requestId: request.id })
        return
      }
    }
    let result: BridgeOperationResult
    try {
      result = dispatch(client, request)
    } catch (error) {
      log.warn("host request failed", { operation: request.operation, requestId: request.id, durationMs: Date.now() - startedAtMs })
      reply({ id: request.id, ok: false, error: errorMessage(error) }, request.operation, startedAtMs)
      return
    }
    await result.then(
      (value) => { reply({ id: request.id, ok: true, value: value ?? undefined }, request.operation, startedAtMs) },
      (error) => {
        log.warn("host request failed", { operation: request.operation, requestId: request.id, durationMs: Date.now() - startedAtMs })
        reply({ id: request.id, ok: false, error: errorMessage(error) }, request.operation, startedAtMs)
      },
    )
  }
  const runClose = async (closePort: boolean): Promise<void> => {
    closed = true
    unsubscribeMessage()
    unsubscribeClose()
    await Promise.all(activeOperations)
    client.close()
    if (closePort) endpoint.close("persistent process bridge is closed")
  }
  const close = (closePort: boolean): Promise<void> => {
    if (!closePromise) closePromise = Promise.resolve().then(() => runClose(closePort))
    return closePromise
  }
  const onClose = (): void => { void close(false) }
  unsubscribeMessage = endpoint.onMessage(onMessage)
  unsubscribeClose = endpoint.onClose(onClose)
  return () => close(true)
}

export type BridgedPersistentProcessClient = PersistentProcessClient

export interface PersistentProcessBridgeClientOptions {
  readonly requestDeadlineMs?: number
  readonly setTimer?: (fire: () => void) => () => void
}

export function connectPersistentProcessBridge(transport: MessagePort | InternalProcessEndpoint<unknown, unknown>, bridgeOptions: PersistentProcessBridgeClientOptions = {}): BridgedPersistentProcessClient {
  const endpoint = transport instanceof MessagePort
    ? createMessagePortProcessEndpoint({ port: transport, decode: (value) => value })
    : transport
  const requestDeadlineMs = bridgeOptions.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS
  let nextId = 0
  let closed = false
  let unsubscribeMessage = (): void => {}
  let unsubscribeClose = (): void => {}
  const pending = new Map<number, { readonly operation: BridgeRequest["operation"]; readonly startedAtMs: number; accept(value: unknown): void; reject(error: Error): void }>()
  const rejectPending = (message: string): void => {
    for (const waiter of pending.values()) waiter.reject(new Error(message))
    pending.clear()
  }
  const onMessage = (data: unknown): void => {
    const reply = decodeReply(data)
    if (!reply) {
      const requestId = safeRequestId(data)
      if (requestId !== undefined) {
        const call = pending.get(requestId)
        if (call) {
          pending.delete(requestId)
          call.reject(new Error("invalid persistent process bridge reply"))
        }
      }
      log.warn("client received invalid reply", requestId === undefined ? {} : { requestId })
      return
    }
    const call = pending.get(reply.id)
    if (!call) {
      log.warn("client received reply for unknown request", { requestId: reply.id })
      return
    }
    pending.delete(reply.id)
    logBridgeProgress("client reply received", { operation: call.operation, requestId: reply.id, ok: reply.ok, durationMs: Date.now() - call.startedAtMs })
    if (reply.ok) call.accept(reply.value)
    else call.reject(new Error(reply.error))
  }
  const onClose = (): void => {
    if (closed) return
    closed = true
    unsubscribeMessage()
    unsubscribeClose()
    rejectPending("persistent process bridge peer closed")
  }
  unsubscribeMessage = endpoint.onMessage(onMessage)
  unsubscribeClose = endpoint.onClose(onClose)
  const call = <T>(request: BridgeRequest, parse: ReplyParser<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("persistent process bridge is closed"))
    const startedAtMs = Date.now()
    const response = new Promise<T>((resolve, reject) => {
      pending.set(request.id, {
        operation: request.operation,
        startedAtMs,
        accept(value) {
          try { resolve(parse(value)) } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
        },
        reject,
      })
      try {
        void endpoint.send(request).catch((error: unknown) => {
          pending.delete(request.id)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
        logBridgeProgress("client request posted", { operation: request.operation, requestId: request.id, deadlineMs: requestDeadlineMs })
      } catch (error) {
        pending.delete(request.id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    return withDeadline(response, requestDeadlineMs, { setTimer: bridgeOptions.setTimer }).catch((error: unknown) => {
      if (error instanceof DeadlineExceeded) log.warn("client request deadline exceeded", { operation: request.operation, requestId: request.id, deadlineMs: requestDeadlineMs, durationMs: Date.now() - startedAtMs })
      throw error
    }).finally(() => { pending.delete(request.id) })
  }
  const id = (): number => ++nextId
  return {
    launch: (command, launchOptions) => call({ id: id(), operation: "launch", args: [command, launchOptions] }, parseProcessRecord),
    list: () => call({ id: id(), operation: "list", args: [] }, parseProcessRecords),
    read: (processId, stream, offset, maxBytes) => call({ id: id(), operation: "read", args: [processId, stream, offset, maxBytes] }, parseRead),
    stop: (processId) => call({ id: id(), operation: "stop", args: [processId] }, parseStopResult),
    release: (processId) => call({ id: id(), operation: "release", args: [processId] }, parseVoid),
    close() {
      if (closed) return
      closed = true
      unsubscribeMessage()
      unsubscribeClose()
      endpoint.close("persistent process bridge is closed")
      rejectPending("persistent process bridge is closed")
    }
  }
}

function bridgeEndpoint(input: {
  readonly port?: MessagePort
  readonly endpoint?: InternalProcessEndpoint<unknown, unknown>
}): InternalProcessEndpoint<unknown, unknown> {
  if (input.endpoint) return input.endpoint
  if (input.port) return createMessagePortProcessEndpoint({ port: input.port, decode: (value) => value })
  throw new Error("persistent process bridge requires an endpoint")
}

function dispatch(client: PersistentProcessClient, request: BridgeRequest): BridgeOperationResult {
  switch (request.operation) {
    case "launch": return client.launch(request.args[0], request.args[1])
    case "list": return client.list()
    case "read": return client.read(...request.args)
    case "stop": return client.stop(request.args[0])
    case "release": return client.release(request.args[0]).then(() => undefined)
  }
}

function decodeRequest(value: unknown): BridgeRequest | undefined {
  if (!isFields(value) || !isPositiveSafeInteger(value.id) || typeof value.operation !== "string" || !Array.isArray(value.args)) return undefined
  const id = value.id
  const args = value.args
  switch (value.operation) {
    case "launch": {
      if (args.length !== 2 || !isStringArray(args[0])) return undefined
      const options = parseLaunchOptions(args[1])
      if (args[1] !== undefined && options === undefined) return undefined
      return { id, operation: "launch", args: [args[0], options] }
    }
    case "list": return args.length === 0 ? { id, operation: "list", args: [] } : undefined
    case "read":
      return args.length === 4 && typeof args[0] === "string" && (args[1] === "stdout" || args[1] === "stderr") && typeof args[2] === "number" && typeof args[3] === "number"
        ? { id, operation: "read", args: [args[0], args[1], args[2], args[3]] }
        : undefined
    case "stop":
    case "release": return args.length === 1 && typeof args[0] === "string" ? { id, operation: value.operation, args: [args[0]] } : undefined
    default: return undefined
  }
}

function decodeReply(value: unknown): { readonly id: number; readonly ok: true; readonly value: unknown } | { readonly id: number; readonly ok: false; readonly error: string } | undefined {
  if (!isFields(value) || !isPositiveSafeInteger(value.id) || typeof value.ok !== "boolean") return undefined
  if (value.ok === true && Object.hasOwn(value, "value")) return { id: value.id, ok: true, value: value.value }
  if (value.ok === false && typeof value.error === "string") return { id: value.id, ok: false, error: value.error }
  return undefined
}

function safeRequestId(value: unknown): number | undefined {
  return isFields(value) && isPositiveSafeInteger(value.id) ? value.id : undefined
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function parseLaunchOptions(value: unknown): PersistentLaunchData | undefined {
  if (value === undefined) return undefined
  if (!hasExactKeys(value, ["cwd", "env"]) || (value.cwd !== undefined && typeof value.cwd !== "string")) return undefined
  const env = parseEnvironment(value.env)
  if (value.env !== undefined && env === undefined) return undefined
  return { cwd: value.cwd, env }
}

interface ParsedEnvironment {
  readonly [name: string]: string | undefined
}

function parseEnvironment(value: unknown): ParsedEnvironment | undefined {
  if (value === undefined) return undefined
  if (!isFields(value)) return undefined
  const environment: { [name: string]: string | undefined } = {}
  for (const [name, entry] of Object.entries(value)) {
    if (entry !== undefined && typeof entry !== "string") return undefined
    environment[name] = entry
  }
  return environment
}

function parseProcessRecords(value: unknown): readonly PersistentProcessRecord[] {
  if (!Array.isArray(value)) throw new Error("invalid persistent process list reply")
  return value.map(parseProcessRecord)
}

function parseProcessRecord(value: unknown): PersistentProcessRecord {
  if (!isFields(value) || typeof value.id !== "string" || typeof value.pid !== "number" || !isStringArray(value.command)
    || typeof value.startedAtMs !== "number" || (value.status !== "running" && value.status !== "exited")
    || typeof value.stdoutBytes !== "number" || typeof value.stderrBytes !== "number") throw new Error("invalid persistent process record reply")
  const base = {
    id: value.id,
    pid: value.pid,
    command: value.command,
    spool: parseSpool(value.spool),
    startedAtMs: value.startedAtMs,
    stdoutBytes: value.stdoutBytes,
    stderrBytes: value.stderrBytes,
  }
  if (value.status === "running") {
    if (Object.hasOwn(value, "exitCode")) throw new Error("invalid persistent process record reply")
    return { ...base, status: "running" }
  }
  if (typeof value.exitCode !== "number") throw new Error("invalid persistent process record reply")
  return { ...base, status: "exited", exitCode: value.exitCode }
}


function parseSpool(value: unknown): PersistentSpool {
  if (!isFields(value) || typeof value.directory !== "string" || typeof value.stdoutPath !== "string" || typeof value.stderrPath !== "string") throw new Error("invalid persistent process spool reply")
  return { directory: value.directory, stdoutPath: value.stdoutPath, stderrPath: value.stderrPath }
}

function parseRead(value: unknown): PersistentRead {
  if (!isFields(value) || !(value.data instanceof Uint8Array) || typeof value.nextOffset !== "number" || typeof value.eof !== "boolean") throw new Error("invalid persistent read reply")
  return { data: value.data, nextOffset: value.nextOffset, eof: value.eof }
}

function parseVoid(value: unknown): void {
  if (value !== undefined) throw new Error("invalid persistent process acknowledgement")
}

function parseStopResult(value: unknown): PersistentStopResult {
  if (value !== "terminated" && value !== "already_exited" && value !== "unsettled") throw new Error("invalid persistent stop acknowledgement")
  return value
}

function isFields(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function hasExactKeys(value: unknown, allowed: readonly string[]): value is UnknownFields {
  return isFields(value) && Object.keys(value).every((key) => allowed.includes(key))
}
