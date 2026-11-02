import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { dlopen, FFIType } from "bun:ffi"

import { createOwnedProcess, type OwnedProcess } from "../../src/infra/owned-subprocess.js"
import { ownedProcessBackend } from "../../src/infra/owned-subprocess-backend.js"
import type { LauncherScope } from "../../src/infra/process-supervisor.js"
import { darwinProcess } from "../../src/infra/darwin-process-api.js"
import { bunContainerProbe, unixProcessFacts, windowsProcessIdentity } from "../../src/infra/process-container.js"
import { windowsJobApi } from "../../src/infra/windows-job-object.js"
import { windowsProcessApi } from "../../src/infra/windows-process-api.js"
import { windowsContainerName } from "../../src/infra/owned-command-supervisor.js"
import { listProcesses, type ProcessRow } from "../../src/infra/process-table.js"
import { removeWhenReleased } from "./remove-when-released.js"

/** Descendants from one process-table snapshot, parents before their children
 *  and the root excluded. An unanswered table throws: it proves no absence. */
export async function descendantProcesses(pid: number): Promise<readonly ProcessRow[]> {
  const rows = await listProcesses()
  if (rows === undefined) throw new Error("the process table could not be read")
  const descendants = (parent: number): ProcessRow[] => rows
    .filter((row) => row.ppid === parent)
    .flatMap((row) => [row, ...descendants(row.pid)])
  return descendants(pid)
}

/** Real containers with no crash backstop: the payload is admitted at once and
 *  ownership is surrendered to nobody. It is what a test needs when it wants a
 *  real process and not a guardian; production never launches this way. The
 *  container watches this test process in the guardian's place, so a test that
 *  dies still takes its containers with it. */
export function unguardedSpawnOwned(killGraceMs = 5_000): LauncherScope["spawnOwned"] {
  return async (command, options = {}): Promise<OwnedProcess> => {
    // Chosen before the launch, exactly as the supervisor chooses it: on a
    // platform whose containers are named, this is the container's name, so a
    // token reused across launches would be two owners of one container.
    const token = `owned:test-${crypto.randomUUID()}`
    const launch = ownedProcessBackend.launch(command, { ...options, killGraceMs, token, guardianPid: process.pid })
    launch.admit()
    return createOwnedProcess({
      pid: launch.pid,
      token,
      child: launch.child,
      release: () => Promise.resolve(),
      stop: () => launch.stop(),
    })
  }
}

/** Scratch directory plus independent cleanup for tests that spawn real
 *  processes.
 *
 *  `guard` is armed before the test asserts anything, so a failed expectation
 *  or a timed-out wait still ends every process the test started. Cleanup does
 *  not depend on the code under test: it signals the process group directly,
 *  then the pid, and ignores every error because a container that already
 *  finished is the expected case.
 *
 *  What it never signals is a bare number. The operating system hands the pid
 *  of a finished process to an unrelated later one, so every pid is recorded
 *  together with a creation identity and that identity is re-read immediately
 *  before each signal. A mismatch, or a probe that cannot answer, skips the
 *  signal: leaving a stray process is a test failure, killing somebody else's
 *  process is a defect. */
export interface TaggedProcess {
  readonly pid: number
  readonly command: string
  /** The identity the pid held while the evidence that found it was read,
   *  or nothing when the pid changed hands meanwhile or could not be
   *  identified. A process without one is reported, never signalled. */
  readonly identity?: ProcessIdentity
}

export interface RealProcessFixture {
  readonly dir: string
  file(name: string): string
  /** Records the identity of a container and returns the pid, so it reads
   *  inline: `const pid = fixture.guard(owned.pid)`. */
  guard(pid: number): number
  cleanup(): void
  /** The file's contents once it holds any. A writer creates a file before it
   *  writes to it, and a reader can open it in between, most often on Windows
   *  under load. An empty file is therefore one that is still being written,
   *  never a written marker: every marker these tests wait for holds content. */
  waitForFile(file: string, timeoutMs?: number): Promise<string>
  waitForFileContaining(file: string, text: string, timeoutMs?: number): Promise<string>
  waitForGone(pid: number, timeoutMs?: number): Promise<void>
  /** Every live process whose command line names this fixture's directory.
   *  The directory is unique per fixture, so it is the one string that finds
   *  everything a test started: a guardian launched with the directory as an
   *  argument it ignores, a container supervisor carrying the payload argv,
   *  and the payload and its descendants carrying their marker paths. It is
   *  how a test proves that nothing at all remains, including processes whose
   *  pids it never learned. */
  tagged(): readonly TaggedProcess[]
}

