/** Processor admission for owned command containers (ARCH-TOOLS-051).
 *
 *  A saturated scheduler gives every runnable process a slice, so when many
 *  processor-heavy commands run at once each one slows and none finishes
 *  sooner. Admission turns that into first-in-first-out service: the oldest
 *  heavy containers run at full speed and the newer ones are held until
 *  processor time frees. Measured on an 11-core Mac, twelve four-process jobs
 *  finished in the same total time either way, but held in order their mean
 *  completion fell by a third and a foreground task slowed 1.2 times instead
 *  of 2 to 2.7 times. */

/** Below this sustained demand a container is light. A light container is
 *  never held and is not counted, so a `grep` or a command that waits on the
 *  network never queues behind heavy work. */
const HEAVY_CORES = 0.5

/** What admission knows about one container. */
export interface ProcessorClaim {
  /** The container's ownership token. */
  readonly id: string
  /** Launch order: a smaller value launched earlier. */
  readonly order: number
  /** The container's demand while it runs: its threads that are ready to
   *  run, smoothed over recent readings. A held container keeps the value
   *  measured before its hold, because a held container runs nothing and its
   *  demand is what it would ask for again. */
  readonly cores: number
  /** A container that a chat's own turn started. It is never held, and its
   *  use counts toward the budget. */
  readonly exempt: boolean
}

/** The heavy containers that must be held so that Flywheel's processor
 *  demand stays near `budget` runnable threads.
 *
 *  Exempt use is counted first. Then heavy containers are admitted oldest
 *  first while use stays under the budget, so the last one admitted may pass
 *  it by its own demand: stopping short would leave cores idle whenever jobs
 *  are larger than what remains. Once one container waits, every newer one
 *  waits too, so a small newer job never passes a held older one. The oldest
 *  heavy container always runs, so work progresses even when exempt use alone
 *  fills the budget. */
export function heldContainers(claims: readonly ProcessorClaim[], budget: number): ReadonlySet<string> {
  let used = 0
  for (const claim of claims) if (claim.exempt) used += claim.cores
  const queue = claims.filter((claim) => !claim.exempt && claim.cores > HEAVY_CORES).sort((a, b) => a.order - b.order)
  const held = new Set<string>()
  let admitted = 0
  for (const claim of queue) {
    if (held.size === 0 && (used < budget || admitted === 0)) {
      used += claim.cores
      admitted += 1
    } else {
      held.add(claim.id)
    }
  }
  return held
}
