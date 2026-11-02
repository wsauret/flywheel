import type { InternalProcessEndpoint } from "./internal-process-channel.js"

export type InternalProcessSubchannelId = "guardian" | "persistent" | "notify"

interface SubchannelEnvelope {
  readonly channel: InternalProcessSubchannelId
  readonly payload: unknown
}

const CHANNEL_IDS: ReadonlySet<unknown> = new Set<InternalProcessSubchannelId>(["guardian", "persistent", "notify"])

function isChannelId(value: unknown): value is InternalProcessSubchannelId {
  return CHANNEL_IDS.has(value)
}

function envelope(value: unknown): SubchannelEnvelope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  if (!("channel" in value) || !("payload" in value) || !isChannelId(value.channel)) return undefined
  return { channel: value.channel, payload: value.payload }
}

/** Borrows one named virtual endpoint from a shared ordered parent transport.
 * Payloads stay `unknown`: each borrower decodes its own protocol at its boundary.
 * Closing the borrower only unsubscribes it; closing the parent closes every borrower. */
export function createInternalProcessSubchannel(
  parent: InternalProcessEndpoint<unknown, unknown>,
  channel: InternalProcessSubchannelId,
): InternalProcessEndpoint<unknown, unknown> {
  const messages = new Set<(message: unknown) => void | Promise<void>>()
  const closes = new Set<(reason: Error) => void>()
  const closed = Promise.withResolvers<void>()
  let reason: Error | undefined
  let unsubscribeMessage = (): void => {}
  let unsubscribeClose = (): void => {}

  const finish = (error: Error): void => {
    if (reason) return
    reason = error
    unsubscribeMessage()
    unsubscribeClose()
    for (const handler of closes) handler(error)
    messages.clear()
    closes.clear()
    closed.resolve()
  }
  unsubscribeMessage = parent.onMessage((value) => {
    const frame = envelope(value)
    if (frame?.channel !== channel || reason) return
    for (const handler of messages) void handler(frame.payload)
  })
  unsubscribeClose = parent.onClose((error) => { finish(error) })
  if (reason) unsubscribeClose()

  return {
    closed: closed.promise,
    async send(message) {
      // oxlint-disable-next-line eslint/no-throw-literal -- boundary: `reason` is the Error this borrower latched at close; every later send reports the same one.
      if (reason) throw reason
      await parent.send({ channel, payload: message })
    },
    onMessage(handler) {
      if (!reason) messages.add(handler)
      return () => messages.delete(handler)
    },
    onClose(handler) {
      if (reason) handler(reason)
      else closes.add(handler)
      return () => closes.delete(handler)
    },
    close(closeReason = `internal process ${channel} subchannel closed`) {
      finish(new Error(closeReason))
    },
  }
}
