import * as fs from "node:fs"
import * as path from "node:path"

import type { AccountDirectories } from "../infra/directory-authorities.js"
import type { ServeLane } from "../infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath } from "../infra/paths.js"
import { emptyContainers, processContainer, type ManagedContainer } from "../infra/process-container.js"
import { errnoCode, errorMessage } from "../infra/error-message.js"
import { releaseLock, tryAcquireLockSync, type TriedLock, type TryLockOptions } from "../infra/ownership-file-lock.js"
import { processAccountHome, type ProcessAccountHome } from "../infra/process-account-home.js"
import { isProcessAlive } from "../infra/process-liveness.js"
import { listProcesses, type ProcessRow } from "../infra/process-table.js"
import { probeRendezvous, readRuntimeIdentity, refusesAccess, type RendezvousProbe } from "./runtime-attach.js"
import { Log } from "../infra/log.js"

const log = Log.create({ service: "kill" })

/** `flywheel kill`: the hard reset. It ends every Flywheel process of the
 *  account home it runs in, whatever placement it is and whatever started it,
 *  and clears the runtime rendezvous files those processes leave behind.
 *  `flywheel kill all` ends every Flywheel process on the machine.
 *
 *  The runtime's own lifetime rules (ARCH-RUNTIME-023, ARCH-RUNTIME-025) are what keep a project's
 *  runtime up across reloads and stop it when it is idle. This command exists
 *  for the day those rules hold a process up that the user knows is done: a
 *  runtime on an older build a client is waiting out, a phantom held client,
 *  a leaked test harness. It does not ask the runtime whether it is busy,
 *  because the user has already decided.
 *
 *  Processes are found in the process table, not in Flywheel's own records:
 *  a record is exactly what a wedged or crashed process may have failed to
 *  write. This command, the shell that runs it, and the helpers it started
 *  are the only Flywheel processes left standing. */

const USAGE = [
  "Usage: flywheel kill [all] [installed|dev] [--dry-run]",
  "",
  "Stop every Flywheel process of this account home: project runtimes,",
  "terminals, headless runs, resident services, and their guardians, from",
  "installed builds and source checkouts alike. Each one is asked to stop, then",
  "killed if it stays. Rendezvous files of runtimes that are gone are removed.",
  "",
  "The account home is HOME, or USERPROFILE on Windows when HOME is empty. A",
  "process belongs to it when the environment the system holds for the process",
  "names the same home. A process whose home cannot be proven keeps running and",
  "is listed. Another user's processes are not touched.",
  "",
  "`all` stops every Flywheel process on this machine, of every account home.",
  "",
  "Name a lane to stop only one lineage: `installed` for the installed builds,",
  "`dev` for source checkouts run through bun. The other lane keeps running and",
  "keeps its rendezvous.",
  "",
  "This is a last resort. A runtime stopped this way cuts its turn in flight;",
  "the session opens interrupted, and Resume or the next message continues it.",
  "",
  "A login service can restart a stopped process. Remove the service to stop",
  "it permanently.",
  "",
  "Options:",
  "  --dry-run    List what would be stopped and stop nothing.",
  "  -h, --help   Show this help.",
].join("\n")

/** How long every host gets between the request to stop and the kill. A
 *  runtime's ordered shutdown settles its durable writers and vacuums the
 *  store, so this is longer than the guardian's own grace. */
const HOST_GRACE_MS = 8_000

/** How long a guardian is given to notice its host is gone, sweep the
 *  containers that host owned, and exit on its own. The guardian's kill grace
 *  is five seconds; this covers it with room for the sweep to be observed.
 *  A guardian killed before it swept would leave the very processes it
 *  existed to remove. */
const GUARDIAN_SWEEP_MS = 6_000

const SWEEP_POLL_MS = 50

/** The whole record of a live Flywheel process, once it is one. */
type FlywheelRole = "host" | "guardian"

/** What the command line proves about a Flywheel process: its role, and the
 *  lane its lineage serves in. */
interface FlywheelIdentity {
  readonly role: FlywheelRole
  readonly lane: ServeLane
}

