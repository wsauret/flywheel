import { readAppVersion } from "../infra/app-version.js"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import { errorDetail, errorMessage } from "../infra/error-message.js"
import type { LaunchState } from "../infra/launch-state.js"
import { Log } from "../infra/log.js"
import type { LauncherContext } from "../infra/process-supervisor.js"
import { createPersistentProcessManager, type PersistentProcessManager } from "../infra/persistent-process-manager.js"
import { startupTrace } from "../infra/startup-trace.js"
import type { createStartupTimeline } from "../infra/startup-timeline.js"
import { HEADLESS_USAGE, hasHeadlessFlag, headlessAuthProfile, headlessAuthSnapshot, headlessDeadlineSeconds, headlessDisabledTools, headlessEffort, headlessModel, headlessSession, headlessSystemPrompt, headlessTask, isHeadlessChat, needsHeadlessUsage } from "./headless-args.js"
import { createCliLauncher } from "./runtime-launch.js"
import type { CliLauncher, TerminalLaunch, TerminalRuntime } from "./runtime-launch.js"
import type { TerminalHandoff } from "./terminal-handoff.js"
import { publishFailedHeadlessTerminal, type CliStartup } from "./startup.js"
import type { SubcommandDispatch } from "./subcommands.js"
import type { HeadlessOutputObserver } from "../orchestration/headless/headless-output.js"
import type { HeadlessTaskResult } from "../orchestration/headless/run-headless-task.js"
import { shutdownSignals } from "../infra/shutdown-signals.js"
import { watchTerminalInput } from "../tui/terminal-input.js"

type MutationResult = number | undefined | { readonly kind: "task"; result: HeadlessTaskResult }

function isHeadlessResult(result: MutationResult): result is Exclude<MutationResult, number | undefined> {
  return typeof result === "object"
}
/** Composes one ordinary command from what the lightweight entry settled:
 *  the run's directories, its live build registration, and for the terminal
 *  run mode the account service that is already starting. */
export async function runCliCommand({ action, directories, subcommand, allowPersistentProcesses, output, withdrawLiveBuild, attach, attached, handoff, launchState, timeline, remote }: CliStartup): Promise<void> {
  let launcher: CliLauncher | undefined
  let persistentProcessManager: PersistentProcessManager | undefined
  let commandResult: MutationResult = undefined
  let failure: unknown
  try {
    const created = await createCliLauncher()
    launcher = created
    startupTrace("launcher created")
    // A terminal that follows the serving build releases what this image
    // owns before it is replaced: the processes its launcher started, then
    // the log, which the successor opens again.
    handoff?.release(() => created.dispose())
    handoff?.release(() => Log.closeGlobal())
    persistentProcessManager = createPersistentProcessManager()
    const terminal: TerminalLaunch | undefined = remote !== undefined ? { kind: "relay", remote } : attach !== undefined && attached !== undefined ? { kind: "local", attach, attached } : undefined
    commandResult = await runCommand(action.args, subcommand, directories, launcher, persistentProcessManager, allowPersistentProcesses, output, terminal, handoff, launchState, timeline)
  } catch (err) {
    failure = err
  } finally {
    try {
      withdrawLiveBuild()
      persistentProcessManager?.releaseAll()
      if (launcher) await launcher.dispose()
    } catch (err) {
      failure = failure === undefined ? err : new AggregateError([failure, err], "Headless command and disposal failed")
    }
  }

  if (failure !== undefined) {
    timeline?.finish("failed", failure)
    const message = errorMessage(failure)
    if (output) {
      await output.close()
      const published = isHeadlessResult(commandResult) ? commandResult : undefined
      if (published?.kind === "task") await output.publishTaskTerminal({ ...published.result, completed: false, error: message })
      else await publishFailedHeadlessTerminal(output, directories.projectRoot, "command_error")
    }
    throw new Error(message, { cause: failure })
  }

  if (isHeadlessResult(commandResult)) {
    if (output) {
      await output.close()
      await output.publishTaskTerminal(commandResult.result)
    }
    await Log.closeGlobal()
    process.exit(commandResult.result.completed ? 0 : 1)
  }
  if (commandResult === undefined) return
  await Log.closeGlobal()
  process.exit(commandResult)
}

/** Every run mode of this CLI, inside the one launcher context. Returns the
 *  exit code for a mode that owns one, or undefined for a mode that ends by
 *  returning; the exit itself belongs to runCliCommand(), after the context closed. */
