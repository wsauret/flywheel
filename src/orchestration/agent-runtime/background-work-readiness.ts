import type { ChildInterruption } from "./background-work.js"

export interface HandoffBlock {
  /** Running work that the agent waits for or stops; a park waits for it. */
  active: number
  pending: number
  activeDescriptions: string[]
  pendingDescriptions: string[]
}

interface ReadinessEntry {
  interruption: ChildInterruption | undefined
  meta: { description: string }
}

/** Every tracked task is owed work, except a child that its parent agent or
 *  the runtime interrupted. A person's interrupt leaves it the parent's work
 *  (PI-AGENT-025). */
export const awaitedWork = (entry: ReadinessEntry): boolean => {
  const by = entry.interruption?.interruptedBy()
  return by === undefined || by === "person"
}

/** Classifies live ownership for handoff without owning task lifetime or delivery. */
export function backgroundHandoffBlock(entries: Iterable<ReadinessEntry>, pendingDescriptions: string[]): HandoffBlock | null {
  const awaited = [...entries].filter(awaitedWork)
  if (awaited.length === 0 && pendingDescriptions.length === 0) return null
  const activeDescriptions = awaited.map((item) => item.meta.description).filter((description) => description.trim().length > 0)
  return { active: awaited.length, pending: pendingDescriptions.length, activeDescriptions, pendingDescriptions }
}
