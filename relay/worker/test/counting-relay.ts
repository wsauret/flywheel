import relayWorker from "../src/index.js"
import { RelayRuntime as Relay } from "../src/relay-runtime.js"

/** The relay Worker with every storage call of its Durable Object counted,
 *  for tests that bound the storage work each handler run does. Tests serve
 *  this file through `startLocalRelay` and read the record at
 *  `GET /__relay-test/<runtimeId>/invocations`, and how many times the
 *  object was constructed at `GET /__relay-test/<runtimeId>/constructions`.
 *  Both records live in the module, not the object, so they survive the
 *  object being evicted and constructed again within the isolate. Handlers can interleave at an
 *  await that is not a storage call, so a call is credited to the handler
 *  that started last; tests act one step at a time. */

/** One handler run and the storage methods it called, in order. */
export interface Invocation {
  readonly handler: string
  readonly calls: string[]
}

const invocations: Invocation[] = []
let current: Invocation | undefined
/** Constructor runs by runtime id. A count that rises while the object's
 *  sockets stay open means the platform evicted the object in between, which
 *  is what hibernation does. */
const constructions = new Map<string, number>()
/** Storage methods that reject when the relay calls them, as a storage
 *  fault that does not reset the object would. Test routes still reach them. */
const failing = new Set<string>()

function begin(handler: string): void {
  current = { handler, calls: [] }
  invocations.push(current)
}

/** The storage methods the relay calls. */
const COUNTED = ["get", "list", "put", "delete", "deleteAll", "getAlarm", "setAlarm", "deleteAlarm"] as const

/** Makes each storage method report its name before it runs. The methods
 *  are replaced on the storage object itself, because the platform's base
 *  class accepts only its own state object, so no wrapper can stand in. */
function countCalls(storage: DurableObjectStorage): void {
  for (const name of COUNTED) Object.defineProperty(storage, name, { value: counted(storage, name) })
}

function counted(storage: DurableObjectStorage, name: (typeof COUNTED)[number]) {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: hands the relay whatever the platform's storage method resolves to, unread.
  const original: (...args: never[]) => Promise<unknown> = storage[name]
  return (...args: never[]) => {
    if (current === undefined) return original.apply(storage, args)
    current.calls.push(name)
    if (failing.has(name)) return Promise.reject(new Error(`storage ${name} failed`))
    return original.apply(storage, args)
  }
}

function messageLabel(message: string | ArrayBuffer): string {
  if (typeof message !== "string") return "message:binary"
  try {
    const value: unknown = JSON.parse(message)
    return typeof value === "object" && value !== null && "type" in value ? `message:${String(value.type)}` : "message:text"
  } catch {
    return "message:text"
  }
}

/** @externalHost Cloudflare instantiates the Durable Object class by its exported name. */
export class RelayRuntime extends Relay {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    countCalls(ctx.storage)
    const runtimeId = ctx.id.name ?? ""
    constructions.set(runtimeId, (constructions.get(runtimeId) ?? 0) + 1)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const [, scope, , action] = url.pathname.split("/")
    if (scope === "__relay-test") {
      current = undefined
      return this.testRoute(action, request)
    }
    begin(`fetch:${url.pathname.split("/")[1]}`)
    return super.fetch(request)
  }

  override async alarm(): Promise<void> {
    begin("alarm")
    return super.alarm()
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    begin(messageLabel(message))
    return super.webSocketMessage(ws, message)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    begin("close")
    return super.webSocketClose(ws, code, reason, wasClean)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    begin("error")
    return super.webSocketError(ws)
  }

  /** The test's view of this object: the record, its constructor runs, the
   *  armed alarm, the stored keys, rows put as an earlier relay left them, and the storage methods
   *  that fail from now on. */
  private async testRoute(action: string | undefined, request: Request): Promise<Response> {
    switch (action) {
      case "invocations":
        return Response.json(invocations)
      case "constructions":
        return Response.json(constructions.get(this.ctx.id.name ?? "") ?? 0)
      case "alarm":
        return Response.json({ alarm: await this.ctx.storage.getAlarm() })
      case "keys":
        return Response.json([...(await this.ctx.storage.list()).keys()])
      case "fail": {
        const names: readonly string[] = await request.json()
        failing.clear()
        for (const name of names) failing.add(name)
        return Response.json({ ok: true })
      }
      case "seed": {
        const rows: { readonly [key: string]: unknown } = await request.json()
        await this.ctx.storage.put(rows)
        return Response.json({ ok: true })
      }
      default:
        return new Response("no such test route", { status: 404 })
    }
  }
}

/** @externalHost Cloudflare calls the Worker's default export. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [, scope, runtimeId] = new URL(request.url).pathname.split("/")
    if (scope === "__relay-test" && runtimeId !== undefined) return env.RELAY_RUNTIME.get(env.RELAY_RUNTIME.idFromName(runtimeId)).fetch(request)
    return relayWorker.fetch(request, env)
  },
} satisfies ExportedHandler<Env>
