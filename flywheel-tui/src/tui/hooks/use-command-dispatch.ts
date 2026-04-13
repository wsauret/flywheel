import type { Accessor } from "solid-js"
import { exitTUI } from "../exit.js"
import { createCommandRegistry } from "../../orchestration/command-registry.js"
import type { AnyBlock } from "../../infra/output-blocks.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export interface CommandDispatchDeps {
  signals: ShellSignals
  services: ShellServices
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

export interface CommandDispatchHook {
  handlePromptSubmit(text: string): void
}

const CHAT_CONTEXT_MAX_CHARS = 2000

function extractChatContext(blocks: readonly AnyBlock[]): string | undefined {
  const lines: string[] = []
  let chars = 0
  for (let i = blocks.length - 1; i >= 0 && chars < CHAT_CONTEXT_MAX_CHARS; i--) {
    const block = blocks[i]!
    if (block.kind === "userMessage" && !block.injected) {
      lines.unshift(`User: ${block.content}`)
      chars += block.content.length + 6
    } else if (block.kind === "text") {
      lines.unshift(`Assistant: ${block.content}`)
      chars += block.content.length + 11
    }
  }
  if (lines.length === 0) return undefined
  let result = lines.join("\n")
  if (result.length > CHAT_CONTEXT_MAX_CHARS) {
    result = result.slice(result.length - CHAT_CONTEXT_MAX_CHARS)
    const firstNewline = result.indexOf("\n")
    if (firstNewline > 0) result = result.slice(firstNewline + 1)
  }
  return result
}

export function useCommandDispatch(deps: CommandDispatchDeps): CommandDispatchHook {
  const commandRegistry = createCommandRegistry()

  function getChatContext(): string | undefined {
    const fgId = deps.signals.foregroundId()
    if (!fgId || !deps.inChat()) return undefined
    const entry = deps.services.sessionStore.get(fgId)
    if (!entry) return undefined
    return extractChatContext(entry.outputBlocks)
  }

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

  // Bare /work or /sprint — enter pending mode, wait for description
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

    // Pending work mode: next submission is the task description
    const pending = deps.signals.pendingWorkCommand()
    if (pending) {
      // Slash commands cancel pending mode and dispatch normally
      if (trimmed.startsWith("/")) {
        deps.signals.setPendingWorkCommand(undefined)
      } else {
        deps.signals.setPendingWorkCommand(undefined)
        const ctx = getChatContext()
        if (deps.inChat()) deps.backgroundChat()
        deps.startWorkflow(pending, trimmed, ctx)
        return
      }
    }

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
