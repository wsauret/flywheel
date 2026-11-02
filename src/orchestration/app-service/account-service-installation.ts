import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, posix, relative, win32 } from "node:path"

import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { osAccount } from "../../infra/os-account.js"
import { nativeAssetDir, MACOS_LAUNCHER_BUNDLE } from "../../infra/native-assets.js"
import { accountServeErrorLogPath, accountServeLauncherExecutablePath, accountServeLauncherPath } from "../../infra/paths.js"
import { trustedProbeLaunch, type TrustedProbeLaunch } from "../../infra/process-container.js"
import { WINDOWS_SERVICE_LAUNCHER_NAME } from "../../infra/update/wrapper-directory.js"
import { ACCOUNT_LAUNCHD_LABEL, ACCOUNT_WINDOWS_TASK, launchdPlist, REGISTRATION_FINGERPRINT_ENV, REGISTRATION_RELOAD_HELPER_LABEL, registrationFingerprint, type RegistrationReloadRecord, SERVICE_STOP_TIMEOUT_SECONDS, windowsTaskXml, windowsTaskXmlBytes } from "./account-service-registration.js"
import { logindLingerOffFor, systemdControl, systemdManager } from "./account-service-systemd.js"
import { installedExecutable } from "./runtime-executable.js"
import { AccountServiceInstallationError, answered, assertOk, failure, type ServiceCommandOutput, type ServiceCommandRunner } from "./service-manager-command.js"

export interface AccountServiceInstallation {
  installed(): Promise<boolean | null>
  install(): Promise<void>
  /** Process initiation Off: afterwards no registration exists, so nothing
   *  starts the service at login or on a client's request. The service can
   *  run this itself, so no step of it stops or unloads the service's own
   *  job, and none depends on a process that such a stop ends: the steps
   *  remove the registration, and on macOS and Linux a transient job outside
   *  the service's tree stops the service afterwards. On Windows the running
   *  instance serves until its next exit. */
  uninstall(): Promise<void>
  /** Asks the service manager to start the registered service now, without
   *  stopping a job that already runs. True when the manager holds, or now
   *  loads, the registration of this account home: that job is then the one
   *  starter, and the caller waits for it. False when no registration exists,
   *  the person disabled it, or the home is not one the manager serves. A
   *  manager that does not answer, cannot prove that no registration exists,
   *  or refuses a registration that exists and is enabled, is a failure,
   *  never a reason for the caller to start a second copy. Nothing is written
   *  here, and a home without a registration file answers without running a
   *  command, so an isolated home pays nothing for the question. */
  start(): Promise<boolean>
  /** Whether a registration exists for this account home, whether or not
   *  the person disabled it. A registration file answers without a command,
   *  and only then is the login home asked. A Windows query that does not
   *  answer is a failure, never an absence, and a query that fails proves no
   *  task only when the full task list does not name it. */
  registered(): Promise<boolean>
  /** What an update runs: a registration that exists is refreshed exactly as
   *  `install` does, and none is created, so a person's Process initiation
   *  Off holds through every update. */
  refresh(): Promise<void>
  /** The name logind states for the account while lingering is off for it
   *  on Linux: the systemd user manager, and the service with it, then stops
   *  at the account's last logout. Nothing while lingering is on, when logind
   *  does not answer, for an account home that is not the login home, and on
   *  macOS and Windows, where no command runs. Registering the service
   *  turns lingering on where logind allows it, so a reading after `install`
   *  names the account only where logind refused or did not answer. */
  lingerOffFor(): Promise<string | undefined>
}

/** What each service manager implements; the installation composes the
 *  refresh and the lingering reading from it. */
export type ServiceManager = Omit<AccountServiceInstallation, "refresh" | "lingerOffFor">

/** What a service that its manager started uses to keep its registration
 *  current without cutting its own work (ARCH-RUNTIME-039). Only a service in the
 *  login home asks for it. */
export interface AccountServiceRegistrationControl {
  /** macOS only. */
  readonly launchd?: {
    /** The fingerprint of the registration file on disk. */
    registeredFingerprint(): Promise<string | undefined>
    /** The pid of the process launchd runs for the job. */
    jobPid(): Promise<number | undefined>
    /** Whether a reload helper job is loaded now. */
    reloadInFlight(): Promise<boolean>
    /** Submits a transient launchd job, outside the service's own coalition,
     *  that runs `serve reload-registration` and then always removes itself.
     *  Answers launchd's refusal when it refused the job, and nothing when it
     *  accepted it. A submit that did not answer can still have loaded the
     *  helper, so it proves neither, and it throws. */
    handOffReload(): Promise<string | undefined>
  }
  /** Linux only. */
  readonly systemd?: {
    /** Run only by the service that systemd started, which its start proof
     *  says (ARCH-RUNTIME-038). Writes this build's unit text over a file that differs
     *  and reloads the manager, which stops nothing; a current file that
     *  systemd has not loaded yet is reloaded too. Only a service of a build
     *  that follows the unit's exit-code contract makes that unit loadable,
     *  because `serve install` never writes the unit while it is active. A
     *  unit file that is gone stays gone. True when it reloaded. */
    refreshUnit(): Promise<boolean>
  }
}

