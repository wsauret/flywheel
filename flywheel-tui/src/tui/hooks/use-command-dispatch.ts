import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import { createCommandRegistry } from "../../orchestration/command-registry.js"
import { extractChatContext } from "../../orchestration/session-actions.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"
import type { SessionStore } from "../../orchestration/session-store-types.js"

interface CommandDispatchDeps {
  signals: ShellSignals
  sessionStore: SessionStore
  showToast: ShellServices["showToast"]
  inChat: Accessor<boolean>
  startWorkflow: (command: string, description: string, chatContext?: string) => void
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

export function useCommandDispatch(deps: CommandDispatchDeps) {
  const commandRegistry = createCommandRegistry()

  function getChatContext(): string | undefined {
    const fgId = deps.signals.foregroundId()
    if (!fgId || !deps.inChat()) return undefined
    const entry = deps.sessionStore.get(fgId)
    if (!entry) return undefined
    return extractChatContext(entry.outputBlocks)
  }

  commandRegistry.register({
    pattern: /^\/help$/i,
    execute() {
      deps.showToast({
        message: "/new /work /sprint /sessions /resume /exit · Esc interrupt · Ctrl+N new · Ctrl+B sessions · Tab switch",
        variant: "info",
        duration: 8000,
      })
      return true
    },
  })

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
    execute(match) { deps.startWorkflow(match[1], match[2], getChatContext()); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|sprint)\s+(.+)$/i,
    execute(match) { deps.startWorkflow(match[1], match[2], getChatContext()); return true },
  })

  commandRegistry.register({
    pattern: /^\/(work|sprint)$/i,
    execute(match) {
      deps.signals.setPendingWorkCommand(match[1])
      return true
    },
  })

  function handlePromptSubmit(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return

    const pending = deps.signals.pendingWorkCommand()
    if (pending) {
      deps.signals.setPendingWorkCommand(undefined)
      if (!trimmed.startsWith("/")) {
        const ctx = getChatContext()
        if (deps.inChat()) deps.backgroundChat()
        deps.startWorkflow(pending, trimmed, ctx)
        return
      }
    }

    if (deps.inChat()) {
      if (trimmed.startsWith("/")) {
        void commandRegistry.dispatch(trimmed).then((handled) => {
          if (!handled) {
            deps.showToast({ message: `Unknown command. Try /help`, variant: "warning" })
          }
        })
        return
      }
      deps.sendMessage(trimmed)
      return
    }

    const state = deps.signals.sessionState()
    if (state === "active" || state === "paused") {
      if (deps.signals.foregroundId() && !trimmed.startsWith("/")) {
        const injected = deps.steerWorkflow(trimmed)
        if (injected) {
          deps.showToast({ message: "Message sent to worker", variant: "info" })
        } else {
          deps.showToast({ message: "Could not deliver message \u2014 worker pipe closed", variant: "warning" })
        }
        return
      }
    }

    void commandRegistry.dispatch(trimmed).then((handled) => {
      if (handled) return

      if (deps.signals.sessionState() === "paused") {
        deps.showToast({ message: "Session paused. Esc to stop, Ctrl+R to resume, or /sessions to switch.", variant: "warning" })
      } else {
        deps.showToast({ message: `Unknown command. Try /help`, variant: "warning" })
      }
    })
  }

  return { handlePromptSubmit }
}
