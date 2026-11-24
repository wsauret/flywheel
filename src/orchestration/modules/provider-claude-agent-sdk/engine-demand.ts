import type { Claim, ProviderDemand } from "../../agent-runtime/llm/types.js";

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