interface ServiceEnvironment { readonly [name: string]: string | undefined }
/** A service registration an earlier release installed under another name.
 *  Installing the account service removes it, so one machine runs one service. */
export interface RetiredServiceInstallation {
  readonly launchdLabel: string
  readonly systemdUnit: string
  readonly windowsTask: string
}

/** The launchd labels of the service job and its reload helper. The installed
 *  platform names the real ones; a test platform names throwaway ones, so the
 *  real launchd sequence runs without touching the real service. */
interface LaunchdLabels {
  readonly service: string
  readonly helper: string
}

const log = Log.create({ service: "account-service-installation" })

/** How often the reload helper asks whether launchd still holds the job. */
const RELOAD_POLL_MS = 250
/** Time beyond the job's own exit timeout before the helper gives up. */
const RELOAD_MARGIN_MS = 10_000
/** launchd answers a bootstrap with error 5 (EIO) while it still tears down
 *  a job that was booted out. OpenClaw's proven reload handoff retries that
 *  bootstrap 15 times, one second apart (RELOAD_BOOTSTRAP_RETRY_COUNT and
 *  RELOAD_BOOTOUT_WAIT_DELAY_SECONDS in its launchd-restart-handoff.ts). */
const BOOTSTRAP_ATTEMPTS = 15
const BOOTSTRAP_RETRY_MS = 1_000
/** The reload helper's program. The reload runs as a child of the shell, and
 *  the shell removes the helper job after the reload exits, whatever its
 *  status, so a helper that fails is never started again. $0 is the
 *  installed command and $1 the helper's own label. */
const RELOAD_HELPER_SCRIPT = `"$0" serve reload-registration; /bin/launchctl remove "$1"`

export interface AccountServicePlatform {
  readonly platform: NodeJS.Platform
  readonly accountHome: string
  /** The home the user's service manager runs its agents in: launchd, the
   *  systemd user manager, and Task Scheduler all start a program in the login
   *  user's own environment, whatever `HOME` the installing process carried.
   *  `undefined` when the platform cannot say. */
  readonly loginHome: () => string | undefined
  readonly env: ServiceEnvironment
  readonly uid: number | undefined
  readonly executable: string
  /** macOS only: the release-invariant application bundle launchd runs,
   *  shipped in the build's native directory and installed at one stable
   *  path. Privacy consent attaches to that bundle, so an update never asks
   *  again. `executable` is the program inside the installed bundle, and
   *  `errorLog` is the file beside it that keeps the service's standard error. */
  readonly launcher: { readonly source: string; readonly target: string; readonly executable: string; readonly errorLog: string } | undefined
  /** macOS only: the labels the service job and its reload helper load under. */
  readonly launchdLabels: LaunchdLabels
  readonly retired: readonly RetiredServiceInstallation[]
  readonly runCommand: ServiceCommandRunner
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly now: () => number
  readonly files: {
    exists(path: string): boolean
    read(path: string): string | undefined
    write(path: string, contents: string | Uint8Array): void
    remove(path: string): void
    /** Places the bundle at `target` with exactly the files of `source`. An
     *  identical bundle is left untouched, so its identity and timestamps hold. */
    installBundle(source: string, target: string): void
    /** Writes `contents` to a file named `name` in a fresh temporary
     *  directory only this user can read, runs `use` with its path, and then
     *  removes the directory, as OpenClaw stages its task XML. */
    withPrivateFile<T>(name: string, contents: Uint8Array, use: (path: string) => Promise<T>): Promise<T>
  }
}

/** What a launchd caller drives launchd through. It names no installed
 *  build: a launchd job loads the registration file on disk, so a reload
 *  helper can always leave the service job running. */
type LaunchdHost = Pick<AccountServicePlatform, "accountHome" | "uid" | "launchdLabels" | "runCommand" | "sleep" | "now" | "files">

