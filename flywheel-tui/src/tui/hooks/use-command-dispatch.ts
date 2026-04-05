import type { Accessor } from "solid-js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { AppState } from "./use-workflow-lifecycle.js"
import { exitTUI } from "../app.js"
import { createCommandRegistry } from "./command-registry.js"

export interface CommandDispatchDeps {
  appState: Accessor<AppState>
  setAppState: (state: AppState) => void
  foregroundId: Accessor<string | undefined>
  registry: SessionRegistry
  startWorkflow: (command: string, description: string) => Promise<void>
  startChat: (initialMessage?: string) => Promise<void>
  endChat: () => void
  sendMessage: (text: string) => void
  handleResume: (sessionIdArg?: string) => Promise<void>
  openSessionsModal: () => void
  startTimer: () => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export interface CommandDispatchHook {
  handlePromptSubmit(text: string): void
}

export function useCommandDispatch(deps: CommandDispatchDeps): CommandDispatchHook {
  const commandRegistry = createCommandRegistry()

  commandRegistry.register({
    pattern: /^\/(?:exit|quit)$/i,
    execute() { exitTUI(); return true },
  })

  commandRegistry.register({
    pattern: /^\/sessions$/i,
    execute() { deps.openSessionsModal(); return true },
  })

  commandRegistry.register({
    pattern: /^\/resume(?:\s+(.+))?$/i,
    execute(match) {
      deps.handleResume(match[1] ?? undefined)
      return true
    },
  })

  commandRegistry.register({
    pattern: /^\/chat(?:\s+(.+))?$/i,
    execute(match) {
      deps.startChat(match[1] ?? undefined)
      return true
    },
  })

  commandRegistry.register({
    pattern: /^\/start\s+(\w+)\s+"([^"]+)"$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  commandRegistry.register({
    pattern: /^\/start\s+(\w+)\s+(.+)$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|plan|review|debug|research)\s+"([^"]+)"$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|plan|review|debug|research)\s+(.+)$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  function handlePromptSubmit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    if (deps.appState() === "chatting") {
      if (trimmed === "/exit" || trimmed === "/quit") { deps.endChat(); exitTUI(); return }
      if (trimmed === "/end" || trimmed === "/stop") { deps.endChat(); return }
      deps.sendMessage(trimmed)
      return
    }

    if (deps.appState() === "working" || deps.appState() === "paused") {
      const fgId = deps.foregroundId()
      if (fgId && !trimmed.startsWith("/")) {
        if (deps.appState() === "paused") {
          deps.registry.cancelShutdown(fgId)
          deps.startTimer()
          deps.setAppState("working")
        }
        const injected = deps.registry.injectMessage(fgId, trimmed)
        if (injected) {
          deps.showToast({ message: "Message sent to worker", variant: "info" })
        } else {
          deps.showToast({ message: "Could not deliver message — worker pipe closed", variant: "warning" })
        }
        return
      }
    }

    void commandRegistry.dispatch(trimmed).then((handled) => {
      if (handled) return

      if (deps.appState() === "paused") {
        deps.showToast({ message: "Session paused. Esc to stop, Ctrl+R to resume, or /sessions to switch.", variant: "warning" })
      } else {
        deps.showToast({ message: `Unknown command. Try /chat, /sessions, /start work "desc", or /exit`, variant: "warning" })
      }
    })
  }

  return { handlePromptSubmit }
}