interface FlywheelProcess extends FlywheelIdentity {
  readonly pid: number
  /** The process group, on a platform that has one; it decides whether the
   *  process is ended as a group or alone. */
  readonly pgid?: number
  /** What the process is, for the listing: runtime, terminal, guardian, and so on. */
  readonly kind: string
  readonly argv: readonly string[]
}

const INSTALLED_PROGRAMS: ReadonlySet<string> = new Set(["flywheel", "flywheel-bin"])
const BUN_PROGRAMS: ReadonlySet<string> = new Set(["bun"])
const INTERNAL_ROLE_PREFIX = "--internal-role="
const SERVE_LANES: readonly ServeLane[] = ["installed", "dev"]
const MACHINE_SCOPE_WORD = "all"

/** Which processes the reset may end: those of one account home, or every
 *  Flywheel process on the machine. */
type KillScope =
  | { readonly kind: "account"; readonly accountHome: string }
  | { readonly kind: "machine" }

/** A Flywheel process the account-scoped reset leaves running because
 *  nothing proves which account home it serves. */
interface UnprovenProcess extends FlywheelProcess {
  readonly reason: string
}

interface KillPlan {
  readonly stop: readonly FlywheelProcess[]
  readonly unproven: readonly UnprovenProcess[]
}

function isServeLane(word: string): word is ServeLane {
  return SERVE_LANES.some((lane) => lane === word)
}

/** The entries a source checkout is run through, as suffixes of the script
 *  path, a pattern standing for a name that varies. The remainder of the path
 *  is the checkout root, which is what proves the entry is Flywheel's rather
 *  than another repository's file of the same name. A command supervisor
 *  runs its module, or once locked a content-named snapshot of it, and a
 *  planned replacement's handover leaves one running past the runtime that
 *  launched it. */
const SOURCE_ENTRIES: readonly (readonly (string | RegExp)[])[] = [
  ["scripts", "dev.ts"],
  ["src", "cli", "index.ts"],
  ["src", "infra", "owned-command-supervisor.ts"],
  ["node_modules", ".cache", "flywheel", /^owned-command-supervisor-[0-9a-f]+\.js$/],
]

/** How Linux names the running executable when a process re-enters itself,
 *  which a source run's command supervisor does through Bun. */
const REENTERED_EXECUTABLE = "/proc/self/exe"

/** The package name a Flywheel checkout declares. */
const CHECKOUT_PACKAGE_NAME = "flywheel-tui"

function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.toLowerCase().replace(/\.exe$/, "")
}

/** The script a `bun` process runs: the first argument that is not a bun flag
 *  and not the `run` verb. */
function bunScript(argv: readonly string[]): string | undefined {
  return argv.slice(1).find((token) => !token.startsWith("-") && token !== "run")
}

/** The checkout root a source entry path sits in, the empty string for a
 *  relative entry run from its own checkout, or undefined when the path is not
 *  a Flywheel entry at all. */
function sourceEntryRoot(script: string): string | undefined {
  const parts = script.split(/[\\/]/)
  for (const entry of SOURCE_ENTRIES) {
    if (parts.length < entry.length) continue
    const tail = parts.slice(parts.length - entry.length)
    if (tail.some((part, index) => { const expected = entry[index]; return typeof expected === "string" ? part !== expected : expected === undefined || !expected.test(part) })) continue
    const rootParts = parts.slice(0, parts.length - entry.length)
    return rootParts.length === 0 ? "" : script.slice(0, script.length - tail.join("/").length - 1)
  }
  return undefined
}

/** Whether `argv` is a Flywheel process, which role it plays, and which lane
 *  it serves in.
 *
 *  The program position decides, so a multiplexer, editor, or shell that was
 *  merely handed a Flywheel path is not one. An installed build is known by
 *  its executable name. A source checkout is known by its entry script, and
 *  only when the checkout that entry belongs to is a Flywheel checkout, which
 *  `isFlywheelCheckout` answers from the root; a relative entry is one run
 *  from inside its own checkout and is accepted as such. Any internal role
 *  marker is Flywheel's regardless, because only Flywheel writes one. The
 *  program position also names the lane, the same way the process itself
 *  derives it: run through bun is the dev lane, a compiled executable the
 *  installed one. */
