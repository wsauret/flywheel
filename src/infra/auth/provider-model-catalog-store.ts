import type { CatalogCanonicalRow, CatalogLimits } from "../llm/model-catalog-resolution.js";
import { validateCanonicalRows } from "../llm/model-catalog-resolution.js";
import { accessProviderAccountKey, type AccessProviderAccountIdentity } from "../llm/access-provider.js";
import type { AuthProfileAccess } from "./auth-profile-store.js";
import { ContainedFileTooLargeError } from "../descriptor-directory.js";
import { Log } from "../log.js";

const log = Log.create({ service: "provider-model-catalog-store" });
const FILE_NAME = "provider-model-catalogs.json";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ACCOUNTS = 128;
const MAX_IDENTITY_BYTES = 1024;

interface SavedProviderModelCatalog {
  readonly account: AccessProviderAccountIdentity;
  readonly lineage: string;
  readonly rows: readonly CatalogCanonicalRow[];
  readonly audit?: ProviderModelAudit;
  readonly refusals?: SavedModelRefusals;
}

const VERSION = 5;

interface CatalogDocument {
  readonly version: typeof VERSION;
  readonly accounts: readonly SavedProviderModelCatalog[];
}

/** What a served request proved that one account refuses for one wire model: the model itself, or every context
 *  window above `contextLimit`, which is the window the account grants. */
export type ModelRefusal =
  | { readonly kind: "model" }
  | { readonly kind: "extended-context"; readonly contextLimit: number };
/** A refusal and the time, in milliseconds since the epoch, at which a request proved it. */
export type SavedModelRefusal = ModelRefusal & { readonly at: number };
export interface SavedModelRefusals { readonly [wireModelId: string]: SavedModelRefusal }

/** How long a saved refusal applies. An account can change what it grants without a new credential: the person
 *  turns on usage credits, changes the plan, or signs the CLI in as another account. After this time the model
 *  is offered again, and one refused request saves the refusal again. */
export const MODEL_REFUSAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The refusals that still apply at `now`. A time far in the future, from a clock that moved back, also ends. */
export function liveModelRefusals(refusals: SavedModelRefusals, now: number): SavedModelRefusals {
  return Object.fromEntries(Object.entries(refusals).filter(([, refusal]) => Math.abs(now - refusal.at) < MODEL_REFUSAL_LIFETIME_MS));
}

/** Everything saved for one exact account generation. `rows` is absent when no catalog is saved. */
export interface SavedProviderModels {
  readonly rows: readonly CatalogCanonicalRow[] | undefined;
  readonly audit: ProviderModelAudit | undefined;
  readonly refusals: SavedModelRefusals;
}

export type ProviderModelAccessOutcome = "completed" | "refused";
interface ProviderModelAccessOutcomes { readonly [modelId: string]: ProviderModelAccessOutcome }
/** Settled access checks transferred with the credential generation that proved them. No catalog rows or probe authority are carried. */
export interface ProviderModelAccessSnapshot {
  readonly account: AccessProviderAccountIdentity;
  readonly lineage: string;
  readonly outcomes: ProviderModelAccessOutcomes;
}
interface ProviderModelAudit {
  readonly candidateIds: readonly string[];
  readonly dueIds: readonly string[];
  readonly outcomes: ProviderModelAccessOutcomes;
  readonly generation: number;
}

const MAX_CANDIDATES = 512;

/** One open auth profile, and the reader of its accounts' current credential lineages. Only the caller knows the
 *  provider definitions that map an account to its credential, which can be a stored one or a login that another
 *  program owns. Every write calls the reader under the profile lock, so a credential that changed after the
 *  caller's capture refuses the write. */
export interface CatalogProfile {
  readonly access: AuthProfileAccess;
  readonly currentLineage: (account: AccessProviderAccountIdentity) => string | undefined;
}

