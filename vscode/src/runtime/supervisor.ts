import { spawn, type SpawnOptions } from "node:child_process"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { Redacted } from "effect"

import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { startRefusalCopy } from "../../../src/protocol/client/runtime-fault-copy.js"
import { createServeStatusReader, decodeServeListeningVersions, readServeDiagnostic, type ServeStartRefusal, type ServeStartStatus } from "../../../src/protocol/serve-handshake.js"
import { probeVersion } from "./probe-version.js"

export type StartFailure =
  | { readonly kind: "executable_missing"; readonly executable: string; readonly detail: string }
  | { readonly kind: "project_root_missing"; readonly projectRoot: string }
  | { readonly kind: "version_unsupported"; readonly version: string; readonly minimum: string }
  | { readonly kind: "protocol_unsupported"; readonly version?: number; readonly required: number }
  | { readonly kind: "no_endpoint"; readonly detail: string }
  | { readonly kind: "startup_failed"; readonly error: string; readonly refusal?: ServeStartRefusal }
  /** `signal` names what stopped a command that has no exit code. */
  | { readonly kind: "exited"; readonly code: number | null; readonly signal?: string; readonly stderr: string }

interface AccountRuntimeTarget {
  readonly socketPath: string
  readonly projectRoot: string
  readonly credential: Redacted.Redacted<string>
}

/** What the supervisor needs of a started `serve` command. A `ChildProcess` is one. */
interface ServeCommandProcess {
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: "error", listener: (cause: Error) => void): this
  unref(): void
  kill(): boolean
}

/** Where the supervisor writes what each start does and what the started
 *  command says, each at its own level. The editor's log channel is one. */
interface SupervisorLog {
  debug(line: string): void
  info(line: string): void
  warn(line: string): void
  error(line: string): void
}

export type PrepareAccountResult =
  /** `service` is the listening service as its handshake names it. The
   *  service outlives the command that reached it by design (ARCH-RUNTIME-037). */
  | { readonly ok: true; readonly target: AccountRuntimeTarget; readonly service: ListeningService }
  | { readonly ok: false; readonly failure: StartFailure }

export interface AccountSupervisorOptions {
  readonly executable: string
  readonly projectRoot: string
  readonly minimumVersion: string
  readonly accountHome?: string
  readonly probeTimeoutMs?: number
  readonly log?: SupervisorLog
  /** Told each step the service's start reports, such as waiting for its
   *  service manager, while the start runs. */
  readonly onPhase?: (label: string) => void
  readonly spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ServeCommandProcess
  readonly probe?: (executable: string, timeoutMs?: number) => Promise<string | undefined>
}

/** Each lane keeps its own private rendezvous directory, the installed lane's
 *  `serve` and the dev lane's `serve-dev`, so an extension pointed at a
 *  checkout finds that checkout's service and not the resident one. The
 *  names mirror the runtime's own path authority. */
const serveDirName = (lane: "installed" | "dev"): string => lane === "installed" ? "serve" : "serve-dev"
const accountServeTokenPath = (userDataRoot: string, lane: "installed" | "dev"): string => join(userDataRoot, serveDirName(lane), "serve.token")
const accountServeSocketPath = (userDataRoot: string, lane: "installed" | "dev"): string => process.platform === "win32"
  ? String.raw`\\.\pipe\flywheel-${serveDirName(lane)}-${createHash("sha256").update(userDataRoot).digest("hex").slice(0, 16)}`
  : join(userDataRoot, serveDirName(lane), "serve.sock")

/** What a person reads when the account service did not start. */
export function describeStartFailure(failure: StartFailure): string {
  switch (failure.kind) {
    case "executable_missing":
      return `Could not run "${failure.executable}". Install Flywheel, or set flywheel.executablePath.`
    case "project_root_missing":
      return `The project folder ${failure.projectRoot} does not exist. Fix flywheel.projectRoot, or clear it to use the open folder.`
    case "version_unsupported":
      return `Flywheel ${failure.version} is older than this extension needs (${failure.minimum} or newer). Run \`flywheel update\` in a terminal.`
    case "protocol_unsupported":
      return failure.version === undefined || failure.version < failure.required
        ? "The running Flywheel is older than this extension. Run `flywheel update` in a terminal."
        : "This extension is older than the running Flywheel. Update the Flywheel extension."
    case "no_endpoint":
      return `Flywheel did not report where its background service listens (${failure.detail}).`
    case "startup_failed": {
      if (failure.refusal === undefined) return `The Flywheel runtime could not start: ${failure.error}`
      const copy = startRefusalCopy(failure.refusal)
      return `${copy.title} ${copy.remedy}`
    }
    case "exited":
      // The last lines keep their own breaks: joined into one sentence, two
      // lines of a stack or a shell error read as one run-on line.
      return [failure.code === null && failure.signal !== undefined ? `The Flywheel runtime was stopped by signal ${failure.signal}.` : `The Flywheel runtime exited with code ${failure.code ?? "unknown"}.`, ...failure.stderr.split("\n").filter((line) => line.trim().length > 0).slice(-3)].join("\n")
  }
}