function classifyFlywheelProcess(argv: readonly string[], checkout: (root: string) => boolean): FlywheelIdentity | undefined {
  const program = argv[0]
  if (program === undefined) return undefined
  const lane: ServeLane = BUN_PROGRAMS.has(programName(program)) ? "dev" : "installed"
  const role = argv.find((token) => token.startsWith(INTERNAL_ROLE_PREFIX))?.slice(INTERNAL_ROLE_PREFIX.length)
  if (role !== undefined) return { role: role === "guardian" ? "guardian" : "host", lane }
  if (INSTALLED_PROGRAMS.has(programName(program))) return { role: "host", lane }
  // A re-entered executable carries no name; a source entry after it says
  // it is Bun running a checkout.
  if (lane === "installed" && program !== REENTERED_EXECUTABLE) return undefined
  const script = bunScript(argv)
  if (script === undefined) return undefined
  const root = sourceEntryRoot(script)
  if (root === undefined) return undefined
  return root === "" || checkout(root) ? { role: "host", lane: "dev" } : undefined
}

/** A short name for the listing, read from the same command line. */
function describeKind(argv: readonly string[], role: FlywheelRole): string {
  if (role === "guardian") return "guardian"
  const internal = argv.find((token) => token.startsWith(INTERNAL_ROLE_PREFIX))
  if (internal !== undefined) return internal.slice(INTERNAL_ROLE_PREFIX.length)
  const args = argv.slice(1)
  if (args.some((arg) => /owned-command-supervisor[^/\\]*$/.test(arg))) return "command-supervisor"
  if (args.includes("serve")) return "account service"
  if (args.includes("--headless")) return "headless"
  const host = args.indexOf("host")
  const noun = host > 0 ? args[host - 1] : undefined
  if (noun !== undefined && !noun.startsWith("-")) return `${noun} host`
  if (args.includes("kill")) return "kill"
  return "terminal"
}

/** Every Flywheel process in the table that this command may end: all of them
 *  in the selected lanes and scope except the command itself, the processes
 *  above it (the launcher or shell it is running under, which may itself be
 *  Flywheel's), the processes below it (its own guardian), and the guardian
 *  of any spared ancestor, because a host left standing without its guardian
 *  has lost the backstop for what it owns. Table order is kept, so the
 *  listing reads the way the operating system lists it.
 *
 *  The account scope reads the home of each candidate only, and ends a
 *  process only when its home is proven to be this one. A process proven to
 *  serve another home is not this command's to name; one whose home is not
 *  proven is returned as unproven, so the listing says why it was left. */
function planKill(rows: readonly ProcessRow[], deps: Pick<KillDependencies, "selfPid" | "isFlywheelCheckout" | "accountHomeOf">, lanes: ReadonlySet<ServeLane>, scope: KillScope): KillPlan {
  const { selfPid, isFlywheelCheckout: checkout } = deps
  const byPid = new Map(rows.map((row) => [row.pid, row] as const))
  const identities = new Map(rows.map((row) => [row.pid, classifyFlywheelProcess(row.argv, checkout)] as const))
  const spared = new Set<number>([selfPid])
  for (let pid = byPid.get(selfPid)?.ppid; pid !== undefined && pid > 0 && !spared.has(pid); pid = byPid.get(pid)?.ppid) {
    spared.add(pid)
    for (const row of rows) if (row.ppid === pid && identities.get(row.pid)?.role === "guardian") spared.add(row.pid)
  }
  const below = new Set<number>([selfPid])
  // `below` grows while it is iterated, which is how the descent proceeds: a
  // Set visits members added during iteration.
  for (const parent of below) {
    for (const row of rows) if (row.ppid === parent) below.add(row.pid)
  }
  for (const pid of below) spared.add(pid)
  const candidates: { readonly row: ProcessRow; readonly entry: FlywheelProcess }[] = []
  for (const row of rows) {
    const identity = identities.get(row.pid)
    if (identity === undefined || spared.has(row.pid) || !lanes.has(identity.lane)) continue
    candidates.push({ row, entry: { pid: row.pid, ...(row.pgid === undefined ? {} : { pgid: row.pgid }), ...identity, kind: describeKind(row.argv, identity.role), argv: row.argv } })
  }
  if (scope.kind === "machine") return { stop: candidates.map(({ entry }) => entry), unproven: [] }

  const verdicts = new Map(candidates.map(({ row }) => [row.pid, accountVerdict(deps.accountHomeOf(row), scope.accountHome)] as const))
  const stop: FlywheelProcess[] = []
  const unproven: UnprovenProcess[] = []
  for (const { row, entry } of candidates) {
    let verdict = verdicts.get(row.pid) ?? LEAVE
    // A guardian goes only with its host: one whose host stays keeps its
    // backstop, and says why when that host's home is not proven.
    const host = verdicts.get(row.ppid)
    if (entry.role === "guardian" && verdict === STOP && host !== undefined && host !== STOP) {
      verdict = typeof host === "string" ? host : { reason: "its host's account home is not proven" }
    }
    if (verdict === STOP) stop.push(entry)
    else if (verdict !== LEAVE) unproven.push({ ...entry, reason: verdict.reason })
  }
  return { stop, unproven }
}

