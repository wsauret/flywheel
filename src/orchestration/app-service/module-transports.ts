import type { Layer } from "effect"
import type { SocketServer } from "effect/unstable/socket"
import { Log } from "../../infra/log.js"

/** A module supplies the transport adapter. The kernel serves the same RPC
 *  handlers over every adapter and counts every accepted client. */
type ModuleTransportListener = (onConnectionCountChanged: (count: number) => void) => Layer.Layer<SocketServer.SocketServer>
interface TransportServing {
  readonly ready: Promise<void>
  dispose(): Promise<void>
}
interface Registration {
  readonly listener: ModuleTransportListener
  serving?: TransportServing
  closing?: Promise<void>
}
export interface ModuleTransports {
  addListener(kind: string, listener: ModuleTransportListener): () => Promise<void>
  serve(start: (kind: string, listener: ModuleTransportListener) => TransportServing): Promise<void>
  dispose(): Promise<void>
}

/** Registrations can precede the protocol server, and live module selection
 *  can add or remove them later. Each registration has one awaited owner. */
export function createModuleTransports(): ModuleTransports {
  const log = Log.create({ service: "module-transports" })
  const entries = new Map<string, Registration>()
  let start: ((kind: string, listener: ModuleTransportListener) => TransportServing) | undefined
  let closed = false
  let settlement: Promise<void> | undefined
  const retire = (kind: string, entry: Registration): Promise<void> => {
    if (entries.get(kind) === entry) entries.delete(kind)
    entry.closing ??= Promise.resolve().then(() => entry.serving?.dispose())
    return entry.closing
  }
  const activate = (kind: string, entry: Registration): void => {
    if (!start) return
    entry.serving = start(kind, entry.listener)
    void entry.serving.ready.catch((error: unknown) => log.warn("module transport failed to serve", { kind, error: error instanceof Error ? error.message : String(error) }))
  }
  return {
    addListener(kind, listener) {
      if (closed) throw new Error("Transport admission is closed")
      if (entries.has(kind)) throw new Error(`Transport ${kind} already has a listener`)
      const entry: Registration = { listener }
      entries.set(kind, entry)
      try { activate(kind, entry) } catch (error) { entries.delete(kind); throw error }
      return () => retire(kind, entry)
    },
    async serve(begin) {
      if (closed) throw new Error("Transport admission is closed")
      if (start) throw new Error("Transport serving already started")
      start = begin
      for (const [kind, entry] of entries) activate(kind, entry)
      await Promise.all([...entries.values()].map((entry) => entry.serving?.ready))
    },
    dispose() {
      closed = true
      settlement ??= (async () => {
        const results = await Promise.allSettled([...entries].map(([kind, entry]) => retire(kind, entry)))
        const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, "Module transports failed to settle")
      })()
      return settlement
    },
  }
}
