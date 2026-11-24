import type { InternalProcessEndpoint } from "./internal-process-channel.js"

/** An endpoint whose live transport can be replaced without its users
 *  noticing. A closed socket says only that a socket closed; the peer process
 *  may be perfectly alive. So a lost transport detaches instead of closing:
 *  sends wait for the next transport, message and close handlers stay
 *  registered, and only the deadline passing with nothing reattached, or an
 *  explicit close, ends the endpoint. Every close carries its cause. */
export interface ReattachableProcessEndpoint<Outgoing, Incoming> extends InternalProcessEndpoint<Outgoing, Incoming> {
  /** Binds a live transport. A transport still attached is closed as superseded. */
  attach(live: InternalProcessEndpoint<Outgoing, Incoming>): void
  /** True while a live transport carries messages. */
  readonly attached: boolean
  /** The live transport closed while this endpoint stays open. Requests in
   *  flight on the lost transport have an unknown outcome; protocol layers
   *  fail them here rather than letting them wait forever. */
  onDetach(handler: (reason: Error) => void): () => void
  /** A new transport carries messages again. Protocol layers resynchronize here. */
  onReattach(handler: () => void): () => void
}

export function createReattachableProcessEndpoint<Outgoing, Incoming>(options: {
  /** How long a detached endpoint waits for a new transport before it closes. */
  readonly reattachDeadlineMs: number
  /** Arms the reattach deadline and returns what cancels it. */
  readonly setTimer?: (fire: () => void, delayMs: number) => () => void
}): ReattachableProcessEndpoint<Outgoing, Incoming> {
  const setTimer = options.setTimer ?? ((fire: () => void, delayMs: number) => {
    const timer = setTimeout(fire, delayMs)
    return () => clearTimeout(timer)
  })
  const messages = new Set<(message: Incoming) => void | Promise<void>>()
  const closes = new Set<(reason: Error) => void>()
  const detaches = new Set<(reason: Error) => void>()
  const reattaches = new Set<() => void>()
  const closed = Promise.withResolvers<void>()
  const waiters = new Set<{ resolve: () => void; reject: (reason: Error) => void }>()
  let live: InternalProcessEndpoint<Outgoing, Incoming> | undefined
  const attached = (): boolean => live !== undefined
  let unbind = (): void => {}
  let reason: Error | undefined
  let cancelDeadline: (() => void) | undefined
  let detachedReason: Error | undefined

  const close = (cause: string): void => {
    if (reason) return
    reason = new Error(cause)
    cancelDeadline?.()
    cancelDeadline = undefined
    const transport = live
    live = undefined
    unbind()
    transport?.close(cause)
    for (const waiter of waiters) waiter.reject(reason)
    waiters.clear()
    for (const handler of closes) handler(reason)
    messages.clear()
    closes.clear()
    detaches.clear()
    reattaches.clear()
    closed.resolve()
  }

  const detach = (transport: InternalProcessEndpoint<Outgoing, Incoming>, cause: Error): void => {
    if (reason || live !== transport) return
    live = undefined
    unbind()
    detachedReason = cause
    cancelDeadline = setTimer(() => {
      cancelDeadline = undefined
      close(`internal process endpoint was not reattached within ${options.reattachDeadlineMs}ms: ${cause.message}`)
    }, options.reattachDeadlineMs)
    for (const handler of detaches) handler(cause)
  }

  return {
    closed: closed.promise,
    get attached() {
      return attached()
    },
    attach(transport) {
      if (reason) {
        transport.close(reason.message)
        return
      }
      const superseded = live
      unbind()
      live = transport
      cancelDeadline?.()
      cancelDeadline = undefined
      const wasDetached = detachedReason !== undefined
      detachedReason = undefined
      const stopMessages = transport.onMessage((message) => {
        if (live !== transport) return
        for (const handler of Array.from(messages)) void handler(message)
      })
      const stopClose = transport.onClose((cause) => detach(transport, cause))
      unbind = () => {
        stopMessages()
        stopClose()
        unbind = () => {}
      }
      superseded?.close("internal process endpoint superseded by a reattached transport")
      for (const waiter of waiters) waiter.resolve()
      waiters.clear()
      if (wasDetached) for (const handler of reattaches) handler()
    },
    async send(message) {
      while (!attached()) {
        // oxlint-disable-next-line eslint/no-throw-literal -- boundary: `reason` is the Error this endpoint latched at close; every later send reports the same one.
        if (reason) throw reason
        await new Promise<void>((resolve, reject) => { waiters.add({ resolve, reject }) })
      }
      if (!live) throw new Error("internal process endpoint lost its transport while sending")
      return live.send(message)
    },
    onMessage(handler) {
      if (!reason) messages.add(handler)
      return () => { messages.delete(handler) }
    },
    onClose(handler) {
      if (reason) handler(reason)
      else closes.add(handler)
      return () => { closes.delete(handler) }
    },
    onDetach(handler) {
      if (!reason) detaches.add(handler)
      return () => { detaches.delete(handler) }
    },
    onReattach(handler) {
      if (!reason) reattaches.add(handler)
      return () => { reattaches.delete(handler) }
    },
    close(cause = "internal process endpoint closed") {
      close(cause)
    },
  }
}
