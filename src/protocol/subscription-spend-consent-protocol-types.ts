import { createHash } from "node:crypto";
import type { SubscriptionSpendConsentStatus } from "../infra/auth/subscription-spend-consent.js";
import type { SubscriptionUsageSpendSource } from "../infra/llm/subscription-usage.js";
import type { RuntimePosition } from "./runtime-ui-protocol-types.js";

export const SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE = "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." as const;

/** Creates a protocol-only opaque join key. The serialized value cannot reveal the credential identifier. */
export function subscriptionSpendAccountCorrelationId(profileId: string, providerId: string, instanceId: string): string {
  return `v1:${createHash("sha256").update(`${profileId}\0${providerId}\0${instanceId}`, "utf8").digest("hex")}`;
}

interface SubscriptionSpendConsentProtocolMode {
  readonly mode: "prepaid" | "automatic";
  readonly envelopeId: string;
  readonly evidence: SubscriptionUsageSpendSource;
  readonly decision: SubscriptionSpendConsentStatus;
}

interface SubscriptionSpendConsentProtocolAccount {
  readonly accountCorrelationId: string;
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly billingUrl?: string;
  readonly label?: string;
  readonly plan?: string;
  readonly tier?: string;
  readonly providerStatus: "ok" | "warning" | "exhausted" | "unknown";
  readonly modes: readonly SubscriptionSpendConsentProtocolMode[];
}

export type SubscriptionSpendConsentView =
  | { readonly kind: "available"; readonly profileId: string; readonly usageGeneration: number; readonly authorityIncarnation: string; readonly authorityRevision: number; readonly accounts: readonly SubscriptionSpendConsentProtocolAccount[] }
  | { readonly kind: "unavailable"; readonly profileId: string; readonly message: typeof SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE };

export function subscriptionSpendConsentEnvelopeIds(view: Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>): readonly string[] {
  return view.accounts.flatMap((account) => account.modes.map((mode) => mode.envelopeId));
}

/** Positive provider evidence with no recorded decision: the one state that asks a question. */
export function paidModeAwaitsAnswer(mode: { readonly evidence: SubscriptionUsageSpendSource; readonly decision: SubscriptionSpendConsentStatus }): boolean {
  if (mode.decision !== "unreviewed") return false;
  return mode.evidence.kind === "prepaid"
    ? mode.evidence.availability === "funded" || mode.evidence.availability === "available" || mode.evidence.availability === "unlimited"
    : mode.evidence.enablement === "enabled";
}

export function subscriptionSpendConsentNeedsReview(view: SubscriptionSpendConsentView): boolean {
  return view.kind === "available" && view.accounts.some((account) => account.modes.some(paidModeAwaitsAnswer));
}

interface SubscriptionSpendConsentMutationBase {
  readonly profileId: string;
  readonly usageGeneration: number;
  readonly authorityIncarnation: string;
  readonly authorityRevision: number;
  readonly clientSnapshotPosition: RuntimePosition;
  readonly envelopeIds: readonly string[];
}

export type SubscriptionSpendConsentMutation = SubscriptionSpendConsentMutationBase & {
  readonly type: "subscription_spend_consent.save";
  readonly reviewedEnvelopeIds: readonly string[];
  readonly acceptedEnvelopeIds: readonly string[];
};

export type SubscriptionSpendConsentMutationResult =
  | { readonly kind: "committed"; readonly consent: SubscriptionSpendConsentView }
  | { readonly kind: "stale" }
  | { readonly kind: "contention" }
  | { readonly kind: "invalid-envelope" }
  | { readonly kind: "storage-failure" };
