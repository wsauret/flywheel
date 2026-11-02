import { createHash } from "node:crypto";
import { subscriptionAccountIdentityKey, type SubscriptionAccountIdentity } from "../llm/subscription-account-identity.js";

export type SubscriptionSpendMode = "prepaid" | "automatic";
export type SubscriptionSpendDecision = "accepted" | "declined";
export type SubscriptionSpendConsentStatus = SubscriptionSpendDecision | "unreviewed";

export interface SubscriptionSpendEnvelope extends SubscriptionAccountIdentity {
  readonly id: string;
  readonly profileId: string;
  readonly mode: SubscriptionSpendMode;
}

export interface SubscriptionSpendEnvelopeState {
  readonly envelope: SubscriptionSpendEnvelope;
  readonly status: SubscriptionSpendConsentStatus;
}

/** Creates the exact profile, account, and spend-mode identity used by durable consent. */
export function createSubscriptionSpendEnvelope(profileId: string, account: SubscriptionAccountIdentity, mode: SubscriptionSpendMode): SubscriptionSpendEnvelope {
  if (profileId.length === 0) throw new Error("subscription spend consent profileId must be non-empty");
  if (mode !== "prepaid" && mode !== "automatic") throw new Error("subscription spend consent mode is invalid");
  const identity = `${profileId}\u0000${subscriptionAccountIdentityKey(account)}\u0000${mode}`;
  return { ...account, profileId, mode, id: `v1:${createHash("sha256").update(identity, "utf8").digest("hex")}` };
}

export function isCanonicalSubscriptionSpendEnvelope(envelope: SubscriptionSpendEnvelope): boolean {
  try {
    return createSubscriptionSpendEnvelope(envelope.profileId, envelope, envelope.mode).id === envelope.id;
  } catch {
    return false;
  }
}