const STOP = "stop"
const LEAVE = "leave"

/** What the account scope does with one process: stop it, leave it unnamed
 *  because it is proven to be another home's or another user's, or leave it
 *  and name the evidence that was missing. */
function accountVerdict(home: ProcessAccountHome, accountHome: string): typeof STOP | typeof LEAVE | { readonly reason: string } {
  if (home.kind === "unproven") return { reason: home.reason }
  return home.kind === "home" && home.home === accountHome ? STOP : LEAVE
}

/** Everything the command reaches the host through, so a test runs it against
 *  a recorded table and fake containers. */
export interface KillDependencies {
  readonly listProcesses: () => Promise<readonly ProcessRow[] | undefined>
  readonly containerFor: (member: { readonly pid: number; readonly pgid?: number }) => ManagedContainer
  readonly isFlywheelCheckout: (root: string) => boolean
  readonly selfPid: number
  readonly sleep: (ms: number) => Promise<void>
  readonly isProcessAlive: (pid: number) => boolean
  readonly probeRendezvous: (socketPath: string) => Promise<RendezvousProbe>
  readonly accountHomeOf: (row: ProcessRow) => ProcessAccountHome
  readonly print: (line: string) => void
  readonly hostGraceMs: number
  readonly guardianSweepMs: number
}

/** Whether `root` is a Flywheel source checkout: its package declares the
 *  name. A root that cannot be read is not one. */
function isFlywheelCheckout(root: string): boolean {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    return typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === CHECKOUT_PACKAGE_NAME
  } catch {
    return false
  }
}

const DEFAULTS: KillDependencies = {
  listProcesses,
  containerFor: processContainer,
  isFlywheelCheckout,
  selfPid: process.pid,
  sleep: Bun.sleep,
  isProcessAlive,
  probeRendezvous,
  accountHomeOf: (row) => processAccountHome(row),
  print: console.log,
  hostGraceMs: HOST_GRACE_MS,
  guardianSweepMs: GUARDIAN_SWEEP_MS,
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}es`}`
}

/** Runs the command and returns its exit status: 0 when every Flywheel process
 *  in scope is gone, 1 when one survived or the table could not be read, 2
 *  for usage. A process left running because its home is not proven is out of
 *  scope, so it is listed but does not change the status. */
