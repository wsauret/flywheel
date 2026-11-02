export interface NotificationAddress {
  readonly sessionId: string
  readonly selection?: { readonly runtimeId: string; readonly placementId: string }
  readonly attention: boolean
}

/** Reads both current full notification addresses and older session-only links. */
export function readNotificationAddress(hash: string): NotificationAddress | undefined {
  const values = new URLSearchParams(hash.replace(/^#/, ""))
  const sessionId = values.get("session")
  if (!sessionId) return undefined
  const runtimeId = values.get("runtime")
  const placementId = values.get("placement")
  return { sessionId, attention: values.get("attention") === "question", ...(runtimeId && placementId ? { selection: { runtimeId, placementId } } : {}) }
}
