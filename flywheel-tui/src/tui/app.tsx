/** @jsxImportSource @opentui/solid */
/**
 * TUI Application Entry Point
 *
 * 1. startTUI() returns new Promise<void> that blocks until exit
 * 2. render() fires the Solid tree with an ExitProvider
 * 3. ExitProvider uses useRenderer() to get the renderer from INSIDE the tree
 * 4. When exit is triggered, it calls renderer.destroy() then resolve()
 * 5. The promise resolves, caller continues, process.exit() runs
 */

import { render } from "@opentui/solid"
import { useRenderer } from "@opentui/solid"
import { ErrorBoundary } from "solid-js"
import { Log } from "../infra/log.js"
import type { ParentProps } from "solid-js"
import { Clipboard } from "./utils/clipboard"
import { ToastProvider } from "@tui/shared/context/toast"
import { ThemeProvider } from "@tui/shared/context/theme"
import { SessionProvider } from "@tui/shared/context/session"
import { createSessionManager } from "../orchestration/session/manager"
import { ErrorComponent } from "./components/error-boundary"
import { loadConfig } from "../orchestration/config/loader"
import { provideSessionFactories } from "../orchestration/workflow-session"
import { CONFIG_FILES } from "../infra/paths.js"
import * as fs from "node:fs"
import { setExitHandler } from "./exit.js"

export { exitTUI } from "./exit.js"

export interface TUIOptions {
  mode?: "dark" | "light"
  projectCwd?: string
}

export function startTUI(options: TUIOptions = {}): Promise<void> {
  const mode = options.mode ?? "dark"
  const projectCwd = options.projectCwd ?? process.cwd()

  // Load config to get theme name (best-effort)
  let themeName: string | undefined
  try {
    const configPath = CONFIG_FILES.find((p) => fs.existsSync(p))
    const { config } = loadConfig(configPath)
    themeName = config.theme
  } catch {
    // Config load failure is non-fatal
  }

  return new Promise<void>(async (resolve) => {
    const onExit = () => {
      resolve()
    }

    // Wire concrete TUI factories into the orchestration layer (DIP boundary)
    const { OpenTUIAdapter } = await import("./adapters/opentui")
    const { createStore } = await import("./routes/work/context/ui-state/store")
    const { TimerService } = await import("./shared/services/timer")
    provideSessionFactories({
      createStore: (key) => createStore(key),
      // Safe: createStore() returns UIActions which satisfies WorkflowStore.
      // The adapter needs the full UIActions at runtime, which is what it gets.
      createAdapter: (opts) => new OpenTUIAdapter(opts as unknown as import("./adapters/opentui").OpenTUIAdapterOptions),
      createTimer: () => new TimerService(),
    })

    // Lazy import FlywheelShell to ensure OpenTUI preload has registered
    const { FlywheelShell } = await import("./shell")

    const manager = createSessionManager({ baseDir: projectCwd })

    render(
      () => (
        <ErrorBoundary fallback={(error) => {
          const renderer = useRenderer()
          const handleExit = () => {
            renderer.destroy()
            onExit()
          }
          return <ErrorComponent error={error} onExit={handleExit} />
        }}>
          <ExitProvider onExit={onExit}>
            <ToastProvider>
              <ThemeProvider mode={mode} themeName={themeName}>
                <SessionProvider manager={manager}>
                  <FlywheelShell />
                </SessionProvider>
              </ThemeProvider>
            </ToastProvider>
          </ExitProvider>
        </ErrorBoundary>
      ),
      {
        targetFps: 30,
        gatherStats: false,
        exitOnCtrlC: false,
        autoFocus: true,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
          onCopySelection: (text) => {
            Clipboard.copy(text).catch((error) => {
              Log.create({ service: "app" }).error("clipboard copy failed", { error: error instanceof Error ? error : String(error) })
            })
          },
        },
      },
    )
  })
}

/**
 * ExitProvider — uses useRenderer() to access the renderer from inside the Solid tree.
 */
function ExitProvider(props: ParentProps<{ onExit: () => void }>) {
  const renderer = useRenderer()

  // Register the global exit function
  setExitHandler(() => {
    renderer.destroy()
    props.onExit()
  })

  return props.children
}
