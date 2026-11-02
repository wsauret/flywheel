/** @jsxImportSource @opentui/solid */

import type { TerminalAttach } from "./terminal-attach.js"
import { NativeSession, type CliRenderer } from "@opentui/core"
import { render, useRenderer } from "@opentui/solid"
import { ModalProvider } from "@tui/components/modal"
import { QuestionInputProvider } from "@tui/components/question-input"
import { KeymapProvider } from "@tui/context/keymap"
import { ThemeProvider } from "@tui/context/theme"
import { TickPoolProvider } from "@tui/context/tick-pool-context"
import { ToastProvider } from "@tui/context/toast"
import type { ParentProps } from "solid-js"
import { ErrorBoundary, onCleanup } from "solid-js"
import { errorMessage } from "../infra/error-message.js"
import type { LaunchState } from "../infra/launch-state.js"
import { Log } from "../infra/log.js"
import { DebugLog } from "../infra/debug-log.js"
import { startupTrace } from "../infra/startup-trace.js"
import type { createStartupTimeline } from "../infra/startup-timeline.js"
import { probeDrain, renderProbeEnabled, renderProbeFrame } from "../infra/render-probe.js"
import { fontInstallSummary, getFontStatus, installBundledFont } from "../orchestration/font-installer.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { RuntimeIdentity } from "../protocol/client/runtime-identity.js"
import { ErrorComponent } from "./components/error-boundary.js"
import { setExitHandler, setRendererHandoff } from "./exit.js"
import { ownedCommandRunner } from "../infra/owned-command.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import { createClipboard } from "./utils/clipboard.js"
import { createTerminalOutput, type TerminalOutput } from "./terminal-output.js"
import { createSettingsStore } from "./hooks/create-settings-store.js"
import { createRuntimeConfigCache } from "./hooks/shell-state.js"


/** Resolved bootstrap inputs for the TUI. Ordinary settings come from RuntimeConfigView. */
export interface TUIOptions {
  mode: "dark" | "light"
  /** The project root as this terminal knows it before the runtime names it:
   *  the local project root, or the project's name on a remote machine. */
  projectRoot: string
  /** The directory this terminal keeps its own state for the project under:
   *  prompt history and the place a successor terminal restores. The project
   *  root for a local project; a directory under the account's data root for
   *  a project on another machine (ARCH-DIRECTORIES-010). */
  stateRoot: string
  /** Startup-selected account data root every account-global path derives from. */
  userDataRoot: string
  /** Account home `userDataRoot` was derived from. */
  accountHome: string

  appVersion: string
  /** How this terminal reaches its runtime. */
  attach: TerminalAttach
  appService: AttachedRuntimeClient
  /** Launch authority of this command. Every process the TUI starts - the
   *  clipboard tools, the browser handoff, the font-cache refresh, a credential
   *  helper - is launched into it and ends with it. */
  launcher: LauncherScope
  /** The place a predecessor terminal handed this one (ARCH-DISTRIBUTION-031). */
  launchState?: LaunchState
  timeline?: ReturnType<typeof createStartupTimeline>
  /** The identity of the account service this terminal's attach reached, so
   *  the welcome card names the serving build before the session catalog
   *  arrives. Never rejects. */
  attachedIdentity: Promise<RuntimeIdentity | undefined>
}

/**
 * Start the Flywheel TUI.
 *
 * @public
 * `tui/launcher.ts` loads this module via `await import("./app")` so OpenTUI's preload hook can
 * register before SolidJS renders; a static import would pull in the JSX runtime too early.
 * Knip cannot trace dynamic imports; this export is not dead.
 */