const realFiles: AccountServicePlatform["files"] = {
  exists: existsSync,
  read(path) {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
  write(path, contents) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, { mode: 0o644 })
  },
  remove: (path) => rmSync(path, { force: true }),
  installBundle(source, target) {
    if (sameTree(source, target)) return
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    cpSync(source, target, { recursive: true })
    for (const file of filesUnder(join(target, "Contents", "MacOS"))) chmodSync(file, 0o755)
  },
  async withPrivateFile(name, contents, use) {
    const directory = mkdtempSync(join(tmpdir(), "flywheel-service-"))
    try {
      const path = join(directory, name)
      writeFileSync(path, contents, { mode: 0o600 })
      return await use(path)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** Whether `target` holds exactly the files of `source` with the same bytes. */
function sameTree(source: string, target: string): boolean {
  const sourceFiles = filesUnder(source).map((file) => relative(source, file))
  const targetFiles = filesUnder(target).map((file) => relative(target, file))
  if (sourceFiles.length !== targetFiles.length || sourceFiles.some((file, index) => file !== targetFiles[index])) return false
  return sourceFiles.every((file) => readFileSync(join(source, file)).equals(readFileSync(join(target, file))))
}

/** This process's launchd host for the account service of `accountHome`. */
export function accountLaunchdHost(input: { readonly accountHome: string; readonly runCommand: ServiceCommandRunner }): LaunchdHost {
  return {
    accountHome: input.accountHome,
    uid: process.getuid?.(),
    launchdLabels: { service: ACCOUNT_LAUNCHD_LABEL, helper: REGISTRATION_RELOAD_HELPER_LABEL },
    runCommand: input.runCommand,
    sleep: Bun.sleep,
    now: Date.now,
    files: realFiles,
  }
}

export function accountServicePlatform(input: {
  readonly userDataRoot: string
  readonly accountHome: string
  readonly retired: readonly RetiredServiceInstallation[]
  readonly runCommand: ServiceCommandRunner
}): AccountServicePlatform | undefined {
  const executable = installedExecutable({ platform: process.platform, userDataRoot: input.userDataRoot, accountHome: input.accountHome, installDirectory: process.env.FLYWHEEL_INSTALL_DIR, execPath: process.execPath })
  if (executable === undefined) return undefined
  const launcher = process.platform === "darwin"
    ? { source: join(nativeAssetDir(), MACOS_LAUNCHER_BUNDLE), target: accountServeLauncherPath(input.userDataRoot), executable: accountServeLauncherExecutablePath(input.userDataRoot), errorLog: accountServeErrorLogPath(input.userDataRoot) }
    : undefined
  return {
    ...accountLaunchdHost(input),
    platform: process.platform,
    loginHome: currentLoginHome,
    env: process.env,
    executable,
    launcher,
    retired: input.retired,
  }
}

/** The machine a service manager command runs on. */
interface ServiceCommandHost {
  readonly platform: NodeJS.Platform
  readonly env: ServiceEnvironment
  readonly uid: number | undefined
}

/** How a client that holds no launcher scope yet launches a service manager
 *  command: through a trusted program path, never the inherited PATH, and on
 *  Linux with the user bus the systemd user manager answers on, which the
 *  fixed probe environment alone does not name. */
export function serviceCommandLaunch(command: readonly string[], host: ServiceCommandHost, exists?: (filePath: string) => boolean): TrustedProbeLaunch {
  return trustedProbeLaunch(command, { env: userBusEnvironment(host), ...(exists === undefined ? {} : { exists }) })
}

function userBusEnvironment(host: ServiceCommandHost) {
  if (host.platform !== "linux") return {}
  const bus = {
    XDG_RUNTIME_DIR: host.env.XDG_RUNTIME_DIR || (host.uid === undefined ? undefined : `/run/user/${host.uid}`),
    DBUS_SESSION_BUS_ADDRESS: host.env.DBUS_SESSION_BUS_ADDRESS,
  }
  return Object.fromEntries(Object.entries(bus).filter((entry): entry is [string, string] => Boolean(entry[1])))
}

/** Whether two home paths name one directory, in the platform's own rules. */
function sameHome(platform: NodeJS.Platform, left: string, right: string): boolean {
  const canonical = (home: string): string => {
    let resolved = platform === "win32" ? win32.resolve(home) : posix.resolve(home)
    try {
      resolved = realpathSync(resolved)
    } catch {
      // A home that does not exist is compared as named.
    }
    return platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return canonical(left) === canonical(right)
}

const launchdPlistPath = (accountHome: string, label: string): string => posix.join(accountHome, "Library", "LaunchAgents", `${label}.plist`)

/** `accountHomeIsLoginHome` is the caller's own answer to whether the
 *  account home is the login home, as `isLoginHome` states it. A service
 *  passes the answer it remembers for its lifetime, so residency, the
 *  registration refresh, and its registration reads share one answer.
 *  Without it, each operation asks the platform. */
export function createAccountServiceInstallation(resolve: () => AccountServicePlatform | undefined, accountHomeIsLoginHome?: () => Promise<boolean | undefined>): AccountServiceInstallation {
  let resolved: { readonly platform: AccountServicePlatform | undefined } | undefined
  const platform = () => (resolved ??= { platform: resolve() }).platform
  const required = () => {
    const current = platform()
    if (!current) throw new AccountServiceInstallationError("Process initiation requires an installed Flywheel build.")
    return installationOn(current, accountHomeIsLoginHome ?? (async () => isLoginHome(current)))
  }
  return {
    async installed() { return platform() === undefined ? null : await required().installed() },
    async install() { await required().install() },
    async uninstall() { await required().uninstall() },
    async start() { return platform() === undefined ? false : await required().start() },
    async registered() { return platform() === undefined ? false : await required().registered() },
    async refresh() { await required().refresh() },
    async lingerOffFor() { return platform() === undefined ? undefined : await required().lingerOffFor() },
  }
}

/** Whether the account home is the home the login user's service manager
 *  runs its agents in. Only that home can hold a registration, so only there
 *  does anything start the account service at login or restart it. Nothing
 *  when the platform cannot name the login home: each caller decides what an
 *  unanswered question means for it. */
export function isLoginHome(home: Pick<AccountServicePlatform, "platform" | "accountHome" | "loginHome">): boolean | undefined {
  const login = home.loginHome()
  return login === undefined ? undefined : sameHome(home.platform, login, home.accountHome)
}

/** This process's login home, as the account database states it, never the
 *  environment, which is exactly what an isolated launch overrides. The read
 *  runs no command, so a client in any home has the answer before the
 *  interface's synchronous load starts, and a client in an isolated home
 *  launches its service at once. Nothing when the database has no entry for
 *  the process. */
export function currentLoginHome(): string | undefined {
  try {
    return osAccount().home
  } catch {
    return undefined
  }
}

/** The service manager's registration for this account, or nothing when the
 *  account home is not the home the manager serves. A registration made from
 *  another home would run the program against the login home anyway, under
 *  the one label and hub address the login account's own service holds, so an
 *  isolated home (a test's, a harness's) registers nothing and reports the
 *  service unavailable. */
function installationOn(platform: AccountServicePlatform, accountHomeIsLoginHome: () => Promise<boolean | undefined>): AccountServiceInstallation {
  let foreign: Promise<boolean> | undefined
  // A login home the platform cannot name counts as this home, so a real
  // account never loses its registration to a probe that fails.
  const isForeign = (): Promise<boolean> => (foreign ??= accountHomeIsLoginHome().then((login) => {
    if (login !== false) return false
    log.info("account service registration is not applicable to this account home", { accountHome: platform.accountHome })
    return true
  }))
  const manager = serviceManagerOn(platform, isForeign)
  return {
    async installed() { return (await isForeign()) ? null : await manager.installed() },
    async install() { if (!(await isForeign())) await manager.install() },
    async uninstall() { if (!(await isForeign())) await manager.uninstall() },
    // The login-home question costs no command, so a home that is not the
    // login home answers without one. launchd and systemd also read their
    // registration file first; Task Scheduler queries its task.
    start: () => manager.start(),
    registered: () => manager.registered(),
    async refresh() {
      if (await isForeign()) return
      if (await manager.registered()) await manager.install()
      else log.info("no registration exists; an update creates none, so Process initiation stays off")
    },
    async lingerOffFor() {
      if (platform.platform !== "linux" || platform.uid === undefined || await isForeign()) return undefined
      return await logindLingerOffFor(platform.runCommand, platform.uid)
    },
  }
}

/** The registration control of a service its manager started in the login
 *  home. The manager's own start proves the home, so nothing asks again. */
export function accountServiceRegistrationControl(platform: AccountServicePlatform): AccountServiceRegistrationControl {
  switch (platform.platform) {
    case "darwin": return { launchd: launchdControl(platform) }
    case "linux": return { systemd: systemdControl(platform) }
    default: return {}
  }
}

function serviceManagerOn(platform: AccountServicePlatform, isForeign: () => Promise<boolean>): ServiceManager {
  switch (platform.platform) {
    case "darwin": return launchdManager(platform, isForeign)
    case "linux": return systemdManager(platform, isForeign)
    case "win32": return taskSchedulerManager(platform, isForeign)
    default:
      return {
        async installed() { return false },
        async install() { throw new AccountServiceInstallationError(`Process initiation is unavailable on ${platform.platform}`) },
        async uninstall() {},
        async start() { return false },
        async registered() { return false },
      }
  }
}

/** What `launchctl print` proved about a label. `unknown` proves nothing: the
 *  command did not answer, or failed for a reason other than absence. */
type LaunchdState = "running" | "stopped" | "absent" | "unknown"
interface LaunchdProbe { readonly status: ServiceCommandOutput; readonly state: LaunchdState }

function launchdState(result: ServiceCommandOutput): LaunchdState {
  if (!answered(result)) return "unknown"
  if (result.exitCode === 0) return /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/i.test(result.stdout) ? "running" : "stopped"
  // 113 is launchctl's answer for a label its domain does not hold.
  return result.exitCode === 113 || /could not find service|no such process|not found/i.test(`${result.stderr}\n${result.stdout}`) ? "absent" : "unknown"
}

/** The fingerprint in the environment launchd loaded for the job, as
 *  `launchctl print` lists it. */
function loadedLaunchdFingerprint(printed: string): string | undefined {
  const environment = /(?:^|\n)[ \t]*environment = \{\n([\s\S]*?)\n[ \t]*\}/.exec(printed)?.[1]
  return environment === undefined ? undefined : new RegExp(`^\\s*${REGISTRATION_FINGERPRINT_ENV} => ([0-9a-f]{16})\\s*$`, "m").exec(environment)?.[1]
}

/** The launchd job of the account service, as each launchd caller drives it. */
function launchdJob(host: LaunchdHost) {
  const run = host.runCommand
  const labels = host.launchdLabels
  const plist = launchdPlistPath(host.accountHome, labels.service)
  const domain = (): string => {
    if (host.uid === undefined) throw new AccountServiceInstallationError("launchd needs the account's user id")
    return `gui/${host.uid}`
  }
  const target = (label = labels.service): string => `${domain()}/${label}`
  const probe = async (label = labels.service): Promise<LaunchdProbe> => {
    const status = await run(["launchctl", "print", target(label)])
    return { status, state: launchdState(status) }
  }
  /** Loads the file on disk. A load another process made first is this
   *  load's success, since both read the same file, and so is a label that a
   *  failed attempt finds loaded after all. */
  const bootstrap = async (): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      const result = await run(["launchctl", "bootstrap", domain(), plist])
      const detail = `${result.stderr}\n${result.stdout}`
      if (result.exitCode === 0 || result.exitCode === 130 || /already exists in domain/i.test(detail)) return
      const { state } = await probe()
      if (state === "running" || state === "stopped") return
      const tearingDown = result.exitCode === 5 || /\b5: Input\/output error/i.test(detail)
      if (!tearingDown || attempt >= BOOTSTRAP_ATTEMPTS) throw failure("launchctl bootstrap", result)
      await host.sleep(BOOTSTRAP_RETRY_MS)
    }
  }
  /** Starts a loaded job. Without -k: a job that already runs, perhaps still
   *  draining before its restart, is left alone. */
  const kickstart = async (): Promise<void> => {
    assertOk("launchctl kickstart", await run(["launchctl", "kickstart", target()]))
  }
  /** Whether the person disabled the service label, in Login Items or with
   *  `launchctl disable`. launchd loads no disabled label, at login or on
   *  request. Current macOS lists a disabled label as `=> disabled` and
   *  earlier releases as `=> true`. */
  const disabled = async (): Promise<boolean> => {
    const listed = await run(["launchctl", "print-disabled", domain()])
    assertOk("launchctl print-disabled", listed)
    return new RegExp(`^\\s*"${RegExp.escape(labels.service)}" => (?:disabled|true)\\s*$`, "m").test(listed.stdout)
  }
  return {
    run,
    labels,
    plist,
    domain,
    target,
    probe,
    bootstrap,
    kickstart,
    /** Submits the reload helper that `handOffReload` states, with
     *  `executable` as its installed command. Off submits the same helper. */
    async submitReloadHelper(executable: string): Promise<string | undefined> {
      // A helper an earlier attempt left behind would refuse the new one.
      await run(["launchctl", "remove", labels.helper])
      const submitted = await run(["launchctl", "submit", "-l", labels.helper, "--", "/bin/sh", "-c", RELOAD_HELPER_SCRIPT, executable, labels.helper])
      if (!answered(submitted)) throw failure("launchctl submit", submitted)
      return submitted.exitCode === 0 ? undefined : failure("launchctl submit", submitted).message
    },
    /** A probe that must answer: no answer is a failure, never an absence. */
    async state(label = labels.service) {
      const probed = await probe(label)
      if (probed.state === "unknown") throw failure(`launchctl print ${label}`, probed.status)
      return probed
    },
    disabled,
    /** Leaves the job loaded and running: the file on disk is loaded when
     *  launchd holds no job, and a loaded job that does not run is started. A
     *  label the person disabled stays as they left it. */
    async ensureRunning(): Promise<void> {
      const { state } = await probe()
      if (state === "absent") {
        if (!await disabled()) await bootstrap()
      } else if (state !== "running") await kickstart()
    },
  }
}

function launchdManager(platform: AccountServicePlatform, isForeign: () => Promise<boolean>): ServiceManager {
  const job = launchdJob(platform)
  const registered = async (): Promise<boolean> => platform.files.exists(job.plist) && !(await isForeign())
  return {
    registered,
    // Off removes the file first, and the job that its helper unloads can
    // stay loaded for a while, so a missing file reads off at once.
    async installed() { return platform.files.exists(job.plist) && (await job.run(["launchctl", "print", job.target()])).exitCode === 0 },
    async install() {
      const launcher = platform.launcher
      if (launcher) platform.files.installBundle(launcher.source, launcher.target)
      const registration = launchdPlist(job.labels.service, [...(launcher ? [launcher.executable] : []), platform.executable, "serve"], platform.accountHome, launcher?.errorLog)
      const { state } = await job.state()
      const changed = platform.files.read(job.plist) !== registration
      if (changed) platform.files.write(job.plist, registration)
      if (state === "absent") {
        await job.bootstrap()
      } else if (state === "stopped" && changed) {
        // launchd reads a registration only when it loads the job.
        await job.run(["launchctl", "bootout", job.target()])
        await job.bootstrap()
      } else if (state === "stopped") {
        await job.kickstart()
      }
      // A running job with a changed file keeps its work: the service finds
      // the new file on its build tick and re-registers from outside its own
      // process tree.
      for (const retired of platform.retired) {
        await job.run(["launchctl", "bootout", `${job.domain()}/${retired.launchdLabel}`])
        platform.files.remove(launchdPlistPath(platform.accountHome, retired.launchdLabel))
      }
    },
    async uninstall() {
      // A removal stops nothing, and it alone holds Off at the next login and
      // through every update, whatever launchd does next. A bootout from the
      // service's own tree would end the process that runs it, so the helper
      // that finds no file on disk unloads the job from outside.
      platform.files.remove(job.plist)
      const loaded = (await job.state()).state !== "absent"
      if (loaded) {
        const refusal = await job.submitReloadHelper(platform.executable)
        if (refusal !== undefined) throw new AccountServiceInstallationError(refusal)
      }
      log.info("the account service registration was removed", { helperUnloadsJob: loaded })
    },
    async start() {
      if (!await registered()) return false
      const { state } = await job.state()
      if (state === "stopped") await job.kickstart()
      else if (state === "absent") {
        // launchd runs a label the person disabled neither at login nor on
        // request, so, as for a systemd unit that is `disabled`, the client
        // launches the service itself.
        if (await job.disabled()) return false
        // A load is safe from any process tree, and RunAtLoad starts the job.
        await job.bootstrap()
      }
      return true
    },
  }
}

/** The pid of a job's running process in \`launchctl print\` output. */
function pidOf(printed: string): number | undefined {
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)/.exec(printed)?.[1]
  return pid === undefined ? undefined : Number(pid)
}