function savedEntry(document: CatalogDocument | undefined, account: AccessProviderAccountIdentity, lineage: string): SavedProviderModelCatalog | undefined {
  const key = accessProviderAccountKey(account);
  return document?.accounts.find((entry) => accessProviderAccountKey(entry.account) === key && entry.lineage === lineage);
}

/** The entry fields that every rewrite of one account generation keeps. */
function keptEvidence(entry: SavedProviderModelCatalog | undefined): Pick<SavedProviderModelCatalog, "audit" | "refusals"> {
  return { ...(entry?.audit === undefined ? {} : { audit: entry.audit }), ...(entry?.refusals === undefined ? {} : { refusals: entry.refusals }) };
}

/** Reads the saved catalog, audit, and refusals of one exact account generation with one read of the file.
 *  Malformed documents are ignored as a whole. */
export function readSavedProviderModels(access: AuthProfileAccess, account: AccessProviderAccountIdentity, lineage: string, limits: CatalogLimits): SavedProviderModels | undefined {
  const entry = savedEntry(readDocument(access, limits), account, lineage);
  if (entry === undefined) return undefined;
  return { rows: entry.rows.length === 0 ? undefined : entry.rows, audit: entry.audit, refusals: entry.refusals ?? {} };
}

/** Replaces the candidate basis without resetting settled outcomes: a candidate that the basis adds with no outcome
 *  becomes due, and a completed one stays settled. A refused one is checked again by every audit
 *  (`runAccessAudit`), and a manual recheck makes every candidate due. */
export async function writeProviderModelCandidates({ access, currentLineage }: CatalogProfile, account: AccessProviderAccountIdentity, lineage: string, rows: readonly CatalogCanonicalRow[], candidateIds: readonly string[], limits: CatalogLimits, manual = false): Promise<boolean> {
  const validated = validateCanonicalRows(rows, limits);
  if (validated.kind !== "valid" || candidateIds.length > MAX_CANDIDATES || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => !boundedIdentity(id))) return false;
  return access.withLock(() => {
    if (currentLineage(account) !== lineage) return false;
    const document = readDocument(access, limits);
    if (!document) return false;
    const key = accessProviderAccountKey(account);
    const saved = savedEntry(document, account, lineage);
    const previous = saved?.audit;
    const basis = [...candidateIds].sort();
    const changed = previous === undefined || basis.length !== previous.candidateIds.length || basis.some((id, index) => id !== previous.candidateIds[index]);
    if ((changed || manual) && previous?.generation === Number.MAX_SAFE_INTEGER) return false;
    const outcomes: ProviderModelAccessOutcomes = previous?.outcomes ?? {};
    const dueIds = manual ? [...basis] : basis.filter((id) => previous?.candidateIds.includes(id) === true
      ? previous.dueIds.includes(id)
      : outcomes[id] === undefined);
    const audit: ProviderModelAudit = { candidateIds: basis, dueIds, outcomes, generation: (previous?.generation ?? 0) + (changed || manual ? 1 : 0) };
    return writeDocument(access, { version: VERSION, accounts: [...document.accounts.filter((entry) => accessProviderAccountKey(entry.account) !== key), { account, lineage, rows: validated.rows, ...keptEvidence(saved), audit }] }, limits);
  });
}

/**
 * Commits one conclusive result for the current audit generation, of a model that is due or of a refused model that
 * an audit checks again; stale results cannot alter a later audit. A refused model that now passes also ends the
 * saved refusal of its wire model that a request proved (PI-MODEL-066); a pass of a model that was not refused keeps
 * that refusal.
 */