async function runCommand(args: readonly string[], subcommand: SubcommandDispatch | undefined, directories: StartupDirectories, launcher: CliLauncher, persistentProcessManager: PersistentProcessManager, allowPersistentProcesses: boolean, output?: HeadlessOutputObserver, terminal?: TerminalLaunch, handoff?: TerminalHandoff, launchState?: LaunchState, timeline?: ReturnType<typeof createStartupTimeline>): Promise<MutationResult> {
  if (subcommand) {
    await subcommand(args.slice(1), directories, launcher, { persistentProcessManager, allowPersistentProcesses })
    return undefined
  }

  if (needsHeadlessUsage(args)) {
    if (output) throw new Error(HEADLESS_USAGE.trimEnd())
    console.error(HEADLESS_USAGE)
    return 1
  }

  // The terminal run mode opened its log in prepareCliStartup(), ahead of its runtime start.
  if (!terminal) {
    await Log.init({
      dir: directories.projectRoot,
      print: args.includes("--print-logs"),
    })
    startupTrace("log initialized")
  }
  // Must branch before startTUI() registers a global terminal raw-mode handler
  if (hasHeadlessFlag(args)) {
    const { composeFirstPartyModules } = await import("../orchestration/modules.js")
    for (const warning of composeFirstPartyModules().warnings) Log.Default.warn(warning)

    // Headless commands own their runtime here. The terminal's separate
    // runtime prepares its own config before it admits client work.
    const { prepareProjectDefaults } = await import("./project-preparation.js")
    await prepareProjectDefaults(directories, { publishReferences: true })
    const disabledTools = headlessDisabledTools(args)

    // Headless runs agent turns too: without parent-death detection, a closed
    // terminal or killed CI runner leaves a detached flywheel process spending
    // provider tokens. Exit promptly; the watchdog's SIGKILL clock backstops.
    const { installProcessWatchdog } = await import("../infra/process-watchdog.js")
    installProcessWatchdog(() => {
      Log.Default.error("parent process died; exiting headless run")
      void Log.closeGlobal().finally(() => process.exit(1))
    })
    return await runHeadless(args, directories, launcher, persistentProcessManager, allowPersistentProcesses, disabledTools, output)
  }

  if (!terminal || !handoff) throw new Error("the terminal run mode has no project runtime attach")
  return await runTUI(directories, launcher, terminal, handoff, launchState, timeline)
}

async function runHeadless(args: readonly string[], directories: StartupDirectories, launcher: LauncherContext, persistentProcessManager: PersistentProcessManager, allowPersistentProcesses: boolean, disabledTools: readonly string[], output?: HeadlessOutputObserver): Promise<MutationResult> {
  if (isHeadlessChat(args)) {
    const { runHeadlessChat } = await import("../orchestration/headless/run-headless-chat.js")
    const { runtimeWorkerUrl } = await import("./runtime-launch.js")
    return await runHeadlessChat({
      ...directories, launcher: launcher.scope,
      persistentProcesses: persistentProcessManager.client(), allowPersistentProcesses,
      workerUrl: runtimeWorkerUrl(), sessionId: headlessSession(args), oneShot: args.includes("--one-shot"), disabledTools,
      input: process.stdin, write: (record) => new Promise<void>((resolve, reject) => {
        process.stdout.write(record, (error) => {
          if (error) reject(error)
          else resolve()
        })
      }),
      progressWriter: (line) => process.stderr.write(`${line}\n`),
    })
  }
  const task = headlessTask(args)
  if (task) return await runHeadlessTaskMode(task, args, directories, launcher, persistentProcessManager, allowPersistentProcesses, disabledTools, output)
  console.error(HEADLESS_USAGE)
  return 1
}

async function runHeadlessTaskMode(task: string, args: readonly string[], directories: StartupDirectories, launcher: LauncherContext, persistentProcessManager: PersistentProcessManager, allowPersistentProcesses: boolean, disabledTools: readonly string[], output?: HeadlessOutputObserver): Promise<MutationResult> {
  const { runHeadlessTask } = await import("../orchestration/headless/run-headless-task.js")
  const result = await runHeadlessTask(task, {
    directories,
    launcher: launcher.scope,
    sourceArchiveSha256: process.env.FLYWHEEL_SOURCE_ARCHIVE_SHA256,
    deadlineSeconds: headlessDeadlineSeconds(args),
    authProfile: headlessAuthProfile(args),
    authSnapshot: headlessAuthSnapshot(args),
    disabledTools,
    systemPrompt: headlessSystemPrompt(args),
    model: headlessModel(args),
    effort: headlessEffort(args),
    printErrorsToStderr: !args.includes("--print-logs"),
    persistentProcesses: persistentProcessManager.client(),
    allowPersistentProcesses,
    connectEventBus: output ? (bus) => output.connect(bus) : undefined,
  })
  if (!output) {
    const { formatLegacyTaskOutput } = await import("../orchestration/headless/headless-output.js")
    process.stdout.write(formatLegacyTaskOutput(result))
  }
  return { kind: "task", result }
}

