import type { Database } from "bun:sqlite";
import { CREATE_USAGE_LEDGER, USAGE_LEDGER_COVERAGE_COLUMNS } from "./usage-authority-codec.js";
import { migrateUncoveredUsageEntry, migrateUsageEntryV3, type UsageEntry } from "./usage-entry.js";

/** Serializes one validated entry in the stable byte order used for idempotent attempt comparison. */
export function canonicalUsageEntry(entry: UsageEntry): string {
  const attribution = entry.attribution.kind === "candidate"
    ? { kind: entry.attribution.kind, providerId: entry.attribution.providerId, ...(entry.attribution.instanceId === undefined ? {} : { instanceId: entry.attribution.instanceId }) }
    : { kind: entry.attribution.kind };
  const identity = { attemptId: entry.attemptId, occurredAt: entry.occurredAt, profileId: entry.profileId };
  const serving = { attribution, spendMode: entry.spendMode, credentialLineage: entry.credentialLineage, model: entry.model };
  if (entry.coverage === "unmeasured") return JSON.stringify({ ...identity, ...serving, classification: entry.classification, coverage: entry.coverage });
  const price = entry.price.kind === "priced"
    ? { kind: entry.price.kind, estimatedUsd: entry.price.estimatedUsd, rateCard: Object.fromEntries(Object.entries(entry.price.rateCard).sort(([left], [right]) => left.localeCompare(right))), provenance: entry.price.provenance }
    : { kind: entry.price.kind, reason: entry.price.reason };
  const { input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning } = entry.tokens;
  const tokens = { input, output, cacheRead, cacheWrite, ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }), reasoning };
  return JSON.stringify({ ...identity, currency: entry.currency, ...serving, tokens, classification: entry.classification, price, coverage: entry.coverage });
}

/** The bindings of one `usage_ledger` row, in its column order. An unmeasured entry and an unreported cache read
 *  store 0 tokens, which the coverage columns mark as no measurement. */
export function usageLedgerRow(entry: UsageEntry) {
  const measured = entry.coverage === "unmeasured" ? undefined : entry;
  return {
    $attempt: entry.attemptId, $occurred: Date.parse(entry.occurredAt), $profile: entry.profileId, $attribution: entry.attribution.kind,
    $provider: entry.attribution.kind === "candidate" ? entry.attribution.providerId : null,
    $instance: entry.attribution.kind === "candidate" ? entry.attribution.instanceId ?? null : null,
    $mode: entry.spendMode, $lineage: entry.credentialLineage, $model: entry.model, $classification: entry.classification,
    $input: measured?.tokens.input ?? 0, $output: measured?.tokens.output ?? 0, $cacheRead: measured?.tokens.cacheRead ?? 0,
    $cacheWrite: measured?.tokens.cacheWrite ?? 0, $reasoning: measured?.tokens.reasoning ?? 0,
    $available: measured?.price.kind === "priced" ? 1 : 0,
    $usd: measured?.price.kind === "priced" ? measured.price.estimatedUsd : null,
    $json: canonicalUsageEntry(entry),
    $coverage: entry.coverage,
    $cacheReadUnreported: measured !== undefined && measured.tokens.cacheRead === null ? 1 : 0,
  };
}

export const INSERT_USAGE_LEDGER_ROW = "insert into usage_ledger values ($attempt,$occurred,$profile,$attribution,$provider,$instance,$mode,$lineage,$model,$classification,$input,$output,$cacheRead,$cacheWrite,$reasoning,$available,$usd,$json,$coverage,$cacheReadUnreported)";

// Remove after 2027-04-30, with the conversion of entries written before coverage existed.
/** Returns the current canonical text of a stored ledger entry. Ledger protocols 4 to 6 stored entries without
 *  coverage, and protocol 7 keeps those rows unchanged so that opening a large ledger rewrites nothing. Every such
 *  entry held the provider's final report, so it reads as the complete entry that a converted settlement checkpoint
 *  replays. */
