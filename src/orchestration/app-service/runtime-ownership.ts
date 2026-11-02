import { shutdownOwner, type RuntimeShutdownOwners, type RuntimeShutdownPhase } from "./runtime-shutdown.js"

interface OwnedResource {
  readonly name: string
  readonly settle: () => Promise<void>
  readonly reserved: boolean
  unit: string | undefined
  adoptedSettlement: (() => Promise<void>) | undefined
  settlementStarted: boolean
}

interface OwnershipUnit {
  readonly owner: string
  readonly phase: RuntimeShutdownPhase
  readonly resources: readonly OwnedResource[]
}

export interface RuntimeOwnership {
  own<T>(name: string, resource: T, dispose: (owned: T) => Promise<void> | void): T
  /** Pre-register a stable shutdown position for a demand-started child resource. */
  reserve(name: string): void
  /** Atomically transfer a child's acquired resources into matching reserved positions. */
  adopt(child: RuntimeOwnership): void
  /** Give one resource's stable disposer to its own shutdown unit. */
  shutdown(name: string, phase: RuntimeShutdownPhase): void
  /** Bind resources to one owner that settles them in the stated order. */
  sequence(owner: string, phase: RuntimeShutdownPhase, resources: readonly string[]): void
  /** Start or join one acquisition's stable settlement. A settlement that
   *  rejected is started again by the next call. */
  settle(name: string): Promise<void>
  /** Publish the complete normal-shutdown graph. Unassigned acquisitions fail. */
  complete(): RuntimeShutdownOwners
  /** Release every acquired resource in reverse order after construction fails. */
  releaseAcquired(): Promise<void>
}

interface OwnershipState {
  readonly acquired: OwnedResource[]
  readonly byName: Map<string, OwnedResource>
  readonly units: OwnershipUnit[]
  completed: boolean
  transferred: boolean
}

const ownershipStates = new WeakMap<RuntimeOwnership, OwnershipState>()

/** Owns every runtime acquisition until it belongs to one ordered shutdown unit
 * or construction rolls back. Both paths use the same settlement, which runs
 * once when it succeeds; a release that failed runs again at the next ask. */
export function createRuntimeOwnership(onRollbackError: (error: unknown) => void): RuntimeOwnership {
  const state: OwnershipState = {
    acquired: [],
    byName: new Map(),
    units: [],
    completed: false,
    transferred: false,
  }

  function ownedResource(name: string): OwnedResource {
    const owned = state.byName.get(name)
    if (owned === undefined) throw new Error(`Runtime ownership has no resource '${name}'`)
    return owned
  }

  function assign(owner: string, phase: RuntimeShutdownPhase, names: readonly string[]): void {
    if (state.completed || state.transferred) throw new Error("Runtime ownership is already complete")
    if (names.length === 0) throw new Error(`Runtime shutdown owner '${owner}' has no resources`)
    if (new Set(names).size !== names.length) throw new Error(`Runtime shutdown owner '${owner}' contains a resource more than once`)
    const resources = names.map((name) => {
      const owned = ownedResource(name)
      if (owned.unit !== undefined) throw new Error(`Runtime resource '${name}' already belongs to '${owned.unit}'`)
      return owned
    })
    if (state.units.some((unit) => unit.owner === owner)) throw new Error(`Runtime shutdown owner '${owner}' is duplicated`)
    for (const resource of resources) resource.unit = owner
    state.units.push({ owner, phase, resources })
  }

  function register(name: string, reserved: boolean, settlement: (() => Promise<void>) | undefined): void {
    if (state.completed || state.transferred) throw new Error("Runtime ownership is already complete")
    if (state.byName.has(name)) throw new Error(`Runtime ownership already contains '${name}'`)
    let stableSettlement: Promise<void> | undefined
    const owned: OwnedResource = {
      name,
      reserved,
      unit: undefined,
      adoptedSettlement: settlement,
      settlementStarted: false,
      settle: () => {
        owned.settlementStarted = true
        if (stableSettlement === undefined) {
          const release = owned.adoptedSettlement?.() ?? Promise.resolve()
          release.catch(() => { if (stableSettlement === release) stableSettlement = undefined })
          stableSettlement = release
        }
        return stableSettlement
      },
    }
    state.acquired.push(owned)
    state.byName.set(name, owned)
  }

  const ownership: RuntimeOwnership = {
    own<T>(name: string, value: T, dispose: (owned: T) => Promise<void> | void): T {
      register(name, false, () => Promise.resolve().then(() => dispose(value)))
      return value
    },
    reserve: (name) => { register(name, true, undefined) },
    adopt(child) {
      const childState = ownershipStates.get(child)
      if (childState === undefined) throw new Error("Runtime ownership can only adopt a runtime ownership child")
      if (childState.completed || childState.transferred) throw new Error("Child runtime ownership is already complete")
      const transfers = childState.acquired.map((resource) => {
        if (resource.reserved) throw new Error(`Child runtime resource '${resource.name}' has no acquisition`)
        if (resource.unit !== undefined) throw new Error(`Child runtime resource '${resource.name}' already belongs to '${resource.unit}'`)
        const position = state.byName.get(resource.name)
        if (position === undefined || !position.reserved) {
          throw new Error(`Runtime ownership has no reserved position '${resource.name}'`)
        }
        if (position.adoptedSettlement !== undefined) {
          throw new Error(`Runtime reserved position '${resource.name}' is already occupied`)
        }
        if (position.settlementStarted) {
          throw new Error(`Runtime reserved position '${resource.name}' is already settling`)
        }
        return { position, resource }
      })
      for (const { position, resource } of transfers) position.adoptedSettlement = resource.settle
      childState.transferred = true
    },
    shutdown: (name, phase) => { assign(name, phase, [name]) },
    sequence: assign,
    settle: (name) => ownedResource(name).settle(),
    complete() {
      if (state.completed || state.transferred) throw new Error("Runtime ownership is already complete")
      const unassigned = state.acquired.filter((owned) => owned.unit === undefined).map((owned) => owned.name)
      if (unassigned.length > 0) throw new Error(`Runtime resources have no shutdown owner: ${unassigned.join(", ")}`)
      state.completed = true
      const owners: RuntimeShutdownOwners = {}
      for (const unit of state.units) {
        const owner = shutdownOwner(unit.owner, async () => {
          for (const resource of unit.resources) await resource.settle()
        })
        owners[unit.phase] = [...(owners[unit.phase] ?? []), owner]
      }
      return owners
    },
    async releaseAcquired(): Promise<void> {
      if (state.transferred) return
      for (const owned of state.acquired.toReversed()) {
        try {
          await owned.settle()
        } catch (error) {
          onRollbackError(error)
        }
      }
    },
  }
  ownershipStates.set(ownership, state)
  return ownership
}