export function createRealProcessFixture(name: string): RealProcessFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flywheel-${name}-`))
  const guarded = new Map<number, ProcessIdentity>()

  return {
    dir,
    file: (leaf) => path.join(dir, leaf),
    guard(pid) {
      const identity = identifyProcess(pid)
      if (identity) guarded.set(pid, identity)
      return pid
    },
    cleanup() {
      // What the test recorded, plus everything else the process table still
      // shows for this fixture: a test that failed before it could record a
      // container must not leave that container running. A pid discovered here
      // carries the identity it held while the table was read, exactly as a
      // guarded one carries the identity it held when it was guarded.
      const targets = new Map(guarded)
      for (const { pid, identity } of taggedProcesses(dir)) {
        if (identity && !targets.has(pid)) targets.set(pid, identity)
      }
      for (const identity of targets.values()) killIdentifiedProcess(identity)
      guarded.clear()
      removeWhenReleased(dir)
    },
    waitForFile(file, timeoutMs = 5_000) {
      return waitFor(() => {
        const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
        return contents === "" ? undefined : contents
      }, `file ${file}`, timeoutMs)
    },
    waitForFileContaining(file, text, timeoutMs = 5_000) {
      return waitFor(() => {
        if (!fs.existsSync(file)) return undefined
        const contents = fs.readFileSync(file, "utf8")
        return contents.includes(text) ? contents : undefined
      }, `file ${file} containing ${JSON.stringify(text)}`, timeoutMs)
    },
    async waitForGone(pid, timeoutMs = 5_000) {
      await waitFor(() => (processAlive(pid) ? undefined : true), `exit of pid ${pid}`, timeoutMs)
    },
    tagged: () => taggedProcesses(dir),
  }
}

/** How a platform reports a container that was ended by force rather than by
 *  its payload's own exit. A POSIX container is a process group, so the kernel
 *  names the signal that ended it. A Windows container is a job object, which
 *  has no signals: the kernel reports the exit code the job supplied to every
 *  member it terminated. */
export const FORCED_END: { readonly code: number | null; readonly signal: string | null } =
  process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" }

export function processAlive(pid: number): boolean {
  // Windows answers this from the kernel rather than from a signal nobody
  // sends: signal zero is a POSIX idiom, and a pid it cannot open reads as
  // gone even when the process is merely protected.
  if (process.platform === "win32") return windowsProcessIdentity(pid).kind === "process"
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stops `pid` from running until it ends, as a scheduler that never gives
 *  it the processor does. POSIX stops it with SIGSTOP; Windows suspends every
 *  thread of it through `NtSuspendProcess`. */
export function suspendProcess(pid: number): void {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGSTOP")
    return
  }
  // Opened only here: the libraries exist only on Windows.
  const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  const ntdll = dlopen("ntdll.dll", { NtSuspendProcess: { args: [FFIType.ptr], returns: FFIType.i32 } })
  const PROCESS_SUSPEND_RESUME = 0x0800
  const handle = kernel32.symbols.OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid)
  try {
    if (!handle || ntdll.symbols.NtSuspendProcess(handle) !== 0) throw new Error(`process ${pid} could not be suspended`)
  } finally {
    if (handle) kernel32.symbols.CloseHandle(handle)
    kernel32.close()
    ntdll.close()
  }
}

/** A process as it existed at one moment: its pid, the container it belongs
 *  to, and a creation identity a recycled pid cannot repeat. */
export interface ProcessIdentity {
  readonly pid: number
  readonly pgid: number
  /** Pid, group, and the kernel's creation identity, which a recycled pid
   *  cannot repeat. */
  readonly identity: string
}

/** Identifies the process that holds `pid` right now, or undefined when no
 *  process holds it and when the probe could not answer. Both cases forbid a
 *  signal, so they are one answer here. */
export function identifyProcess(pid: number): ProcessIdentity | undefined {
  if (process.platform === "win32") {
    // Windows has no process group, so a process stands for its own container,
    // exactly as the product treats it. The creation time is what a recycled
    // pid cannot repeat, and it comes from the kernel rather than a program.
    const identity = windowsProcessIdentity(pid)
    return identity.kind === "process" ? { pid, pgid: pid, identity: identity.identity } : undefined
  }
  // libproc on macOS and /proc on Linux: the kernel answers without a
  // program start, so a whole table of pids can be identified in one sweep.
  const facts = unixProcessFacts(pid, bunContainerProbe)
  return facts.kind === "facts" ? { pid, pgid: facts.pgid, identity: facts.identity } : undefined
}

/** The container a process belongs to, or undefined when it is gone. */
export function processGroupOf(pid: number): number | undefined {
  return identifyProcess(pid)?.pgid
}

/** Whether `pid` is a member of the container `owned` names.
 *
 *  Membership is the question every caller here actually has; how a platform
 *  answers it is the platform's business. A POSIX container is the process
 *  group the owned pid leads, so membership is a group id. A Windows container
 *  is a job object named by the ownership token, so membership is what the
 *  kernel reports for that job. */
export function containerHolds(owned: { readonly pid: number; readonly token: string }, pid: number): boolean {
  if (process.platform !== "win32") return processGroupOf(pid) === owned.pid
  const open = windowsJobApi()?.open(windowsContainerName(owned.token))
  if (open?.kind !== "opened") return false
  try {
    return open.job.pids()?.includes(pid) ?? false
  } finally {
    open.job.close()
  }
}

/** Live processes, this process excluded, with an argument that mentions
 *  directory `tag`: the directory is the whole argument, starts it, or
 *  follows whitespace, a quote, or `=` inside it, and is followed by a path
 *  separator, a quote, or the end. A fixture's directory is a fresh temporary
 *  name, so a mention inside source text that a process was started with,
 *  such as `bun -e`, finds that process too. */
export function taggedProcesses(tag: string): readonly TaggedProcess[] {
  const mention = mentionPattern(tag)
  return processSnapshot()
    .filter((entry) => entry.pid !== process.pid && entry.argv.some((argument) => mention.test(normalizedPath(argument))))
    .map(confirmed)
}

/** Whether `value` is `directory` or a path below it. A sibling that only
 *  shares a string prefix, such as `gate3.ps1` or `gate other` beside `gate`,
 *  never matches. Both path separators are accepted, and a drive-letter or
 *  UNC path compares without case, as Windows does. */
function namesPath(value: string, directory: string): boolean {
  const root = normalizedPath(directory).replace(/\/+$/, "")
  const candidate = normalizedPath(value)
  const [left, right] = caseInsensitivePath(directory) ? [candidate.toLowerCase(), root.toLowerCase()] : [candidate, root]
  return left === right || left.startsWith(`${right}/`)
}

function mentionPattern(directory: string): RegExp {
  const escaped = normalizedPath(directory).replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[/"'])`, caseInsensitivePath(directory) ? "i" : "")
}

