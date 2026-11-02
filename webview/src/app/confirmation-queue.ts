import { createSignal, onCleanup } from "solid-js"
import type { ConfirmRequest } from "./client-context.js"

interface Confirmation {
  readonly request: ConfirmRequest
  readonly settle: (confirmed: boolean) => void
}

/** Presents one confirmation at a time in arrival order. Abort or owner disposal resolves false. */
export function createConfirmationQueue() {
  const [pending, setPending] = createSignal<readonly Confirmation[]>([])
  let disposed = false
  onCleanup(() => {
    disposed = true
    for (const confirmation of pending()) confirmation.settle(false)
  })
  const confirm = (request: ConfirmRequest, signal?: AbortSignal): Promise<boolean> => new Promise((resolve) => {
    if (disposed || signal?.aborted) { resolve(false); return }
    let settled = false
    const settle = (confirmed: boolean): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", cancel)
      setPending((requests) => requests.filter((entry) => entry.settle !== settle))
      resolve(confirmed)
    }
    const cancel = (): void => settle(false)
    signal?.addEventListener("abort", cancel, { once: true })
    setPending((requests) => [...requests, { request, settle }])
  })
  return { current: () => pending()[0], confirm }
}
