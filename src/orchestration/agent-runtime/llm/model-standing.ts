import { candidateProviderId, type AdmittedFailoverPlan } from "../../../infra/llm/access-provider.js";
import type { CapacityReset } from "../../../infra/llm/provider-error-copy.js";
import { candidateReadiness, type CandidateReadinessInputs } from "./failover-client.js";

/** The quota that a model's routes spent until a stated time: the earliest such time, and the providers that state it. */
export interface SpentQuota {
  readonly reset: CapacityReset;
  readonly providers: readonly string[];
}

/** Whether one model can serve an agent's next request now, judged by the walk's own readiness rule
 *  (ARCH-PROVIDERS-080). A route is usable when it is ready, waits on a recheck, or is held only by a condition that
 *  clears by itself or states no reset time (PI-MODEL-060). `serves`: an included route is usable. `paid`: only a
 *  paid route is usable. `spent`: no route is usable until `spent.reset`. `unusable`: every route is ineligible, for
 *  example under the role's provider options, and no known time changes that. A `paid` standing names the quota that
 *  its other routes spent until a stated time, if any. */
export type ModelStanding =
  | { readonly kind: "serves" }
  | { readonly kind: "paid"; readonly spent?: SpentQuota }
  | { readonly kind: "spent"; readonly spent: SpentQuota }
  | { readonly kind: "unusable" };

const SERVES: ModelStanding = { kind: "serves" };

/** Decides `plan`'s standing from the request's captured availability, under the role's provider options in
 *  `inputs`. It claims no probe and builds no adapter. */
export function modelStanding(
  plan: AdmittedFailoverPlan,
  inputs: Omit<CandidateReadinessInputs, "family">,
  shortName: (providerId: string) => string,
): ModelStanding {
  const readinessInputs = { ...inputs, family: plan.family };
  let paidServes = false;
  const spent: { readonly reset: CapacityReset; readonly provider: string }[] = [];
  for (const attribution of plan.candidateAttributions) {
    const readiness = candidateReadiness(attribution.candidate, readinessInputs);
    const state = readiness.kind === "refused" ? readiness.state : undefined;
    if (state?.reason === "ineligible") continue;
    const stated = state?.reason === "quota" && state.reset?.hold.kind === "usage_limit" && state.reset.hold.stated ? state.reset : undefined;
    if (stated !== undefined) spent.push({ reset: stated, provider: shortName(candidateProviderId(attribution.candidate)) });
    else if (attribution.candidate.spendMode === "included" || attribution.routeKind === "free") return SERVES;
    else paidServes = true;
  }
  const earliest = spent.reduce<CapacityReset | undefined>((held, entry) => held === undefined || entry.reset.atMs < held.atMs ? entry.reset : held, undefined);
  const quota = earliest === undefined ? undefined : { reset: earliest, providers: [...new Set(spent.map((entry) => entry.provider))] };
  if (paidServes) return quota === undefined ? { kind: "paid" } : { kind: "paid", spent: quota };
  return quota === undefined ? { kind: "unusable" } : { kind: "spent", spent: quota };
}
