import type { InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { errorMessage } from "../../infra/error-message.js"
import type { ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { SessionMetadataChange } from "../session/manager.js"
import { createProjectStateClient, type ProjectStateClient, type ProjectStateClientTransport } from "./project-state-client.js"
import {
  decodeProjectStateMessage,
  decodeProjectStateRequest,
  encodeProjectStateResponse,
  encodeProjectStateResponseFrame,
  encodeProjectStateSessionChange,
  encodeProjectStateStored,
  type ProjectStateRequest,
  type ProjectStateResponse,
  type ProjectStateResponseFrame,
} from "./project-state-protocol.js"

/** Who a served state channel answers. An executor generation's writes are
 *  fenced to its generation, and it hears every committed fact and session
 *  change. A startup maintenance job is no generation: its writes take the
 *  control lane, as the account's own writes do, and it hears no broadcast
 *  because it only asks. Neither can admit, close, or recover a generation. */
export type ProjectStatePeer =
  | { readonly kind: "executor"; readonly projectId: string; readonly generation: number }
  | { readonly kind: "maintenance"; readonly projectId: string }

/** Serves one peer's connection without taking ownership of the account state client. */
export function serveProjectStateChannel(
  state: ProjectStateClient,
  endpoint: InternalProcessEndpoint<unknown, unknown> & Partial<Pick<ReattachableProcessEndpoint<unknown, unknown>, "attached">>,
  peer: ProjectStatePeer,
): () => Promise<void> {
  const log = Log.create({ service: "project-state-channel" }).with(peer.kind === "executor"
    ? { projectId: peer.projectId, generation: peer.generation }
    : { projectId: peer.projectId, peer: peer.kind })
  const sends = new Set<Promise<void>>()
  const requests = new Set<Promise<void>>()
  let accepting = true

  // A send waits for the executor to drain, so pressure never fails a message.
  // What can still fail is one message of its own: an oversize frame is a
  // producer bug that must not take the generation with it, so it is logged and
  // the connection stays. A closed endpoint has already stopped admission, and
  // a message in flight when the transport went away is the transport's story:
  // the facade reports the detach and waits for the executor, or the executor
  // has stopped and the generation ends behind it.
  const send = (message: unknown): void => {
    if (!accepting) return
    const pending = endpoint.send(message)
    sends.add(pending)
    void pending.catch((error: unknown) => {
      if (!accepting) return
      if (endpoint.attached === false) log.debug("project state channel send lost with its transport", { error: errorMessage(error) })
      else log.error("project state channel send failed", { error: errorMessage(error) })
    }).finally(() => sends.delete(pending))
  }
  const stopBroadcasts = peer.kind === "executor"
    ? [
      state.onStored((events) => send(encodeProjectStateStored(events))),
      state.sessions.subscribe((change) => send(encodeProjectStateSessionChange(change))),
    ]
    : []
  const stopMessages = endpoint.onMessage((value) => {
    if (!accepting) return
    const request = decodeProjectStateRequest(value)
    if (!request) {
      endpoint.close("invalid project state request")
      return
    }
    const pending = serveRequest(state, request, peer, send)
    requests.add(pending)
    void pending.finally(() => requests.delete(pending))
  })
  const stopClose = endpoint.onClose(() => stopAdmission())

  function stopAdmission(): void {
    if (!accepting) return
    accepting = false
    stopMessages()
    for (const stop of stopBroadcasts) stop()
  }

  let closing: Promise<void> | undefined
  return () => {
    closing ??= (async () => {
      stopAdmission()
      endpoint.close()
      stopClose()
      await Promise.allSettled(requests)
      await Promise.allSettled(sends)
      await endpoint.closed
    })()
    return closing
  }
}

/** Connects a peer's state client. Closing it owns only this endpoint. */
export function connectProjectStateChannel(
  endpoint: InternalProcessEndpoint<unknown, unknown> & Partial<Pick<ReattachableProcessEndpoint<unknown, unknown>, "onDetach">>,
  peer: ProjectStatePeer,
): ProjectStateClient {
  const responses = new Set<(frame: ProjectStateResponseFrame) => boolean>()
  const inFlight = new Set<number>()
  const answer = (frame: ProjectStateResponseFrame): void => {
    inFlight.delete(frame.id)
    for (const listener of responses) if (!listener(frame)) endpoint.close("invalid project state response")
  }
  const fail = (response: ProjectStateResponse): void => answer(encodeProjectStateResponseFrame(response))
  // A request in flight when the transport was lost has an unknown outcome:
  // its bytes may or may not have reached the account. It fails with that
  // truth instead of waiting forever or being replayed as a second write.
  const detached = new Set<() => void>()
  endpoint.onDetach?.((cause) => {
    for (const listener of detached) listener()
    const ids = [...inFlight]
    inFlight.clear()
    for (const id of ids) fail({ id, result: { kind: "failed", error: new Error(`project state channel detached before the reply arrived; the outcome is unknown: ${cause.message}`) } })
  })
  const stored = new Set<(events: readonly StoredFact[]) => void>()
  const sessions = new Set<(change: SessionMetadataChange) => void>()
  const closes = new Set<(reason: string) => void>()
  let lost = false

  const lose = (reason: string): void => {
    if (lost) return
    lost = true
    for (const listener of closes) listener(reason)
    closes.clear()
  }
  endpoint.onClose((error) => lose(error.message))
  endpoint.onMessage((value) => {
    const message = decodeProjectStateMessage(value)
    if (message?.kind === "response") answer(message.frame)
    else if (message?.kind === "stored") for (const listener of stored) listener(message.events)
    else if (message?.kind === "session-change") for (const listener of sessions) listener(message.change)
    else endpoint.close("invalid project state response")
  })

  const transport: ProjectStateClientTransport = {
    prepare(request) {
      const operation = request.operation
      const kind = operation.kind
      if (peer.kind !== "executor" || request.lane !== "control"
        || kind === "position.capture" || kind.startsWith("facts.") || kind.startsWith("in-flight.read")
        || kind === "in-flight.sessions" || kind.startsWith("aggregate.") || kind === "content.page"
        || kind === "content.node" || kind === "content.range") return request
      if (operation.kind === "generation.admit" || operation.kind === "generation.close"
        || operation.kind === "generation.recover" || operation.kind === "execution.operation") return request
      return { ...request, lane: "execution", operation: {
        kind: "execution.operation", projectId: peer.projectId, generation: peer.generation,
        operation,
      } }
    },
    // A request that cannot be framed fails as that request's own result. The
    // endpoint stays: the account still owns the generation, and every other
    // request on this channel is unaffected.
    send(request, encoded) {
      inFlight.add(request.id)
      void endpoint.send(encoded).catch((cause: unknown) => {
        if (lost || !inFlight.has(request.id)) return
        const error = cause instanceof Error ? cause : new Error(String(cause))
        fail({ id: request.id, result: { kind: "failed", error } })
      })
    },
    onResponse(listener) {
      responses.add(listener)
    },
    onClose(listener) {
      if (lost) listener("project state channel closed")
      else closes.add(listener)
    },
    onStored(listener) {
      stored.add(listener)
      return () => { stored.delete(listener) }
    },
    onSessionChange(listener) {
      sessions.add(listener)
      return () => { sessions.delete(listener) }
    },
    onDetach(listener) {
      detached.add(listener)
    },
    close() {
      endpoint.close()
      return endpoint.closed
    },
  }
  // An executor hears every commit of the account's store connection; a
  // maintenance job hears none.
  return createProjectStateClient(transport, { commitWindow: peer.kind === "executor" })
}

async function serveRequest(
  state: ProjectStateClient,
  request: ProjectStateRequest,
  peer: ProjectStatePeer,
  send: (message: unknown) => void,
): Promise<void> {
  // A relayed answer is the Worker's frame, head included, which the peer
  // reads; an answer the account makes itself has no head, because the
  // Worker read nothing for it.
  const refuse = (message: string): Uint8Array => encodeProjectStateResponse({ id: request.id, result: { kind: "refused", reason: "invalid", message } })
  try {
    const operation = request.operation
    let response: Uint8Array
    switch (operation.kind) {
      case "generation.admit":
      case "generation.close":
      case "generation.recover":
        response = refuse("Peer connections cannot control generation admission")
        break
      case "execution.operation":
        response = peer.kind === "executor" && operation.projectId === peer.projectId && operation.generation === peer.generation
          ? await state.relay("execution", operation, request.id)
          : refuse("Peer generation does not match its channel")
        break
      case "position.capture":
      case "facts.latest-position":
      case "facts.latest-payload":
      case "facts.latest-by-types":
      case "facts.slice":
      case "in-flight.read":
      case "in-flight.sessions":
      case "aggregate.count":
      case "aggregate.sequence":
      case "facts.page":
      case "content.page":
      case "content.node":
      case "content.range":
        response = await state.relay("control", operation, request.id)
        break
      default:
        response = peer.kind === "executor"
          ? refuse("Executor writes require their generation wrapper")
          : await state.relay("control", operation, request.id)
    }
    send(response)
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    send(encodeProjectStateResponse({ id: request.id, result: { kind: "failed", error } }))
  }
}
