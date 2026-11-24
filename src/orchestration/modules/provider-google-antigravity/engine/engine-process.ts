import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { antigravityEnginePath, requireQualifiedAntigravityVersion, separatedAntigravityEnvironment, type AntigravityEngineHost } from "../../../../infra/antigravity-engine.js"
import { DebugLog } from "../../../../infra/debug-log.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { Log } from "../../../../infra/log.js"
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../infra/owned-command.js"
import type { OwnedProcess } from "../../../../infra/owned-subprocess.js"
import { acquireLock, LockRefusal, releaseLock } from "../../../../infra/ownership-file-lock.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"
import { ProviderAuthenticationError } from "../../../agent-runtime/llm/stream/provider-failure.js"
import { AcpRequestError, openAcpConnection, type AcpConnection } from "../acp/connection.js"
import type { AcpMethod, AcpNewSessionResult, AcpPromptResult, AcpRequests, AcpSessionUpdate, AcpTextBlock } from "../acp/schema.js"
import { acpRequestFailure } from "../acp/errors.js"
import type { GateHookHandler } from "./hook-command.js"
import type { ToolListener, ToolServerRegistration } from "../tools/mcp-server.js"
import { acpLaunch, engineToolName, prepareLoginHome, writeLaunchMcpConfig } from "./private-home.js"
import { createRetryWatch, failedAttemptLogReader, failedAttemptTranscriptDetail } from "./retry-watch.js"
import { readConversationRows, type ConversationRead } from "../usage/conversation-usage.js"
import { createProcessRecord, sessionConversationPath, sessionTranscriptPath, sweepLogin } from "./session-files.js"
import { keychainReachedFailure, prepareTokenStore, tokenStoreObservation, TokenStoreUnavailableError } from "./token-store.js"
import type { McpToolDeclaration } from "../tools/tool-projection.js"

const log = Log.create({ service: "provider-google-antigravity" })

/** How long a launch waits for each engine answer before it fails: agy answers `initialize` in 64 to 350 ms and lists
 *  Flywheel's tools a few ms after it (REPORT.md Q7). */
const LAUNCH_STEP_DEADLINE_MS = 30_000
/** How long a closed engine has to exit by itself after its input ended, before it is ended. agy exits in a few ms. */
const EXIT_GRACE_MS = 5_000
/** How often an engine reads its log, from launch until it exited, and the transcripts of its open prompts. A failed
 *  attempt shows there 1 to 4 ms after the response, and agy retries at least 4 s later. */
const OBSERVE_INTERVAL_MS = 50

/** The commands that agy advertises for Flywheel's agent (`excludeDefaultComponents`). Its default agent advertises
 *  more (`goal`, `browser`, `swarm` and others), so any other command shows that agy runs its default agent. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(["plan", "grill-me", "learn"])
/** agy's log line when the agent that `--agent` names does not load, after which it runs its default agent silently. */
const AGENT_FALLBACK = /Agent "[^"]*" not found, falling back to default/u

/** Why an engine cannot serve the login. `login-in-use`: another live Flywheel process serves the login.
 *  `agent-fallback`: agy runs its default agent instead of Flywheel's. `engine-missing`: no verified engine is placed.
 *  `engine-unqualified`: the engine is not the qualified version. `launch-failed`: the engine did not start or
 *  answer. */
export type EngineUnavailableReason = "login-in-use" | "agent-fallback" | "engine-missing" | "engine-unqualified" | "launch-failed"

export class EngineUnavailableError extends RouteUnavailableError {
  constructor(readonly reason: EngineUnavailableReason, message: string) {
    super(message)
    this.name = "EngineUnavailableError"
  }
}

/** What the owner of one engine session hears: each of its ACP updates, and each of its MCP tool calls, which waits
 *  until the returned promise settles (`signal` aborts when agy gives the call up). */
interface EngineSessionHandlers {
  readonly onUpdate: (update: AcpSessionUpdate) => void
  readonly onToolCall: ToolServerRegistration["onCall"]
}

/** How an engine process ended. `served`: a prompt of it answered. `failure`: the error that ended it, when one did. */
interface EngineEnd {
  readonly reason: string
  readonly served: boolean
  readonly failure?: Error
}