function normalizedPath(text: string): string {
  return text.replaceAll("\\", "/")
}

function caseInsensitivePath(directory: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory)
}

/** The entry the release harness sets in the environment of every process
 *  it starts (scripts/perf-gate.ts, tests/release/run.ts, and
 *  scripts/uat/harness.ts), which each child inherits. The user's installed
 *  and dev-lane services never carry it. */
export const RELEASE_HARNESS_ENVIRONMENT = { FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1" } as const
const RELEASE_HARNESS_MARKER = `FLYWHEEL_INTERNAL_RELEASE_HARNESS=${RELEASE_HARNESS_ENVIRONMENT.FLYWHEEL_INTERNAL_RELEASE_HARNESS}`

/** What the process table states about one process: the arguments it was
 *  started with, and its environment, or nothing when the kernel refused to
 *  show it. */
interface ProcessEvidence {
  readonly argv: readonly string[]
  readonly environment: readonly string[] | undefined
}

/** Whether a harness run under `root` started the process `evidence`
 *  describes. Its environment must carry the release harness marker, on every
 *  platform; a process whose environment the kernel refused to show is never
 *  one. Then an environment value, an argument, or the value of an
 *  `--option=value` argument must be `root` or a path below it. */
export function harnessOwns(evidence: ProcessEvidence, root: string): boolean {
  const { environment } = evidence
  if (environment === undefined || !environment.includes(RELEASE_HARNESS_MARKER)) return false
  const valueOf = (entry: string): string => entry.slice(entry.indexOf("=") + 1)
  return environment.some((variable) => namesPath(valueOf(variable), root))
    || evidence.argv.some((argument) => namesPath(argument, root) || (argument.includes("=") && namesPath(valueOf(argument), root)))
}

/** Live processes that a harness run under `root` started, as `harnessOwns`
 *  decides, this process excluded. The process table is the whole source, so
 *  a process whose run directory another run already removed is still found,
 *  and so is a detached service whose client has exited.
 *
 *  A Windows console host that serves an owned process is part of that
 *  process, not a process the run left behind: Windows starts it as a child
 *  of its client with the client's environment, marker included, and ends it
 *  when its last client ends. */
export function harnessProcesses(root: string): readonly TaggedProcess[] {
  const owned = processSnapshot().filter((entry) => entry.pid !== process.pid && harnessOwns(entry, root))
  const ownedPids = new Set(owned.map((entry) => entry.pid))
  return owned.filter((entry) => entry.consoleClient === undefined || !ownedPids.has(entry.consoleClient)).map(confirmed)
}

interface SnapshotEntry extends WindowsConsoleEvidence {
  readonly pid: number
  readonly command: string
  /** The identity the pid held before the evidence was read. */
  readonly before: ProcessIdentity | undefined
}

interface WindowsConsoleEvidence extends ProcessEvidence {
  /** For a Windows console host, the pid of the process that started it,
   *  which is the client it serves. */
  readonly consoleClient?: number | undefined
}

/** Every live process with its evidence. Each identity is read before any
 *  evidence, and `confirmed` reads it again after: two equal reads prove that
 *  the evidence between them came from that one process, because a recycled
 *  pid never repeats a creation identity. */
function processSnapshot(): readonly SnapshotEntry[] {
  const before = new Map<number, ProcessIdentity>()
  for (const pid of livePids()) {
    const identity = identifyProcess(pid)
    if (identity) before.set(pid, identity)
  }
  const evidence = process.platform === "linux" ? procfsEvidence(before.keys()) : process.platform === "win32" ? windowsEvidence() : darwinEvidence(before.keys())
  return evidence.map((entry) => ({ ...entry, before: before.get(entry.pid) }))
}

/** The discovered process, with the identity it held while its evidence was
 *  read. A pid that changed hands meanwhile, or that could not be identified,
 *  is reported without one, and nothing signals it on this evidence. */
function confirmed(entry: SnapshotEntry): TaggedProcess {
  const { pid, command, before } = entry
  const identity = before !== undefined && identifyProcess(pid)?.identity === before.identity ? before : undefined
  return identity ? { pid, command, identity } : { pid, command }
}

function livePids(): Iterable<number> {
  if (process.platform === "linux") return fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number)
  const pids = process.platform === "win32" ? windowsProcessApi()?.list()?.map((row) => row.pid) : darwinProcess.pids()
  if (pids === undefined) throw new Error("could not read the process table")
  return pids
}

