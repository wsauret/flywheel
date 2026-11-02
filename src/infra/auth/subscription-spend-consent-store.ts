import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AuthProfileAccess } from "./auth-profile-store.js";
import { subscriptionAccountIdentityKey, type SubscriptionAccountIdentity } from "../llm/subscription-account-identity.js";
import { createSubscriptionSpendEnvelope, isCanonicalSubscriptionSpendEnvelope, type SubscriptionSpendDecision, type SubscriptionSpendEnvelope, type SubscriptionSpendEnvelopeState } from "./subscription-spend-consent.js";

export const SUBSCRIPTION_SPEND_CONSENT_FILE = "subscription-spend-consent-v1.sqlite";
const PROTOCOL_VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;

export class SubscriptionSpendConsentCorruptError extends Error {
  readonly _tag = "SubscriptionSpendConsentCorruptError" as const;
}

export class SubscriptionSpendConsentStaleError extends Error {
  readonly _tag = "SubscriptionSpendConsentStaleError" as const;
}

export type SubscriptionSpendConsentRevision =
  | { readonly kind: "missing" }
  | { readonly kind: "content"; readonly digest: string };

export interface SubscriptionSpendConsentSnapshot {
  readonly profileId: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly envelopes: readonly SubscriptionSpendEnvelopeState[];
}

interface SubscriptionSpendConsentMutation {
  readonly expectedIncarnation: string;
  readonly expectedRevision: number;
  readonly envelopes: readonly SubscriptionSpendEnvelope[];
  readonly acceptedEnvelopeIds: readonly string[];
  readonly reviewedEnvelopeIds: readonly string[];
  readonly isEvidenceCurrent?: () => boolean;
}