/** One running `agy acp` process, shared by the sessions of one chat tree on one login (ARCH-PROVIDERS-086). */
export interface EngineProcess {
  readonly processId: string
  readonly loginDir: string
  /** The tools that the process declared at launch, which it never changes (agy reads them at launch only). */
  readonly toolNames: ReadonlySet<string>
  /** Whether a prompt of the process answered. */
  readonly served: boolean
  /** Settles once the process exited and its session files and record are removed. */
  readonly ended: Promise<EngineEnd>
  /** Opens one engine session in the login's private workspace, with `append` after the agent's fixed text. Rejects
   *  with the process's failure when the engine runs its default agent or reached a keyring. */
  openSession(options: { readonly append?: string } & EngineSessionHandlers): Promise<AcpNewSessionResult>
  /** Forgets the session `sessionId` that its owner retired: its handlers and its transcript reader. Later updates and
   *  calls of the session reach no one, and a call of it fails; a prompt of it that is still open settles as before. */
  releaseSession(sessionId: string): void
  /** Sends one prompt to `sessionId` and settles with its result. When the retry watch saw a failed attempt of it, the
   *  prompt is cancelled and rejects with that failure; when the process failed, it rejects with that failure. */
  prompt(sessionId: string, prompt: readonly AcpTextBlock[]): Promise<AcpPromptResult>
  /** Sends `session/cancel` for `sessionId`. */
  cancel(sessionId: string): Promise<void>
  /** The usage of each model request that agy recorded for `sessionId` after the request `afterIdx`. */
  conversationRows(sessionId: string, afterIdx: number): ConversationRead
  /** Changes the model or a configuration option of a session between prompts. */
  configure<M extends "session/set_config_option" | "session/set_model">(method: M, params: AcpRequests[M]["params"]): Promise<AcpRequests[M]["result"]>
  /** Whether no prompt is open. */
  idle(): boolean
  /** Settles when no prompt is open. */
  whenIdle(): Promise<void>
  /** Ends the engine's input, waits for its exit (ending it after a grace), and settles with `ended`. */
  close(reason: string): Promise<EngineEnd>
}

export interface EngineLaunchOptions {
  /** The absolute login directory. */
  readonly loginDir: string
  readonly launcher: Pick<LauncherScope, "spawnOwned">
  readonly host: AntigravityEngineHost
  /** The login's PreInvocation handler (`gateHookHandler`). */
  readonly gateHook: GateHookHandler
  readonly toolListener: Pick<ToolListener, "register" | "unregister">
  /** The tree's composed tool surface, every tool declared eager. */
  readonly tools: readonly McpToolDeclaration[]
  /** Flywheel's own client identity (decision 12). */
  readonly clientInfo: { readonly name: string; readonly version: string }
  /** The ACP auth method to authenticate with after `initialize`, such as `gemini-api-key` against a fake host. */
  readonly authMethod?: string
  /** Test seams: `retryWatch: false` turns the retry watch off (the control case); `transcriptSign` returns false for a
   *  session whose transcript signs the watch must not see. */
  readonly testSeams?: { readonly retryWatch?: boolean; readonly transcriptSign?: (sessionId: string) => boolean }
}

/** The launches of this process, by login directory: one at a time per login, so a launch never waits on the launch
 *  lock of a sibling of the same process, and the lock decides only between processes. */
const launches = new Map<string, Promise<unknown>>()

function oneLaunchPerLogin<T>(loginDir: string, launch: () => Promise<T>): Promise<T> {
  const launched = (launches.get(loginDir) ?? Promise.resolve()).then(launch)
  const tail = launched.catch(() => {})
  launches.set(loginDir, tail)
  void tail.then(() => { if (launches.get(loginDir) === tail) launches.delete(loginDir) })
  return launched
}

/**
 * Runs `work` while this process owns the login directory `loginDir` against every other process: under the login's
 * launch lock, after a sweep (`sweepLogin`) proved that no live owner of another process serves the login. Every write
 * to the login's private home and every `agy` run on it happens inside this bracket, so the hook that `hooks.json`
 * names is always the one of the process whose engines run on the login (plan P15). `work` may remove the login
 * directory, and the lock goes with it. Rejects with `EngineUnavailableError` (`login-in-use`) when another process
 * holds the lock or serves the login, and runs nothing then.
 */
