import { isAbsolute, resolve, sep } from "node:path"
import { canonicalPathWithMissingTail } from "../../infra/canonical-path.js"
import { Log } from "../../infra/log.js"
import { processLoginShellPath, type LoginShellPath } from "../../infra/login-shell-path.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import { withDeadline } from "../../infra/with-deadline.js"
import type { GitAiAttributionStatus } from "../../protocol/git-ai-attribution-protocol-types.js"

const CHECKPOINT_ARGS = Object.freeze(["checkpoint", "agent-v1", "--hook-input", "stdin"])
const COMMAND_TIMEOUT_MS = 2_000
const DISPOSAL_DRAIN_MS = 500
const MAX_QUEUED_OPERATIONS = 32
const MAX_QUEUED_BYTES = 8 * 1_024 * 1_024
const log = Log.create({ service: "git-ai-attribution" })
/** The agent name that every git-ai checkpoint of Flywheel carries: a git-ai wire value, not a name Flywheel shows. */
export const GIT_AI_AGENT_NAME = "opencode"
const SAFE_ENVIRONMENT_KEYS = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "PATHEXT", "LANG", "LC_ALL"] as const

interface JsonObject { readonly [key: string]: unknown }
interface StringEnvironment { [key: string]: string }

export interface GitAiTranscriptMessage {
  readonly type: "user" | "assistant" | "tool_use"
  readonly text?: string
  readonly name?: string
  readonly input?: JsonObject
  readonly timestamp: string
}

export interface GitAiRequestRegistration {
  readonly requestId: string
  readonly model: string
  readonly conversationId: string
  readonly transcript: () => { readonly messages: readonly GitAiTranscriptMessage[] }
  readonly transcriptBytes: number
}

interface GitAiDirectFile {
  readonly path: string
  readonly beforeContent: string
  readonly afterContent: string
}

interface AttributionOperation {
  readonly identity: GitAiRequestRegistration
  readonly files: readonly GitAiDirectFile[]
}

function canonicalRepositoryPath(authoredPath: string, repositoryRoot: string): string | undefined {
  try {
    const unresolved = isAbsolute(authoredPath) ? authoredPath : resolve(repositoryRoot, authoredPath)
    const path = canonicalPathWithMissingTail(unresolved)
    return path === repositoryRoot || path.startsWith(repositoryRoot + sep) ? path : undefined
  } catch {
    return undefined
  }
}

export interface GitAiAttributionService {
  readonly canonicalRepositoryRoot: string
  status(): GitAiAttributionStatus
  subscribe(listener: (status: GitAiAttributionStatus) => void): () => void
  checkAvailability(): Promise<GitAiAttributionStatus>
  registerRequest(registration: GitAiRequestRegistration): GitAiRequestRegistration | undefined
  /** Queues one human and one AI checkpoint for files a tool call published. */
  direct(operation: AttributionOperation): void
  dispose(): Promise<void>
}

export interface GitAiAttributionServiceOptions {
  readonly canonicalRepositoryRoot: string
  readonly runOwnedCommand: OwnedCommandRunner
  /** Finds git-ai on the given search PATH, or on the process's own PATH when it is undefined. */
  readonly resolveExecutable?: (path: string | undefined) => string | null
  /** The PATH agent commands use. A service started from a desktop app
   *  inherits a minimal PATH that misses the user's own install directories. */
  readonly loginShellPath?: Pick<LoginShellPath, "current" | "watch">
}

/** Owns one bounded FIFO checkpoint lane for one canonical repository. Failures
 * are observations only: attribution never changes a tool's result or rejection. */
