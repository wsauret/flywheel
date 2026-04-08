import type { Accessor } from "solid-js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { AgentState, SessionStatus } from "./use-workflow-lifecycle.js"
import { exitTUI } from "../exit.js"
import { createCommandRegistry } from "./command-registry.js"

export interface CommandDispatchDeps {
  agentState: Accessor<AgentState>
  sessionStatus: Accessor<SessionStatus>
  setAgentState: (state: AgentState) => void
  setSessionStatus: (status: SessionStatus) => void
  foregroundId: Accessor<string | undefined>
  inChat: Accessor<boolean>
  registry: SessionRegistry
  startWorkflow: (command: string, description: string) => Promise<void>
  startTestStep: (stepId?: string) => Promise<void>
  startChat: (initialMessage?: string) => Promise<void>
  backgroundChat: () => void
  endChat: () => void
  sendMessage: (text: string) => void
  handleResume: (sessionIdArg?: string) => Promise<void>
  openSessionsModal: () => void
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
    pattern: /^\/(work|plan|review|debug|research|sprint)\s+"([^"]+)"$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|plan|review|debug|research|sprint)\s+(.+)$/i,
    execute(match) { deps.startWorkflow(match[1], match[2]); return true },
  })

  function handlePromptSubmit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    // Chat session: slash commands go through the registry, free text goes to chat
    if (deps.inChat()) {
      if (trimmed === "/exit" || trimmed === "/quit") { deps.endChat(); exitTUI(); return }
      if (trimmed === "/new") { deps.backgroundChat(); deps.startChat(); return }
      // Try command registry for slash commands (e.g. /work, /sessions, /resume)
      if (trimmed.startsWith("/")) {
        void commandRegistry.dispatch(trimmed).then((handled) => {
          if (!handled) {
            deps.showToast({ message: `Unknown command: ${trimmed.split(/\s/)[0]}`, variant: "warning" })
          }
        })
        return
      }
      deps.sendMessage(trimmed)
      return
    }

    // Workflow session: non-command text steers the worker or resumes from pause
    if (deps.sessionStatus() === "running" || deps.sessionStatus() === "paused") {
      const fgId = deps.foregroundId()
      if (fgId && !trimmed.startsWith("/")) {
        if (deps.sessionStatus() === "paused") {
          deps.registry.cancelShutdown(fgId)
          deps.setAgentState("active")
          deps.setSessionStatus("running")
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

      if (deps.sessionStatus() === "paused") {
        deps.showToast({ message: "Session paused. Esc to stop, Ctrl+R to resume, or /sessions to switch.", variant: "warning" })
      } else {
        deps.showToast({ message: `Unknown command. Try /new, /sessions, /sprint "desc", /work "desc", or /exit`, variant: "warning" })
      }
    })
  }

  return { handlePromptSubmit }
}