export async function recordProviderModelAccess({ access, currentLineage }: CatalogProfile, account: AccessProviderAccountIdentity, lineage: string, generation: number, modelId: string, wireModelId: string, outcome: ProviderModelAccessOutcome, limits: CatalogLimits): Promise<boolean> {
  return access.withLock(() => {
    if (currentLineage(account) !== lineage) return false;
    const document = readDocument(access, limits);
    if (!document) return false;
    const entry = savedEntry(document, account, lineage);
    const previous = entry?.audit?.outcomes[modelId];
    const due = entry?.audit?.dueIds.includes(modelId) === true;
    if (!entry?.audit || entry.audit.generation !== generation || (!due && previous !== "refused") || (outcome !== "completed" && outcome !== "refused")) return false;
    const audit: ProviderModelAudit = { ...entry.audit, dueIds: entry.audit.dueIds.filter((id) => id !== modelId), outcomes: { ...entry.audit.outcomes, [modelId]: outcome } };
    const { [wireModelId]: ended, ...kept } = entry.refusals ?? {};
    const refusals = previous === "refused" && outcome === "completed" && ended !== undefined ? { refusals: kept } : {};
    return writeDocument(access, { version: VERSION, accounts: document.accounts.map((candidate) => candidate === entry ? { ...entry, audit, ...refusals } : candidate) }, limits);
  });
}

/**
 * Saves what a served request proved: the account generation refuses one wire model, or its extended window. The
 * refusal replaces an earlier one of the same wire model, and refusals that no longer apply are dropped. An account
 * with no saved entry gets one that holds only the refusal. Returns false, and writes nothing, when the lineage is
 * no longer the account's current credential or the refusal is malformed.
 */
export async function recordProviderModelRefusal({ access, currentLineage }: CatalogProfile, account: AccessProviderAccountIdentity, lineage: string, wireModelId: string, refusal: SavedModelRefusal, limits: CatalogLimits): Promise<boolean> {
  if (!boundedIdentity(wireModelId) || decodeRefusal(refusal) === undefined) return false;
  return access.withLock(() => {
    if (currentLineage(account) !== lineage) return false;
    const document = readDocument(access, limits);
    if (!document) return false;
    const entry = savedEntry(document, account, lineage);
    const live = Object.entries(liveModelRefusals(entry?.refusals ?? {}, refusal.at)).filter(([id]) => id !== wireModelId);
    const refusals: SavedModelRefusals = Object.fromEntries([...live.slice(-(MAX_CANDIDATES - 1)), [wireModelId, refusal]]);
    const key = accessProviderAccountKey(account);
    // An earlier credential generation of the account can never be read again, so the new entry replaces it.
    const accounts = document.accounts.filter((candidate) => accessProviderAccountKey(candidate.account) !== key);
    return writeDocument(access, { version: VERSION, accounts: [...accounts, { account, lineage, rows: entry?.rows ?? [], ...keptEvidence(entry), refusals }] }, limits);
  });
}

function writeDocument(access: AuthProfileAccess, document: CatalogDocument, limits: CatalogLimits): boolean {
  if (document.accounts.length > MAX_ACCOUNTS) throw new Error("provider model catalog cache exceeds account limit");
  const accounts = [...document.accounts].sort((left, right) => accessProviderAccountKey(left.account).localeCompare(accessProviderAccountKey(right.account)));
  const encoded = JSON.stringify({ version: VERSION, accounts });
  if (Buffer.byteLength(encoded) > Math.min(MAX_BYTES, limits.durableBytes)) throw new Error("provider model catalog cache exceeds durable byte limit");
  access.writeFile(FILE_NAME, encoded);
  return true;
}

/** Atomically replaces one exact account generation after reading auth.json under the profile lock. */
export async function writeProviderModelCatalog(
  { access, currentLineage }: CatalogProfile,
  account: AccessProviderAccountIdentity,
  lineage: string,
  rows: readonly CatalogCanonicalRow[],
  limits: CatalogLimits,
): Promise<boolean> {
  const validated = validateCanonicalRows(rows, limits);
  if (validated.kind !== "valid" || validated.rows.length === 0) return false;
  return access.withLock(() => {
    if (currentLineage(account) !== lineage) return false;
    const current = readDocument(access, limits);
    if (current === undefined) return false;
    const key = accessProviderAccountKey(account);
    const accounts = current.accounts.filter((entry) => accessProviderAccountKey(entry.account) !== key);
    accounts.push({ account, lineage, rows: validated.rows, ...keptEvidence(savedEntry(current, account, lineage)) });
    return writeDocument(access, { version: VERSION, accounts }, limits);
  });
}