export async function withLoginOwnership<T>(loginDir: string, work: () => Promise<T>): Promise<T> {
  let lock: Awaited<ReturnType<typeof acquireLock>>
  try {
    lock = await acquireLock(join(loginDir, "launch.lock"))
  } catch (error) {
    if (error instanceof LockRefusal) throw new EngineUnavailableError("login-in-use", `Another Flywheel process is starting an Antigravity engine on the login at ${loginDir}: ${error.message}`)
    throw error
  }
  try {
    if (sweepLogin(loginDir).kind === "in-use") throw new EngineUnavailableError("login-in-use", `Another Flywheel process serves the Google Antigravity login at ${loginDir}.`)
    return await work()
  } finally {
    if (existsSync(loginDir)) releaseLock(lock)
  }
}

/**
 * Launches one engine process on `options.loginDir` (plan M11, ARCH-PROVIDERS-086). While this process owns the login
 * (`withLoginOwnership`) it checks the login-stable files, prepares the token store (no `agy` runs before it, P16),
 * qualifies the engine's version in the separated environment, records the new process, serves its tools on its own
 * path and token, writes the per-launch MCP configuration, and starts `agy acp`. Its output is read from launch: ACP
 * frames, its standard error (drained, never kept), its exit, and its log. The lock is released once the engine listed
 * its tools, so the next launch can rewrite the MCP configuration. Rejects with `EngineUnavailableError`,
 * `TokenStoreUnavailableError`, or a login failure, and then leaves no process, record, or tool path behind.
 */
export function launchEngine(options: EngineLaunchOptions): Promise<EngineProcess> {
  return oneLaunchPerLogin(options.loginDir, async () => {
    const started = Date.now()
    try {
      return await withLoginOwnership(options.loginDir, () => launchOwned(options, started))
    } catch (error) {
      throw launchFailure(error)
    }
  })
}

async function launchOwned(options: EngineLaunchOptions, started: number): Promise<EngineProcess> {
  const { loginDir, host } = options
  const run = ownedCommandRunner(options.launcher)
  const environment = separatedAntigravityEnvironment(host, loginDir)
  await prepareLoginHome(loginDir, { gateHook: options.gateHook, run }).catch((error: unknown) => {
    throw new EngineUnavailableError("launch-failed", `The Google Antigravity login at ${loginDir} could not be prepared: ${errorMessage(error)}`)
  })
  await prepareTokenStore(loginDir, { platform: host.platform, run })
  const processId = randomUUID()
  const launch = acpLaunch(loginDir, processId)
  const separatedRun: OwnedCommandRunner = (command, commandOptions) => run(command, { ...commandOptions, env: environment, cwd: launch.cwd })
  let enginePath: string
  try {
    enginePath = antigravityEnginePath()
  } catch (error) {
    throw new EngineUnavailableError("engine-missing", errorMessage(error))
  }
  await requireQualifiedAntigravityVersion(enginePath, separatedRun).catch((error: unknown) => {
    throw new EngineUnavailableError("engine-unqualified", errorMessage(error))
  })
  const record = createProcessRecord(loginDir, processId)
  const sessions = new Map<string, EngineSessionHandlers>()
  let server: ReturnType<ToolListener["register"]>
  let engine: OwnedProcess
  try {
    server = options.toolListener.register(processId, {
      tools: options.tools,
      onCall: (call, signal) => {
        const handlers = sessions.get(call.sessionId)
        if (handlers === undefined) return Promise.reject(new Error(`The engine session ${call.sessionId} has no owner in this process`))
        return handlers.onToolCall(call, signal)
      },
    })
    writeLaunchMcpConfig(loginDir, { url: server.url, token: server.token, toolNames: options.tools.map((tool) => tool.name) })
    mkdirSync(launch.cwd, { recursive: true })
    engine = await options.launcher.spawnOwned([enginePath, ...launch.args], { cwd: launch.cwd, env: environment })
  } catch (error) {
    options.toolListener.unregister(processId)
    record.remove()
    throw new EngineUnavailableError("launch-failed", `The Google Antigravity engine did not start: ${errorMessage(error)}`)
  }
  const { stdin, stdout } = engine
  if (stdin === undefined || stdout === undefined) {
    await engine.terminate()
    options.toolListener.unregister(processId)
    record.remove()
    throw new EngineUnavailableError("launch-failed", "The Google Antigravity engine started without its standard input and output pipes.")
  }
  const observed = observeEngine({ ...options, processId, engine, pipes: { stdin, stdout }, record, sessions, logFile: launch.logFile, workspace: launch.cwd, started })
  try {
    const signal = AbortSignal.timeout(LAUNCH_STEP_DEADLINE_MS)
    await observed.connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: options.clientInfo,
    }, signal)
    // agy 1.5.14 boots its backend, which reads the MCP configuration and lists the tools, at the first request after
    // `initialize`, and not before. A Google login has no `authenticate`: `session/list` boots the backend on agy's
    // stored sign-in, with no browser and no model request, so the tools are listed while this launch still holds the
    // login and the next launch cannot rewrite the configuration first.
    if (options.authMethod === undefined) await observed.connection.request("session/list", { cwd: launch.cwd }, signal)
    else await observed.connection.request("authenticate", { methodId: options.authMethod }, signal)
    await Promise.race([server.ready, observed.engine.ended.then(() => { throw new Error("the engine ended before it listed its tools") }), abortion(signal)])
  } catch (error) {
    await observed.engine.close("launch-failed")
    throw launchFailure(error)
  }
  DebugLog.record({ type: "provider.antigravity.process.started", payload: { processId, pid: engine.pid, tools: options.tools.length, durationMs: Date.now() - started } })
  return observed.engine
}

