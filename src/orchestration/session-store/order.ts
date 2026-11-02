export function appendSessionOrder(ids: readonly string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? [...ids] : [...ids, sessionId]
}

export function removeSessionOrder(ids: readonly string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId)
}

export function orderedSessionIds(order: readonly string[], liveIds: readonly string[]): string[] {
  const live = new Set(liveIds)
  const seen = new Set(order)
  return [
    ...order.filter((id) => live.has(id)),
    ...liveIds.filter((id) => !seen.has(id)),
  ]
}

export function reorderSessionIds(current: readonly string[], sessionId: string, beforeSessionId: string | null): string[] | null {
  if (!current.includes(sessionId)) return null
  const without = current.filter((id) => id !== sessionId)
  const to = beforeSessionId === null ? without.length : without.indexOf(beforeSessionId)
  if (to === -1) return null
  const next = [...without]
  next.splice(to, 0, sessionId)
  return next
}

export function sameSessionOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}