/** Deletes one rejected account generation without removing a newer reconnect generation. */
export async function deleteProviderModelCatalog(
  { access, currentLineage }: CatalogProfile,
  account: AccessProviderAccountIdentity,
  lineage: string,
  limits: CatalogLimits,
): Promise<boolean> {
  return access.withLock(() => {
    if (currentLineage(account) !== lineage) return false;
    const current = readDocument(access, limits);
    if (!current) return false;
    const key = accessProviderAccountKey(account);
    const accounts = current.accounts.filter((entry) => accessProviderAccountKey(entry.account) !== key || entry.lineage !== lineage);
    if (accounts.length === current.accounts.length) return false;
    if (accounts.length === 0) access.removeFile(FILE_NAME);
    else writeDocument(access, { version: VERSION, accounts }, limits);
    return true;
  });
}

/** Converts versions 1, 2, and 4 before eligibility readers start, preserving rows and audit evidence. Version 5 only
 *  adds the optional refusals of each entry, so a version 4 document reads unchanged. Remove the version 1 and 2
 *  conversions after 2027-03-01 and the version 4 conversion after 2027-04-08. */
export async function adoptPreviousProviderModelCatalogs(access: AuthProfileAccess, limits: CatalogLimits): Promise<boolean> {
  return access.withLock(() => {
    let bytes: Buffer | undefined;
    try {
      bytes = access.readFile(FILE_NAME, Math.min(MAX_BYTES, limits.durableBytes));
    } catch (error) {
      if (!(error instanceof ContainedFileTooLargeError)) throw error;
      log.warn("previous provider model catalog cache exceeds the size limit and is left unchanged");
      return false;
    }
    if (!bytes) return false;
    let version: unknown;
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      version = isObject(value) ? value.version : undefined;
    } catch {
      return false;
    }
    if (version !== 1 && version !== 2 && version !== 4) return false;
    const document = decode(bytes, limits);
    return document === undefined ? false : writeDocument(access, document, limits);
  });
}

function decode(bytes: Buffer | undefined, limits: CatalogLimits): CatalogDocument | undefined {
  if (!bytes) return { version: VERSION, accounts: [] };
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value) || Object.keys(value).some((key) => key !== "version" && key !== "accounts") || (value.version !== 1 && value.version !== 2 && value.version !== 4 && value.version !== VERSION) || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) return undefined;
    const accounts: SavedProviderModelCatalog[] = [];
    const identities = new Set<string>();
    for (const raw of value.accounts) {
      // Remove the published v2 field conversion after 2027-03-01.
      const auditKey = value.version === 2 ? "superGrok" : "audit";
      const fields = value.version === 1 ? [] : value.version === VERSION ? [auditKey, "refusals"] : [auditKey];
      if (!isObject(raw) || Object.keys(raw).some((key) => key !== "account" && key !== "lineage" && key !== "rows" && !fields.includes(key)) || !boundedIdentity(raw.lineage) || !Array.isArray(raw.rows)) return undefined;
      const account = decodeAccount(raw.account);
      if (!account) return undefined;
      const validated = validateCanonicalRows(raw.rows, limits);
      const rawAudit = raw[auditKey];
      if (validated.kind !== "valid" || (validated.rows.length === 0 && rawAudit === undefined && raw.refusals === undefined)) return undefined;
      const audit = rawAudit === undefined ? undefined : decodeAudit(rawAudit);
      if (rawAudit !== undefined && audit === undefined) return undefined;
      const refusals = raw.refusals === undefined ? undefined : decodeRefusals(raw.refusals);
      if (raw.refusals !== undefined && refusals === undefined) return undefined;
      const identity = `${accessProviderAccountKey(account)}\0${raw.lineage}`;
      if (identities.has(identity)) return undefined;
      identities.add(identity);
      accounts.push({ account, lineage: raw.lineage, rows: validated.rows, ...(audit ? { audit } : {}), ...(refusals ? { refusals } : {}) });
    }
    return { version: VERSION, accounts };
  } catch {
    return undefined;
  }
}