function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("the engine did not answer within the launch deadline")), { once: true })
  })
}

/** The typed failure of a launch: a typed failure stays, and every other error, such as a login directory that was
 *  removed, is an engine that cannot start, so the walk fails over at once. */
function launchFailure(error: unknown): Error {
  if (error instanceof RouteUnavailableError || error instanceof ProviderAuthenticationError) return error
  if (error instanceof AcpRequestError) return acpRequestFailure(error)
  return new EngineUnavailableError("launch-failed", `The Google Antigravity engine did not start: ${errorMessage(error)}`)
}

/** The complete lines appended to the file at `path` since the last read, from its start. A file that does not exist
 *  yet has none. */
function fileTail(path: string): () => string[] {
  let offset = 0
  let partial = ""
  const decoder = new StringDecoder("utf8")
  return () => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return []
    }
    if (size <= offset) return []
    const buffer = Buffer.alloc(size - offset)
    const descriptor = openSync(path, "r")
    let read: number
    try {
      read = readSync(descriptor, buffer, 0, buffer.length, offset)
    } finally {
      closeSync(descriptor)
    }
    offset += read
    const lines = (partial + decoder.write(buffer.subarray(0, read))).split("\n")
    partial = lines.pop() ?? ""
    return lines.map((line) => line.replace(/\r$/u, ""))
  }
}

interface ObservedLaunch extends EngineLaunchOptions {
  readonly processId: string
  readonly engine: OwnedProcess
  readonly pipes: { readonly stdin: NonNullable<OwnedProcess["stdin"]>; readonly stdout: NonNullable<OwnedProcess["stdout"]> }
  readonly record: ReturnType<typeof createProcessRecord>
  readonly sessions: Map<string, EngineSessionHandlers>
  readonly logFile: string
  readonly workspace: string
  readonly started: number
}

/** A prompt that is open, and the failure the retry watch ended it with. */
interface OpenPrompt {
  failure: Error | undefined
}

/** An engine process that is observed from launch, with its ACP connection. */
interface ObservedEngine {
  readonly engine: EngineProcess
  readonly connection: AcpConnection
}

