import type { ChildInterruption } from "./background-work.js"

export interface HandoffBlock {
  /** Running work that settles on its own; a park waits for it. */
  active: number
  pending: number
  /** Services block handoff until they end, but only explicit waits park on them. */
  services: number
  activeDescriptions: string[]
  pendingDescriptions: string[]
  serviceDescriptions: string[]
}

interface ReadinessEntry {
  service: boolean
  interruption: ChildInterruption | undefined
  meta: { description: string }
}

/** A child that its parent agent or the runtime interrupted is not active
 *  work. A person's interrupt leaves it the parent's work (PI-AGENT-025). */
export const waitableWork = (entry: ReadinessEntry): boolean => {
  const by = entry.interruption?.interruptedBy()
  return by === undefined || by === "person"
}

// Services hold explicit waits, not automatic completion or handoff parks.
export const awaitedWork = (entry: ReadinessEntry): boolean => !entry.service && waitableWork(entry)

/** Classifies live ownership for handoff without owning task lifetime or delivery. */
export function backgroundHandoffBlock(entries: Iterable<ReadinessEntry>, pendingDescriptions: string[]): HandoffBlock | null {
  const active = [...entries]
  const services = active.filter((entry) => entry.service)
  const awaited = active.filter(awaitedWork)
  if (services.length === 0 && awaited.length === 0 && pendingDescriptions.length === 0) return null
  const describe = (items: ReadinessEntry[]) => items.map((item) => item.meta.description).filter((description) => description.trim().length > 0)
  return { active: awaited.length, pending: pendingDescriptions.length, services: services.length, activeDescriptions: describe(awaited), pendingDescriptions, serviceDescriptions: describe(services) }
}
