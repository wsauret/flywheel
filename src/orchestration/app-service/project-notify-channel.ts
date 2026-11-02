import { Schema } from "effect"
import type { InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { NotificationEpisodeInputSchema, type NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { withDeadline } from "../../infra/with-deadline.js"

const Request = Schema.Struct({ id: Schema.Int, episode: NotificationEpisodeInputSchema })
const Reply = Schema.Struct({ id: Schema.Int, error: Schema.optionalKey(Schema.String) })
const MAX_PENDING = 64

/** Forwards the generic notify seam to its account service owner and joins accepted durable writes. */
export function serveProjectNotifyChannel(endpoint: InternalProcessEndpoint<unknown, unknown>, notify: (episode: NotificationEpisodeInput) => Promise<void>): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const unsubscribe = endpoint.onMessage((value) => {
    const request = Schema.decodeUnknownSync(Request)(value)
    if (pending.size >= MAX_PENDING) {
      endpoint.close("Notification capacity exceeded")
      return
    }
    const task = notify(request.episode).then(
      () => endpoint.send({ id: request.id }),
      () => endpoint.send({ id: request.id, error: "Notification could not be stored" }),
    ).catch(() => {}).finally(() => pending.delete(task))
    pending.add(task)
  })
  return async () => {
    unsubscribe()
    await Promise.all(pending)
    endpoint.close()
  }
}

/** Each caller gets the owning journal's settlement, not just socket delivery. */
export function connectProjectNotifyChannel(endpoint: InternalProcessEndpoint<unknown, unknown>): (episode: NotificationEpisodeInput) => Promise<void> {
  const pending = new Map<number, PromiseWithResolvers<void>>()
  let id = 0
  endpoint.onMessage((value) => {
    const reply = Schema.decodeUnknownSync(Reply)(value)
    const call = pending.get(reply.id)
    if (reply.error) call?.reject(new Error(reply.error))
    else call?.resolve()
  })
  endpoint.onClose((error) => { for (const call of pending.values()) call.reject(error) })
  return async (episode) => {
    if (pending.size >= MAX_PENDING) throw new Error("Notification capacity exceeded")
    const requestId = ++id
    const call = Promise.withResolvers<void>()
    void call.promise.catch(() => {})
    pending.set(requestId, call)
    try {
      await endpoint.send(Schema.encodeUnknownSync(Request)({ id: requestId, episode }))
      await withDeadline(call.promise, 10_000)
    } finally { pending.delete(requestId) }
  }
}
