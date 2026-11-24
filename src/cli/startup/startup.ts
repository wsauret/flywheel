import { existsSync, mkdirSync } from "node:fs"
import { isatty } from "node:tty"

import { AccountHomeRefusal, type AccountDirectories, type StartupDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import type { LaunchState } from "../../infra/launch-state.js"
import { Log } from "../../infra/log.js"
import { accountServeErrorLogPath, remoteProjectStateRoot, terminalDeviceStoreFile } from "../../infra/paths.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import { registerLiveBuild } from "../../infra/update/live-builds.js"
import { serveLaneFor, type ServeLane } from "../../infra/cli-subprocess.js"
import type { HeadlessFailure, HeadlessOutputObserver } from "../../orchestration/headless/headless-output.js"
import type { RemoteAttach, TerminalRemoteChoice, TerminalRemoteRequest } from "../../orchestration/terminal-remote.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../protocol/runtime-liveness.js"
import { hasHeadlessFlag, isHeadlessChat, needsHeadlessUsage } from "../headless-args.js"
import { installAccountCrashPolicy } from "./fatal-exit.js"
import { chooseStartupDirectory, PromptCancelled, promptCancelledExitCode, promptFromReadline } from "../readline-prompt.js"
import type { RootCliAction } from "../root-args.js"
import type { AccountRuntimeAttach, AccountRuntimeAttachOptions } from "../account-service/runtime-attach.js"
import type { RuntimeIdentity } from "../account-service/runtime-identity-record.js"
import { keepServiceErrorLogBounded } from "../account-service/service-error-log.js"
import { selectRunDirectories, shouldSelectStartupInteractively, type AnotherMachine } from "./startup-directories.js"
import { subcommandDispatch, type SubcommandDispatch } from "../subcommands.js"
import { createTerminalHandoff, LAUNCH_STATE_ENV, REMOTE_HANDOFF_ENV, type TerminalHandoff, type TerminalHandoffSeams, type TerminalSuccessor } from "../account-service/terminal-handoff.js"

type RunCliAction = Extract<RootCliAction, { kind: "run" }>

/** Everything the entry settles before it loads command composition. */
export interface CliStartup {
  readonly action: RunCliAction
  readonly directories: StartupDirectories
  readonly subcommand: SubcommandDispatch | undefined
  readonly allowPersistentProcesses: boolean
  /** The jsonl observer of a headless run; one instance for the whole run. */
  readonly output: HeadlessOutputObserver | undefined
  readonly withdrawLiveBuild: () => void
  /** Present exactly when this run owns the terminal; its service is already starting. */
  readonly attach: AccountRuntimeAttach | undefined
  /** The first attach of `attach`, which resolves with the identity record
   *  of the service it reached; present with `attach`. */
  readonly attached: Promise<RuntimeIdentity | undefined> | undefined
  /** How the terminal follows a protocol change; present with `attach`. */
  readonly handoff: TerminalHandoff | undefined
  /** The place a predecessor terminal handed this one, for the shell to restore. */
  readonly launchState: LaunchState | undefined
  /** Present exactly when this run's terminal opens a project on a remote
   *  machine through the relay (PI-REMOTE-016). It then has no `attach`:
   *  nothing on this machine is found, started, or followed, and
   *  `directories.projectRoot` is the directory of the terminal's own state
   *  for that project. */
  readonly remote?: RemoteAttach
  readonly timeline?: ReturnType<typeof createStartupTimeline>
}

/** The process boundaries the startup sequence crosses, so a test can prove
 *  the order without selecting real directories, writing a log, or launching
 *  a service. */
export interface StartupBoundaries {
  /** The process environment, which carries a predecessor terminal's place. */
  readonly env: { [name: string]: string | undefined }
  readonly selectDirectories: (action: RunCliAction) => Promise<StartupDirectories | AnotherMachine>
  /** Asks for a project on a paired machine through the module that owns
   *  remote access. */
  readonly chooseRemote: (request: Omit<TerminalRemoteRequest, "prompt" | "print">) => Promise<TerminalRemoteChoice>
  /** Installs one release for the account, and answers the program a
   *  terminal becomes to run it, or why it cannot. */
  readonly installRelease: (account: AccountDirectories, version: string) => Promise<TerminalSuccessor | string>
  readonly registerLiveBuild: (userDataRoot: string) => () => void
  readonly initLog: (options: { readonly dir: string; readonly print: boolean }) => Promise<void>
  /** Contains a floating abort on the account service's thread, and sends
   *  every other uncaught failure through the entry's fatal path. */
  readonly installCrashPolicy: () => void
  readonly createAttach: (options: AccountRuntimeAttachOptions) => Promise<AccountRuntimeAttach>
  /** Keeps the file that launchd appends this start's standard error to
   *  within its bound, before the start can write to it. */
  readonly boundServiceErrorLog: (userDataRoot: string) => void
  /** Counts this start of the installed account service, or rolls the
   *  account back from a build whose starts never listened. */
  readonly admitServiceStart: (userDataRoot: string) => Promise<"serve" | "rolled-back">
  /** How the terminal becomes a successor build; the live process image. */
  readonly handoffSeams?: TerminalHandoffSeams
}

/** Counts the paired machines only when the terminal ever paired as a
 *  device: one existence check first, so a terminal that never paired loads
 *  nothing of the remote module. A store this build cannot read offers no
 *  remote project and says why, and the local choice goes on. */
async function livePairedMachines(userDataRoot: string): Promise<number> {
  if (!existsSync(terminalDeviceStoreFile(userDataRoot))) return 0
  try {
    return await (await import("../remote-terminal.js")).pairedMachineCount(userDataRoot)
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    return 0
  }
}

const liveBoundaries: StartupBoundaries = {
  env: process.env,
  // The descriptors answer whether they are terminals. Reading
  // `process.stdout` would create Bun's stdout stream, and once that stream
  // exists Bun's console.log drops the bytes a slow pipe has not taken yet,
  // so a command's piped output would end at the pipe's 64 KiB.
  selectDirectories: (action) => selectRunDirectories(action, {
    env: process.env,
    cwd: process.cwd(),
    interactive: shouldSelectStartupInteractively(action.args, isatty(0), isatty(1)),
    choose: (candidates, options) => chooseStartupDirectory(candidates, promptFromReadline, options),
    pairedMachines: livePairedMachines,
  }),
  chooseRemote: async (request) => (await import("../remote-terminal.js")).chooseRemoteProject(request),
  installRelease: async (account, version) => {
    const [{ createCliLauncher }, { installTerminalRelease }] = await Promise.all([import("../account-service/runtime-launch.js"), import("../remote-terminal.js")])
    const launcher = await createCliLauncher()
    try {
      return await installTerminalRelease(account, launcher, version)
    } finally {
      await launcher.dispose()
    }
  },
  registerLiveBuild,
  initLog: (options) => Log.init(options),
  installCrashPolicy: installAccountCrashPolicy,
  createAttach: async (options) => (await import("../account-service/runtime-attach.js")).createAccountRuntimeAttach(options),
  boundServiceErrorLog: (userDataRoot) => keepServiceErrorLogBounded(accountServeErrorLogPath(userDataRoot), 2),
  admitServiceStart: async (userDataRoot) => (await import("../../orchestration/update/service-start.js")).admitServiceStart({ userDataRoot, nowMs: Date.now() }),
}

/** Settles the run's directories and, for the terminal run mode, starts the
 *  account service before command composition loads, so the service's boot
 *  overlaps this process's own module load. A start of the account service
 *  installs its crash policy here, and a start of the installed account
 *  service counts itself here. Returns undefined when the run ended here: the
 *  composition probe, or a service start that rolled the account back. An
 *  unusable root action or project directory exits the process. */
export async function prepareCliStartup(rootAction: Exclude<RootCliAction, { kind: "help" | "version" }>, boundaries: StartupBoundaries = liveBoundaries): Promise<CliStartup | undefined> {
  const preparationStarted = performance.now()
  const args = process.argv.slice(2)
  const jsonlMode = args.includes("--headless") && args.includes("--jsonl") && !isHeadlessChat(args)
  const output = jsonlMode ? (await import("../../orchestration/headless/headless-output.js")).createHeadlessOutputObserver(process.stdout) : undefined
  if (rootAction.kind === "error") {
    const { rootUsage } = await import("../root-help.js")
    process.stderr.write(`${rootAction.message}\n\n${await rootUsage()}\n`)
    if (output) await publishFailedHeadlessTerminal(output, process.cwd(), "usage_error")
    process.exit(1)
  }

  let selected: StartupDirectories | AnotherMachine
  try {
    selected = await boundaries.selectDirectories(rootAction)
  } catch (err) {
    if (err instanceof PromptCancelled) {
      process.stderr.write("Project selection cancelled. Run flywheel again to choose a project root.\n")
      process.exit(promptCancelledExitCode(err))
    }
    const message = err instanceof AccountHomeRefusal ? err.message : `Invalid project directory: ${errorMessage(err)}`
    process.stderr.write(`${message}\n`)
    if (output) await publishFailedHeadlessTerminal(output, process.cwd(), "project_error")
    process.exit(1)
  }
  if ("kind" in selected) return await prepareRemoteStartup(rootAction, selected.account, boundaries, preparationStarted)
  const directories = selected
  const directoriesSelected = performance.now()
  startupTrace("startup directories selected")

  if (process.env.FLYWHEEL_INTERNAL_COMPOSITION_PROBE === "1") {
    const { runCompositionProbe } = await import("./composition-probe.js")
    runCompositionProbe(directories)
    return undefined
  }

  // Declared before any work: while this process runs, the build it is
  // executing is one no collector may remove, whatever else this run does or
  // how long it lives (ARCH-DISTRIBUTION-019). A run from a source checkout declares
  // nothing, because it is executing no installed build.
  const withdrawLiveBuild = boundaries.registerLiveBuild(directories.userDataRoot)
  startupTrace("live build registered")

  const allowPersistentProcesses = rootAction.allowPersistentProcesses ?? false
  const subcommand = rootAction.args[0] === undefined ? undefined : await subcommandDispatch(rootAction.args[0])
  if (rootAction.args[0] === "serve") {
    // The account service's log opens here, and its start installs its crash
    // policy, bounds its error log, and counts itself here, before command
    // composition loads: a build can fail in that import, and a start that
    // fails leaves no other evidence (ARCH-RUNTIME-042). The policy comes first, so an
    // uncaught failure from here on reaches the account log and the lane's
    // failing streak as a thrown one does (ARCH-RUNTIME-030). A start that rolled the
    // account back ends with the code its service manager restarts, so the
    // manager starts the build `current` now names.
    await boundaries.initLog({ dir: directories.accountHome, print: false })
    const { SERVE_EXIT, startsService } = await import("../account-service/serve-contract.js")
    if (startsService(rootAction.args.slice(1))) {
      boundaries.installCrashPolicy()
      boundaries.boundServiceErrorLog(directories.userDataRoot)
      if (await boundaries.admitServiceStart(directories.userDataRoot) === "rolled-back") {
        withdrawLiveBuild()
        process.exitCode = SERVE_EXIT.restart
        return undefined
      }
    }
  }
  const runsTerminal = subcommand === undefined && !hasHeadlessFlag(rootAction.args) && !needsHeadlessUsage(rootAction.args)
  let attach: AccountRuntimeAttach | undefined
  let attached: Promise<RuntimeIdentity | undefined> | undefined
  let handoff: TerminalHandoff | undefined
  let launchState: LaunchState | undefined
  let timeline: ReturnType<typeof createStartupTimeline> | undefined
  if (runsTerminal) {
    // The terminal's runtime is a separate process (ARCH-RUNTIME-005), and its boot is
    // the long pole of chat readiness. The log opens first, so no raw
    // diagnostic line the start writes reaches the terminal the interface
    // is about to own.
    const printLogs = rootAction.args.includes("--print-logs")
    const logStarted = performance.now()
    await boundaries.initLog({ dir: directories.projectRoot, print: printLogs })
    const logOpened = performance.now()
    timeline = createStartupTimeline({
      owner: "client",
      stages: ["terminal.directories", "terminal.log", "terminal.attach", "terminal.service_ready", "client.composition", "client.imports", "client.client_create", "client.app_import", "client.shell_import", "client.first_frame", "client.background_warm"],
      context: { projectRoot: directories.projectRoot, pid: String(process.pid), timelineId: crypto.randomUUID() },
      originMs: preparationStarted,
    })
    timeline.recordCompleted("terminal.directories", preparationStarted, directoriesSelected)
    timeline.recordCompleted("terminal.log", logStarted, logOpened)
    startupTrace("log initialized")
    // A predecessor terminal names its place in this environment. The name
    // is consumed here, so no process this terminal starts inherits it.
    const handedPath = boundaries.env[LAUNCH_STATE_ENV]
    if (handedPath !== undefined) {
      Reflect.deleteProperty(boundaries.env, LAUNCH_STATE_ENV)
      launchState = await takeHandedPlace(handedPath, directories.projectRoot)
    }
    // The one thing this image owns before command composition is its
    // live-build record; the launcher and the log join it in main.
    handoff = createTerminalHandoff({ lane: serveLaneFor(process.execPath), userDataRoot: directories.userDataRoot, projectRoot: directories.projectRoot, allowPersistentProcesses, printLogs, incoming: launchState }, boundaries.handoffSeams)
    handoff.release(withdrawLiveBuild)
    const endAttach = timeline.begin("terminal.attach")
    try {
      attach = await boundaries.createAttach({ ...directories, allowPersistentProcesses, follow: handoff.follow })
      endAttach()
    } catch (error) {
      endAttach("failed")
      timeline.finish("failed", error)
      throw error
    }
    startupTrace("account runtime attach start")
    // The terminal's client joins this same start and receives its latest phase.
    // A protocol boundary found now re-executes before the shell exists.
    const endServiceReady = timeline.begin("terminal.service_ready")
    attached = attach.ensure(() => {})
    attached.then(() => endServiceReady(), () => endServiceReady("failed"))
  }

  return { action: rootAction, directories, subcommand, allowPersistentProcesses, output, withdrawLiveBuild, attach, attached, handoff, launchState, timeline }
}

/** The terminal run mode for a project on a remote machine (PI-REMOTE-016).
 *  It asks for the project, or takes the one a predecessor handed it, and
 *  follows the machine's release: a later release is installed and this
 *  terminal becomes it, and an earlier one is waited out. It never looks for,
 *  starts, or follows a service on this machine. The terminal's log and
 *  prompt history live in the directory of its own state for the project. */
async function prepareRemoteStartup(action: RunCliAction, account: AccountDirectories, boundaries: StartupBoundaries, preparationStarted: number): Promise<CliStartup | undefined> {
  const handed = boundaries.env[REMOTE_HANDOFF_ENV]
  if (handed !== undefined) Reflect.deleteProperty(boundaries.env, REMOTE_HANDOFF_ENV)
  const withdrawLiveBuild = boundaries.registerLiveBuild(account.userDataRoot)
  const allowPersistentProcesses = action.allowPersistentProcesses ?? false
  const printLogs = action.args.includes("--print-logs")
  const lane = serveLaneFor(process.execPath)
  let choice: TerminalRemoteChoice
  try {
    choice = await boundaries.chooseRemote({ userDataRoot: account.userDataRoot, terminal: { version: process.env.FLYWHEEL_APP_VERSION, protocolVersion: RUNTIME_PROTOCOL_VERSION }, ...(handed === undefined ? {} : { handed }) })
  } catch (error) {
    withdrawLiveBuild()
    if (error instanceof PromptCancelled) {
      process.stderr.write("Project selection cancelled. Run flywheel --remote again to choose a project.\n")
      process.exit(promptCancelledExitCode(error))
    }
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exit(1)
  }
  if (choice.kind === "cancelled") {
    withdrawLiveBuild()
    process.stderr.write("Project selection cancelled. Run flywheel --remote again to choose a project.\n")
    process.exit(1)
  }
  if (choice.kind === "install") {
    process.stdout.write(`${choice.machine} runs Flywheel ${choice.version}. Installing it for this terminal...\n`)
    const successor = await boundaries.installRelease(account, choice.version)
    if (typeof successor === "string") {
      withdrawLiveBuild()
      process.stderr.write(`${successor}\n`)
      process.exit(1)
    }
    const handoff = createTerminalHandoff({ lane, userDataRoot: account.userDataRoot, projectRoot: account.userDataRoot, remote: choice.handoff, allowPersistentProcesses, printLogs, incoming: undefined }, boundaries.handoffSeams)
    handoff.release(withdrawLiveBuild)
    return await handoff.follow(successor)
  }
  const remote = choice.attach
  try {
    return await prepareRelayTerminal(action, account, remote, boundaries, { preparationStarted, lane, allowPersistentProcesses, printLogs, withdrawLiveBuild })
  } catch (error) {
    // The relay client's presence sockets would keep this process alive
    // after a startup that failed before it connected.
    remote.close()
    throw error
  }
}

async function prepareRelayTerminal(action: RunCliAction, account: AccountDirectories, remote: RemoteAttach, boundaries: StartupBoundaries, run: { readonly preparationStarted: number; readonly lane: ServeLane; readonly allowPersistentProcesses: boolean; readonly printLogs: boolean; readonly withdrawLiveBuild: () => void }): Promise<CliStartup> {
  const { preparationStarted, lane, allowPersistentProcesses, printLogs, withdrawLiveBuild } = run
  const stateRoot = remoteProjectStateRoot(account.userDataRoot, remote.runtimeId, remote.placementId)
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const directories: StartupDirectories = { ...account, projectRoot: stateRoot, executionCwd: stateRoot }
  const directoriesSelected = performance.now()
  const logStarted = performance.now()
  await boundaries.initLog({ dir: stateRoot, print: printLogs })
  const logOpened = performance.now()
  const timeline = createStartupTimeline({
    owner: "client",
    stages: ["terminal.directories", "terminal.log", "client.composition", "client.imports", "client.client_create", "client.app_import", "client.shell_import", "client.first_frame", "client.background_warm"],
    context: { projectRoot: stateRoot, pid: String(process.pid), timelineId: crypto.randomUUID() },
    originMs: preparationStarted,
  })
  timeline.recordCompleted("terminal.directories", preparationStarted, directoriesSelected)
  timeline.recordCompleted("terminal.log", logStarted, logOpened)
  Log.Default.info("terminal attaches to a project on a remote machine", { runtimeId: remote.runtimeId, placementId: remote.placementId, version: remote.release.version, protocolVersion: remote.release.protocolVersion })
  const handedPath = boundaries.env[LAUNCH_STATE_ENV]
  let launchState: LaunchState | undefined
  if (handedPath !== undefined) {
    Reflect.deleteProperty(boundaries.env, LAUNCH_STATE_ENV)
    launchState = await takeHandedPlace(handedPath, stateRoot)
  }
  const handoff = createTerminalHandoff({ lane, userDataRoot: account.userDataRoot, projectRoot: stateRoot, remote: remote.handoff, allowPersistentProcesses, printLogs, incoming: launchState }, boundaries.handoffSeams)
  handoff.release(withdrawLiveBuild)
  return { action, directories, subcommand: undefined, allowPersistentProcesses, output: undefined, withdrawLiveBuild, attach: undefined, attached: undefined, handoff, launchState, timeline, remote }
}

/** Reads the place a predecessor terminal handed over. A place this build
 *  cannot read is a plain start with the reason in the log, never a failure. */
async function takeHandedPlace(path: string, projectRoot: string): Promise<LaunchState | undefined> {
  const { takeLaunchState } = await import("../../infra/launch-state.js")
  const taken = takeLaunchState(path, projectRoot)
  if (taken.kind === "restore") return taken.state
  Log.Default.warn("the previous terminal's place was not restored", { reason: taken.reason })
  return undefined
}

/** The terminal record of a headless run that ended before it published a
 *  result. It names the target and the stage that failed; the message goes
 *  to stderr only, because the JSONL contract carries no error text. */
export async function publishFailedHeadlessTerminal(output: HeadlessOutputObserver, projectRoot: string, failure: HeadlessFailure): Promise<void> {
  await output.close()
  await output.publishTaskTerminal({ completed: false, projectRoot, termination: { version: 2, deadlineFired: false } }, failure)
}