/** Reads the bounded authority bytes without taking the profile lock. */
export function subscriptionSpendConsentRevision(access: AuthProfileAccess): SubscriptionSpendConsentRevision {
  const bytes = access.readFile(SUBSCRIPTION_SPEND_CONSENT_FILE, MAX_BYTES);
  return bytes === undefined
    ? Object.freeze({ kind: "missing" })
    : Object.freeze({ kind: "content", digest: createHash("sha256").update(bytes).digest("hex") });
}
export interface SubscriptionSpendConsentStore {
  read(envelopes: readonly SubscriptionSpendEnvelope[]): Promise<SubscriptionSpendConsentSnapshot>;
  save(mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentSnapshot>;
}

/** `currentAccounts` reads the profile's subscription accounts as their owners hold them now: the auth store for a
 *  stored login, and the program for an external one. A save checks it under the profile lock. */
export function createSubscriptionSpendConsentStore(options: { readonly profileId: string; readonly access: AuthProfileAccess; readonly currentAccounts: () => readonly SubscriptionAccountIdentity[] }): SubscriptionSpendConsentStore {
  const { profileId, access, currentAccounts } = options;
  if (profileId.length === 0) throw new Error("subscription spend consent profileId must be non-empty");

  return {
    read: (envelopes) => access.withLock(() => withAuthority(access, profileId, false, (db, authority) => snapshot(db, profileId, authority, envelopes))),
    save: (mutation) => mutate(access, profileId, currentAccounts, mutation, (db, envelopes) => {
      const reviewed = new Set(mutation.reviewedEnvelopeIds);
      const accepted = new Set(mutation.acceptedEnvelopeIds);
      if (reviewed.size !== mutation.reviewedEnvelopeIds.length
        || accepted.size !== mutation.acceptedEnvelopeIds.length
        || [...reviewed].some((id) => !envelopes.some((envelope) => envelope.id === id))
        || [...accepted].some((id) => !reviewed.has(id))) {
        throw new SubscriptionSpendConsentStaleError("subscription spend consent envelope set changed");
      }
      for (const envelope of envelopes) {
        if (reviewed.has(envelope.id)) writeDecision(db, envelope, accepted.has(envelope.id) ? "accepted" : "declined");
      }
      return reviewed.size > 0;
    }),
  };
}

/** Moves the decisions of each `from` account to its `to` account, and returns how many moved. A decision keeps
 *  its subject, so it applies to the `to` account only while that account names the same subject. A `to` account
 *  that already holds a decision for a mode keeps its own. */
export async function transferSubscriptionSpendDecisions(access: AuthProfileAccess, transfers: readonly { readonly from: SubscriptionAccountSlot; readonly to: SubscriptionAccountSlot }[]): Promise<number> {
  return await access.withLock(() => {
    const bytes = access.readFile(SUBSCRIPTION_SPEND_CONSENT_FILE, MAX_BYTES);
    if (bytes === undefined) return 0;
    const db = deserializeAuthority(bytes);
    try {
      const profileId = db.query<{ profile_id: string }, []>("select profile_id from authority").get()?.profile_id;
      if (profileId === undefined) throw new SubscriptionSpendConsentCorruptError("subscription spend consent authority metadata is invalid");
      const authority = readAuthority(db, profileId);
      let moved = 0;
      db.transaction(() => {
        for (const { from, to } of transfers) {
          const rows = db.query<StoredDecision & { readonly envelope_id: string }, [string, string]>("select envelope_id, provider_id, instance_id, subject_digest, mode, decision from decisions where provider_id = ? and instance_id = ?").all(from.providerId, from.instanceId);
          for (const row of rows) {
            if ((row.mode !== "prepaid" && row.mode !== "automatic") || (row.decision !== "accepted" && row.decision !== "declined")) throw new SubscriptionSpendConsentCorruptError("subscription spend consent decision is invalid");
            const envelope = createSubscriptionSpendEnvelope(profileId, { ...to, subjectDigest: row.subject_digest }, row.mode);
            db.query("delete from decisions where envelope_id = ?").run(row.envelope_id);
            db.query("insert into decisions values ($id, $provider, $instance, $subject, $mode, $decision) on conflict(envelope_id) do nothing").run({ $id: envelope.id, $provider: envelope.providerId, $instance: envelope.instanceId, $subject: envelope.subjectDigest, $mode: envelope.mode, $decision: row.decision });
            moved += 1;
          }
        }
        if (moved > 0) db.query("update authority set revision = $revision where singleton = 1").run({ $revision: authority.revision + 1 });
      }).immediate();
      if (moved > 0) access.writeFile(SUBSCRIPTION_SPEND_CONSENT_FILE, Buffer.from(db.serialize()).toString("base64"));
      return moved;
    } finally {
      db.close();
    }
  });
}

/** The provider and account of a decision, without its subject. */
interface SubscriptionAccountSlot {
  readonly providerId: string;
  readonly instanceId: string;
}

function deserializeAuthority(bytes: Buffer): Database {
  try {
    return Database.deserialize(Buffer.from(bytes.toString("utf8"), "base64"));
  } catch {
    throw new SubscriptionSpendConsentCorruptError("subscription spend consent authority is malformed");
  }
}

async function mutate(
  access: AuthProfileAccess,
  profileId: string,
  currentAccounts: () => readonly SubscriptionAccountIdentity[],
  mutation: SubscriptionSpendConsentMutation,
  apply: (db: Database, envelopes: readonly SubscriptionSpendEnvelope[]) => boolean,
): Promise<SubscriptionSpendConsentSnapshot> {
  return await access.withLock(() => withAuthority(access, profileId, true, (db, authority) => {
    if (authority.incarnation !== mutation.expectedIncarnation || authority.revision !== mutation.expectedRevision) {
      throw new SubscriptionSpendConsentStaleError("subscription spend consent authority changed");
    }
    const envelopes = validateEnvelopeSet(profileId, mutation.envelopes);
    validateCurrentAccounts(currentAccounts(), envelopes);
    if (mutation.isEvidenceCurrent?.() === false) throw new SubscriptionSpendConsentStaleError("subscription spend consent evidence envelope changed");
    let revision = authority.revision;
    db.transaction(() => {
      if (!apply(db, envelopes)) return;
      revision += 1;
      db.query("update authority set revision = $revision where singleton = 1 and revision = $expected").run({ $revision: revision, $expected: authority.revision });
    }).immediate();
    return snapshot(db, profileId, { ...authority, revision }, envelopes);
  }));
}

interface Authority { readonly incarnation: string; readonly revision: number }

function withAuthority<T>(access: AuthProfileAccess, profileId: string, persist: boolean, use: (db: Database, authority: Authority) => T): T {
  const bytes = access.readFile(SUBSCRIPTION_SPEND_CONSENT_FILE, MAX_BYTES);
  const db = bytes === undefined ? new Database(":memory:") : deserializeAuthority(bytes);
  try {
    if (bytes === undefined) initialize(db, profileId);
    const authority = readAuthority(db, profileId);
    const result = use(db, authority);
    if (bytes === undefined || persist) access.writeFile(SUBSCRIPTION_SPEND_CONSENT_FILE, Buffer.from(db.serialize()).toString("base64"));
    return result;
  } catch (error) {
    if (error instanceof SubscriptionSpendConsentCorruptError || error instanceof SubscriptionSpendConsentStaleError) throw error;
    throw new SubscriptionSpendConsentCorruptError(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

function initialize(db: Database, profileId: string): void {
  db.exec("create table authority (singleton integer primary key check (singleton = 1), protocol_version integer not null, profile_id text not null, incarnation text not null, revision integer not null check (revision >= 0)); create table decisions (envelope_id text primary key, provider_id text not null, instance_id text not null, subject_digest text not null, mode text not null check (mode in ('prepaid', 'automatic')), decision text not null check (decision in ('accepted', 'declined')))");
  db.query("insert into authority values (1, $protocol, $profile, $incarnation, 0)").run({ $protocol: PROTOCOL_VERSION, $profile: profileId, $incarnation: randomUUID() });
}

function readAuthority(db: Database, profileId: string): Authority {
  const rows = db.query<{ protocol_version: number; profile_id: string; incarnation: string; revision: number }, []>("select protocol_version, profile_id, incarnation, revision from authority").all();
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.protocol_version !== PROTOCOL_VERSION || row.profile_id !== profileId || !/^[0-9a-f-]{36}$/.test(row.incarnation) || !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new SubscriptionSpendConsentCorruptError("subscription spend consent authority metadata is invalid");
  }
  return { incarnation: row.incarnation, revision: row.revision };
}

function snapshot(db: Database, profileId: string, authority: Authority, envelopes: readonly SubscriptionSpendEnvelope[]): SubscriptionSpendConsentSnapshot {
  return {
    profileId,
    incarnation: authority.incarnation,
    revision: authority.revision,
    envelopes: validateEnvelopeSet(profileId, envelopes).map((envelope) => ({ envelope, status: decision(db, envelope) ?? "unreviewed" })),
  };
}

interface StoredDecision {
  readonly provider_id: string;
  readonly instance_id: string;
  readonly subject_digest: string;
  readonly mode: string;
  readonly decision: string;
}

function decision(db: Database, envelope: SubscriptionSpendEnvelope): SubscriptionSpendDecision | undefined {
  const row = db.query<StoredDecision, [string]>("select provider_id, instance_id, subject_digest, mode, decision from decisions where envelope_id = ?").get(envelope.id);
  if (row === null) return undefined;
  if ((row.decision !== "accepted" && row.decision !== "declined") || (row.mode !== "prepaid" && row.mode !== "automatic")) {
    throw new SubscriptionSpendConsentCorruptError("subscription spend consent decision is invalid");
  }
  if (row.provider_id !== envelope.providerId || row.instance_id !== envelope.instanceId || row.subject_digest !== envelope.subjectDigest || row.mode !== envelope.mode) {
    throw new SubscriptionSpendConsentCorruptError("subscription spend consent decision envelope is invalid");
  }
  return row.decision;
}

function writeDecision(db: Database, envelope: SubscriptionSpendEnvelope, value: SubscriptionSpendDecision): void {
  db.query("insert into decisions values ($id, $provider, $instance, $subject, $mode, $decision) on conflict(envelope_id) do update set decision = excluded.decision").run({ $id: envelope.id, $provider: envelope.providerId, $instance: envelope.instanceId, $subject: envelope.subjectDigest, $mode: envelope.mode, $decision: value });
}

function validateEnvelopeSet(profileId: string, envelopes: readonly SubscriptionSpendEnvelope[]): readonly SubscriptionSpendEnvelope[] {
  const ids = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.profileId !== profileId || !isCanonicalSubscriptionSpendEnvelope(envelope) || ids.has(envelope.id)) {
      throw new SubscriptionSpendConsentStaleError("subscription spend consent envelope set changed");
    }
    ids.add(envelope.id);
  }
  return envelopes;
}

function validateCurrentAccounts(accounts: readonly SubscriptionAccountIdentity[], envelopes: readonly SubscriptionSpendEnvelope[]): void {
  const current = new Set(accounts.map(subscriptionAccountIdentityKey));
  if (envelopes.some((envelope) => !current.has(subscriptionAccountIdentityKey(envelope)))) throw new SubscriptionSpendConsentStaleError("subscription account changed");
}