export async function startTUI(options: TUIOptions): Promise<void> {
  startupTrace("tui app startTUI entered")
  const endShellImport = options.timeline?.begin("client.shell_import")
  // Lazy import FlywheelShell to ensure OpenTUI preload has registered
  let shell: typeof import("./shell")
  try {
    shell = await import("./shell")
    endShellImport?.()
  } catch (error) {
    endShellImport?.("failed")
    throw error
  }
  const { FlywheelShell } = shell
  const endFirstFrame = options.timeline?.begin("client.first_frame")
  startupTrace("flywheel shell imported")

  // One clipboard for this TUI: the console overlay, the crash screen, and the
  // shell all copy through the same owned commands.
  const clipboard = createClipboard(ownedCommandRunner(options.launcher))
  const output = createTerminalOutput()
  const stdout = output.rendererConfig.stdout ?? process.stdout
  const nativeSession = new NativeSession(stdout)
  let attachedRenderer: CliRenderer | undefined
  let foregroundId: () => string | undefined = () => undefined

  return new Promise<void>((resolve, reject) => {
    let exiting = false
    const releaseTerminal = Log.holdTerminal()
    const onExit = () => {
      exiting = true
      releaseTerminal()
      options.timeline?.finish("incomplete")
      resolve()
    }
    const onFirstFrame = (): void => {
      endFirstFrame?.()
      options.timeline?.foregroundReady()
      const endWarm = options.timeline?.begin("client.background_warm")
      void options.appService.dispatch({ type: "background.warm" }).then(() => {
        endWarm?.()
        options.timeline?.finish()
      }).catch((err) => {
        endWarm?.("failed")
        options.timeline?.finish("failed", err)
        if (!exiting) startupTrace(`background warm failed: ${errorMessage(err)}`)
      })
    }

    render(
      () => {
        attachedRenderer = useRenderer()
        const runtimeConfig = createRuntimeConfigCache({ appService: options.appService })
        const settingsOperations = { getFontStatus, installBundledFont, fontInstallSummary }
        const settings = createSettingsStore(runtimeConfig, options.appService)
        return (
        <ExitProvider onExit={onExit} onFirstFrame={onFirstFrame} output={output}>
          <ToastProvider>
            <TickPoolProvider>
              <ThemeProvider mode={options.mode} config={runtimeConfig.view} renderer={useRenderer()}>
                <ErrorBoundary fallback={(error) => {
                  Log.create({ service: "tui-renderer" }).error("renderer failed", { error })
                  const renderer = useRenderer()
                  const handleExit = () => {
                    if (!renderer.isDestroyed) {
                      renderer.resetTerminalBgColor()
                      renderer.setTerminalTitle("")
                    }
                    renderer.destroy()
                  }
                  return <ErrorComponent error={error} onExit={handleExit} clipboard={clipboard} appService={options.appService} appVersion={options.appVersion} sessionId={foregroundId()} />
                }}>
                  <KeymapProvider config={runtimeConfig.view}>
                  <QuestionInputProvider>
                    <ModalProvider clipboard={clipboard}>
                      <FlywheelShell appService={options.appService} attach={options.attach} runtimeConfig={runtimeConfig} projectRoot={options.projectRoot} stateRoot={options.stateRoot} userDataRoot={options.userDataRoot} accountHome={options.accountHome} appVersion={options.appVersion} launcher={options.launcher} clipboard={clipboard} settings={settings} settingsOperations={settingsOperations} launchState={options.launchState} attachedIdentity={options.attachedIdentity} registerForeground={(read) => { foregroundId = read }} terminalWriter={nativeSession} />
                    </ModalProvider>
                  </QuestionInputProvider>
                  </KeymapProvider>
                </ErrorBoundary>
              </ThemeProvider>
            </TickPoolProvider>
          </ToastProvider>
        </ExitProvider>
        )
      },
      {
        // Matched to the intake's 16ms frame batch (the one pacing authority):
        // at 30fps half the coalesced reactive work never reached a painted
        // frame (the frame scheduler pairs its 16ms batch with 60fps the same way).
        targetFps: 60,
        gatherStats: false,
        exitOnCtrlC: false,
        autoFocus: true,
        openConsoleOnError: false,
        ...output.rendererConfig,
        stdout,
        nativeSession,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
          onCopySelection: (text) => {
            clipboard.copy(text).catch((error) => {
              Log.create({ service: "app" }).error("clipboard copy failed", { error: errorMessage(error) })
            })
          },
        },
      },
    ).catch((error: unknown) => {
      if (attachedRenderer) attachedRenderer.destroy()
      else nativeSession.dispose()
      releaseTerminal()
      reject(error)
    })
    startupTrace("opentui render returned")
  })
}

function ExitProvider(props: ParentProps<{ onExit: () => void; onFirstFrame: () => void; output: TerminalOutput }>) {
  const renderer = useRenderer()
  // eslint-disable-next-line solid/reactivity -- output is a static value from the composition root, never changes
  const output = props.output
  onCleanup(output.attach(renderer))
  // eslint-disable-next-line solid/reactivity -- onFirstFrame is a static callback from the composition root, never changes
  const onFirstFrame = props.onFirstFrame
  let sampleAt = performance.now()
  if (renderProbeEnabled()) {
    renderer.setGatherStats(true)
    onCleanup(() => {
      probeDrain()
    })
  }
  let tracedFirstFrame = false
  renderer.on("frame", () => {
    renderProbeFrame()
    if (renderProbeEnabled() && performance.now() - sampleAt >= 1_000) {
      sampleAt = performance.now()
      const { counters, gauges } = probeDrain()
      DebugLog.record({
        type: "render.frame.summary",
        payload: { counters, gauges, renderer: renderer.getStats() },
      })
      renderer.resetStats()
    }
    if (tracedFirstFrame) return
    tracedFirstFrame = true
    startupTrace("opentui first frame")
    onFirstFrame()
  })

  // eslint-disable-next-line solid/reactivity -- onExit is a static callback from the composition root, never changes
  const onExit = props.onExit
  // Output failure can destroy the renderer without an explicit exit. Stream
  // restoration, including a failed restoration, settles before the CLI exits.
  void renderer.closed.then(onExit, error => {
    Log.create({ service: "tui-renderer" }).error("terminal restoration failed", { error: errorMessage(error) })
    onExit()
  })
  setExitHandler(() => {
    if (!renderer.isDestroyed) {
      renderer.resetTerminalBgColor()
      renderer.setTerminalTitle("")
    }
    renderer.destroy()
  })
  // A terminal that follows the serving build hands the tty over with the
  // frame in flight finished and every mode restored, and takes it back if
  // the successor cannot start (ARCH-RUNTIME-036).
  setRendererHandoff({
    suspend: async () => {
      await renderer.idle()
      await renderer.suspend()
    },
    resume: async () => { await renderer.resume() },
    destroy: async () => {
      renderer.destroy()
      await renderer.closed
    },
  })
  onCleanup(() => { setRendererHandoff(null) })

  // eslint-disable-next-line solid/reactivity -- children is the static component tree, accessed in JSX return position
  return props.children
}