function launchdControl(platform: AccountServicePlatform): NonNullable<AccountServiceRegistrationControl["launchd"]> {
  const job = launchdJob(platform)
  return {
    async registeredFingerprint() { return registrationFingerprint(platform.files.read(job.plist)) },
    async jobPid() { return pidOf((await job.state()).status.stdout) },
    async reloadInFlight() { return (await job.state(job.labels.helper)).state !== "absent" },
    handOffReload: () => job.submitReloadHelper(platform.executable),
  }
}

/** What the reload helper job runs (`serve reload-registration`): it makes
 *  launchd hold the registration on disk. It refuses to run as anything but
 *  the helper job, because a bootout from inside the service's own process
 *  tree would end the process that asked for it.
 *
 *  With a fingerprinted file on disk, it loads that file in place of the one
 *  launchd holds: it boots the service job out, waits until launchd no longer
 *  holds it, and bootstraps the file. A job that already runs the
 *  registration on disk is left alone, so a helper that runs twice changes
 *  nothing the second time. `record` receives the outcome for the loop guard.
 *  Any failure, the refusal included, records `failed` for the fingerprint on
 *  disk, then leaves the service job loaded and running, and then rethrows,
 *  so a stale start parked for this reload never leaves the resident service
 *  down: the start this causes finds the guard spent for the fingerprint and
 *  serves as it is. A file with no fingerprint, an earlier release's, or one
 *  that cannot be read, is refused the same way, with nothing recorded.
 *
 *  With no file on disk, Process initiation Off removed the registration
 *  and handed the unload here, so the helper boots a loaded job out, waits
 *  until launchd no longer holds it, and loads nothing. It records nothing,
 *  and a failure leaves launchd as it is, because a recovery that started the
 *  job would turn the service back on. */