function decodeAudit(value: unknown): ProviderModelAudit | undefined {
  if (!isObject(value) || Object.keys(value).some((key) => !["candidateIds", "dueIds", "outcomes", "generation"].includes(key)) || !Array.isArray(value.candidateIds) || !Array.isArray(value.dueIds) || !isObject(value.outcomes) || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) return undefined;
  const candidates: unknown[] = value.candidateIds;
  const due: unknown[] = value.dueIds;
  if (candidates.length > MAX_CANDIDATES || due.length > candidates.length || !candidates.every(boundedIdentity) || !due.every(boundedIdentity)) return undefined;
  const candidateIds = candidates;
  const dueIds = due;
  const ids = new Set(candidateIds);
  if (ids.size !== candidateIds.length || new Set(dueIds).size !== dueIds.length || dueIds.some((id) => !ids.has(id))) return undefined;
  const outcomes: { [modelId: string]: ProviderModelAccessOutcome } = {};
  for (const [id, outcome] of Object.entries(value.outcomes)) {
    if (!boundedIdentity(id) || (outcome !== "completed" && outcome !== "refused")) return undefined;
    outcomes[id] = outcome;
  }
  return { candidateIds, dueIds, outcomes, generation: value.generation };
}

function decodeRefusals(value: unknown): SavedModelRefusals | undefined {
  if (!isObject(value) || Object.keys(value).length > MAX_CANDIDATES) return undefined;
  const refusals: { [wireModelId: string]: SavedModelRefusal } = {};
  for (const [id, raw] of Object.entries(value)) {
    const refusal = decodeRefusal(raw);
    if (!boundedIdentity(id) || refusal === undefined) return undefined;
    refusals[id] = refusal;
  }
  return refusals;
}

function decodeRefusal(value: unknown): SavedModelRefusal | undefined {
  if (!isObject(value) || typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0) return undefined;
  const keys = Object.keys(value);
  if (value.kind === "model" && keys.length === 2) return { kind: "model", at: value.at };
  if (value.kind !== "extended-context" || keys.length !== 3 || typeof value.contextLimit !== "number" || !Number.isSafeInteger(value.contextLimit) || value.contextLimit <= 0) return undefined;
  return { kind: "extended-context", contextLimit: value.contextLimit, at: value.at };
}

/** A document this reader cannot decode is absent evidence, never an error, but
 *  it is said out loud: silence here once hid a whole profile's catalogs. */
function readDocument(access: AuthProfileAccess, limits: CatalogLimits): CatalogDocument | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = access.readFile(FILE_NAME, Math.min(MAX_BYTES, limits.durableBytes));
  } catch (error) {
    if (!(error instanceof ContainedFileTooLargeError)) throw error;
    log.warn("provider model catalog cache exceeds the size limit and is treated as absent");
    return undefined;
  }
  const document = decode(bytes, limits);
  if (document === undefined) log.warn("provider model catalog cache is unreadable and treated as absent", { bytes: bytes?.length ?? 0 });
  return document;
}

function decodeAccount(value: unknown): AccessProviderAccountIdentity | undefined {
  if (!isObject(value)) return undefined;
  const keys = Object.keys(value);
  if (value.kind === "singleton" && keys.length === 2 && keys.includes("providerId") && boundedIdentity(value.providerId)) return { kind: "singleton", providerId: value.providerId };
  if (value.kind === "subscription" && keys.length === 3 && keys.includes("providerId") && keys.includes("instanceId") && boundedIdentity(value.providerId) && boundedIdentity(value.instanceId)) return { kind: "subscription", providerId: value.providerId, instanceId: value.instanceId };
  return undefined;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_IDENTITY_BYTES;
}

interface UnknownObject { readonly [key: string]: unknown }

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
