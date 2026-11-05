import { accessProviderAccountKey, type AccessProviderDefinition, type SubscriptionPlanReading } from "./access-provider.js";

/** The one statement of PI-MODEL-038, PI-MODEL-069: only paid subscription accounts rotate. A profile holds at most one free-plan
 *  account of a provider, and a free-plan account serves only while it is the only account of its provider. */

/** The question a person answers before a paid account replaces the free-plan accounts of its provider. */
export const FREE_PLAN_REPLACE_QUESTION = "This will replace your attached free subscription because we only allow multiple copies of paid subscriptions.";

/** Whether `reading` names a free plan of the provider that `definition` declares. A reading that names no plan, and a
 *  provider that declares no free plan, count as paid. */
export function isFreePlan(definition: Pick<AccessProviderDefinition, "usage"> | undefined, reading: SubscriptionPlanReading): boolean {
  return definition?.usage?.freePlan?.(reading) === true;
}

/** What is known of one account's plan: the latest usage reading of its current identity, which can name no plan,
 *  or nothing, because no reading of that identity exists or it could not be read. */
export type PlanEvidence =
  | { readonly kind: "read"; readonly reading: SubscriptionPlanReading }
  | { readonly kind: "unavailable" };

/** One stored subscription account, as the rule reads it. */
export interface PlanAccount {
  readonly providerId: string;
  readonly instanceId: string;
  readonly identity?: string;
}

/** A free-plan account that does not serve, with the identity whose plan decided it. */
export interface IdleFreePlanMark {
  readonly identity?: string;
}

/** The marks of the free-plan accounts that do not serve, by account key (`accessProviderAccountKey`), because each
 *  sits beside another account of its provider. `accounts` holds every stored account of the profile. `evidence` is
 *  asked only for the named accounts of a provider that declares a free plan and holds more than one account. An
 *  account without evidence keeps the mark that `previous` gives it while its identity is the one that mark was
 *  decided for, so a reading that fails never makes a known free-plan account serve again, and a reconnect as another
 *  identity never inherits the mark of the identity it replaced. */
export function idleFreePlanAccounts(
  accounts: Iterable<PlanAccount>,
  evidence: (account: PlanAccount) => PlanEvidence,
  definition: (providerId: string) => Pick<AccessProviderDefinition, "usage"> | undefined,
  previous: ReadonlyMap<string, IdleFreePlanMark>,
): ReadonlyMap<string, IdleFreePlanMark> {
  const idle = new Map<string, IdleFreePlanMark>();
  for (const [providerId, provided] of Map.groupBy(accounts, (account) => account.providerId)) {
    const declared = definition(providerId);
    if (declared?.usage?.freePlan === undefined || new Set(provided.map(({ instanceId }) => instanceId)).size < 2) continue;
    for (const account of provided) {
      const key = accessProviderAccountKey({ kind: "subscription", providerId, instanceId: account.instanceId });
      const known = evidence(account);
      const kept = previous.get(key);
      const free = known.kind === "read" ? isFreePlan(declared, known.reading) : kept !== undefined && kept.identity === account.identity;
      if (free) idle.set(key, account.identity === undefined ? {} : { identity: account.identity });
    }
  }
  return idle;
}
