import net from "node:net"

import {
  createAccountAttachResponseReader,
  encodeAccountAttach,
  type ClientBundle,
} from "../../../src/protocol/account-attach.js"
import type { RuntimeSocketTarget } from "./node-socket.js"

/** A source runtime builds its client on the first request, so the default
 *  wait is the length of a build, not the length of a socket round trip. */
const DEFAULT_TIMEOUT_MS = 600_000

/** Asks the account service where its editor client bundle is.
 *
 *  One connection, one attach line, one answer. The runtime serves the client
 *  from its own build directory, so the extension mounts what the runtime
 *  names and never a bundle of its own. Resolves on the `client` response and
 *  rejects on any other answer, on a transport error, and on the timeout; the
 *  socket is destroyed in every case. */
export function resolveEditorClient(target: RuntimeSocketTarget, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ClientBundle> {
  return new Promise<ClientBundle>((resolve, reject) => {
    const socket = net.connect(target.socketPath)
    const reader = createAccountAttachResponseReader()
    let settled = false
    const finish = (bundle: ClientBundle | undefined, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (bundle === undefined) reject(error ?? new Error("account service closed before naming its client"))
      else resolve(bundle)
    }
    const timer = setTimeout(() => finish(undefined, new Error(`account service did not name its client within ${timeoutMs}ms`)), timeoutMs)
    socket.once("connect", () => {
      socket.write(encodeAccountAttach({ intent: "client", host: "editor", credential: target.credential }))
    })
    socket.on("data", (chunk: Buffer) => {
      const result = reader.push(chunk)
      switch (result.kind) {
        case "pending":
        case "starting":
          return
        case "client":
          finish(result.bundle)
          return
        case "failed":
          finish(undefined, new Error(result.error))
          return
        default:
          finish(undefined, new Error(`account service answered a client request with ${result.kind}`))
      }
    })
    socket.once("error", (cause) => finish(undefined, cause))
    socket.once("close", () => finish(undefined))
  })
}
