import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../infra/owned-command.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import type { McpCallResult } from "../../agent-runtime/mcp-result.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import {
  IOS_SIMULATOR_ACTIONS,
  REQUIRED_IOS_SIMULATOR_MCP_TOOLS,
  type IosSimulatorCallRequest,
  type IosSimulatorRequest,
  type SimulatorWorkflow,
} from "./ios-simulator-tool.js"
import {
  connectOwnedIosSimulatorBackend,
  type IosSimulatorBackend,
  type IosSimulatorBackendConnectionInput,
} from "./ios-simulator-backend.js"
import {
  executeIosSimulatorPointTap,
  IOS_SIMULATOR_POINT_TAP_SCHEMA,
  IOS_SIMULATOR_POINT_TAP_TOOL,
} from "./ios-simulator-point-tap.js"

const ENABLED_WORKFLOWS = "simulator,simulator-management,ui-automation"
const SNAPSHOT_ACTIONS = new Set(["snapshot-ui", "wait-for-ui"])
const ELEMENT_REF_ACTIONS = new Set(["batch", "drag", "long-press", "swipe", "tap", "touch", "type-text"])
const UI_MUTATING_ACTIONS = new Set([
  "batch",
  "boot",
  "button",
  "drag",
  "gesture",
  "key-press",
  "key-sequence",
  "long-press",
  "open",
  "set-appearance",
  "statusbar",
  "swipe",
  "tap",
  "tap-point",
  "touch",
  "toggle-connect-hardware-keyboard",
  "toggle-software-keyboard",
  "type-text",
])

interface UnknownObject {
  readonly [key: string]: unknown
}

export interface IosSimulatorService extends ModuleServiceInstance {
  execute(request: IosSimulatorRequest, signal?: AbortSignal): Promise<McpCallResult>
}

export const iosSimulatorService = moduleServiceHandle<IosSimulatorService>("development")

interface Backend {
  readonly connection: IosSimulatorBackend
  readonly lifecycle: AbortController
}

interface Waiter {
  readonly admit: () => void
  readonly abort: AbortController
  readonly reject: (reason: Error) => void
  readonly signal?: AbortSignal
  forget(): void
}

export interface IosSimulatorServiceDeps {
  readonly launcher: LauncherScope
  readonly executionCwd: string
  readonly resolveCli?: () => string
  readonly executable?: string
  readonly connect?: (input: IosSimulatorBackendConnectionInput) => Promise<IosSimulatorBackend>
  readonly runOwnedCommand?: OwnedCommandRunner
}

function defaultCliPath(): string {
  return fileURLToPath(import.meta.resolve("xcodebuildmcp"))
}

function definedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("iOS Simulator operation was cancelled")
}

