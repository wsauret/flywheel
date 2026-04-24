/** @jsxImportSource @opentui/solid */

import { render } from "@opentui/solid"
import { useRenderer } from "@opentui/solid"
import { ErrorBoundary } from "solid-js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import type { ParentProps } from "solid-js"
import { Clipboard } from "./utils/clipboard.js"
import { ToastProvider } from "@tui/shared/context/toast"
import { ThemeProvider } from "@tui/shared/context/theme"
import { SessionProvider } from "@tui/shared/context/session"
import { createSessionManager } from "../orchestration/session/manager.js"
import { ErrorComponent } from "./components/error-boundary.js"
import { loadConfig } from "../orchestration/config/loader.js"
import { resolveTierConfigs } from "../orchestration/config/schema.js"
import { getEngine } from "../orchestration/engines/core/registry.js"
import type { CreateWorkflowAdapter } from "../orchestration/session-store-types.js"
import { findConfigFile } from "../infra/paths.js"
import { setExitHandler } from "./exit.js"

/**
 * Options for configuring the TUI runtime.
 *
 * @public
 * Dynamic-import entry point (see below).
 */
export interface TUIOptions {
  mode?: "dark" | "light"
  projectCwd?: string
}

/**
 * Start the Flywheel TUI.
 *
 * @public
 * `tui/launcher.ts` loads this module via `await import("./app")` so OpenTUI's preload hook can
 * register before SolidJS renders — a static import would pull in the JSX runtime too early.
 * Knip cannot trace dynamic imports; this export is not dead.
 */
export function startTUI(options: TUIOptions = {}): Promise<void> {
  const mode = options.mode ?? "dark"
  const projectCwd = options.projectCwd ?? process.env.FLYWHEEL_PROJECT_CWD ?? process.cwd()

  // Load config (best-effort) for display settings
  let themeName: string | undefined
  let showThinking = true
  let engineName = ""
  let modelName = ""
  let openaiAuth: "api_key" | "chatgpt" = "api_key"
  let openaiEmail: string | undefined
  try {
    const configPath = findConfigFile()
    const { config } = loadConfig(configPath)
    themeName = config.theme
    showThinking = config.show_thinking
    const engine = getEngine(config.engine)
    engineName = engine.metadata.id === "harness" ? "" : engine.metadata.name
    modelName = resolveTierConfigs(config).worker.model
    openaiAuth = config.openai_auth
    openaiEmail = config.openai_email
  } catch (err) {
    Log.Default.warn("config load failed (non-fatal, using defaults)", { error: errorMessage(err) })
  }

  // Promise with async executor: ExitProvider must live inside the Solid render
  // tree (needs useRenderer()), so we can't use top-level async/await here.
  return new Promise<void>(async (resolve) => {
    if (openaiAuth === "chatgpt") {
      const { loadStoredTokens } = await import("../infra/auth/openai-token-store.js")
      if (!loadStoredTokens()) {
        const { startBrowserFlow } = await import("../orchestration/auth/openai-oauth.js")
        console.log("No ChatGPT tokens found. Opening browser to authenticate...")
        await startBrowserFlow(openaiEmail)
      }
    }

    const onExit = () => {
      resolve()
    }

    const { OpenTUIAdapter } = await import("./adapters/opentui")
    const createAdapter: CreateWorkflowAdapter = (opts) => new OpenTUIAdapter(opts)

    // Lazy import FlywheelShell to ensure OpenTUI preload has registered
    const { FlywheelShell } = await import("./shell")

    const manager = createSessionManager({ baseDir: projectCwd })
    manager.recoverStaleSessions()

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
                  <FlywheelShell createAdapter={createAdapter} projectCwd={projectCwd} showThinking={showThinking} engineName={engineName} modelName={modelName} />
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
        openConsoleOnError: false,
        consoleOptions: {
          keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
          onCopySelection: (text) => {
            Clipboard.copy(text).catch((error) => {
              Log.create({ service: "app" }).error("clipboard copy failed", { error: errorMessage(error) })
            })
          },
        },
      },
    )
  })
}

function ExitProvider(props: ParentProps<{ onExit: () => void }>) {
  const renderer = useRenderer()

  setExitHandler(() => {
    renderer.destroy()
    props.onExit()
  })

  return props.children
}
