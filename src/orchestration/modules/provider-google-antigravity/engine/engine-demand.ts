import { Effect, Scope } from "effect"
import type { Claim, ProviderDemand } from "../../../agent-runtime/llm/types.js"
import type { EngineLease, RegisteredEngine } from "./engine-registry.js"
import { registerLiveEngine } from "./live-engines.js"

/**
 * Tells the session whose demand is `demand` to plan again after an engine end that a plan can repair: a release
 * because the module was turned off (`drained`), whose next plan routes elsewhere, or the end of an engine that
 * answered a prompt (`served`). An engine that ended before it served, such as one whose launch failed, would end
 * again, so its end stays silent and the next show, role change, or turn end tries again. Each end asks at most once.
 */
function reportEngineEnd(demand: ProviderDemand | undefined, end: { readonly drained: boolean; readonly served: boolean }): void {
  if (end.drained || end.served) demand?.stale()
}

/** One claim that takes effect once: `release` runs on its first call only. */
function onceClaim(release: () => Promise<void>): Claim {
  let released = false
  return {
    release: () => {
      if (released) return Promise.resolve()
      released = true
      return release()
    },
  }
}

/** The claims on one place's engine of a session: the one lease that they share, and the claims that hold it. */
interface PlaceDemand {
  readonly lease: EngineLease<RegisteredEngine>
  readonly claims: Set<Claim>
}

/**
 * What the claims of one session (`ProviderDemand`) hold in this module: one registry lease for each distinct place
 * (`EnginePlace`, a chat tree on a login) that any of the session's role selections anticipates, whose engine the first
 * claim launches ahead of the request (ARCH-PROVIDERS-068). Every claim on a place shares its lease, so any number of
 * roles on one place hold one engine, and that engine's end asks for one plan (`reportEngineEnd`). A caller that moves
 * a role to another selection claims the new place before it releases the old claim, so an engine that both places
 * share never closes between them. What a demand holds lives in the demand's scope, not a client's. The module turned
 * off ends every lease at once, because a shown session's claim serves no request, and asks for one plan.
 */
interface SessionEngineDemand {
  /** Claims the engine of the place whose key is `key`. The first claim on a place leases it with `lease` and launches
   *  its engine; the release of the last claim ends that lease. A claim on an engine that ended holds nothing. */
  claimEngine(key: string, lease: () => EngineLease<RegisteredEngine>): Claim
}

const demands = new WeakMap<ProviderDemand, SessionEngineDemand>()

/** The module's demand of the session whose engine demand is `demand`, made on its first claim. */
export function sessionEngineDemand(demand: ProviderDemand): SessionEngineDemand {
  const known = demands.get(demand)
  if (known !== undefined) return known
  const places = new Map<string, PlaceDemand>()
  /** Ends the lease of `key`'s place when `entry` holds it now; a later end of the same engine finds nothing. */
  const drop = (key: string, entry: PlaceDemand): Promise<void> => {
    if (places.get(key) !== entry) return Promise.resolve()
    places.delete(key)
    return entry.lease.release()
  }
  const dropAll = () => Promise.all([...places].map(([key, entry]) => drop(key, entry)))
  const unregister = registerLiveEngine(() => {
    if (places.size === 0) return
    void dropAll()
    reportEngineEnd(demand, { drained: true, served: false })
  })
  Effect.runSync(Scope.addFinalizer(demand.scope, Effect.promise(() => {
    unregister()
    return dropAll()
  })))
  const created: SessionEngineDemand = {
    claimEngine(key, lease) {
      let entry = places.get(key)
      if (entry === undefined) {
        const opened: PlaceDemand = { lease: lease(), claims: new Set() }
        places.set(key, opened)
        void opened.lease.engine().then(async (engine) => {
          const end = await engine.ended
          if (places.get(key) !== opened) return
          void drop(key, opened)
          reportEngineEnd(demand, { drained: false, served: end.served })
        }, () => {
          // A launch that failed never served: the claim holds nothing, and the next plan tries again.
          void drop(key, opened)
        })
        entry = opened
      }
      const held = entry
      const claim = onceClaim(async () => {
        held.claims.delete(claim)
        if (held.claims.size === 0) await drop(key, held)
      })
      held.claims.add(claim)
      return claim
    },
  }
  demands.set(demand, created)
  return created
}
