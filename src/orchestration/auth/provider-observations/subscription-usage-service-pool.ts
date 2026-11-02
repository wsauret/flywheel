import type { SubscriptionUsageProfile, SubscriptionUsageService } from "./subscription-usage-service.js"

export interface SubscriptionUsageServiceLease {
  readonly profile: SubscriptionUsageProfile
  readonly service: SubscriptionUsageService
  release(): Promise<void>
}

type SubscriptionUsagePublicationListener = (profile: SubscriptionUsageProfile, service: SubscriptionUsageService) => void

export interface SubscriptionUsageServicePool {
  acquire(profile: SubscriptionUsageProfile): Promise<SubscriptionUsageServiceLease>
  acquireSettlement(profile: SubscriptionUsageProfile): Promise<SubscriptionUsageServiceLease>
  onPublished(listener: SubscriptionUsagePublicationListener): () => void
  closeProfile(profileId: string): Promise<() => void>
  refresh(): Promise<void>
  replaceThresholds(thresholds: readonly number[]): Promise<void>
  start(): void
  pause(): void
  closeAdmission(): void
  settled(): Promise<void>
}

interface SubscriptionUsageServicePoolOptions {
  /** Initial monitoring policy; every later replacement belongs to this pool. */
  readonly thresholds?: readonly number[]
  readonly create: (profile: SubscriptionUsageProfile, thresholds: readonly number[]) => SubscriptionUsageService
}

interface PoolEntry {
  readonly profile: SubscriptionUsageProfile
  readonly service: SubscriptionUsageService
  readonly unsubscribe: () => void
  leases: number
  closing: Promise<void> | undefined
  settlementLeases: number
  settlementWaiter: (() => void) | undefined
}

interface ProfileClosure {
  readonly settled: Promise<() => void>
  readonly admission: Promise<void>
}

/** The refusal of a pool that its owner closed for shutdown. It is an abort,
 *  not a failure, so work that the shutdown overtook settles quietly. */
function closedPoolRefusal(): DOMException {
  return new DOMException("subscription usage service pool is closed", "AbortError")
}

/** Owns one immutable service generation for each leased resolved profile. */
export function createSubscriptionUsageServicePool(options: SubscriptionUsageServicePoolOptions): SubscriptionUsageServicePool {
  const entries = new Map<string, PoolEntry>()
  let closed = false
  let started = false
  let thresholds = Object.freeze([...(options.thresholds ?? [])])
  let shutdown: Promise<void> | undefined
  const profileClosures = new Map<string, ProfileClosure>()
  const publicationListeners = new Set<SubscriptionUsagePublicationListener>()

  const closeEntry = (entry: PoolEntry): Promise<void> => {
    if (entry.closing !== undefined) return entry.closing
    entry.service.closeAdmission()
    entry.closing = (async () => {
      if (entry.settlementLeases > 0) await new Promise<void>((resolve) => { entry.settlementWaiter = resolve })
      await entry.service.settled()
    })().finally(() => {
      entry.unsubscribe()
      if (entries.get(entry.profile.id) === entry) entries.delete(entry.profile.id)
    })
    return entry.closing
  }

  const acquire = async (profile: SubscriptionUsageProfile): Promise<SubscriptionUsageServiceLease> => {
    if (closed) throw closedPoolRefusal()
    const closure = profileClosures.get(profile.id)
    if (closure !== undefined) {
      await closure.admission
      return acquire(profile)
    }
    let entry = entries.get(profile.id)
    if (entry?.closing !== undefined) {
      try {
        await entry.closing
      } catch {
        // A failed generation close is replaced before new work is admitted.
      }
      if (closed) throw closedPoolRefusal()
      return acquire(profile)
    }
    if (entry !== undefined && entry.profile.directory !== profile.directory) {
      throw new Error(`subscription usage profile directory changed for ${profile.id}`)
    }
    if (entry === undefined) {
      const captured = Object.freeze({ ...profile })
      const service = options.create(captured, thresholds)
      entry = {
        profile: captured,
        service,
        leases: 0,
        closing: undefined,
        settlementLeases: 0,
        settlementWaiter: undefined,
        unsubscribe: service.onPublished(() => {
          for (const listener of publicationListeners) listener(captured, service)
        }),
      }
      entries.set(captured.id, entry)
      if (started) service.start()
    }
    entry.leases += 1
    let released = false
    return Object.freeze({
      profile: entry.profile,
      service: entry.service,
      release: async () => {
        if (released) return
        released = true
        entry.leases -= 1
        if (entry.leases === 0) await closeEntry(entry)
      },
    })
  }
  const acquireSettlement = async (profile: SubscriptionUsageProfile): Promise<SubscriptionUsageServiceLease> => {
    const lease = await acquire(profile)
    const entry = entries.get(profile.id)
    if (!entry || entry.service !== lease.service || entry.closing !== undefined) {
      await lease.release()
      throw new Error(`usage settlement admission is closed for profile ${profile.id}`)
    }
    entry.settlementLeases += 1
    let released = false
    return Object.freeze({
      ...lease,
      release: async () => {
        if (released) return
        released = true
        entry.settlementLeases -= 1
        if (entry.settlementLeases === 0) {
          entry.settlementWaiter?.()
          entry.settlementWaiter = undefined
        }
        await lease.release()
      },
    })
  }

  const closeProfile = (profileId: string): Promise<() => void> => {
    const active = profileClosures.get(profileId)
    if (active !== undefined) return active.settled
    let admit: (() => void) | undefined
    const admission = new Promise<void>((resolve) => { admit = resolve })
    let released = false
    const finish = (): void => {
      if (released) return
      released = true
      profileClosures.delete(profileId)
      admit?.()
    }
    const settled = Promise.resolve().then(async () => {
      const entry = entries.get(profileId)
      if (entry !== undefined) await closeEntry(entry)
      return finish
    }).catch((error: unknown) => {
      finish()
      throw error
    })
    profileClosures.set(profileId, { settled, admission })
    return settled
  }

  return {
    acquire,
    acquireSettlement,
    onPublished: (listener) => {
      if (closed) return () => {}
      publicationListeners.add(listener)
      return () => { publicationListeners.delete(listener) }
    },
    closeProfile,
    refresh: async () => { await Promise.all([...entries.values()].filter((entry) => entry.closing === undefined).map((entry) => entry.service.refresh())); },
    replaceThresholds: async (next) => {
      thresholds = Object.freeze([...next])
      await Promise.all([...entries.values()].filter((entry) => entry.closing === undefined).map((entry) => entry.service.replaceThresholds(thresholds)))
    },
    start: () => {
      if (closed || started) return
      started = true
      for (const entry of entries.values()) entry.service.start()
    },
    pause: () => {
      started = false
      for (const entry of entries.values()) entry.service.pause()
    },
    closeAdmission: () => {
      if (closed) return
      closed = true
      shutdown = Promise.all([...entries.values()].map(closeEntry)).then(() => undefined)
    },
    settled: async () => {
      if (!closed) {
        closed = true
        shutdown = Promise.all([...entries.values()].map(closeEntry)).then(() => undefined)
      }
      await shutdown
    },
  }
}