/** Starts reading everything the engine writes and returns the engine process with its ACP connection. */
function observeEngine(launch: ObservedLaunch): ObservedEngine {
  const { processId, engine: owned, record, sessions, loginDir } = launch
  const seams = launch.testSeams ?? {}
  const openPrompts = new Map<string, OpenPrompt>()
  const transcripts = new Map<string, () => string[]>()
  const readLog = fileTail(launch.logFile)
  const readAttempt = failedAttemptLogReader()
  const idleWaiters: (() => void)[] = []
  // Updates of a session whose `session/new` answer the connection has passed on, before its owner registered.
  const early = new Map<string, AcpSessionUpdate[]>()
  let opening = 0
  let served = false
  let failure: Error | undefined
  let endReason: string | undefined
  let closing: Promise<EngineEnd> | undefined

  const fail = (error: Error) => {
    if (failure !== undefined) return
    failure = error
    log.warn("Google Antigravity engine failed", { processId, reason: error instanceof EngineUnavailableError || error instanceof TokenStoreUnavailableError ? error.reason : error.name })
    void close("failed")
  }
  const agentFallback = () => new EngineUnavailableError("agent-fallback", "The Google Antigravity engine runs its default agent instead of Flywheel's agent.")

  /** Every request of the engine: once the engine failed, a request that is pending or later rejects with that
   *  failure, not with the connection's close that the failure caused. */
  const request = async <M extends AcpMethod>(method: M, params: AcpRequests[M]["params"]): Promise<AcpRequests[M]["result"]> => {
    if (failure !== undefined) throw failure
    try {
      return await connection.request(method, params)
    } catch (error) {
      throw failure ?? error
    }
  }

  const connection = openAcpConnection({
    stdin: launch.pipes.stdin,
    stdout: launch.pipes.stdout,
    onNotification({ sessionId, update }) {
      if (update.sessionUpdate === "available_commands_update" && update.availableCommands.some(({ name }) => !AGENT_COMMANDS.has(name))) fail(agentFallback())
      const handlers = sessions.get(sessionId)
      if (handlers !== undefined) handlers.onUpdate(update)
      else if (opening > 0) early.set(sessionId, [...early.get(sessionId) ?? [], update])
    },
    onAgentRequestRefused: ({ method, sessionId }) => log.debug("Google Antigravity engine request refused", { processId, method, sessionId }),
    allowedTools: new Set(launch.tools.map((tool) => engineToolName(tool.name))),
  })
  void connection.closed.then(({ reason }) => {
    if (reason.kind !== "closed") void close(`connection-${reason.kind}`)
  })
  void drainStderr(owned, processId)

  const watch = createRetryWatch({
    processId,
    cancel(sessionId, error) {
      const open = openPrompts.get(sessionId)
      if (open !== undefined) open.failure = error
      void connection.notify("session/cancel", { sessionId }).catch(() => {})
    },
  })
  const watching = seams.retryWatch !== false

  /** Reads what the engine logged since the last read: a keyring call that the token store should have prevented, or
   *  the fallback to the default agent, fails the process; a failed attempt goes to the retry watch. Every line passes
   *  the attempt reader, so a record that spans two reads stays whole. */
  const observeLog = () => {
    const lines = readLog()
    if (lines.length === 0) return
    const keychain = keychainReachedFailure(tokenStoreObservation(lines))
    if (keychain !== undefined) fail(keychain)
    for (const line of lines) {
      if (AGENT_FALLBACK.test(line)) fail(agentFallback())
      const detail = readAttempt(line)
      if (watching && detail !== undefined) watch.observe({ kind: "log", detail })
    }
  }
  /** Transcripts first: a transcript sign and the log line of one attempt can arrive in one read, and the sign that
   *  names the session must reach the watch first. */
  const observe = () => {
    if (watching) {
      for (const sessionId of openPrompts.keys()) {
        for (const line of transcripts.get(sessionId)?.() ?? []) {
          const detail = failedAttemptTranscriptDetail(line)
          if (detail !== undefined && seams.transcriptSign?.(sessionId) !== false) watch.observe({ kind: "transcript", sessionId, detail })
        }
      }
    }
    observeLog()
  }

  // The log is read from launch, so an idle engine whose log shows a failure fails before its next request.
  const observer = setInterval(observe, OBSERVE_INTERVAL_MS)
  const ended: Promise<EngineEnd> = owned.exited.then((exit) => {
    clearInterval(observer)
    // The lines that the engine wrote just before it exited.
    observeLog()
    watch.dispose()
    launch.toolListener.unregister(processId)
    void connection.close()
    try {
      record.remove()
    } catch (error) {
      log.warn("Google Antigravity engine session files not removed", { processId, error: errorMessage(error) })
    }
    const reason = endReason ?? "exited"
    DebugLog.record({ type: "provider.antigravity.process.ended", payload: { processId, reason, served, code: exit.code, signal: exit.signal, sessions: record.sessions.length, durationMs: Date.now() - launch.started } })
    for (const resolve of idleWaiters.splice(0)) resolve()
    return { reason, served, ...(failure === undefined ? {} : { failure }) }
  })

  function close(reason: string): Promise<EngineEnd> {
    closing ??= (async () => {
      endReason ??= reason
      await connection.close()
      if (!await settlesWithin(owned.exited, EXIT_GRACE_MS)) await owned.terminate()
      return ended
    })()
    return closing
  }

  const engine: EngineProcess = {
    processId,
    loginDir,
    toolNames: new Set(launch.tools.map((tool) => tool.name)),
    get served() { return served },
    ended,
    async openSession({ append, ...handlers }) {
      if (failure !== undefined) throw failure
      opening += 1
      record.beginOpen()
      let opened: AcpNewSessionResult | undefined
      try {
        opened = await request("session/new", {
          cwd: launch.workspace,
          mcpServers: [],
          ...(append === undefined ? {} : { _meta: { antigravity: { systemPrompt: { append } } } }),
        })
      } finally {
        opening -= 1
        record.endOpen(opened?.sessionId)
      }
      const { sessionId } = opened
      sessions.set(sessionId, handlers)
      transcripts.set(sessionId, fileTail(sessionTranscriptPath(loginDir, sessionId)))
      for (const update of early.get(sessionId) ?? []) handlers.onUpdate(update)
      early.delete(sessionId)
      if (opening === 0) early.clear()
      observeLog()
      if (failure !== undefined) throw failure
      return opened
    },
    async prompt(sessionId, prompt) {
      // The keyring and agent checks of the log run before every prompt, so no prompt leaves for a failed engine.
      observeLog()
      if (failure !== undefined) throw failure
      // Steps of earlier prompts of the session are no sign of this one.
      transcripts.get(sessionId)?.()
      const open: OpenPrompt = { failure: undefined }
      openPrompts.set(sessionId, open)
      watch.open(sessionId)
      const started = Date.now()
      let stopReason = "failed"
      try {
        const result = await request("session/prompt", { sessionId, prompt })
        served = true
        stopReason = result.stopReason
        if (open.failure !== undefined) throw open.failure
        return result
      } catch (error) {
        throw open.failure ?? error
      } finally {
        DebugLog.record({ type: "provider.antigravity.prompt.ended", payload: { processId, sessionId, stopReason, durationMs: Date.now() - started } })
        watch.settle(sessionId)
        openPrompts.delete(sessionId)
        if (openPrompts.size === 0) for (const resolve of idleWaiters.splice(0)) resolve()
      }
    },
    releaseSession(sessionId) {
      sessions.delete(sessionId)
      transcripts.delete(sessionId)
    },
    cancel: (sessionId) => connection.notify("session/cancel", { sessionId }),
    conversationRows: (sessionId, afterIdx) => readConversationRows(sessionConversationPath(loginDir, sessionId), afterIdx),
    configure: (method, params) => request(method, params),
    idle: () => openPrompts.size === 0,
    whenIdle: () => openPrompts.size === 0 ? Promise.resolve() : new Promise((resolve) => { idleWaiters.push(resolve) }),
    close,
  }
  return { engine, connection }
}

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  try {
    return await Promise.race([promise.then(() => true, () => true), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Reads the engine's standard error to its end, so a full pipe never stops the engine, and keeps only its size. */
async function drainStderr(owned: OwnedProcess, processId: string): Promise<void> {
  if (owned.stderr === undefined) return
  let bytes = 0
  try {
    for await (const chunk of owned.stderr) bytes += chunk.byteLength
  } catch {
    // The pipe ends with the process.
  }
  if (bytes > 0) log.debug("Google Antigravity engine wrote to standard error", { processId, bytes })
}