export async function runKill(args: readonly string[], directories: AccountDirectories, overrides: Partial<KillDependencies> = {}): Promise<number> {
  const deps: KillDependencies = { ...DEFAULTS, ...overrides }
  let dryRun = false
  let scope: KillScope = { kind: "account", accountHome: directories.accountHome }
  const selected = new Set<ServeLane>()
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true
    else if (arg === MACHINE_SCOPE_WORD) scope = { kind: "machine" }
    else if (isServeLane(arg)) selected.add(arg)
    else if (arg === "--help" || arg === "-h") {
      deps.print(USAGE)
      return 0
    } else {
      deps.print(USAGE)
      return 2
    }
  }

  // No lane word means every lane.
  const lanes: ReadonlySet<ServeLane> = selected.size === 0 ? new Set(SERVE_LANES) : selected
  const whose = scope.kind === "account" ? ` of the account home ${scope.accountHome}` : ""
  const inLane = lanes.size === SERVE_LANES.length ? "" : ` in the ${[...lanes].join(" and ")} lane`
  const where = `${whose}${inLane}`
  const rows = await deps.listProcesses()
  if (rows === undefined) {
    deps.print("Flywheel could not read the process table, so it stopped nothing.")
    return 1
  }
  const { stop: plan, unproven } = planKill(rows, deps, lanes, scope)
  const listed = [...plan, ...unproven]
  const width = Math.max(0, ...listed.map((entry) => String(entry.pid).length))
  const kindWidth = Math.max(0, ...listed.map((entry) => entry.kind.length))
  const row = (entry: FlywheelProcess) => `  ${String(entry.pid).padStart(width)}  ${entry.kind.padEnd(kindWidth)}  ${entry.lane.padEnd(9)}  ${entry.argv.join(" ")}`
  const printUnproven = () => {
    if (unproven.length === 0) return
    deps.print("Left running, account home not proven (`flywheel kill all` stops these too):")
    for (const entry of unproven) deps.print(`${row(entry)}  (${entry.reason})`)
  }
  // The hard reset is a decision about every process it names: one record of
  // what it ended, what survived, which rendezvous it cleared, and which start
  // locks it took from a holder that is not Flywheel's. Each signal also
  // records its own termination decision.
  const settle = async (survivors: readonly number[]): Promise<number> => {
    const { removed, reclaimedStartLocks } = await removeStaleRendezvous(directories, lanes, deps)
    for (const reclaimed of reclaimedStartLocks) deps.print(describeReclaimedStartLock(reclaimed))
    log.info("flywheel kill settled", {
      lanes: [...lanes],
      targets: plan.map((entry) => ({ pid: entry.pid, kind: entry.kind, lane: entry.lane })),
      survivors,
      removedRecords: removed,
      reclaimedStartLocks,
    })
    return removed
  }
  if (plan.length === 0) {
    deps.print(`No Flywheel processes${whose} are running${inLane}.`)
    printUnproven()
    if (!dryRun) await settle([])
    return 0
  }
  if (!dryRun) deps.print(`Stopping ${plural(plan.length, "Flywheel process")}${where}:`)
  for (const entry of plan) deps.print(row(entry))
  printUnproven()
  if (dryRun) {
    deps.print(`Would stop ${plural(plan.length, "Flywheel process")}${where}.`)
    return 0
  }

  const survivors = await endProcesses(plan, deps)
  const removed = await settle(survivors)
  const stopped = plan.length - survivors.length
  const records = removed === 0 ? "" : ` Removed ${removed === 1 ? "1 runtime record" : `${removed} runtime records`}.`
  if (survivors.length === 0) {
    deps.print(`Stopped ${plural(stopped, "Flywheel process")}.${records}`)
    return 0
  }
  deps.print(`Stopped ${plural(stopped, "Flywheel process")}; ${plural(survivors.length, "process")} survived SIGKILL: ${survivors.join(", ")}.${records}`)
  return 1
}

/** Hosts first, then guardians. A guardian ends its owner's containers when
 *  the owner goes, so it is given time to do that and leave on its own; only
 *  a guardian that stays after the sweep window is signalled. Returns the
 *  pids of what survived. */
