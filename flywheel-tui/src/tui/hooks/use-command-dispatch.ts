import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import { createCommandRegistry } from "../../orchestration/command-registry.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export interface CommandDispatchDeps {
  signals: ShellSignals
  services: ShellServices
  inChat: Accessor<boolean>
  startWorkflow: (command: string, description: string) => void
  startTestStep: (stepId?: string) => void
  startChat: (initialMessage?: string) => Promise<void>
  backgroundChat: () => void
  endChat: () => void
  sendMessage: (text: string) => void
  handleResume: (sessionIdArg?: string) => Promise<void>
  /** Steer a running workflow by injecting a user message. */
  steerWorkflow: (text: string) => boolean
  openSessionsModal: () => void
}

export interface CommandDispatchHook {
  handlePromptSubmit(text: string): void
}

export function useCommandDispatch(deps: CommandDispatchDeps): CommandDispatchHook {
  const commandRegistry = createCommandRegistry()

  commandRegistry.register({
    pattern: /^\/(?:exit|quit)$/i,
    execute() {
      if (deps.inChat()) deps.endChat()
      exitTUI()
      return true
    },
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
    pattern: /^\/new$/i,
    execute() {
      deps.backgroundChat()
      deps.startChat()
      return true
    },
  })

  commandRegistry.register({
    pattern: /^\/test(?:\s+(\S+))?$/i,
    execute(match) {
      deps.startTestStep(match[1] ?? undefined)
      return true
    },
  })

  commandRegistry.register({
    pattern: /^\/(work|sprint)\s+"([^"]+)"$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|sprint)\s+(.+)$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  function handlePromptSubmit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    // Chat session: slash commands go through the registry, free text goes to chat
    if (deps.inChat()) {
      if (trimmed.startsWith("/")) {
        void commandRegistry.dispatch(trimmed).then((handled) => {
          if (!handled) {
            deps.services.showToast({ message: `Unknown command: ${trimmed.split(/\s/)[0]}`, variant: "warning" })
          }
        })
        return
      }
      deps.sendMessage(trimmed)
      return
    }

    // Workflow session: non-command text steers the worker or resumes from pause
    const state = deps.signals.sessionState()
    if (state === "active" || state === "paused") {
      if (deps.signals.foregroundId() && !trimmed.startsWith("/")) {
        const injected = deps.steerWorkflow(trimmed)
        if (injected) {
          deps.services.showToast({ message: "Message sent to worker", variant: "info" })
        } else {
          deps.services.showToast({ message: "Could not deliver message \u2014 worker pipe closed", variant: "warning" })
        }
        return
      }
    }

    void commandRegistry.dispatch(trimmed).then((handled) => {
      if (handled) return

      if (deps.signals.sessionState() === "paused") {
        deps.services.showToast({ message: "Session paused. Esc to stop, Ctrl+R to resume, or /sessions to switch.", variant: "warning" })
      } else {
        deps.services.showToast({ message: `Unknown command. Try /new, /sessions, /sprint "desc", /work "desc", or /exit`, variant: "warning" })
      }
    })
  }

  return { handlePromptSubmit }
}
