import type { ServiceCommand, ServiceNames } from "./account-service-registration.js"
import type { ServiceCommandRunner } from "./service-manager-command.js"

/** The contract between the account service installation and the service
 *  manager each platform runs it through: what the installation offers its
 *  callers, what one manager implements, and the platform a manager drives. */

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

export interface ServiceEnvironment { readonly [name: string]: string | undefined }
/** A service registration an earlier release installed under another name.
 *  Installing the account service removes it, so one machine runs one service. */
export interface RetiredServiceInstallation {
  readonly launchdLabel: string
  readonly systemdUnit: string
  readonly windowsTask: string
}

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
  /** What the manager runs with `serve` after it: the installed command, on
   *  Windows its windowless service launcher, or the checkout's dev entry. */
  readonly command: ServiceCommand
  /** macOS only: the release-invariant application bundle launchd runs,
   *  shipped in the build's native directory and installed at one stable
   *  path. Privacy consent attaches to that bundle, so an update never asks
   *  again. `executable` is the program inside the installed bundle, and
   *  `errorLog` is the file beside it that keeps the service's standard error.
   *  The dev lane ships no bundle, so launchd runs its command directly. */
  readonly launcher: { readonly source: string; readonly target: string; readonly executable: string; readonly errorLog: string } | undefined
  /** The names the lane's registration holds. A test platform names
   *  throwaway ones, so the real launchd sequence runs without touching the
   *  real service. */
  readonly names: ServiceNames
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
     *  removes the directory. */
    withPrivateFile<T>(name: string, contents: Uint8Array, use: (path: string) => Promise<T>): Promise<T>
  }
}
