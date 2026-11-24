export const USAGE_AUTHORITY_PROTOCOL_VERSION = 7;

/** The ledger columns that every protocol since 4 has. One row per settled attempt; the coverage columns below
 *  complete it. A measured attempt has its tokens and price availability; an unmeasured attempt has zero tokens and
 *  no price, and its coverage says the zeros are not a measurement. */
export const CREATE_USAGE_LEDGER = `
  create table if not exists usage_ledger (
    attempt_id text primary key,
    occurred_at_ms integer not null check (occurred_at_ms >= 0),
    profile_id text not null check (length(profile_id) > 0),
    attribution_kind text not null check (attribution_kind in ('candidate', 'unattributed')),
    provider_id text,
    instance_id text,
    spend_mode text not null check (spend_mode in ('included', 'prepaid', 'automatic', 'direct_api', 'aggregator')),
    credential_lineage text not null check (length(credential_lineage) > 0),
    model text not null check (length(model) > 0),
    classification text not null check (classification in ('subscription_equivalent', 'real_spend')),
    input_tokens integer not null check (input_tokens >= 0),
    output_tokens integer not null check (output_tokens >= 0),
    cache_read_tokens integer not null check (cache_read_tokens >= 0),
    cache_write_tokens integer not null check (cache_write_tokens >= 0),
    reasoning_tokens integer not null check (reasoning_tokens >= 0),
    price_available integer not null check (price_available in (0, 1)),
    estimated_usd real,
    entry_json text not null check (length(entry_json) > 0),
    check ((attribution_kind = 'candidate' and provider_id is not null) or (attribution_kind = 'unattributed' and provider_id is null and instance_id is null)),
    check ((price_available = 1 and estimated_usd is not null) or (price_available = 0 and estimated_usd is null))
  )
`;

/** The columns that protocol 7 appends to every ledger, new or old, so both have one shape. `coverage` is
 *  `complete`, `partial`, or `unmeasured`; `cache_read_unreported` is 1 for a measured attempt whose provider did not
 *  report cache reads, whose `cache_read_tokens` is then 0. Each default is the true value of every row written
 *  before the column existed, so adding a column rewrites no row. The columns have no CHECK constraint, because
 *  SQLite tests an added column's CHECK against every existing row (2.1 s on a 355k-row ledger); the entry codec
 *  validates each value on append. */
export const USAGE_LEDGER_COVERAGE_COLUMNS = [
  { name: "coverage", definition: "coverage text not null default 'complete'" },
  { name: "cache_read_unreported", definition: "cache_read_unreported integer not null default 0" },
] as const;

export const CREATE_USAGE_RANGE_INDEX = "create index if not exists usage_ledger_range_idx on usage_ledger (profile_id, occurred_at_ms, attribution_kind, provider_id, instance_id, classification)";
export const CREATE_USAGE_QUOTA_INDEX = "create index if not exists usage_ledger_quota_idx on usage_ledger (profile_id, attribution_kind, provider_id, instance_id, spend_mode, classification, occurred_at_ms)";

/** The 0 or 1 flags of one ledger row (named `row` in the statement) that the summary and every read sum into
 *  coverage counts and price availability. An unmeasured row has no price, which does not make a price unavailable. */
export function ledgerRowFlags(row: string) {
  return {
    unmeasured: `${row}.coverage = 'unmeasured'`,
    partial: `${row}.coverage = 'partial'`,
    cacheReadUnreported: `${row}.cache_read_unreported`,
    priceUnavailable: `(${row}.coverage <> 'unmeasured' and ${row}.price_available = 0)`,
  };
}

/** The hourly summary of `usage_ledger` that range reads use for whole hours.
 *  It is derived: a later shape gets a new versioned name and rebuilds from the
 *  ledger. Provider and instance store '' for NULL, which the ledger never
 *  holds as a real value, because a primary key upsert treats NULLs as distinct.
 *  The ledger read summed USD with SQLite `sum()`, which compensates rounding
 *  (Kahan-Babuska-Neumaier), so each row carries its own Neumaier compensation
 *  and a read sums it back in to give the USD that read gave. `attempts` counts
 *  every settled attempt; `unmeasured_attempts` the ones with no usage report,
 *  `partial_attempts` the ones that ended before the final report, and
 *  `cache_read_unreported_attempts` the measured ones whose provider did not
 *  report cache reads. */
export const USAGE_LEDGER_HOURLY = "usage_ledger_hourly_v2";
/** The summary names that earlier protocols kept, which a migration drops. */
export const RETIRED_USAGE_LEDGER_HOURLY = ["usage_ledger_hourly_v1"] as const;
export const CREATE_USAGE_LEDGER_HOURLY = `
  create table ${USAGE_LEDGER_HOURLY} (
    profile_id text not null, hour_start_ms integer not null, attribution_kind text not null, provider_id text not null, instance_id text not null,
    spend_mode text not null, credential_lineage text not null, model text not null, classification text not null,
    attempts integer not null, unmeasured_attempts integer not null, partial_attempts integer not null, cache_read_unreported_attempts integer not null,
    input_tokens integer not null, output_tokens integer not null, cache_read_tokens integer not null,
    cache_write_tokens integer not null, reasoning_tokens integer not null, estimated_usd real not null, estimated_usd_compensation real not null, price_unavailable integer not null,
    primary key (profile_id, hour_start_ms, attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification)
  ) without rowid
`;
/** The ledger rows that existed when the summary was created and that it does not hold yet: rowids in
 *  (`folded_through_rowid`, `through_rowid`]. The trigger folds every later row. While this row exists, reads take
 *  every hour from the ledger, so the summary is built in bounded steps after the open, not in it. */
