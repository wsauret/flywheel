import { unlink } from "node:fs/promises"

import type { GateAnswer, GateQuery } from "../../../infra/antigravity-gate-hook.js"
import { connectInternalProcessChannel, listenInternalProcessChannel, type InternalProcessChannelServer } from "../../../infra/internal-process-channel.js"
import { RouteUnavailableError } from "../../agent-runtime/llm/errors.js"

/** The one hold of the gate for one engine session: one admitted model step
 *  (`step`), or the expected fixed primer, which the gate refuses as the proof
 *  that the hook runs (`canary`). */
interface Admission {
  readonly sessionId: string
  readonly kind: "step" | "canary"
}

/** One answer of the gate. `consumed`: an admission let one step through.
 *  `canary-refused`: the session's primer reached the gate and was refused.
 *  `refused`: a step that no admission covers was refused. */
export interface StepGateEvent {
  readonly sessionId: string
  readonly invocationNum: number
  readonly kind: "consumed" | "refused" | "canary-refused"
}

/**
 * The step gate of one login (ARCH-PROVIDERS-087). The PreInvocation hook of
 * every engine process of the login asks it before each model step, through
 * the gate hook client, and it routes the query by the engine session id.
 * Every query that no live admission covers gets terminate, so the engine
 * sends no model request for it.
 */
export interface StepGate {
  /** Admits the next step of `sessionId` once (P5). A step that the request
   *  releases consumes it; the request revokes it when it settles first. A new
   *  grant replaces the session's earlier one, so a session never holds more
   *  than one admitted step. A grant while the session's primer is expected
   *  does not replace the canary: the returned admission is already ended. */
  grant(sessionId: string): Admission
  /** Marks that the next step of `sessionId` is its fixed primer, which the
   *  gate refuses and reports as `canary-refused`. It replaces a held step.
   *  A primer that never reaches the gate is how a bridge sees that the hook
   *  does not run. */
  expectCanary(sessionId: string): Admission
  /** Ends `admission` when it is still live. An admission that a step used,
   *  that a later one replaced, or that the gate already ended is no error. */
  revoke(admission: Admission): void
  /** Hears each answer of the gate. The listener must return at once. */
  onEvent(listener: (event: StepGateEvent) => void): () => void
  /** Stops answering and ends every admission. A hook that asks afterwards
   *  finds no gate and prints terminate. */
  dispose(): Promise<void>
}

/**
 * Opens the step gate of the login whose hook commands name `address` and
 * `gateId`. A query whose gate id differs is refused, and one that is not a
 * gate query closes its connection, which the hook client reads as terminate.
 * The address is stable for the login, so a socket file that a gone owner
 * left is removed. Throws `RouteUnavailableError` when another live owner
 * already serves the address.
 */
export async function openStepGate(options: { readonly address: string; readonly gateId: string }): Promise<StepGate> {
  const holds = new Map<string, Admission>()
  const listeners = new Set<(event: StepGateEvent) => void>()
  const decide = (query: GateQuery): GateAnswer["decision"] => {
    const { conversationId: sessionId, invocationNum } = query
    const held = query.gateId === options.gateId ? holds.get(sessionId) : undefined
    if (held) holds.delete(sessionId)
    const kind: StepGateEvent["kind"] = held?.kind === "canary" ? "canary-refused" : held ? "consumed" : "refused"
    for (const listener of Array.from(listeners)) listener({ sessionId, invocationNum, kind })
    return kind === "consumed" ? "allow" : "terminate"
  }
  const server = await listenAt(options.address, decide)
  return {
    grant(sessionId) {
      const admission: Admission = { sessionId, kind: "step" }
      if (holds.get(sessionId)?.kind !== "canary") holds.set(sessionId, admission)
      return admission
    },
    expectCanary(sessionId) {
      const admission: Admission = { sessionId, kind: "canary" }
      holds.set(sessionId, admission)
      return admission
    },
    revoke(admission) {
      if (holds.get(admission.sessionId) === admission) holds.delete(admission.sessionId)
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async dispose() {
      holds.clear()
      listeners.clear()
      await server.dispose()
    },
  }
}

async function listenAt(address: string, decide: (query: GateQuery) => GateAnswer["decision"]): Promise<InternalProcessChannelServer> {
  const listen = (): InternalProcessChannelServer => listenInternalProcessChannel<GateAnswer, GateQuery>({
    path: address,
    decode: gateQuery,
    onConnection(endpoint) {
      endpoint.onMessage((query) => endpoint.send({ decision: decide(query) }).catch(() => {}))
    },
  })
  let server: InternalProcessChannelServer
  try {
    server = listen()
  } catch (error) {
    // A Unix socket file outlives an owner that was killed, and a listen at
    // its path fails until it is removed; a Windows pipe ends with its owner.
    if (process.platform === "win32" || await answers(address)) {
      throw new RouteUnavailableError(`The Antigravity step gate at ${address} is already served by another Flywheel process: ${String(error)}`)
    }
    await unlink(address).catch(() => {})
    server = listen()
  }
  await server.ready
  return server
}

async function answers(address: string): Promise<boolean> {
  try {
    const endpoint = await connectInternalProcessChannel<never, never>({ path: address, decode: () => undefined })
    endpoint.close("step gate owner probe")
    return true
  } catch {
    return false
  }
}

function gateQuery(value: unknown): GateQuery | undefined {
  if (typeof value !== "object" || value === null || !("gateId" in value) || !("conversationId" in value) || !("invocationNum" in value)) return undefined
  const { gateId, conversationId, invocationNum } = value
  if (typeof gateId !== "string" || typeof conversationId !== "string" || typeof invocationNum !== "number") return undefined
  return { gateId, conversationId, invocationNum }
}