export function currentLedgerEntryJson(stored: string): string {
  const value: unknown = JSON.parse(stored);
  return typeof value === "object" && value !== null && !("coverage" in value) ? canonicalUsageEntry(migrateUncoveredUsageEntry(value)) : stored;
}

interface IntermediateV3LedgerRow {
  readonly attempt_id: string;
  readonly rowid: number;
  readonly occurred_at_ms: number;
  readonly profile_id: string;
  readonly classification: UsageEntry["classification"];
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly reasoning_tokens: number;
  readonly estimated_usd: number | null;
  readonly entry_json: string;
}

interface LegacyLedgerRow { readonly rowid: number; readonly entry_json: string }

function isIntermediateV3LedgerRow(row: LegacyLedgerRow | IntermediateV3LedgerRow): row is IntermediateV3LedgerRow {
  return "attempt_id" in row;
}

/** Brings the ledger to the current shape. A ledger with attribution columns (protocols 4 to 6, or a new one) only
 *  gains the coverage columns it lacks, which rewrites no row, so the open costs the same at any ledger size. Rows of
 *  older ledgers are decoded, validated, and converted one by one into a new ledger. */
export function ensureCanonicalLedger(opened: Database, sourceVersion?: number): void {
  if (ledgerColumns(opened).has("attribution_kind")) addMissingCoverageColumns(opened);
  else rebuildPreAttributionLedger(opened, sourceVersion);
}

function ledgerColumns(opened: Database): ReadonlySet<string> {
  return new Set(opened.query<{ name: string }, []>("pragma table_info(usage_ledger)").all().map(({ name }) => name));
}

function addMissingCoverageColumns(opened: Database): void {
  const columns = ledgerColumns(opened);
  for (const column of USAGE_LEDGER_COVERAGE_COLUMNS) if (!columns.has(column.name)) opened.exec(`alter table usage_ledger add column ${column.definition}`);
}

function rebuildPreAttributionLedger(opened: Database, sourceVersion: number | undefined): void {
  opened.exec("alter table usage_ledger rename to usage_ledger_legacy");
  opened.exec(CREATE_USAGE_LEDGER);
  addMissingCoverageColumns(opened);
  const insert = opened.query(INSERT_USAGE_LEDGER_ROW);
  let cursor = 0;
  const read = sourceVersion === 3
    ? opened.query<IntermediateV3LedgerRow, [number]>("select rowid, attempt_id, occurred_at_ms, profile_id, classification, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_usd, entry_json from usage_ledger_legacy where rowid > ? order by rowid limit 128")
    : opened.query<LegacyLedgerRow, [number]>("select rowid, entry_json from usage_ledger_legacy where rowid > ? order by rowid limit 128");
  for (;;) {
    const rows = read.all(cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      const entry = sourceVersion === 3 ? migrateUsageEntryV3(JSON.parse(row.entry_json)) : migrateUncoveredUsageEntry(JSON.parse(row.entry_json));
      if (entry.coverage === "unmeasured") throw new Error(`Usage authority ledger row ${entry.attemptId} has no measurement`);
      if (sourceVersion === 3) {
        if (!isIntermediateV3LedgerRow(row)) throw new Error("Usage authority v3 ledger row is malformed");
        const legacy = row;
        if (legacy.attempt_id !== entry.attemptId
          || legacy.occurred_at_ms !== Date.parse(entry.occurredAt)
          || legacy.profile_id !== entry.profileId
          || legacy.classification !== entry.classification
          || legacy.input_tokens !== entry.tokens.input
          || legacy.output_tokens !== entry.tokens.output
          || legacy.cache_read_tokens !== entry.tokens.cacheRead
          || legacy.cache_write_tokens !== entry.tokens.cacheWrite
          || legacy.reasoning_tokens !== entry.tokens.reasoning
          || legacy.estimated_usd !== (entry.price.kind === "priced" ? entry.price.estimatedUsd : null)) throw new Error(`Usage authority v3 ledger row ${legacy.attempt_id} does not match its canonical entry`);
      }
      insert.run(usageLedgerRow(entry));
      cursor = row.rowid;
    }
  }
  opened.exec("drop table usage_ledger_legacy");
}
