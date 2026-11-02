import { createHash } from "node:crypto";

export interface SubscriptionAccountIdentity {
  readonly providerId: string;
  readonly instanceId: string;
  readonly subjectDigest: string;
}

interface SubscriptionAccountSubject {
  readonly providerId: string;
  readonly instanceId: string;
  readonly identity?: string;
}

export type SubscriptionAccountRef = SubscriptionAccountSubject | SubscriptionAccountIdentity;

/** Returns the versioned, secret-free identity shared by subscription usage and consent. */
export function createSubscriptionAccountIdentity(providerId: string, instanceId: string, subject: string): SubscriptionAccountIdentity {
  requireIdentityPart(providerId, "providerId");
  requireIdentityPart(instanceId, "instanceId");
  requireIdentityPart(subject, "subject");
  return { providerId, instanceId, subjectDigest: subscriptionSubjectDigest(subject) };
}

/** Hashes a provider subject without retaining its raw value. */
export function subscriptionSubjectDigest(subject: string): string {
  requireIdentityPart(subject, "subject");
  return `v1:${createHash("sha256").update(subject, "utf8").digest("hex")}`;
}

/** Normalizes either a raw boundary account or an already canonical identity. */
export function subscriptionAccountIdentityFromRef(ref: SubscriptionAccountRef): SubscriptionAccountIdentity {
  if ("subjectDigest" in ref) {
    requireIdentityPart(ref.providerId, "providerId");
    requireIdentityPart(ref.instanceId, "instanceId");
    requireSubjectDigest(ref.subjectDigest);
    return { providerId: ref.providerId, instanceId: ref.instanceId, subjectDigest: ref.subjectDigest };
  }
  if (ref.identity === undefined) throw new Error("subscription account identity is unavailable");
  return createSubscriptionAccountIdentity(ref.providerId, ref.instanceId, ref.identity);
}

export function subscriptionAccountIdentityKey(identity: SubscriptionAccountIdentity): string {
  return `${identity.providerId}\u0000${identity.instanceId}\u0000${identity.subjectDigest}`;
}

function requireIdentityPart(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error(`subscription account ${field} must be non-empty`);
}

function requireSubjectDigest(value: string): void {
  if (!/^v1:[a-f0-9]{64}$/.test(value)) throw new Error("subscription account subjectDigest is invalid");
}