/** Prepares the resident account service and returns one authenticated project target. */
export async function prepareAccountRuntime(options: AccountSupervisorOptions): Promise<PrepareAccountResult> {
  const probed = await (options.probe ?? probeVersion)(options.executable, options.probeTimeoutMs)
  if (probed === undefined) return { ok: false, failure: { kind: "no_endpoint", detail: `${options.executable} did not report a version` } }
  if (!isVersionAtLeast(probed, options.minimumVersion)) return { ok: false, failure: { kind: "version_unsupported", version: probed, minimum: options.minimumVersion } }
  return await ensureAccountRuntime(options)
}

/** Finds the account service or starts it, and returns one authenticated
 *  project target. The extension runs it at activation and again when its
 *  connection finds nothing listening after it had been connected.
 *
 *  The extension never starts the service itself. It asks the executable to
 *  find or start it with `serve ensure`, which applies the same rules as a
 *  terminal: on the installed lane in the login home the service manager
 *  starts the registered job, and only where no registration is loaded and
 *  enabled does that command launch the service. That command owns every
 *  bound of the start, so the extension waits for its answer or its exit.
 *  It logs the run and its answer: the listening service, or the reason it
 *  failed. */
export async function ensureAccountRuntime(options: AccountSupervisorOptions): Promise<PrepareAccountResult> {
  options.log?.info(`running ${options.executable} serve ensure`)
  const result = await answerServeEnsure(options)
  if (result.ok) options.log?.info(`serve ensure: the account service is listening: pid ${result.service.pid}, lane ${result.service.lane}, version ${result.service.version}, protocol ${result.service.protocolVersion}`)
  else options.log?.error(`serve ensure failed: ${describeStartFailure(result.failure)}`)
  return result
}

/** Logs one line the started command writes on stderr. A structured record
 *  is logged as its message, never its JSON, at its own level, except that
 *  the command's routine INFO records go to `debug`, below the log's default
 *  level. Plain text, such as a launch's error, is `info`. */
function logServeStderr(log: SupervisorLog, line: string, diagnostic: ReturnType<typeof readServeDiagnostic>): void {
  if (diagnostic === undefined) log.info(line)
  else log[diagnostic.level === "info" ? "debug" : diagnostic.level](diagnostic.text)
}

/** Starts `serve ensure` and reads its status records until one names a
 *  listening service, one reports a failure, or it exits. */