/** Linux states each process's arguments and environment under /proc, with
 *  a NUL after every entry. Another user's environment reads as refused, and
 *  a process that exits while the table is read is left out. */
function procfsEvidence(pids: Iterable<number>): readonly (ProcessEvidence & { readonly pid: number; readonly command: string })[] {
  const entries: (ProcessEvidence & { readonly pid: number; readonly command: string })[] = []
  const fields = (pid: number, file: string): string[] => fs.readFileSync(path.join("/proc", String(pid), file), "utf8").split("\0").filter((field) => field.length > 0)
  for (const pid of pids) {
    let argv: string[]
    try {
      argv = fields(pid, "cmdline")
    } catch {
      continue
    }
    let environment: string[] | undefined
    try {
      environment = fields(pid, "environ")
    } catch {
      environment = undefined
    }
    entries.push({ pid, command: argv.join(" "), argv, environment })
  }
  return entries
}

/** macOS states the arguments and environment a process was started with in
 *  one kernel read. `ps` joins the arguments with spaces and so loses where a
 *  path that holds a space ends.
 *  The kernel answers for a process of the same user only; another process
 *  is left out. */
function darwinEvidence(pids: Iterable<number>): readonly (ProcessEvidence & { readonly pid: number; readonly command: string })[] {
  const entries: (ProcessEvidence & { readonly pid: number; readonly command: string })[] = []
  for (const pid of pids) {
    const evidence = darwinProcess.processArguments(pid)
    if (evidence === undefined) continue
    const { argv, environment } = evidence
    entries.push({ pid, command: argv.join(" "), argv, environment })
  }
  return entries
}

/** Windows names each environment in the process's own memory, which the
 *  kernel lets a script read for a process of the same user only. Any other
 *  process reads as refused. */
function windowsEvidence(): readonly (WindowsConsoleEvidence & { readonly pid: number; readonly command: string })[] {
  const api = windowsProcessApi()
  const parents = new Map(api?.list()?.map((row) => [row.pid, row.parentPid] as const))
  return [...windowsCommandLines()].map(([pid, command]) => {
    const argv = commandLineArguments(command)
    const consoleClient = /(?:^|[\\/])conhost\.exe$/i.test(argv[0] ?? "") ? parents.get(pid) : undefined
    return { pid, command, argv, environment: api?.environment(pid), consoleClient }
  })
}