/** Owns one lazy XcodeBuildMCP MCP process and serializes calls that share semantic snapshot state. */
export function createIosSimulatorService(deps: IosSimulatorServiceDeps): IosSimulatorService {
  const scope = deps.launcher.open()
  const runOwnedCommand = deps.runOwnedCommand ?? ownedCommandRunner(scope)
  const connect = deps.connect ?? connectOwnedIosSimulatorBackend
  const requiredTools = REQUIRED_IOS_SIMULATOR_MCP_TOOLS
  const command = deps.executable ?? process.execPath
  const resolveCli = deps.resolveCli ?? defaultCliPath
  const environment = () => ({
    ...definedEnvironment(),
    XCODEBUILDMCP_SENTRY_DISABLED: "true",
    XCODEBUILDMCP_ENABLED_WORKFLOWS: ENABLED_WORKFLOWS,
    XCODEBUILDMCP_DISABLE_SESSION_DEFAULTS: "true",
  })

  let backend: Backend | undefined
  let stopping: Promise<void> | undefined
  let active = false
  let activeAbort: AbortController | undefined
  const waiters: Waiter[] = []
  const inFlight = new Set<Promise<McpCallResult>>()
  let closed = false
  let snapshotToken: string | undefined

  const stopBackend = (expected?: Backend): Promise<void> => {
    if (stopping) return stopping
    const current = backend
    if (!current || expected && current !== expected) return Promise.resolve()
    backend = undefined
    snapshotToken = undefined
    current.lifecycle.abort(new Error("iOS Simulator backend is stopping"))
    stopping = current.connection.close().finally(() => { stopping = undefined })
    return stopping
  }

  const startBackend = async (signal?: AbortSignal): Promise<Backend> => {
    if (backend) return backend
    await stopping
    signal?.throwIfAborted()
    const lifecycle = new AbortController()
    const onAbort = (): void => {
      if (signal) lifecycle.abort(abortError(signal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    let connection: IosSimulatorBackend
    try {
      connection = await connect({
        command,
        args: [resolveCli(), "mcp"],
        cwd: deps.executionCwd,
        env: environment(),
        signal: lifecycle.signal,
        requiredTools,
        spawnOwned: scope.spawnOwned,
      })
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
    if (signal?.aborted) {
      await connection.close()
      throw abortError(signal)
    }
    const missing = requiredTools.filter((name) => !connection.tools.has(name))
    if (missing.length > 0) {
      await connection.close()
      throw new Error(`Pinned XcodeBuildMCP backend is missing required tools: ${missing.join(", ")}`)
    }
    const current: Backend = { connection, lifecycle }
    backend = current
    connection.onClose(() => {
      if (backend === current) {
        backend = undefined
        snapshotToken = undefined
      }
    })
    return current
  }

  const drainQueue = (): void => {
    if (active || closed) return
    while (waiters.length > 0) {
      const waiter = waiters.shift()
      if (!waiter) return
      waiter.forget()
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal))
        continue
      }
      active = true
      activeAbort = waiter.abort
      waiter.admit()
      return
    }
  }

  const admit = (abort: AbortController): Promise<void> => {
    const signal = abort.signal
    if (closed) return Promise.reject(new Error("iOS Simulator service is closing"))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const deferred = Promise.withResolvers<void>()
    const onAbort = (): void => {
      const index = waiters.indexOf(waiter)
      if (index < 0) return
      waiters.splice(index, 1)
      waiter.forget()
      deferred.reject(abortError(signal))
    }
    const waiter: Waiter = {
      admit: deferred.resolve,
      abort,
      reject: deferred.reject,
      signal,
      forget: () => signal?.removeEventListener("abort", onAbort),
    }
    waiters.push(waiter)
    signal?.addEventListener("abort", onAbort, { once: true })
    drainQueue()
    return deferred.promise
  }

  const schemaResult = (workflow: SimulatorWorkflow, current: Backend): McpCallResult => {
    const actions = Object.entries(IOS_SIMULATOR_ACTIONS[workflow]).map(([action, mcpName]) => ({
      action,
      mcpName,
      inputSchema: mcpName === IOS_SIMULATOR_POINT_TAP_TOOL
        ? IOS_SIMULATOR_POINT_TAP_SCHEMA
        : current.connection.tools.get(mcpName),
    }))
    const structuredContent = { workflow, actions }
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      isError: false,
      structuredContent,
    }
  }

  const executeCall = async (
    request: IosSimulatorCallRequest,
    current: Backend,
    operationSignal: AbortSignal,
  ): Promise<McpCallResult> => {
    if (ELEMENT_REF_ACTIONS.has(request.action)) {
      if (!snapshotToken) throw new Error(`${request.action} requires a fresh snapshot and its snapshotToken`)
      if (!request.snapshotToken) throw new Error(`${request.action} requires the current snapshotToken`)
      if (request.snapshotToken !== snapshotToken) throw new Error(`${request.action} snapshot token is stale; capture a fresh snapshot`)
    }
    if (UI_MUTATING_ACTIONS.has(request.action)) snapshotToken = undefined
    let result = await current.connection.call(request.mcpName, request.arguments, operationSignal)
    if (!result.isError && SNAPSHOT_ACTIONS.has(request.action)) {
      snapshotToken = randomUUID()
      const prior = result.structuredContent
      result = {
        ...result,
        structuredContent: isRecord(prior)
          ? { ...prior, snapshotToken }
          : { backendResult: prior, snapshotToken },
      }
    }
    return result
  }

  const executeAdmitted = async (request: IosSimulatorRequest, abort: AbortController): Promise<McpCallResult> => {
    const operationSignal = abort.signal
    let current: Backend | undefined
    const onAbort = (): void => { if (current) void stopBackend(current) }
    operationSignal.addEventListener("abort", onAbort, { once: true })
    try {
      if (request.kind === "call" && request.mcpName === IOS_SIMULATOR_POINT_TAP_TOOL) {
        operationSignal.throwIfAborted()
        if (closed) throw new Error("iOS Simulator service is closing")
        snapshotToken = undefined
        return await executeIosSimulatorPointTap({
          runOwnedCommand,
          cliPath: resolveCli(),
          arguments: request.arguments,
          signal: operationSignal,
        })
      }
      current = await startBackend(operationSignal)
      operationSignal.throwIfAborted()
      if (closed) throw new Error("iOS Simulator service is closing")
      return request.kind === "schema"
        ? schemaResult(request.workflow, current)
        : await executeCall(request, current, operationSignal)
    } catch (error) {
      if (operationSignal.aborted) throw abortError(operationSignal)
      throw error
    } finally {
      operationSignal.removeEventListener("abort", onAbort)
      if (operationSignal.aborted && current) await stopBackend(current)
    }
  }

  const execute = (request: IosSimulatorRequest, signal?: AbortSignal): Promise<McpCallResult> => {
    const abort = new AbortController()
    const onAbort = (): void => {
      if (signal) abort.abort(abortError(signal))
    }
    if (signal?.aborted) abort.abort(abortError(signal))
    signal?.addEventListener("abort", onAbort, { once: true })
    let admitted = false
    const operation = (async () => {
      await admit(abort)
      admitted = true
      try {
        abort.signal.throwIfAborted()
        if (closed) throw new Error("iOS Simulator service is closing")
        return await executeAdmitted(request, abort)
      } finally {
        if (activeAbort === abort) activeAbort = undefined
        active = false
        drainQueue()
      }
    })().finally(() => {
      signal?.removeEventListener("abort", onAbort)
      if (!admitted) drainQueue()
    })
    inFlight.add(operation)
    void operation.finally(() => inFlight.delete(operation)).catch(() => {})
    return operation
  }

  const closeAdmission = (): void => {
    if (closed) return
    closed = true
    activeAbort?.abort(new Error("iOS Simulator service is closing"))
    for (const waiter of waiters.splice(0)) {
      waiter.forget()
      waiter.reject(new Error("iOS Simulator service is closing"))
    }
  }

  return {
    execute,
    closeAdmission,
    async dispose() {
      closeAdmission()
      await Promise.allSettled(inFlight)
      await stopBackend()
      const closure = await scope.close()
      if (!closure.settled) throw new Error(`iOS Simulator process ownership did not settle: ${closure.reason}`)
    },
  }
}

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createDevelopmentIosSimulatorService(services: ModuleProcessServices): IosSimulatorService {
  return createIosSimulatorService({ launcher: services.launcher, executionCwd: services.directories.executionCwd })
}
