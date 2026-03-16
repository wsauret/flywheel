/** @jsxImportSource @opentui/solid */
/**
 * TUI Application Entry Point
 *
 * Copies OpenCode's lifecycle exactly:
 * 1. startTUI() returns new Promise<void> that blocks until exit
 * 2. render() fires the Solid tree with an ExitProvider
 * 3. ExitProvider uses useRenderer() to get the renderer from INSIDE the tree
 * 4. When exit is triggered, it calls renderer.destroy() then resolve()
 * 5. The promise resolves, caller continues, process.exit() runs
 */

import { render } from "@opentui/solid"
import { useRenderer } from "@opentui/solid"
import { ErrorBoundary } from "solid-js"
import type { ParentProps } from "solid-js"
import { ToastProvider } from "@tui/shared/context/toast"
import { ThemeProvider } from "@tui/shared/context/theme"
import { ErrorComponent } from "./components/error-boundary"

export interface TUIOptions {
  mode?: "dark" | "light"
}

// Global exit function — set by ExitProvider inside the Solid tree
let globalExit: (() => void) | null = null

export function startTUI(options: TUIOptions = {}): Promise<void> {
  const mode = options.mode ?? "dark"

  return new Promise<void>(async (resolve) => {
    const onExit = () => {
      resolve()
    }

    // Lazy import FlywheelShell to ensure OpenTUI preload has registered
    const { FlywheelShell } = await import("./components/flywheel-shell")

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
              <ThemeProvider mode={mode}>
                <FlywheelShell />
              </ThemeProvider>
            </ToastProvider>
          </ExitProvider>
        </ErrorBoundary>
      ),
      {
        targetFps: 30,
        gatherStats: false,
        exitOnCtrlC: false,
      },
    )
  })
}

/**
 * Exit the TUI. Calls renderer.destroy() from inside the Solid tree
 * (via the ExitProvider), then resolves the startTUI() promise.
 */
export function exitTUI(): void {
  if (globalExit) {
    globalExit()
    globalExit = null
  }
}

/**
 * ExitProvider — exactly like OpenCode's.
 * Uses useRenderer() to access the renderer from inside the Solid tree.
 */
function ExitProvider(props: ParentProps<{ onExit: () => void }>) {
  const renderer = useRenderer()

  // Register the global exit function
  globalExit = () => {
    renderer.destroy()
    props.onExit()
  }

  return props.children
}
