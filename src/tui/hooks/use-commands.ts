import { createEffect, createRoot, getOwner } from "solid-js"
import { normalizeChatInput, type ChatInput, type ChatInputLike } from "../../infra/chat-input.js"
import type { CommandDispatch } from "../commands/command-dispatch.js"
import { createAsyncReporter } from "./report-async.js"
import type { ComposerSubmitResult } from "../components/composer-types.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { OpenSettingsDestination } from "../settings-destination.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"
import type { SessionCreator } from "./create-session-creator.js"
import { NO_PROVIDER_READY, settledProviderSetup, type ProviderSetup } from "../../protocol/client/provider-setup.js"

export interface CommandDeps {
  signals: Pick<ShellSignals, "foregroundId" | "foregroundTarget">
  dispatch: CommandDispatch
  showToast: ShellServices["showToast"]
  sendMessage: (sessionId: string, input: ChatInput) => Promise<void>
  startChat: SessionCreator["startChat"]
  openSettingsDestination: OpenSettingsDestination
  /** Reactive: a send waits while this is "loading". */
  providerSetup: () => ProviderSetup
  /** Opens required paid-capacity review at a safe foreground boundary. */
  openSubscriptionSpendReview: () => boolean
}

export interface CommandsHook {
  /** Answers false when no command or session delivery path took the input,
   *  so local routing cannot swallow it. A command answers with its pending
   *  acceptance, and the prompt gets the input back when the command refuses it. */
  handleComposerSubmit: (rawInput: ChatInputLike) => ComposerSubmitResult
}

/** Owns prompt-submission routing after built-in execution is bound by definitions. */
export function useCommands(deps: CommandDeps): CommandsHook {
  const runAsync = createAsyncReporter(deps.showToast)
  const owner = getOwner()

  /** Resolves when the runtime has published the auth view, normally a few
   *  frames after startup or a tab switch. The watch ends with the wait. */
  function providerSetupKnown(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      createRoot((dispose) => {
        signal.addEventListener("abort", dispose, { once: true })
        createEffect(() => {
          if (deps.providerSetup() !== "loading") resolve()
        })
      }, owner)
    })
  }

  function contextSessionId(): string | undefined {
    return deps.signals.foregroundId()
  }


  /** Paid-use review and the provider check both read the auth view, so a
   *  send made before the runtime publishes it is decided when it arrives.
   *  Deciding early would treat "not known yet" as "usable". */
  function handleChatInput(input: ChatInput): ComposerSubmitResult {
    const sessionId = contextSessionId()
    if (deps.providerSetup() !== "loading") return deliverChatInput(input, sessionId)
    return { accepted: settledProviderSetup(deps.providerSetup, providerSetupKnown).then(() => deliverChatInput(input, sessionId)) }
  }

  function deliverChatInput(input: ChatInput, sessionId: string | undefined): boolean {
    const automatic = automaticDialogsEnabled()
    if (automatic && deps.openSubscriptionSpendReview()) return false
    if (deps.providerSetup() === "none") {
      deps.showToast({ message: `${NO_PROVIDER_READY}; ${automatic ? "opening" : "use"} /auth`, variant: "warning" })
      if (automatic) runAsync(() => deps.openSettingsDestination({ kind: "auth" }))
      return false
    }
    if (!sessionId) {
      // Composer must clear the accepted buffer before creation changes its
      // draft owner. The creator retains failed initial messages for recall.
      runAsync(async () => { await Promise.resolve(); await deps.startChat(input) })
      return true
    }
    runAsync(() => deps.sendMessage(sessionId, input))
    return true
  }

  function handleComposerSubmit(rawInput: ChatInputLike): ComposerSubmitResult {
    const input = normalizeChatInput(rawInput)
    const trimmed = input.text.trim()
    if (!trimmed && !input.attachments?.length) return false
    const isSlashCommand = trimmed.startsWith("/") && !input.attachments?.length

    if (!isSlashCommand && deps.signals.foregroundTarget()?.kind === "pending") {
      deps.showToast({ message: "Chat is still opening; your message stays in the prompt", variant: "warning" })
      return false
    }

    if (isSlashCommand) return { accepted: deps.dispatch.dispatch(trimmed) }

    return handleChatInput(input)
  }

  return { handleComposerSubmit }
}