async function endProcesses(plan: readonly FlywheelProcess[], deps: KillDependencies): Promise<readonly number[]> {
  const held = plan.map((entry) => ({ entry, container: deps.containerFor(entry) }))
  const hosts = held.filter(({ entry }) => entry.role === "host").map(({ container }) => container)
  await emptyContainers(hosts, deps.hostGraceMs, deps.sleep, { reason: "flywheel kill" })

  const guardians = held.filter(({ entry }) => entry.role === "guardian").map(({ container }) => container)
  const sweepDeadline = Date.now() + deps.guardianSweepMs
  while (guardians.some((container) => container.populated()) && Date.now() < sweepDeadline) await deps.sleep(SWEEP_POLL_MS)
  await emptyContainers(guardians, deps.hostGraceMs, deps.sleep, { reason: "flywheel kill: guardian outlived its sweep" })

  return held.filter(({ container }) => container.populated()).map(({ entry }) => entry.pid)
}

/** A start lock this command took: from a holder that the process table
 *  proved is not a Flywheel process of this account home, or a damaged lock
 *  that named no holder while no account service of this home ran in the
 *  lane. */
type ReclaimedStartLock =
  | { readonly lane: ServeLane; readonly pid: number }
  | { readonly lane: ServeLane; readonly path: string; readonly entry: "empty" | "malformed" }

function describeReclaimedStartLock(reclaimed: ReclaimedStartLock): string {
  if ("pid" in reclaimed) return `Reclaimed the ${reclaimed.lane} start lock from pid ${reclaimed.pid}, which is not a Flywheel process of this account home.`
  const words = reclaimed.entry === "empty" ? "is empty" : "holds bytes that are not a lock record"
  return `Removed the ${reclaimed.lane} start lock ${reclaimed.path}, which named no holder: the lock record ${words}.`
}

/** Clears the rendezvous of every account service that is gone in the
 *  selected lanes: its identity record, its socket, and its start lock.
 *  Returns how many services were cleared and which start locks were
 *  reclaimed. A lane that the reset leaves as it is, other than one whose
 *  service still runs, is named with the reason, and the reset goes on with
 *  the next lane: a start lock that another holder or an earlier release's
 *  empty claim keeps, a lane directory the file system fails, and an address
 *  that a connection proves nothing about. */
async function removeStaleRendezvous(directories: AccountDirectories, lanes: ReadonlySet<ServeLane>, deps: KillDependencies): Promise<{ readonly removed: number; readonly reclaimedStartLocks: readonly ReclaimedStartLock[] }> {
  let removed = 0
  const reclaimedStartLocks: ReclaimedStartLock[] = []
  for (const lane of lanes) {
    const identityPath = accountServeRecordPath(directories.userDataRoot, lane)
    if (!fs.existsSync(path.dirname(identityPath))) continue
    // A serve between its liveness probe and its identity publication has no
    // record and no socket yet, so it would read as gone; the start lock it
    // holds for exactly that window is what says the lane is starting and
    // nothing here is stale.
    const lockPath = accountServeStartLockPath(directories.userDataRoot, lane)
    let start: TriedLock
    try {
      start = await takeStartLock(lockPath, lane, directories.accountHome, deps)
    } catch (error) {
      if (errnoCode(error) === undefined) throw error
      deps.print(`The ${lane} lane's rendezvous was not cleared: ${errorMessage(error)}.`)
      continue
    }
    if (start.kind === "blocked") {
      deps.print(`The ${lane} lane's rendezvous was not cleared, because its start lock ${lockPath} is taken: ${start.reason}.`)
      continue
    }
    try {
      const reclaimed = start.reclaimed
      if (reclaimed?.kind === "nameless") reclaimedStartLocks.push({ lane, path: lockPath, entry: reclaimed.entry })
      else if (reclaimed?.proof === "caller-proven") reclaimedStartLocks.push({ lane, pid: reclaimed.pid })
      if (await removeIfStale(lane, identityPath, accountServeSocketPath(directories.userDataRoot, lane), deps)) removed += 1
    } finally {
      releaseLock(start)
    }
  }
  return { removed, reclaimedStartLocks }
}

/** Takes one lane's start lock, or answers why it could not. A lock whose
 *  holder is proven gone is reclaimed by the acquire itself, so the file is
 *  never removed by path out from under a live owner. A holder that the lock
 *  protocol reads as alive or unknown, such as an earlier build's record of a
 *  pid that another process now holds, gives way only when a fresh read of
 *  the process table proves it is not a Flywheel process of this account
 *  home. A lock that names no holder gives way only when that read finds no
 *  account service in the lane that may be this home's. */
