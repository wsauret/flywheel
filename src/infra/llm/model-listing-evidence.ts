/** The saved evidence of one model listing client's profile: catalog rows, access audit, and refusals. */
import { AuthProfileDirectoryNotFoundError } from "../auth/auth-profile-store.js";
import { readSavedProviderModels, recordProviderModelRefusal, type CatalogProfile, type ModelRefusal, type SavedProviderModels } from "../auth/provider-model-catalog-store.js";
import { Log } from "../log.js";
import { accessProviderAccountKey, type AccessProviderAccountIdentity } from "./access-provider.js";
import type { CatalogCanonicalRow, CatalogLimits } from "./model-catalog-resolution.js";

const log = Log.create({ service: "model-listing" });

interface SavedListingEvidenceOptions {
  /** Opens the profile for one read or write and closes it after. */
  readonly withProfile: <T>(use: (profile: CatalogProfile) => T | Promise<T>) => Promise<T>;
  readonly now: () => number;
}

/**
 * The listing reads each exact account generation's saved entry once, and its own writes keep the entry current.
 * Another process's write is read after this process's credential or listing generation changes. Saved evidence is
 * optional: a profile or file that this process cannot read is absent evidence, so the listing falls back to
 * models.dev and continues.
 */
export interface SavedListingEvidence {
  read(account: AccessProviderAccountIdentity, lineage: string, limits: CatalogLimits): Promise<SavedProviderModels | undefined>;
  /** Keeps the rows that this process just saved, beside the audit and refusals already read. */
  keepRows(account: AccessProviderAccountIdentity, lineage: string, rows: readonly CatalogCanonicalRow[]): void;
  /** Forgets an entry that this process deleted, or changed with a write that the evidence did not make, such as an
   *  access audit result that ended a refusal. */
  forget(account: AccessProviderAccountIdentity, lineage: string): void;
  /** Saves a refusal that a request proved, timed now. Resolves false when the store refused it or the write
   *  failed; a failed write is a warning. */
  recordRefusal(account: AccessProviderAccountIdentity, lineage: string, wireModelId: string, refusal: ModelRefusal, limits: CatalogLimits): Promise<boolean>;
}

export function createSavedListingEvidence(options: SavedListingEvidenceOptions): SavedListingEvidence {
  /** One read per exact account generation, shared by every candidate of the account that lists at the same time. */
  const entries = new Map<string, Promise<SavedProviderModels | undefined>>();
  /** Keys whose unreadable file was reported once. */
  const unreadable = new Set<string>();
  const keyOf = (account: AccessProviderAccountIdentity, lineage: string) => `${accessProviderAccountKey(account)}\0${lineage}`;
  const readOnce = async (key: string, account: AccessProviderAccountIdentity, lineage: string, limits: CatalogLimits): Promise<SavedProviderModels | undefined> => {
    try {
      const saved = await options.withProfile(({ access }) => readSavedProviderModels(access, account, lineage, limits));
      unreadable.delete(key);
      return saved;
    } catch (error) {
      // A credential from the environment has no profile directory, and so no saved evidence.
      if (!(error instanceof AuthProfileDirectoryNotFoundError) && !unreadable.has(key)) {
        unreadable.add(key);
        log.warn("saved provider models are unreadable and treated as absent", { providerId: account.providerId, error: error instanceof Error ? error.name : "unknown" });
      }
      return undefined;
    }
  };
  return {
    read(account, lineage, limits) {
      const key = keyOf(account, lineage);
      const cached = entries.get(key);
      if (cached !== undefined) return cached;
      const reading = readOnce(key, account, lineage, limits);
      entries.set(key, reading);
      // Absent evidence is read again by the next listing, which can follow another process's first write.
      void reading.then((saved) => { if (saved === undefined && entries.get(key) === reading) entries.delete(key); });
      return reading;
    },
    keepRows(account, lineage, rows) {
      const key = keyOf(account, lineage);
      const previous = entries.get(key) ?? Promise.resolve(undefined);
      entries.set(key, previous.then((cached) => ({ rows, audit: cached?.audit, refusals: cached?.refusals ?? {} })));
    },
    forget(account, lineage) {
      entries.delete(keyOf(account, lineage));
    },
    async recordRefusal(account, lineage, wireModelId, refusal, limits) {
      let saved: boolean;
      try {
        saved = await options.withProfile((profile) => recordProviderModelRefusal(profile, account, lineage, wireModelId, { ...refusal, at: options.now() }, limits));
      } catch (error) {
        log.warn("a model refusal that a request proved was not saved", { providerId: account.providerId, error: error instanceof Error ? error.name : "unknown" });
        return false;
      }
      // The next listing reads the entry again, so it holds what was just written.
      if (saved) entries.delete(keyOf(account, lineage));
      return saved;
    },
  };
}