export const USAGE_LEDGER_HOURLY_BACKLOG = `${USAGE_LEDGER_HOURLY}_backlog`;
export const CREATE_USAGE_LEDGER_HOURLY_BACKLOG = `create table ${USAGE_LEDGER_HOURLY_BACKLOG} (id integer primary key check (id = 0), folded_through_rowid integer not null, through_rowid integer not null)`;
/** The summary row of one ledger row, folded in by the Neumaier step. Both the
 *  trigger and the backlog fold rows one at a time through it, because a
 *  grouped `sum()` rounds away the compensation that the read needs. */
const hourlyUpsert = (source: "new" | "backlog") => {
  const ledgerRow = source === "new" ? "new" : "ledger";
  const flags = ledgerRowFlags(ledgerRow);
  return `
  insert into ${USAGE_LEDGER_HOURLY}
  select ${ledgerRow}.profile_id, (${ledgerRow}.occurred_at_ms / 3600000) * 3600000, ${ledgerRow}.attribution_kind, coalesce(${ledgerRow}.provider_id, ''), coalesce(${ledgerRow}.instance_id, ''), ${ledgerRow}.spend_mode, ${ledgerRow}.credential_lineage, ${ledgerRow}.model, ${ledgerRow}.classification,
    1, ${flags.unmeasured}, ${flags.partial}, ${flags.cacheReadUnreported},
    ${ledgerRow}.input_tokens, ${ledgerRow}.output_tokens, ${ledgerRow}.cache_read_tokens, ${ledgerRow}.cache_write_tokens, ${ledgerRow}.reasoning_tokens,
    coalesce(${ledgerRow}.estimated_usd, 0), 0, ${flags.priceUnavailable}
  ${source === "new" ? "where true" : "from usage_ledger ledger where ledger.rowid > $after and ledger.rowid <= $through order by ledger.rowid"}
  on conflict (profile_id, hour_start_ms, attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification) do update set
    attempts = attempts + 1, unmeasured_attempts = unmeasured_attempts + excluded.unmeasured_attempts, partial_attempts = partial_attempts + excluded.partial_attempts,
    cache_read_unreported_attempts = cache_read_unreported_attempts + excluded.cache_read_unreported_attempts,
    input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    -- Every SET expression reads the row before the update, as the Neumaier step needs.
    estimated_usd_compensation = estimated_usd_compensation + case when abs(estimated_usd) > abs(excluded.estimated_usd)
      then (estimated_usd - (estimated_usd + excluded.estimated_usd)) + excluded.estimated_usd
      else (excluded.estimated_usd - (estimated_usd + excluded.estimated_usd)) + estimated_usd end,
    estimated_usd = estimated_usd + excluded.estimated_usd,
    price_unavailable = max(price_unavailable, excluded.price_unavailable)`;
};
/** Folds the backlog rows with rowids in (`$after`, `$through`] into the summary. */
export const FOLD_USAGE_LEDGER_HOURLY_BACKLOG = hourlyUpsert("backlog");
/** The summary is kept by a trigger in the database, not by the append code,
 *  so an older binary that inserts into the same ledger keeps it exact too. */
export const CREATE_USAGE_LEDGER_HOURLY_TRIGGER = `
  create trigger if not exists ${USAGE_LEDGER_HOURLY}_insert after insert on usage_ledger begin
    ${hourlyUpsert("new")};
  end
`;

export const CREATE_USAGE_RESET_IN_FLIGHT = `
  create table if not exists subscription_usage_reset_in_flight (
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    action_id text not null check (length(action_id) > 0),
    credit_id text not null check (length(credit_id) > 0),
    provider_key text not null check (length(provider_key) > 0),
    reviewed_incarnation text not null check (length(reviewed_incarnation) > 0),
    reviewed_revision integer not null check (reviewed_revision >= 0),
    primary key (provider_id, instance_id, subject_digest)
  )
`;


export interface RawUsageLedgerEntry { readonly entry_json: string }


export interface UsageRangeBounds { readonly startMs: number; readonly endMs: number; readonly start: string; readonly end: string }

/** Validates a strict half-open ledger range. */
export function usageRangeBounds(startMs: number, endMs: number): UsageRangeBounds {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || startMs >= endMs) throw new Error("Usage range must be a non-empty half-open range of non-negative safe integers");
  return { startMs, endMs, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}
/** Derives the current local calendar month as a strict half-open range. */
export function localMonthBounds(atMs: number): UsageRangeBounds {
  const at = new Date(atMs);
  if (!Number.isFinite(at.getTime())) throw new Error("Usage month timestamp must be finite");
  const start = new Date(at.getFullYear(), at.getMonth(), 1).getTime();
  const end = new Date(at.getFullYear(), at.getMonth() + 1, 1).getTime();
  return usageRangeBounds(start, end);
}
