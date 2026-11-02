import { Redacted } from "effect"
import { join } from "node:path"
import { errorMessage } from "../../infra/error-message.js"
import { startRefusalOf } from "../../protocol/serve-handshake.js"
import { startupPhase, type StartupReached } from "../../protocol/startup-steps.js"
import {
  ACCOUNT_ATTACH_LATER_MAX_BYTES,
  createAccountAttachReader,
  encodeAccountAttachResponse,
  type AccountModuleRequest,
} from "../../protocol/account-attach.js"
import type { SettledControlUiAssetState } from "./web-serving/control-ui-assets.js"

export interface AccountProjectConnection {
  readonly receive: (bytes: Uint8Array) => void | Promise<void>
  readonly release: () => void
}

export interface AccountSocketRouter<Connection extends object | string | number> {
  readonly receive: (connection: Connection, bytes: Uint8Array) => Promise<"accepted" | "pending" | "rejected">
  readonly close: (connection: Connection) => void
}

interface ConnectionAdmission {
  readonly reader: ReturnType<typeof createAccountAttachReader>
  closed: boolean
  intent?: "runtime" | "browser"
  later: Uint8Array[]
  laterBytes: number
  routing: boolean
  binding?: AccountProjectConnection
  opening?: Promise<AccountProjectConnection>
  /** Aborts when a `module` attach's connection closes before its request ends. */
  withdrawn?: AbortController
}

/** Admit account-socket connections and route their remaining protocol bytes
 * to the canonical project's shared handler. Project opening settles before
 * bytes after AccountAttach are delivered. Each socket owns an independent
 * project binding and releases its own client hold when it closes.
 *
 * A `client` attach only asks where this runtime's client bundle for one host
 * is and ends with the answer: that host's directory under the client root,
 * and the identity of the whole client. Whether the page a host mounts is this
 * runtime's is checked where every host attaches, at the protocol's event
 * attach, not here.
 *
 * A `module` attach sends one request to a module's account-lifetime service
 * and opens no project. Its answers stream on the connection until the
 * service ends the request, and a close before then withdraws it. */
