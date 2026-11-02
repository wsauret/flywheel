import type { ChatInputLike } from "../../infra/chat-input.js"

/** Applies the shared first-row Up rule. Local pending input precedes runtime
 * recall; only the main composer supplies a history fallback. */
export function recallOnUp(input: {
  readonly ready: boolean
  readonly row: number
  readonly text: string
  readonly active: boolean
  readonly preventDefault?: () => void
  readonly local?: () => { readonly kind: "input"; readonly input: ChatInputLike } | { readonly kind: "waiting" } | null
  readonly queued?: () => ChatInputLike | null | Promise<ChatInputLike | null>
  readonly restore: (input: ChatInputLike) => void
  readonly settle: (input: ChatInputLike | null | Promise<ChatInputLike | null>) => void
  readonly history?: () => void
}): boolean {
  if (!input.ready || input.row !== 0 || input.text.startsWith("/")) return false
  if (input.text.length > 0 && !input.history) return false
  input.preventDefault?.()
  if (input.text.length === 0) {
    const local = input.local?.()
    if (local?.kind === "input") { input.restore(local.input); return true }
    if (local?.kind === "waiting") return true
    const queued = input.active ? input.queued?.() : null
    if (queued) { input.settle(queued); return true }
  }
  input.history?.()
  return true
}
