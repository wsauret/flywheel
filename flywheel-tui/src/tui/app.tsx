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
import { getEngine } from "../orchestration/engines/core/registry.js"
import type { WorkflowSessionFactories } from "../orchestration/session-store-types.js"
import { CONFIG_FILES } from "../infra/paths.js"
import * as fs from "node:fs"
import { setExitHandler } from "./exit.js"

export interface TUIOptions {
  mode?: "dark" | "light"
  projectCwd?: string
}

export function startTUI(options: TUIOptions = {}): Promise<void> {
  const mode = options.mode ?? "dark"
  const projectCwd = options.projectCwd ?? process.env.FLYWHEEL_PROJECT_CWD ?? process.cwd()

  // Load config (best-effort) for display settings
  let themeName: string | undefined
  let showThinking = true
  let engineName = ""
  try {
    const configPath = CONFIG_FILES.find((p) => fs.existsSync(p))
    const { config } = loadConfig(configPath)
    themeName = config.theme
    showThinking = config.show_thinking
    engineName = getEngine(config.engine).metadata.name
    if (config.openai_auth && !process.env["FLYWHEEL_OPENAI_AUTH"]) {
      process.env["FLYWHEEL_OPENAI_AUTH"] = config.openai_auth
    }
  } catch {
    // Config load failure is non-fatal
  }

  // Promise with async executor: ExitProvider must live inside the Solid render
  // tree (needs useRenderer()), so we can't use top-level async/await here.
  return new Promise<void>(async (resolve) => {
    if (process.env["FLYWHEEL_OPENAI_AUTH"] === "chatgpt") {
      const { loadStoredTokens } = await import("../infra/auth/openai-token-store.js")
      if (!loadStoredTokens()) {
        const { startBrowserFlow } = await import("../orchestration/auth/openai-oauth.js")
        const { loadConfig: lc } = await import("../orchestration/config/loader.js")
        const cp = CONFIG_FILES.find((p) => fs.existsSync(p))
        const email = cp ? lc(cp).config.openai_email : undefined
        console.log("No ChatGPT tokens found. Opening browser to authenticate...")
        await startBrowserFlow(email)
      }
    }

    const onExit = () => {
      resolve()
    }

    const { OpenTUIAdapter } = await import("./adapters/opentui")
    const factories: WorkflowSessionFactories = {
      createAdapter: (opts) => new OpenTUIAdapter(opts),
    }

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
                  <FlywheelShell factories={factories} projectCwd={projectCwd} showThinking={showThinking} engineName={engineName} />
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