async function runTUI(directories: StartupDirectories, launcher: CliLauncher, terminal: TerminalLaunch, handoff: TerminalHandoff, launchState: LaunchState | undefined, timeline?: ReturnType<typeof createStartupTimeline>): Promise<number> {
  startupTrace("runTUI start")
  const endImports = timeline?.begin("client.imports")
  const { armProcessWatchdog, installProcessWatchdog } = await import("../infra/process-watchdog.js")
  const { startTUI } = await import("../tui/launcher.js");
  startupTrace("tui launcher imported")
  const { exitTUI, registerPreExitCleanup } = await import("../tui/exit.js");
  const { RUNTIME_SHUTDOWN_HARD_EXIT_MS } = await import("../orchestration/app-service/runtime-shutdown.js")
  // Parent death without a signal (SIGKILLed shell, crashed terminal emulator)
  // attempts the same graceful path as SIGHUP; the watchdog Worker's hard-exit
  // clock is armed independently, so a wedged main thread still dies bounded.
  installProcessWatchdog(() => {
    Log.Default.error("parent process died; running graceful exit")
    exitTUI()
  }, RUNTIME_SHUTDOWN_HARD_EXIT_MS)

  const { projectRoot, userDataRoot, accountHome } = directories

  const appVersion = await readAppVersion()
  startupTrace("app version resolved")

  // Each reach imports only its own launcher: a local launch loads none of
  // the relay, and a relay launch none of the local attach.
  const launchers = terminal.kind === "relay"
    ? { kind: "relay" as const, remote: terminal.remote, module: await import("./remote-terminal.js") }
    : { kind: "local" as const, terminal, modules: await Promise.all([import("./runtime-launch.js"), import("./runtime-attach.js")]) }
  startupTrace("runtime launcher imported")
  endImports?.()
  const endClientCreate = timeline?.begin("client.client_create")
  let launchedRuntime: TerminalRuntime
  if (launchers.kind === "relay") {
    launchedRuntime = launchers.module.launchRelayRuntime(launchers.remote, directories, launcher, handoff)
  } else {
    const [{ launchRuntimeClient }, { displayedRuntimeIdentity }] = launchers.modules
    const local = launchers.terminal
    launchedRuntime = {
      ...await launchRuntimeClient({ ...directories, attach: local.attach }),
      attach: { kind: "local", lane: local.attach.lane, restart: local.attach.restart },
      projectRoot,
      // An attach that fails shows its failure on the load screen; the card
      // then waits for the first snapshot of the attach that succeeds.
      attachedIdentity: local.attached.then((identity) => identity && displayedRuntimeIdentity(identity), () => undefined),
    }
  }
  endClientCreate?.()
  startupTrace("runtime client launched")
  // The runtime client ends when exit begins, not once the renderer is gone.
  // A signal can end the account service in the same instant, and a client
  // still attached while the exit finishes recovers its lane by launching a
  // new service that outlives this process.
  registerPreExitCleanup(launchedRuntime.dispose)

  // Terminal-close and interrupt signals route through the same cleanup path as /exit.
  // exitTUI() arms the independent Worker watchdog before touching the renderer,
  // so a wedged main/runtime thread cannot turn graceful cleanup into an orphan.
  const signalHandler = () => { exitTUI() }
  for (const signal of shutdownSignals(process.platform)) process.on(signal, signalHandler)
  // A closed terminal fails the renderer's next read before its SIGHUP arrives.
  watchTerminalInput(process.stdin)

  // OpenTUI's render loop is async-fired from a timer: a throw inside
  // root.render() surfaces as an unhandled rejection that OpenTUI's own
  // handler buries in its hidden console overlay, and the dead loop leaves
  // _isRunning latched so every subsequent requestRender is swallowed (frozen
  // screen, live process). Persist these to the file log so render-path
  // failures are diagnosable.
  const crashLog = Log.create({ service: "process" })
  process.on("unhandledRejection", (reason) => {
    crashLog.error("unhandled rejection", { error: errorMessage(reason), errorDetail: errorDetail(reason) })
  })
  process.on("uncaughtException", (err) => {
    crashLog.error("uncaught exception", { error: errorMessage(err), errorDetail: errorDetail(err) })
  })

  try {
    startupTrace("startTUI call")
    await startTUI({ mode: "dark", projectRoot: launchedRuntime.projectRoot, stateRoot: projectRoot, userDataRoot, accountHome, appVersion, attach: launchedRuntime.attach, appService: launchedRuntime.client, launcher: launcher.scope, launchState, timeline, attachedIdentity: launchedRuntime.attachedIdentity });
  } finally {
    // Renderer teardown can resolve without passing through exitTUI(), such as
    // when its terminal disappears. Every path into runtime disposal gets the
    // same bounded hard-exit owner.
    armProcessWatchdog()
    await launchedRuntime.dispose();
  }
  timeline?.finish("incomplete")
  // exitTUI() restores terminal state; the explicit exit in runCliCommand() prevents
  // cleanup hooks from re-entering, and it happens after the launcher context
  // this run opened has closed.
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0
  Log.Default.info("process exit after graceful shutdown", { exitCode })
  return exitCode
}
