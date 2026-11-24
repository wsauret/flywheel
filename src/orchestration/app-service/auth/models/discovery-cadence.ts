/** How long after a profile's discovery an ordinary refresh request is skipped. */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000
/** How long a profile goes without discovery before background discovery runs by itself (PI-MODEL-046). */
const BACKGROUND_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000

/** When each profile's model discovery runs: the cooldown after a discovery, and the background discovery one
 *  interval after the latest one. Background discovery is armed only by a discovery, so it never runs before a
 *  profile's first one, runs only while its owner holds the profile open, and never keeps a process alive. */
export interface DiscoveryCadence<Profile extends { readonly id: string }> {
  /** Records a discovery of the profile now, and moves its background discovery one interval from now. */
  admit(profile: Profile): void
  /** True while the profile's latest discovery is younger than the refresh cooldown. */
  coolingDown(profile: Profile): boolean
  /** Cancels every background discovery; a later `admit` arms none. */
  dispose(): void
}

/** `discover` runs a background discovery. It goes through the ordinary refresh request, so a run that the cooldown
 *  or a running discovery skips arms the next interval before it asks. `held` answers whether the owner still holds
 *  the profile open when its background discovery is due: a released or deleted profile discovers nothing, and stays
 *  so until a later discovery arms it again. */
export function createDiscoveryCadence<Profile extends { readonly id: string }>(now: () => number, discover: (profile: Profile) => void, held: (profile: Profile) => boolean, backgroundIntervalMs = BACKGROUND_DISCOVERY_INTERVAL_MS): DiscoveryCadence<Profile> {
  const latest = new Map<string, number>()
  const due = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  const arm = (profile: Profile): void => {
    clearTimeout(due.get(profile.id))
    // A discovery that was admitted before the disposal can still end after it.
    if (closed) return
    const timer = setTimeout(() => {
      due.delete(profile.id)
      if (!held(profile)) return
      arm(profile)
      discover(profile)
    }, backgroundIntervalMs)
    timer.unref()
    due.set(profile.id, timer)
  }
  return {
    admit: (profile) => {
      latest.set(profile.id, now())
      arm(profile)
    },
    coolingDown: (profile) => {
      const last = latest.get(profile.id)
      return last !== undefined && now() - last < REFRESH_COOLDOWN_MS
    },
    dispose: () => {
      closed = true
      for (const timer of due.values()) clearTimeout(timer)
      due.clear()
      latest.clear()
    },
  }
}