async function answerServeEnsure(options: AccountSupervisorOptions): Promise<PrepareAccountResult> {
  const accountHome = options.accountHome ?? homedir()
  const userDataRoot = join(accountHome, ".flywheel")
  // The command runs in the project folder, so a folder that does not exist
  // fails the spawn with the same ENOENT as a missing executable. It is
  // checked first so the failure names the setting that is wrong.
  if (!isDirectory(options.projectRoot)) return { ok: false, failure: { kind: "project_root_missing", projectRoot: options.projectRoot } }
  let child: ServeCommandProcess
  try {
    const spawnProcess = options.spawnProcess ?? ((command: string, spawnArgs: readonly string[], spawnOptions: SpawnOptions) =>
      spawn(command, [...spawnArgs], spawnOptions))
    child = spawnProcess(options.executable, ["serve", "ensure"], {
      cwd: options.projectRoot,
      detached: true,
      env: { ...process.env, HOME: accountHome },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } catch (cause) {
    return { ok: false, failure: { kind: "executable_missing", executable: options.executable, detail: String(cause) } }
  }

  const stderr: string[] = []
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (line) => {
      const diagnostic = readServeDiagnostic(line)
      // The failure names the last lines, so they are kept as words too.
      if (stderr.length >= 50) stderr.shift()
      stderr.push(diagnostic?.text ?? line)
      if (options.log) logServeStderr(options.log, line, diagnostic)
    })
  }
  const result = await new Promise<PrepareAccountResult>((resolve) => {
    let done = false
    const finish = (value: PrepareAccountResult): void => {
      if (done) return
      done = true
      // oxlint-disable-next-line promise/no-multiple-resolved -- boundary: done guards the sole settlement.
      resolve(value)
    }
    child.once("error", (cause) => finish({ ok: false, failure: { kind: "executable_missing", executable: options.executable, detail: String(cause) } }))
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => finish({ ok: false, failure: { kind: "exited", code, ...(signal === null ? {} : { signal }), stderr: stderr.join("\n") } }))
    if (!child.stdout) {
      finish({ ok: false, failure: { kind: "no_endpoint", detail: "account service produced no stdout" } })
      return
    }
    const readStatus = createServeStatusReader()
    createInterface({ input: child.stdout }).on("line", (line) => {
      const verdict = judgeServeStatusLine(line, options.minimumVersion, readStatus)
      if (verdict.kind === "pending") return
      if (verdict.kind === "phase") {
        options.onPhase?.(verdict.label)
        return
      }
      if (verdict.kind === "failed") {
        if (verdict.failure.kind === "no_endpoint") options.log?.warn(`serve ensure printed a listening record this extension cannot read: ${line}`)
        return finish({ ok: false, failure: verdict.failure })
      }
      const status = verdict.status
      try {
        finish({
          ok: true,
          target: {
            socketPath: accountServeSocketPath(userDataRoot, status.lane),
            projectRoot: realpathSync(options.projectRoot),
            credential: Redacted.make(readFileSync(accountServeTokenPath(userDataRoot, status.lane), "utf8").trim()),
          },
          service: { pid: status.pid, lane: status.lane, version: status.version, protocolVersion: status.protocolVersion },
        })
      } catch (cause) {
        finish({ ok: false, failure: { kind: "startup_failed", error: String(cause) } })
      }
    })
  })
  if (result.ok) child.unref()
  else child.kill()
  return result
}

type ListeningRecord = Extract<ServeStartStatus, { readonly lane: unknown }>
type ListeningService = Pick<ListeningRecord, "pid" | "lane" | "version" | "protocolVersion">

type StatusVerdict =
  | { readonly kind: "pending" }
  | { readonly kind: "phase"; readonly label: string }
  | { readonly kind: "failed"; readonly failure: StartFailure }
  | { readonly kind: "listening"; readonly status: ListeningRecord }

/** Judges one line the account service prints, read in order by
 *  `readStatus`, which carries a start's refusal into the failure that
 *  follows it. A listening record is judged by the release and protocol it
 *  names before its shape is decoded, because a release older than this
 *  extension prints a record the current decoder refuses, and a refused
 *  record would otherwise read as a service that never listened: the
 *  extension waited out its whole start bound and said nothing useful. */
export function judgeServeStatusLine(line: string, minimumVersion: string, readStatus: (line: string) => ServeStartStatus | undefined): StatusVerdict {
  const versions = decodeServeListeningVersions(line)
  if (versions !== undefined) {
    if (!isVersionAtLeast(versions.version, minimumVersion)) return { kind: "failed", failure: { kind: "version_unsupported", version: versions.version, minimum: minimumVersion } }
    if (versions.protocolVersion !== RUNTIME_PROTOCOL_VERSION) return { kind: "failed", failure: { kind: "protocol_unsupported", version: versions.protocolVersion, required: RUNTIME_PROTOCOL_VERSION } }
  }
  const status = readStatus(line)
  if (status?.flywheel === "serve.startup.phase") return { kind: "phase", label: status.label }
  if (status?.flywheel === "serve.startup.failed") return { kind: "failed", failure: { kind: "startup_failed", error: status.error, ...(status.refusal === undefined ? {} : { refusal: status.refusal }) } }
  if (status?.flywheel === "serve.listening" || status?.flywheel === "serve.already-listening") return { kind: "listening", status }
  // The record itself goes to the log, not to the sentence a person reads.
  if (versions !== undefined) return { kind: "failed", failure: { kind: "no_endpoint", detail: "its listening record could not be read" } }
  return { kind: "pending" }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- boundary: a probed version piece can carry build metadata after its leading digits
  const parts = (value: string): number[] => value.split("-")[0]!.split(".").map((piece) => Number.parseInt(piece, 10) || 0)
  const actual = parts(version)
  const required = parts(minimum)
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    const left = actual[index] ?? 0
    const right = required[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}
