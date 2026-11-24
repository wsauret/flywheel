import type { PresentationChannel, PresentationIdOn } from "../../infra/error-presentation.js"
import type { PresentationResult } from "../../infra/desktop-notify.js"

interface ToastDisplay {
  message: string
  variant: "info" | "warning" | "error" | "success"
  duration?: number
}

export interface ToastOptions extends ToastDisplay {
  /** Dedup identity within the family, presenter-internal and never
   *  forwarded to the toast surface. Defaults to the message, so an
   *  unchanged fact re-toasts nothing; pass a composed key when the same
   *  message is news again in a new context (another session, for one). */
  dedupeKey?: string
}

type ToastPresentation = PresentationIdOn<Extract<PresentationChannel, "toast">>
type ToastSink = (options: ToastDisplay) => void | PresentationResult

function isPresentationResult(value: unknown): value is PresentationResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false
  const kind = value.kind
  return kind === "accepted" || kind === "skipped-by-policy" || kind === "failed"
}

/** The toast-channel presenter for unsolicited TUI-local facts.
 *
 *  Every call names its registered family, which is the enforcement seam:
 *  re-registering a family on another channel fails to compile at these call
 *  sites, forcing real rewiring instead of a silent second surface. Direct
 *  feedback to a command the user just issued stays with plain `showToast`
 *  and never registers.
 *
 *  Presentation is deduplicated per family against the last shown key, so a
 *  reactive source that re-emits an unchanged degradation does not stack
 *  toasts; `reset` re-arms a family whose context moved on. */
export function createToastPresenter(showToast: ToastSink, config: { readonly presentationCapable?: () => boolean } = {}) {
  const lastShownByFamily = new Map<ToastPresentation, string>()
  const presentDisplay = (display: ToastDisplay): PresentationResult => {
    if (config.presentationCapable && !config.presentationCapable()) return { kind: "failed", error: "Toast presentation requires a presentation-capable TTY" }
    try {
      const result = showToast(display)
      return isPresentationResult(result) ? result : { kind: "accepted" }
    } catch (cause) {
      return { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  return {
    present(presentation: ToastPresentation, toastOptions: ToastOptions): PresentationResult {
      const { dedupeKey, ...display } = toastOptions
      const key = dedupeKey ?? display.message
      if (lastShownByFamily.get(presentation) === key) return { kind: "skipped-by-policy" }
      const result = presentDisplay(display)
      if (result.kind === "accepted") lastShownByFamily.set(presentation, key)
      return result
    },
    /** Present a durable alert without assigning it a local presentation family. */
    presentUntracked(toastOptions: ToastOptions): PresentationResult {
      const display: ToastDisplay = { message: toastOptions.message, variant: toastOptions.variant, ...(toastOptions.duration === undefined ? {} : { duration: toastOptions.duration }) }
      return presentDisplay(display)
    },
    reset(presentation: ToastPresentation): void {
      lastShownByFamily.delete(presentation)
    },
  }
}