export function createAccountSocketRouter<Connection extends object | string | number>(options: {
  readonly credential: Redacted.Redacted<string>
  readonly canonicalizeProjectRoot: (projectRoot: string) => string
  readonly send?: (connection: Connection, bytes: Uint8Array) => void | Promise<void>
  /** Told once for each connection whose attach is accepted, before any work
   *  on its request starts. What the service does next, such as building the
   *  web client or opening a project, can take longer than an unheld service
   *  stays up, so the connection must hold the service from here until it
   *  closes. */
  readonly admitted?: (connection: Connection) => void
  /** Answers a client's cutover request: `retiring` once the service has
   *  begun to make way for another, which `beforeRetire` tells the client
   *  before the listener withdraws, and `busy` while it stays. */
  readonly answerCutover: (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">
  /** Answers a person's restart request in the same words as a cutover: the
   *  service makes way for a successor whatever build it runs. */
  readonly answerRestart: (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">
  /** Serves a `module` attach: hands `request` to the account-lifetime
   *  service of `module`, which sends each answer through `answer` and
   *  settles when the request ends. `withdrawn` aborts when the client
   *  closes first. A rejection is the failure the client reads. */
  readonly moduleRequest: (module: string, request: AccountModuleRequest, answer: (payload: unknown) => Promise<void>, withdrawn: AbortSignal) => Promise<void>
  /** The client root and identity this runtime serves, or why it serves none. */
  readonly client: () => Promise<SettledControlUiAssetState>
  readonly openProject: (canonicalProjectRoot: string, intent: "runtime" | "browser", connection: Connection, onStartupStep?: (reached: StartupReached) => void) => Promise<AccountProjectConnection>
}): AccountSocketRouter<Connection> {
  const connections = new Map<Connection, ConnectionAdmission>()
  const encoder = new TextEncoder()
  const send = (connection: Connection, response: Parameters<typeof encodeAccountAttachResponse>[0]): Promise<void> =>
    Promise.resolve(options.send?.(connection, encoder.encode(encodeAccountAttachResponse(response))))
  const release = (admission: ConnectionAdmission): void => {
    const binding = admission.binding
    admission.binding = undefined
    binding?.release()
  }
  return {
    async receive(connection, bytes) {
      const current = connections.get(connection)
      if (current?.closed) return "rejected"
      if (current?.binding && current.routing) {
        if (current.intent === "runtime") await current.binding.receive(bytes)
        return "accepted"
      }
      if (current?.intent !== undefined) {
        if (current.intent === "runtime") {
          current.laterBytes += bytes.length
          if (current.laterBytes > ACCOUNT_ATTACH_LATER_MAX_BYTES) {
            current.closed = true
            release(current)
            if (!current.opening) connections.delete(connection)
            return "rejected"
          }
          current.later.push(bytes.slice())
        }
        return "pending"
      }
      const pending = current ?? {
        reader: createAccountAttachReader({
          credential: options.credential,
          canonicalizeProjectRoot: options.canonicalizeProjectRoot,
        }),
        closed: false,
        later: [],
        laterBytes: 0,
        routing: false,
      }
      connections.set(connection, pending)
      const result = pending.reader.push(bytes)
      if (result.kind !== "accepted") {
        if (result.kind === "rejected") connections.delete(connection)
        return result.kind
      }
      options.admitted?.(connection)

      if (result.intent === "cutover" || result.intent === "restart") {
        if (result.remainder.length > 0) {
          connections.delete(connection)
          return "rejected"
        }
        const answer = result.intent === "cutover" ? options.answerCutover : options.answerRestart
        const outcome = await answer(() => send(connection, { kind: "retiring" }))
        if (outcome === "busy") await send(connection, { kind: "busy" })
        connections.delete(connection)
        return "accepted"
      }
      if (result.intent === "client") {
        if (result.remainder.length > 0) {
          connections.delete(connection)
          return "rejected"
        }
        const client = await options.client()
        await send(connection, client.kind === "resolved"
          ? { kind: "client", bundle: { dir: join(client.root, result.host), identity: client.identity } }
          : { kind: "failed", error: client.error })
        connections.delete(connection)
        return "accepted"
      }
      if (result.intent === "module") {
        if (result.remainder.length > 0) {
          connections.delete(connection)
          return "rejected"
        }
        const withdrawn = new AbortController()
        pending.withdrawn = withdrawn
        try {
          await options.moduleRequest(result.module, result.request, (payload) => withdrawn.signal.aborted ? Promise.resolve() : send(connection, { kind: "answer", payload }), withdrawn.signal)
          if (!withdrawn.signal.aborted) await send(connection, { kind: "end" })
        } catch (cause) {
          if (!withdrawn.signal.aborted) await send(connection, { kind: "failed", error: errorMessage(cause) })
        }
        connections.delete(connection)
        return "accepted"
      }
      pending.intent = result.intent
      pending.laterBytes = result.remainder.length
      if (result.intent === "runtime" && pending.laterBytes > ACCOUNT_ATTACH_LATER_MAX_BYTES) {
        pending.closed = true
        connections.delete(connection)
        return "rejected"
      }
      await send(connection, { kind: "starting" })
      if (pending.closed) {
        connections.delete(connection)
        return "rejected"
      }
      let phaseWrites = Promise.resolve()
      const opening = options.openProject(result.projectRoot, result.intent, connection, (reached) => {
        // The socket is where a step leaves this build, so this is the one
        // place a step becomes the label and count a client of any build reads.
        phaseWrites = phaseWrites.then(() => {
          if (!pending.closed) return send(connection, { kind: "phase", ...startupPhase(reached) })
        })
        // The receive task observes this failure after opening settles.
        void phaseWrites.catch(() => {})
      })
      pending.opening = opening
      try {
        const binding = await opening
        pending.opening = undefined
        pending.binding = binding
        await phaseWrites
        if (pending.closed) {
          release(pending)
          connections.delete(connection)
          return "rejected"
        }
        await send(connection, { kind: "ready" })
        if (pending.closed) {
          connections.delete(connection)
          return "rejected"
        }
        pending.routing = true
        if (result.intent === "runtime") {
          if (result.remainder.length > 0) await binding.receive(result.remainder)
          for (const later of pending.later) await binding.receive(later)
          pending.later = []
          pending.laterBytes = 0
        }
        return "accepted"
      } catch (cause) {
        pending.opening = undefined
        await phaseWrites.catch(() => {})
        if (!pending.closed) {
          const refusal = startRefusalOf(cause)
          await send(connection, { kind: "failed", error: errorMessage(cause), ...(refusal === undefined ? {} : { refusal }) })
        }
        release(pending)
        connections.delete(connection)
        return "rejected"
      }
    },
    close(connection) {
      const current = connections.get(connection)
      if (!current) return
      current.closed = true
      current.withdrawn?.abort()
      release(current)
      if (!current.opening && !current.withdrawn) connections.delete(connection)
    },
  }
}