async function takeStartLock(lockPath: string, lane: ServeLane, accountHome: string, deps: KillDependencies): Promise<TriedLock> {
  const first = tryAcquireLockSync(lockPath)
  if (first.kind === "acquired") return first
  return tryAcquireLockSync(lockPath, await startLockProofs(lane, accountHome, deps))
}

/** Removes one lane's rendezvous when no service runs there, and answers
 *  whether it removed one. A record whose pid is still alive belongs to a
 *  service this command spared, such as the one it is running under, and
 *  stays. A lane with no record is live while a service listens on its
 *  socket. A socket is removed only when a connection proves that nobody
 *  listens there: an answer that proves nothing keeps the path, and the
 *  reset names it with the error, and with the remedy when the error says
 *  that this user may not connect. */
async function removeIfStale(lane: ServeLane, identityPath: string, socketPath: string, deps: KillDependencies): Promise<boolean> {
  const identity = readRuntimeIdentity(identityPath)
  if (identity !== undefined && deps.isProcessAlive(identity.pid)) return false
  const socket = process.platform !== "win32" && fs.existsSync(socketPath) ? await deps.probeRendezvous(socketPath) : undefined
  if (identity === undefined && socket?.kind === "listening") return false
  if (socket?.kind === "unknown") {
    const remedy = refusesAccess(socket.code) ? " Fix its permissions so that you can connect to it, or remove the file." : ""
    deps.print(`The ${lane} lane's address ${socketPath} was kept: a connection to it failed with ${socket.code}, which proves neither a running service nor its absence.${remedy}`)
  }
  for (const file of [identityPath, ...(socket?.kind === "absent" ? [socketPath] : [])]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // The next serve start also clears a stale rendezvous before binding.
    }
  }
  return identity !== undefined || socket?.kind === "absent"
}

/** Whether a fresh read of the process table proves that a start lock's
 *  holder is not a Flywheel process of this account home: the table lists a
 *  process that is not Flywheel's under the pid, or one that is proven to
 *  serve another home or belong to another user. The table is read again
 *  here, because a service manager or a client can start a serve after the
 *  first read. A pid that the table does not list is proven only when the
 *  kernel says it runs nothing: a process that runs under it started after
 *  the read, and may be a serve that took the lock since. A table that
 *  cannot be read, a Flywheel process of this home, one whose home is not
 *  proven, and this command itself prove nothing.
 *
 *  The same read also proves that no process holds a start lock that names
 *  no holder: it lists no account service in the lane whose home is this
 *  one or is not proven. Only a serve takes the start lock, and a serve that
 *  starts after the read publishes a whole record, which never replaces an
 *  empty or malformed one. */
async function startLockProofs(lane: ServeLane, accountHome: string, deps: KillDependencies): Promise<TryLockOptions> {
  const rows = await deps.listProcesses()
  if (rows === undefined) return { ownerProvenGone: () => false, noHolderRuns: false }
  const byPid = new Map(rows.map((row) => [row.pid, row] as const))
  const otherHome = (row: ProcessRow): boolean => {
    const home = deps.accountHomeOf(row)
    return home.kind === "other-user" || (home.kind === "home" && home.home !== accountHome)
  }
  const laneService = (row: ProcessRow): boolean => {
    if (row.pid === deps.selfPid) return false
    const identity = classifyFlywheelProcess(row.argv, deps.isFlywheelCheckout)
    return identity?.lane === lane && identity.role === "host" && describeKind(row.argv, identity.role) === "account service"
  }
  return {
    ownerProvenGone: (pid) => {
      if (pid === deps.selfPid) return false
      const row = byPid.get(pid)
      if (row === undefined) return !deps.isProcessAlive(pid)
      if (classifyFlywheelProcess(row.argv, deps.isFlywheelCheckout) === undefined) return true
      return otherHome(row)
    },
    noHolderRuns: !rows.some((row) => laneService(row) && !otherHome(row)),
  }
}
