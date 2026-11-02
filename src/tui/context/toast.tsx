/** @jsxImportSource solid-js */
import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper.js"

type ToastVariant = "success" | "error" | "info" | "warning"

type ToastMessage = {
  message: string
  variant: ToastVariant
}

type ToastOptions = ToastMessage & {
  duration?: number
}

export type ToastInput = ToastOptions | (() => ToastOptions | null)

/** How long a toast stays when its caller names no duration. A warning or an
 *  error states something the person must read and possibly act on, so it
 *  stays long enough to read a full sentence. */
const DEFAULT_DURATION_MS = { success: 3000, info: 3000, warning: 8000, error: 8000 } as const satisfies { readonly [V in ToastVariant]: number }

/** Single-toast display with extend-on-repeat dedupe: showing the same message and
 *  variant again extends the visible toast's remaining time instead of
 *  restarting it, so repeated notifications read as one longer toast. The
 *  toast lives as long as its owner, and disposing the owner ends its timer.
 *  Exported for unit tests; the provider below is the production consumer. */
export function createToastState() {
  const [input, setInput] = createSignal<ToastInput | null>(null)
  const current = (): ToastOptions | null => {
    const value = input()
    return typeof value === "function" ? value() : value
  }
  let timeoutHandle: NodeJS.Timeout | null = null
  let deadline = 0
  onCleanup(() => { if (timeoutHandle) clearTimeout(timeoutHandle) })

  const schedule = (duration: number) => {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = null
    if (duration > 0) {
      deadline = Date.now() + duration
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null
        setInput(null)
      }, duration)
    }
  }

  return {
    get current() {
      const value = current()
      return value ? { message: value.message, variant: value.variant } : null
    },
    /** Derived content stays live until replaced or timed out. Null content hides the toast. */
    show(options: ToastInput) {
      const value = typeof options === "function" ? options() : options
      const duration = value?.duration ?? (value === null ? 0 : DEFAULT_DURATION_MS[value.variant])
      const existing = current()
      if (typeof options !== "function" && typeof input() !== "function" && existing && timeoutHandle && duration > 0 && existing.message === options.message && existing.variant === options.variant) {
        schedule(Math.max(deadline - Date.now(), 0) + duration)
        return
      }
      setInput(() => options)
      schedule(duration)
    },
  }
}

export const { use: useToast, provider: ToastProvider } = createSimpleContext({
  name: "Toast",
  init: createToastState,
})
