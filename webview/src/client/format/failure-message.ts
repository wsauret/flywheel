/** A failure, in words rather than in the transport's vocabulary.
 *
 *  `String(cause)` on an Effect RPC error yields its type tag,
 *  "~effect/rpc/RpcClientError", which names the layer that failed and nothing
 *  a person can act on. Worse, the common cause is the runtime restarting under
 *  a reload, which is both temporary and self-healing, and deserves to be said
 *  as such. */
export function describeFailure(cause: unknown): string {
  const message = readMessage(cause)
  if (message === undefined) return "the runtime did not answer"
  // The transport's own errors all mean the same thing from here: the
  // connection went away mid-call. The client reconnects on its own. Every
  // name the RPC and socket layers give an error counts, so none of those
  // names reaches the screen.
  if (/\bRpcClient|Socket[A-Za-z]*Error|socket error|ECONNREFUSED|EPIPE|closed/i.test(message)) {
    return "the connection to the runtime dropped. It reconnects on its own; try that again in a moment"
  }
  return message
}

function readMessage(cause: unknown): string | undefined {
  if (typeof cause === "string") return cause
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const record: { readonly message?: unknown; readonly reason?: unknown; readonly _tag?: unknown } = cause
    for (const value of [record.message, record.reason, record._tag]) {
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  return undefined
}