export function createGitAiAttributionService(options: GitAiAttributionServiceOptions): GitAiAttributionService {
  const disposal = new AbortController()
  const lane = createBackgroundLane(log, "git-ai-attribution")
  const environment = safeEnvironment(process.env)
  const loginShellPath = options.loginShellPath ?? processLoginShellPath
  const resolveExecutable = options.resolveExecutable ?? ((path) => Bun.which("git-ai", path === undefined ? undefined : { PATH: path }))
  let executable: string | undefined
  let queuedOperations = 0
  let queuedBytes = 0
  let accepting = true
  let availability: GitAiAttributionStatus = Object.freeze({ kind: "checking" })
  const availabilitySubscribers = new Set<(status: GitAiAttributionStatus) => void>()

  function setAvailability(next: GitAiAttributionStatus): GitAiAttributionStatus {
    availability = Object.freeze(next)
    for (const subscriber of availabilitySubscribers) subscriber(availability)
    return availability
  }

  function resolveAvailability(): GitAiAttributionStatus {
    if (executable !== undefined) return setAvailability({ kind: "available" })
    try {
      executable = resolveExecutable(loginShellPath.current()) ?? undefined
      return setAvailability(executable === undefined
        ? { kind: "unavailable", reason: "command-not-found" }
        : { kind: "available" })
    } catch {
      return setAvailability({ kind: "unavailable", reason: "check-failed" })
    }
  }

  async function checkAvailability(): Promise<GitAiAttributionStatus> {
    return accepting ? resolveAvailability() : availability
  }

  // The login shell PATH can arrive after the startup check found nothing.
  // Before that check, it stays pending so the check reads the PATH itself.
  const stopWatchingPath = loginShellPath.watch(() => {
    if (accepting && executable === undefined && availability.kind !== "checking") resolveAvailability()
  })

  function registerRequest(registration: GitAiRequestRegistration): GitAiRequestRegistration | undefined {
    if (!accepting || resolveAvailability().kind !== "available") return undefined
    return Object.freeze(registration)
  }

  function checkpointCommand(): readonly string[] | undefined {
    if (executable === undefined && resolveAvailability().kind !== "available") return undefined
    return executable === undefined ? undefined : [executable, ...CHECKPOINT_ARGS]
  }

  /** Resolves true only when the checkpoint ran and exited 0. */
  async function runCheckpoint(stdin: string): Promise<boolean> {
    const command = checkpointCommand()
    if (!command) return false
    try {
      const result = await options.runOwnedCommand(command, {
        cwd: options.canonicalRepositoryRoot,
        env: withSearchPath(environment, loginShellPath.current()),
        stdin,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal: disposal.signal,
      })
      return result.exitCode === 0 && !result.timedOut
    } catch {
      return false
    }
  }

  /** Drops the job when the lane is closed or its operation or byte budget is spent. */
  function enqueue(payloads: () => readonly JsonObject[], bytes: number): void {
    if (!accepting || queuedOperations >= MAX_QUEUED_OPERATIONS || queuedBytes + bytes > MAX_QUEUED_BYTES) return
    queuedOperations += 1
    queuedBytes += bytes
    lane.runInBackground("checkpoint", async () => {
      try {
        for (const payload of payloads()) {
          if (!await runCheckpoint(JSON.stringify(payload))) return
        }
      } finally {
        queuedOperations -= 1
        queuedBytes -= bytes
      }
    })
  }

  function dirtyFiles(files: readonly GitAiDirectFile[], image: "beforeContent" | "afterContent"): JsonObject {
    return Object.fromEntries(files.map((file) => [file.path, file[image]]))
  }

  function humanPayload(operation: AttributionOperation): JsonObject {
    return {
      type: "human",
      repo_working_dir: options.canonicalRepositoryRoot,
      dirty_files: dirtyFiles(operation.files, "beforeContent"),
      will_edit_filepaths: operation.files.map((file) => file.path),
    }
  }

  function aiPayload(operation: AttributionOperation): JsonObject {
    return {
      type: "ai_agent",
      repo_working_dir: options.canonicalRepositoryRoot,
      transcript: operation.identity.transcript(),
      agent_name: GIT_AI_AGENT_NAME,
      dirty_files: dirtyFiles(operation.files, "afterContent"),
      edited_filepaths: operation.files.map((file) => file.path),
      model: operation.identity.model,
      conversation_id: operation.identity.conversationId,
    }
  }

  function operationBytes(operation: AttributionOperation): number {
    let bytes = operation.identity.model.length * 2 + operation.identity.conversationId.length * 2 + operation.identity.transcriptBytes
    for (const file of operation.files) bytes += (file.path.length + file.beforeContent.length + file.afterContent.length) * 2
    return bytes
  }

  function direct(operation: AttributionOperation): void {
    const files = operation.files.flatMap((file) => {
      const path = canonicalRepositoryPath(file.path, options.canonicalRepositoryRoot)
      return path === undefined ? [] : [{ ...file, path }]
    })
    if (files.length === 0) return
    const admitted = { ...operation, files }
    enqueue(() => [humanPayload(admitted), aiPayload(admitted)], operationBytes(admitted))
  }

  async function dispose(): Promise<void> {
    if (!accepting) return
    accepting = false
    stopWatchingPath()
    // A project executor disposes this service in its stop and then ends by
    // returning, so each bound must clear its timer once the lane settles.
    const drained = await withDeadline(lane.settled(), DISPOSAL_DRAIN_MS).then(() => true, () => false)
    if (!drained) {
      disposal.abort()
      await withDeadline(lane.settled(), DISPOSAL_DRAIN_MS).catch(() => undefined)
    }
    availabilitySubscribers.clear()
  }

  return Object.freeze({
    canonicalRepositoryRoot: options.canonicalRepositoryRoot,
    status: () => availability,
    subscribe: (listener: (status: GitAiAttributionStatus) => void) => { availabilitySubscribers.add(listener); return () => { availabilitySubscribers.delete(listener) } },
    checkAvailability,
    registerRequest,
    direct,
    dispose,
  })
}

function safeEnvironment(source: NodeJS.ProcessEnv): StringEnvironment {
  const entries: Array<[string, string]> = []
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

function withSearchPath(environment: StringEnvironment, path: string | undefined): StringEnvironment {
  return path === undefined ? environment : { ...environment, PATH: path }
}