/** Every live process's full command line by pid, from one table read. */
function windowsCommandLines(): ReadonlyMap<number, string> {
  // Windows exposes no command line through the kernel calls the product
  // uses, and nothing else on the platform prints one, so this is the one
  // place a shell-hosted query is the only option. It runs once per sweep
  // round rather than per probe, which is what makes the cost bearable here
  // and not in the product.
  const probe = Bun.spawnSync([
    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    // One line per process, whatever the command line holds. A launch that
    // carries source text - `bun -e "..."` - has newlines inside its own
    // command line, and without flattening them the line that names a
    // fixture is a continuation line with no pid in front of it, which this
    // reader would skip and report as nothing running.
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine -replace '[\\r\\n]+', ' ')\" }",
  ], { stdout: "pipe", stderr: "ignore", windowsHide: true })
  if (!probe.success) throw new Error("could not read the process table")
  const lines = new Map<number, string>()
  for (const raw of new TextDecoder().decode(probe.stdout).split("\n")) {
    // A carriage return is a line terminator to a regular expression, so `.`
    // never reaches one and an anchored pattern never matches a line that
    // still carries it. Windows ends every line with one.
    const match = /^(\d+)\s+(.+)$/.exec(raw.trim())
    if (match) lines.set(Number(match[1]), String(match[2]))
  }
  return lines
}

/** The arguments a Windows command line holds, split as the C runtime and
 *  `CommandLineToArgvW` split it: whitespace ends an argument only outside
 *  double quotes, `""` inside quotes is one quote, and backslashes are
 *  literal unless a quote follows them, where each pair is one backslash and
 *  an odd one escapes the quote. */
export function commandLineArguments(line: string): readonly string[] {
  const argv: string[] = []
  let current = ""
  let started = false
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === "\\") {
      let count = 0
      while (line[index + count] === "\\") count += 1
      index += count - 1
      started = true
      if (line[index + 1] !== "\"") {
        current += "\\".repeat(count)
        continue
      }
      current += "\\".repeat(count >> 1)
      index += 1
      if (count % 2 === 1) current += "\""
      else quoted = !quoted
      continue
    }
    if (character === "\"") {
      started = true
      if (quoted && line[index + 1] === "\"") {
        current += "\""
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && (character === " " || character === "\t")) {
      if (started) argv.push(current)
      current = ""
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started) argv.push(current)
  return argv
}

/** Ends every live process that a harness run under one of `roots` started,
 *  as `harnessProcesses` finds them, and answers the ones still running when
 *  `timeoutMs` elapses; an empty answer proves the table held none at the
 *  last read.
 *
 *  Each process is ended by the identity it held while its evidence was
 *  read, never by whoever holds its pid later, so a recycled pid is never
 *  signalled. The table is read again after every round of kills, because a
 *  process that is being ended can start another: a client that sees its
 *  account service close relaunches it, and the new service is in a process
 *  group of its own. */
export function stopHarnessProcesses(roots: readonly string[], timeoutMs = 15_000): readonly TaggedProcess[] {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = [...new Map(roots.flatMap(harnessProcesses).map((entry) => [entry.pid, entry])).values()]
    if (found.length === 0 || Date.now() >= deadline) return found
    for (const { identity } of found) if (identity) killIdentifiedProcess(identity)
    Bun.sleepSync(100)
  }
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** Kills the recorded process, and the group it leads when it led one. A
 *  process that leads no group is signalled alone, because the group it belongs
 *  to may be this test runner's own.
 *
 *  The identity is re-read immediately before each signal, so the window in
 *  which a pid could be recycled between the check and the signal is one
 *  syscall wide rather than the whole test. */
export function killIdentifiedProcess(recorded: ProcessIdentity): void {
  const stillThere = (): boolean => identifyProcess(recorded.pid)?.identity === recorded.identity
  if (!stillThere()) return
  if (process.platform === "win32") {
    // No group to signal, so the tree below the pid is what gets ended. The
    // identity was just re-read, so this is not a bare number being killed.
    Bun.spawnSync(["taskkill", "/PID", String(recorded.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    return
  }
  if (recorded.pgid === recorded.pid) kill(-recorded.pid)
  if (stillThere()) kill(recorded.pid)
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Already gone, which is what the test wanted.
  }
}
