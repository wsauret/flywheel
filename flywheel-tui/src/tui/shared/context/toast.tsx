/** @jsxImportSource solid-js */
import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper.js"

export type ToastVariant = "success" | "error" | "info" | "warning"

type ToastMessage = {
  message: string
  variant: ToastVariant
}

type ToastOptions = ToastMessage & {
  duration?: number
}

export const { use: useToast, provider: ToastProvider } = createSimpleContext({
  name: "Toast",
  init: () => {
    const [current, setCurrent] = createSignal<ToastMessage | null>(null)
    let timeoutHandle: NodeJS.Timeout | null = null

    return {
      get current() {
        return current()
      },
      show(options: ToastOptions) {
        const { duration = 3000, ...rest } = options
        setCurrent(rest)

        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (duration > 0) {
          timeoutHandle = setTimeout(() => setCurrent(null), duration)
        }
      },
    }
  },
})