export async function reloadLaunchdRegistration(host: LaunchdHost, caller: { readonly parentPid: number }, record: (outcome: RegistrationReloadRecord) => void): Promise<void> {
  const job = launchdJob(host)
  const proveHelper = async (): Promise<void> => {
    // launchd names the helper job's own process, the shell that runs this
    // command. A job started with `launchctl submit` carries no label in
    // XPC_SERVICE_NAME, so the proof is the pid launchd reports for it.
    if (pidOf((await job.probe(job.labels.helper)).status.stdout) !== caller.parentPid) {
      throw new AccountServiceInstallationError(`serve reload-registration runs only as the launchd job ${job.labels.helper}, outside the account service's own process tree`)
    }
  }
  /** Boots the loaded job out and waits, for at most the job's exit timeout
   *  plus a margin, until launchd no longer holds it or holds a job that
   *  `settled` accepts. Answers what launchd holds then. */
  const bootOut = async (loaded: LaunchdProbe, settled: (probed: LaunchdProbe) => boolean = () => false): Promise<LaunchdProbe> => {
    const exitTimeoutSeconds = Number(/exit timeout\s*=\s*(\d+)/.exec(loaded.status.stdout)?.[1] ?? SERVICE_STOP_TIMEOUT_SECONDS)
    await job.run(["launchctl", "bootout", job.target()])
    const deadline = host.now() + exitTimeoutSeconds * 1_000 + RELOAD_MARGIN_MS
    let probed = await job.probe()
    while (probed.state !== "absent" && !settled(probed)) {
      if (host.now() >= deadline) throw new AccountServiceInstallationError(`the account service job did not leave launchd within ${exitTimeoutSeconds} seconds of its bootout`)
      await host.sleep(RELOAD_POLL_MS)
      probed = await job.probe()
    }
    return probed
  }
  if (!host.files.exists(job.plist)) {
    await proveHelper()
    // The wait never ends at a loaded fingerprint: an unfingerprinted job of
    // an earlier release would match the missing one.
    const loaded = await job.state()
    if (loaded.state !== "absent") await bootOut(loaded)
    log.info("the account service registration is gone; launchd holds no job for it", { bootedOut: loaded.state !== "absent" })
    return
  }
  // A file that cannot be read has no fingerprint, and is refused as one
  // without a fingerprint is.
  const onDisk = registrationFingerprint(host.files.read(job.plist))
  const holdsOnDisk = ({ status, state }: LaunchdProbe): boolean => state !== "absent" && loadedLaunchdFingerprint(status.stdout) === onDisk
  const load = async (): Promise<void> => {
    // A person who turned the service off in Login Items has decided; a
    // re-registration never turns it back on.
    if (await job.disabled()) throw new AccountServiceInstallationError("the account service is turned off in Login Items, so its registration stays as it is")
    const loaded = await job.state()
    if (holdsOnDisk(loaded)) {
      log.info("launchd already holds the account service registration on disk", { fingerprint: onDisk })
      return
    }
    // A client that finds nothing listening loads the file on disk, and that
    // load can land during the wait for the bootout. It completes this reload.
    if (loaded.state !== "absent" && holdsOnDisk(await bootOut(loaded, holdsOnDisk))) {
      log.info("a client loaded the account service registration on disk during its re-registration", { fingerprint: onDisk })
      return
    }
    await job.bootstrap()
    log.info("account service re-registered", { fingerprint: onDisk })
  }
  try {
    await proveHelper()
    if (onDisk === undefined) throw new AccountServiceInstallationError(`no fingerprinted account service registration is at ${job.plist}`)
    await load()
    record({ fingerprint: onDisk, outcome: "reloaded" })
  } catch (error) {
    if (onDisk !== undefined) {
      try {
        record({ fingerprint: onDisk, outcome: "failed", error: errorMessage(error) })
      } catch (unrecorded) {
        log.error("the failed re-registration of the account service could not be recorded", { error: errorMessage(unrecorded) })
      }
    }
    try {
      await job.ensureRunning()
    } catch (recovery) {
      log.error("the account service job could not be loaded and started after a failed re-registration", { error: errorMessage(recovery) })
    }
    throw error
  }
}

