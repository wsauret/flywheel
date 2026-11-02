import { pack } from "msgpackr"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "../../../../src/infra/internal-process-channel.js"
import type { FrontendEvent, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const PARKED_TIMER_MS = 2 ** 31 - 1

// Timers fire only through expireAll. Each handle is a real parked timer so
// the clock keeps the runtime's handle type without pretending.
export function manualClock() {
  const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>()
  return {
    clock: {
      setTimeout(callback: () => void) {
        const handle = setTimeout(() => {}, PARKED_TIMER_MS)
        handle.unref()
        callbacks.set(handle, callback)
        return handle
      },
      clearTimeout(timer: ReturnType<typeof setTimeout>) {
        clearTimeout(timer)
        callbacks.delete(timer)
      },
    },
    expireAll() {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [handle] of pending) clearTimeout(handle)
      for (const [, expire] of pending) expire()
    },
    pendingTimers: () => callbacks.size,
  }
}

export function endpointPair(): readonly [InternalProcessEndpoint<unknown, unknown>, InternalProcessEndpoint<unknown, unknown>] {
  const channel = new MessageChannel()
  return [
    createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value }),
    createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value }),
  ]
}

/** A patch the tests use to mark a place in the event order. */
export function markerEvent(position: number): FrontendEvent {
  return { type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position, prevPosition: position - 1, payload: { kind: "executor.changed", executor: { kind: "serving" } } } }
}

/** The marker's position, or undefined for any other event. */
export function markerPosition(event: FrontendEvent): number | undefined {
  return event.type === "patch" && event.patch.payload.kind === "executor.changed" ? event.patch.position : undefined
}

export async function deliverGaps(peer: InternalProcessEndpoint<unknown, unknown>, client: RuntimeClient, count: number) {
  const delivered = deferred<void>()
  const unsubscribe = client.subscribe(() => delivered.resolve())
  try {
    for (let index = 0; index < count; index += 1) await peer.send({ kind: "gap" })
    await peer.send({ kind: "events", frames: [pack(markerEvent(1))] })
    await delivered.promise
  } finally {
    unsubscribe()
  }
}

/** The correlation id of a request frame the client sent. */
export function requestFrame(value: unknown) {
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
    return { id: value.id }
  }
  throw new Error("expected a request frame")
}

/** The kind and message of a response frame the server sent. */
export function responseFrame(value: unknown) {
  if (typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string") {
    if ("message" in value && value.message !== undefined && typeof value.message !== "string") {
      throw new Error("expected a response frame")
    }
    return {
      kind: value.kind,
      ...("message" in value && typeof value.message === "string" ? { message: value.message } : {}),
    }
  }
  throw new Error("expected a response frame")
}

export function runtimeHarness() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  let closeCalls = 0
  const watches: (readonly string[])[] = []
  const runtime: RuntimeClient & { watchOutput(sessionIds: readonly string[]): void; hideSession(sessionId: string): Promise<void> } = {
    query: runtimeQuery({ commandUsageSnapshot: async () => ({ snapshotPosition: 7, usage: { uses: [{ name: "ship", count: 2 }] } }) }),
    dispatch: runtimeDispatch({ "session.close": async () => ({ ok: true, sessionRemoved: true }) }),
    watchOutput(sessionIds) {
      watches.push(sessionIds)
    },
    async hideSession() {},
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      closeCalls += 1
    },
  }
  return {
    runtime,
    /** Every output watch union the executor heard, in order. */
    watches,
    emit(event: FrontendEvent) {
      for (const listener of listeners) listener(event)
    },
    get closeCalls() {
      return closeCalls
    },
    get subscriptions() {
      return listeners.size
    },
  }
}
