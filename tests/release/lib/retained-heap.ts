import { existsSync, statSync } from "node:fs"
import { Schema } from "effect"
import type { Socket } from "bun"
import { releaseMeasurementNow } from "../../../src/infra/startup-trace.js"
import type { RetainedHeapSample } from "../scenarios/scenario-context.js"
import { withTimeout } from "./isolated-serve.js"

const Reply = Schema.Struct({
  id: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  result: Schema.optional(Schema.Struct({
    wasThrown: Schema.optional(Schema.Boolean),
    result: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.Unknown) })),
  })),
})
type InspectorReply = typeof Reply.Type
interface Connection {
  buffer: Buffer
  next: number
  pending: Map<number, { resolve(reply: InspectorReply): void; reject(error: Error): void }>
}
const Identity = Schema.Struct({ pid: Schema.Number, executor: Schema.Boolean })
const Memory = Schema.Struct({ heapUsed: Schema.Number, rss: Schema.Number })

async function request(socket: Socket<Connection>, method: string, params = {}): Promise<InspectorReply> {
  const id = ++socket.data.next
  const body = Buffer.from(JSON.stringify({ id, method, params }))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  const reply = new Promise<InspectorReply>((resolve, reject) => socket.data.pending.set(id, { resolve, reject }))
  socket.write(Buffer.concat([header, body]))
  try {
    const response = await withTimeout(`heap inspector ${method}`, reply, 10_000)
    if (response.error || response.result?.wasThrown) throw new Error(`heap inspector ${method} failed`)
    return response
  } finally { socket.data.pending.delete(id) }
}

async function evaluate(socket: Socket<Connection>, expression: string): Promise<string> {
  return Schema.decodeUnknownSync(Schema.String)((await request(socket, "Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value)
}

/** Owns a release-only reverse inspector connection. Both immutable and current builds use Heap.gc.
 * The existing process-tree marker precedes the plateau; final bounds validate the GC and sample.
 * No heap snapshot is taken: it pauses the executor long enough to invalidate request timings. */
export function startRetainedHeapSampler(options: { readonly socketPath: string; readonly markerPath: string }) {
  const executors = new Map<number, Socket<Connection>>()
  let failure: Error | undefined
  let sample: RetainedHeapSample | undefined
  let measurement: Promise<void> | undefined
  let midpointTimer: ReturnType<typeof setTimeout> | undefined
  const server = Bun.listen<Connection>({
    unix: options.socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0), next: 0, pending: new Map() }
        void evaluate(socket, 'JSON.stringify({pid:process.pid,executor:process.argv.find(arg=>arg.startsWith("--internal-role="))==="--internal-role=project-executor"})')
          .then(value => {
            const identity = Schema.decodeUnknownSync(Identity)(JSON.parse(value))
            if (identity.executor) executors.set(identity.pid, socket)
          // Short-lived supervisors can exit before identification. Only a measured executor is required.
          }).catch(() => {})
      },
      data(socket, bytes) {
        const connection = socket.data
        connection.buffer = Buffer.concat([connection.buffer, bytes])
        while (connection.buffer.length >= 4) {
          const length = connection.buffer.readUInt32BE(0)
          if (connection.buffer.length < length + 4) break
          try {
            const message = Schema.decodeUnknownSync(Reply)(JSON.parse(connection.buffer.subarray(4, length + 4).toString("utf8")))
            if (message.id !== undefined) connection.pending.get(message.id)?.resolve(message)
          } catch (error) { failure = new Error("heap inspector reply failed", { cause: error }) }
          connection.buffer = connection.buffer.subarray(length + 4)
        }
      },
      close(socket) {
        for (const pending of socket.data.pending.values()) pending.reject(new Error("heap inspector disconnected"))
        for (const [pid, executor] of executors) if (executor === socket) executors.delete(pid)
      },
    },
  })
  const markerTimer = setInterval(() => {
    if (!existsSync(options.markerPath)) return
    clearInterval(markerTimer)
    const targetAt = statSync(options.markerPath).mtimeMs + 22_500
    midpointTimer = setTimeout(() => {
      measurement = (async () => {
        if (executors.size !== 1) throw new Error("retained heap requires one connected project executor")
        const [pid, executor] = [...executors][0]!
        const gcStartedAtMs = releaseMeasurementNow()
        await request(executor, "Heap.gc")
        const value = await evaluate(executor, "JSON.stringify(process.memoryUsage())")
        const memory = Schema.decodeUnknownSync(Memory)(JSON.parse(value))
        sample = { pid, gcStartedAtMs, timestampMs: releaseMeasurementNow(), ...memory }
      })().catch(error => { failure = new Error("post-GC heap observation failed", { cause: error }) })
    }, Math.max(0, targetAt - releaseMeasurementNow()))
  }, 25)
  return {
    environment: { BUN_INSPECT_CONNECT_TO: `unix://${options.socketPath}` },
    async read(): Promise<RetainedHeapSample> {
      await measurement
      if (failure) throw new Error("retained heap sampling failed", { cause: failure })
      if (!sample) throw new Error("active plateau has no post-GC heap sample")
      return sample
    },
    dispose() {
      clearInterval(markerTimer)
      clearTimeout(midpointTimer)
      server.stop(true)
    },
  }
}