/** The task's state as Task Scheduler lists it, with `Status` and
 *  `Scheduled Task State` among its fields. */
const TASK_STATUS_QUERY = ["schtasks", "/Query", "/TN", ACCOUNT_WINDOWS_TASK, "/FO", "LIST", "/V"]
/** Every task the user can read, one CSV row each with the task's full path
 *  first. Task Scheduler states its messages in the display language, but
 *  never translates a task's name, and it answers the list with exit 0. */
const TASK_LIST_QUERY = ["schtasks", "/Query", "/FO", "CSV", "/NH"]

/** Whether a task list names the account's task, which sits in the root
 *  folder. Task Scheduler compares task names without case. */
function listsAccountTask(list: string): boolean {
  const row = `"\\${ACCOUNT_WINDOWS_TASK}",`.toLowerCase()
  return list.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(row))
}

function taskSchedulerManager(platform: AccountServicePlatform, isForeign: () => Promise<boolean>): ServiceManager {
  const run = platform.runCommand
  /** The task's listed state, or nothing when Task Scheduler holds no task.
   *  Task Scheduler names the login user's one task from any home, so the
   *  home is checked before the task is. A failed query states its cause in
   *  the display language, so no text of it proves the task absent. Only a
   *  list that does not name the task proves it. A task the list names, or a
   *  list that cannot be read, throws the query's cause, because a task the
   *  manager may hold is a registration and a starter; the next caller asks
   *  again. */
  const listedTask = async (): Promise<string | undefined> => {
    if (await isForeign()) return undefined
    const query = await run(TASK_STATUS_QUERY)
    if (!answered(query)) throw failure("schtasks query", query)
    if (query.exitCode === 0) return query.stdout
    const list = await run(TASK_LIST_QUERY)
    const listed = answered(list) && list.exitCode === 0
    if (listed && !listsAccountTask(list.stdout)) return undefined
    const cause = failure("schtasks query", query).message
    throw new AccountServiceInstallationError(listed ? cause : `${cause} (${failure("schtasks list", list).message})`)
  }
  return {
    registered: async () => (await listedTask()) !== undefined,
    async installed() { return (await run(["schtasks", "/Query", "/TN", ACCOUNT_WINDOWS_TASK])).exitCode === 0 },
    async install() {
      const identity = await run(["whoami", "/user", "/fo", "csv", "/nh"])
      if (!answered(identity) || identity.exitCode !== 0) throw failure("whoami /user", identity)
      const sid = /^"[^"\r\n]+","(S-1-\d+(?:-\d+)+)"$/u.exec(identity.stdout.trim())?.[1]
      if (sid === undefined) throw new AccountServiceInstallationError("whoami /user returned no valid account SID")
      const definition = windowsTaskXml(win32.join(win32.dirname(platform.executable), WINDOWS_SERVICE_LAUNCHER_NAME), sid)
      const query = await run(["schtasks", "/Query", "/TN", ACCOUNT_WINDOWS_TASK, "/XML"])
      const registered = query.exitCode === 0 ? registrationFingerprint(query.stdout) : undefined
      if (registered !== registrationFingerprint(definition)) {
        // Replacing a task definition leaves a running instance alone; the
        // next start runs the new one.
        await platform.files.withPrivateFile("task.xml", windowsTaskXmlBytes(definition), async (file) => {
          assertOk("schtasks create", await run(["schtasks", "/Create", "/F", "/TN", ACCOUNT_WINDOWS_TASK, "/XML", file]))
        })
      }
      const status = await run(TASK_STATUS_QUERY)
      if (!/(?:^|\r?\n)\s*Status:\s*Running\s*(?:\r?\n|$)/i.test(status.stdout)) {
        assertOk("schtasks run", await run(["schtasks", "/Run", "/TN", ACCOUNT_WINDOWS_TASK]))
      }
      for (const retired of platform.retired) {
        await run(["schtasks", "/End", "/TN", retired.windowsTask])
        await run(["schtasks", "/Delete", "/F", "/TN", retired.windowsTask])
      }
    },
    async uninstall() {
      // A deletion leaves a running instance alone, as a replacement of the
      // definition does, and a deleted task starts nothing, so the instance
      // serves until it exits and nothing starts it again. `/End` from the
      // service's own tree would end the process that asked for it, and an
      // `/End` from outside is a hard termination with no drain.
      assertOk("schtasks delete", await run(["schtasks", "/Delete", "/F", "/TN", ACCOUNT_WINDOWS_TASK]))
      log.info("the account service task was deleted; a running instance serves until it exits")
    },
    async start() {
      const listed = await listedTask()
      if (listed === undefined) return false
      // Task Scheduler runs a task the person disabled neither at logon nor
      // on request, so, as for a systemd unit that is `disabled`, the client
      // launches the service itself.
      if (/(?:^|\r?\n)\s*(?:Status|Scheduled Task State):\s*Disabled\s*(?:\r?\n|$)/i.test(listed)) return false
      assertOk("schtasks run", await run(["schtasks", "/Run", "/TN", ACCOUNT_WINDOWS_TASK]))
      return true
    },
  }
}
