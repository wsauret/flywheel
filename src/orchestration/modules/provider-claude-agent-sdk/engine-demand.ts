import { Effect, Scope } from "effect";
import type { Claim, ProviderDemand } from "../../agent-runtime/llm/types.js";
import type { HostLease } from "./agent-host/host-registry.js";
import { registerLiveBridge } from "./live-bridges.js";

/**
 * Tells the session whose demand is `demand` to plan again after an engine end that a plan can repair: a release
 * because the module was turned off (`drained`), whose next plan routes elsewhere, or the end of an engine that
 * answered a request (`served`). An engine that ended before it
 * served, such as one that a usage limit or a lost login ended at its start, would end again, so its end stays silent
 * and the next show, role change, or turn end tries again. Each end asks at most once.
 */
export function reportEngineEnd(demand: ProviderDemand | undefined, end: { readonly drained: boolean; readonly served: boolean }): void {
  if (end.drained || end.served) demand?.stale();
}

/** One claim that takes effect once: `release` runs on its first call only. */
export function onceClaim(release: () => Promise<void>): Claim {
  let released = false;
  return {
    release: () => {
      if (released) return Promise.resolve();
      released = true;
      return release();
    },
  };
}

/** The claims on one host of a session: the one lease that they share, and the claims that hold it. */
interface HostDemand {
  readonly lease: HostLease;
  readonly claims: Set<Claim>;
}

/**
 * What the claims of one session (`ProviderDemand`) hold in this module beyond the chat bridge, whose claims its
 * reservation holds (bridge-reservation.ts): one registry lease, and one listener of its end, for each distinct host
 * place that any of the session's role selections anticipates. A claim on a place shares its lease, so any number of
 * roles on one place hold one host, and that host's end asks for one plan (`reportEngineEnd`). What it holds lives in
 * the demand's scope, not a client's, so a client that a newer one replaces keeps none of it from the session. The
 * module turned off ends every lease at once, because a shown session's claim serves no request, and asks for one
 * plan.
 */
interface SessionEngineDemand {
  /** Claims the host of the place whose key is `key`. The first claim on a place leases its host with `lease`; the
   *  release of the last claim ends that lease. A claim on a host that ended holds nothing. */
  claimHost(key: string, lease: () => HostLease): Claim;
}

const demands = new WeakMap<ProviderDemand, SessionEngineDemand>();

/** The module's demand of the session whose engine demand is `demand`, made on its first claim. */
export function sessionEngineDemand(demand: ProviderDemand): SessionEngineDemand {
  const known = demands.get(demand);
  if (known !== undefined) return known;
  const hosts = new Map<string, HostDemand>();
  /** Ends the lease of `key`'s host when `entry` holds it now; a later end of the same host finds nothing. */
  const drop = (key: string, entry: HostDemand): Promise<void> => {
    if (hosts.get(key) !== entry) return Promise.resolve();
    hosts.delete(key);
    return entry.lease.release();
  };
  const dropAll = () => Promise.all([...hosts].map(([key, entry]) => drop(key, entry)));
  const unregister = registerLiveBridge(() => {
    if (hosts.size === 0) return;
    void dropAll();
    reportEngineEnd(demand, { drained: true, served: false });
  });
  // The session's owner releases its claims when no client shows it; the demand's end releases what is left.
  Effect.runSync(Scope.addFinalizer(demand.scope, Effect.promise(() => {
    unregister();
    return dropAll();
  })));
  const created: SessionEngineDemand = {
    claimHost(key, lease) {
      let entry = hosts.get(key);
      if (entry === undefined) {
        const opened: HostDemand = { lease: lease(), claims: new Set() };
        hosts.set(key, opened);
        const { host } = opened.lease;
        void host.ended.then(() => {
          if (hosts.get(key) !== opened) return;
          void drop(key, opened);
          reportEngineEnd(demand, { drained: false, served: host.served });
        });
        entry = opened;
      }
      const held = entry;
      const claim = onceClaim(async () => {
        held.claims.delete(claim);
        if (held.claims.size === 0) await drop(key, held);
      });
      held.claims.add(claim);
      return claim;
    },
  };
  demands.set(demand, created);
  return created;
}
