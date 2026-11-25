export interface ProfileRuntimeSnapshot<Snapshot> {
  readonly profileId: string
  readonly generation: number
  readonly snapshot: Snapshot
}

export interface ProfileRuntimeStateOwner<Snapshot> {
  /** Allocates a generation for synchronous state derived before publication. */
  create(profileId: string, build: (generation: number) => Snapshot): ProfileRuntimeSnapshot<Snapshot>
  /** Runs one preparation per profile and publishes only its newest result. */
  prepare(profileId: string, build: () => Promise<Snapshot>): Promise<ProfileRuntimeSnapshot<Snapshot>>
  /** Publishes a previously allocated snapshot if it is still current. */
  publish(snapshot: ProfileRuntimeSnapshot<Snapshot>): boolean
  /** Reads the latest snapshot for a profile, or the latest published profile. */
  current(profileId?: string): ProfileRuntimeSnapshot<Snapshot> | undefined
  /** Clears all owned snapshots and joins preparations already in flight. */
  dispose(): Promise<void>
}

export interface ProfileRuntimeStateOwnerOptions<Snapshot> {
  readonly publish?: (snapshot: ProfileRuntimeSnapshot<Snapshot>) => void
}

/** Owns secret-free runtime snapshots by profile. Generations are allocated at
 * preparation start, so a slower older preparation cannot replace a newer one. */
export function createProfileRuntimeStateOwner<Snapshot>(
  options: ProfileRuntimeStateOwnerOptions<Snapshot> = {},
): ProfileRuntimeStateOwner<Snapshot> {
  let generation = 0
  let disposed = false
  let latest: ProfileRuntimeSnapshot<Snapshot> | undefined
  const snapshots = new Map<string, ProfileRuntimeSnapshot<Snapshot>>()
  const preparations = new Map<string, Promise<ProfileRuntimeSnapshot<Snapshot>>>()

  const create = (profileId: string, build: (generation: number) => Snapshot): ProfileRuntimeSnapshot<Snapshot> => {
    if (disposed) throw new Error("profile runtime state is disposed")
    const nextGeneration = ++generation
    return Object.freeze({ profileId, generation: nextGeneration, snapshot: build(nextGeneration) })
  }

  const publish = (snapshot: ProfileRuntimeSnapshot<Snapshot>): boolean => {
    if (disposed) return false
    const profileLatest = snapshots.get(snapshot.profileId)
    if (profileLatest !== undefined && snapshot.generation <= profileLatest.generation) return false
    snapshots.set(snapshot.profileId, snapshot)
    if (latest === undefined || snapshot.generation > latest.generation) latest = snapshot
    options.publish?.(snapshot)
    return true
  }

  const prepare = (profileId: string, build: () => Promise<Snapshot>): Promise<ProfileRuntimeSnapshot<Snapshot>> => {
    if (disposed) return Promise.reject(new Error("profile runtime state is disposed"))
    const pending = preparations.get(profileId)
    if (pending !== undefined) return pending
    const operation = (async () => {
      const nextGeneration = ++generation
      const value = await build()
      const snapshot = Object.freeze({ profileId, generation: nextGeneration, snapshot: value })
      publish(snapshot)
      return snapshot
    })()
    preparations.set(profileId, operation)
    void operation.then(() => {
      if (preparations.get(profileId) === operation) preparations.delete(profileId)
    }, () => {
      if (preparations.get(profileId) === operation) preparations.delete(profileId)
    })
    return operation
  }

  return {
    create,
    prepare,
    publish,
    current: (profileId) => profileId === undefined ? latest : snapshots.get(profileId),
    async dispose(): Promise<void> {
      disposed = true
      snapshots.clear()
      latest = undefined
      await Promise.allSettled(preparations.values())
      preparations.clear()
    },
  }
}
