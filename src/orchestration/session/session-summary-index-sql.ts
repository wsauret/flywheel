import { Database } from "bun:sqlite"
import { Schema } from "effect"

import type { BudgetProjectionState } from "./budget-projection.js"
import type { UsageTotals } from "./budget-summary.js"
import type { DiffStatSummary } from "./diff-stat-summary.js"
import type { SessionDurationProjectionState } from "./session-duration-projection.js"

// The index is derived state: raise the generation whenever the fold changes
// what it derives, so an index of another generation rebuilds from the log.
const SESSION_SUMMARY_INDEX_GENERATION = 13

export type SessionSummaryScope = "budget" | "duration" | "diffStats" | "descendants" | "generation"

export interface StoredSessionSummary {
  readonly budget: BudgetProjectionState
  readonly duration: SessionDurationProjectionState
  readonly diffStats: DiffStatSummary | null
  /** The output tokens and the duration of the session's own recorded
   *  generation measurements, pooled. */
  readonly generation: GenerationSums
}

interface GenerationSums {
  readonly outputTokens: number
  readonly durationMs: number
}

interface SessionSummaryKindChange {
  readonly changed: boolean
  readonly becameEligible: boolean
}

interface SessionSummaryErrors {
  readonly budget?: string
  readonly duration?: string
  readonly diffStats?: string
  readonly descendants?: string
  readonly generation?: string
}

const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const BudgetProjectionStateSchema = Schema.Struct({
  totalCost: NonNegativeNumber,
  totalBilledCost: NonNegativeNumber,
  priceUnavailable: Schema.Boolean,
  totalInputTokens: NonNegativeInt,
  totalOutputTokens: NonNegativeInt,
  unmeasuredRequests: NonNegativeInt,
  invocationsUsed: NonNegativeInt,
  contextPromptTokens: NonNegativeInt,
  contextWindow: NonNegativeInt,
  compactionTriggerTokens: Schema.optionalKey(NonNegativeInt),
  streamBaselines: Schema.Record(Schema.String, Schema.Struct({
    cost: NonNegativeNumber,
    billedCost: NonNegativeNumber,
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
  })),
  committedUsageStreams: Schema.Record(Schema.String, Schema.Literal(true)),
})
const decodeBudgetProjectionState = Schema.decodeUnknownSync(BudgetProjectionStateSchema, { onExcessProperty: "error" })

const EMPTY_USAGE: UsageTotals = {
  totalCost: 0,
  totalBilledCost: 0,
  priceUnavailable: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,
}

export function initializeSessionSummarySchema(db: Database): void {
  const generation = db.query<{ user_version: number }, []>("pragma user_version").get()?.user_version
  if (generation === SESSION_SUMMARY_INDEX_GENERATION && sessionSummarySchemaMatches(db)) return
  rebuildSessionSummarySchema(db)
}

export function rebuildSessionSummarySchema(db: Database): void {
  db.exec(`
    drop table if exists session_summary_watermark;
    drop table if exists session_summary_local;
    drop table if exists session_summary_usage;
    drop table if exists session_summary_direct;
    drop table if exists session_summary_kind;
    drop table if exists session_summary_edge;
    drop table if exists session_summary_descendant;
    drop table if exists session_summary_error;
    create table session_summary_watermark (position integer not null);
    insert into session_summary_watermark values (0);
    create table session_summary_local (
      session_id text primary key,
      budget_json text not null,
      duration_ms integer not null,
      diff_added integer,
      diff_modified integer,
      diff_removed integer,
      generation_output_tokens integer not null,
      generation_duration_ms real not null
    );
    create table session_summary_usage (
      session_id text not null,
      semantic_id text not null,
      primary key (session_id, semantic_id)
    );
    create table session_summary_direct (
      session_id text primary key,
      total_cost real not null,
      total_billed_cost real not null,
      price_unavailable integer not null,
      input_tokens integer not null,
      output_tokens integer not null
    );
    create table session_summary_kind (session_id text primary key, kind text not null);
    create table session_summary_edge (
      parent_id text not null,
      child_id text not null,
      primary key (parent_id, child_id)
    );
    create index session_summary_edge_child_idx on session_summary_edge(child_id);
    create table session_summary_descendant (
      session_id text primary key,
      total_cost real not null,
      total_billed_cost real not null,
      price_unavailable integer not null,
      input_tokens integer not null,
      output_tokens integer not null
    );
    create table session_summary_error (
      session_id text not null,
      scope text not null,
      reason text not null,
      primary key (session_id, scope)
    );
    pragma user_version = ${SESSION_SUMMARY_INDEX_GENERATION};
  `)
}

function sessionSummarySchemaMatches(db: Database): boolean {
  try {
    db.query("select position from session_summary_watermark limit 0").get()
    db.query("select session_id, budget_json, duration_ms, diff_added, diff_modified, diff_removed, generation_output_tokens, generation_duration_ms from session_summary_local limit 0").get()
    db.query("select session_id, semantic_id from session_summary_usage limit 0").get()
    db.query("select session_id, total_cost, total_billed_cost, price_unavailable, input_tokens, output_tokens from session_summary_direct limit 0").get()
    db.query("select session_id, kind from session_summary_kind limit 0").get()
    db.query("select parent_id, child_id from session_summary_edge indexed by session_summary_edge_child_idx limit 0").get()
    db.query("select session_id, total_cost, total_billed_cost, price_unavailable, input_tokens, output_tokens from session_summary_descendant limit 0").get()
    db.query("select session_id, scope, reason from session_summary_error limit 0").get()
    return true
  } catch {
    return false
  }
}

export function readSummaryWatermark(db: Database): number | undefined {
  const rows = db.query<{ position: unknown }, []>("select position from session_summary_watermark").all()
  if (rows.length !== 1) return undefined
  const position = rows[0]?.position
  return typeof position === "number" && Number.isSafeInteger(position) && position >= 0 ? position : undefined
}

export function updateSummaryWatermark(db: Database, expected: number, next: number): boolean {
  return db.query("update session_summary_watermark set position = ? where position = ?").run(next, expected).changes === 1
}

export function readStoredSessionSummary(db: Database, sessionId: string): StoredSessionSummary | undefined {
  const row = db.query<{
    budget_json: string
    duration_ms: number
    diff_added: number | null
    diff_modified: number | null
    diff_removed: number | null
    generation_output_tokens: number
    generation_duration_ms: number
  }, [string]>("select budget_json, duration_ms, diff_added, diff_modified, diff_removed, generation_output_tokens, generation_duration_ms from session_summary_local where session_id = ?").get(sessionId)
  if (!row) return undefined
  return {
    budget: { ...decodeBudgetProjectionState(JSON.parse(row.budget_json)), settledUsageEntryIds: {} },
    duration: { accumulatedActiveMs: row.duration_ms },
    diffStats: row.diff_added === null ? null : { added: row.diff_added, modified: row.diff_modified ?? 0, removed: row.diff_removed ?? 0 },
    generation: { outputTokens: row.generation_output_tokens, durationMs: row.generation_duration_ms },
  }
}

export function writeStoredSessionSummary(db: Database, sessionId: string, summary: StoredSessionSummary): void {
  db.query(`insert into session_summary_local values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(session_id) do update set budget_json=excluded.budget_json, duration_ms=excluded.duration_ms,
      diff_added=excluded.diff_added, diff_modified=excluded.diff_modified, diff_removed=excluded.diff_removed,
      generation_output_tokens=excluded.generation_output_tokens, generation_duration_ms=excluded.generation_duration_ms`).run(
    sessionId,
    JSON.stringify({
      totalCost: summary.budget.totalCost,
      totalBilledCost: summary.budget.totalBilledCost,
      priceUnavailable: summary.budget.priceUnavailable,
      totalInputTokens: summary.budget.totalInputTokens,
      totalOutputTokens: summary.budget.totalOutputTokens,
      unmeasuredRequests: summary.budget.unmeasuredRequests,
      invocationsUsed: summary.budget.invocationsUsed,
      contextPromptTokens: summary.budget.contextPromptTokens,
      contextWindow: summary.budget.contextWindow,
      compactionTriggerTokens: summary.budget.compactionTriggerTokens,
      streamBaselines: summary.budget.streamBaselines,
      committedUsageStreams: summary.budget.committedUsageStreams,
    }),
    summary.duration.accumulatedActiveMs,
    summary.diffStats?.added ?? null,
    summary.diffStats?.modified ?? null,
    summary.diffStats?.removed ?? null,
    summary.generation.outputTokens,
    summary.generation.durationMs,
  )
}

/** Claims one canonical V4/V5 usage identity before any totals are changed. */
export function insertSemanticUsage(db: Database, sessionId: string, semanticId: string): boolean {
  return db.query("insert or ignore into session_summary_usage (session_id, semantic_id) values (?, ?)").run(sessionId, semanticId).changes === 1
}

export function addDirectUsage(db: Database, sessionId: string, usage: UsageTotals): void {
  addUsageRow(db, "session_summary_direct", sessionId, usage)
}

export function readDescendantUsage(db: Database, sessionId: string): UsageTotals {
  return readUsageRow(db, "session_summary_descendant", sessionId)
}

export function putSessionSummaryKind(db: Database, sessionId: string, kind: string): SessionSummaryKindChange {
  const current = db.query<{ kind: string }, [string]>("select kind from session_summary_kind where session_id = ?").get(sessionId)
  if (current?.kind === kind) return { changed: false, becameEligible: false }
  db.query("insert into session_summary_kind values (?, ?) on conflict(session_id) do update set kind=excluded.kind").run(sessionId, kind)
  return { changed: true, becameEligible: !isLaunchedDescendantKind(current?.kind) && isLaunchedDescendantKind(kind) }
}

/** The child kinds whose work counts as work of their ancestors: their
 *  request usage (PI-INTERACTION-006) and their file changes
 *  (PI-INTERACTION-008). A fork is a chat, so it stays independent of its
 *  source. The summary fold, its live refresh, the statistics reader, and the
 *  change review all use this one rule, so their totals cannot disagree. */
const LAUNCHED_DESCENDANT_KINDS = ["subagent", "workflow", "workflow-agent", "aggregate"] as const
const LAUNCHED_DESCENDANT_KINDS_SQL = LAUNCHED_DESCENDANT_KINDS.map((kind) => `'${kind}'`).join(", ")

export function isLaunchedDescendantKind(kind: string | undefined): boolean {
  return LAUNCHED_DESCENDANT_KINDS.some((eligible) => eligible === kind)
}

export function putSessionSummaryEdge(db: Database, parentId: string, childId: string): boolean {
  return db.query("insert or ignore into session_summary_edge values (?, ?)").run(parentId, childId).changes === 1
}

function sessionSummaryKind(db: Database, sessionId: string): string | undefined {
  return db.query<{ kind: string }, [string]>("select kind from session_summary_kind where session_id = ?").get(sessionId)?.kind
}

/** Adds a new direct usage leaf to every currently eligible ancestor. */
export function propagateUsageToAncestors(db: Database, sessionId: string, usage: UsageTotals): void {
  if (!isLaunchedDescendantKind(sessionSummaryKind(db, sessionId))) return
  for (const ancestorId of ancestorIds(db, sessionId)) addUsageRow(db, "session_summary_descendant", ancestorId, usage)
}

/** Adds a newly counted child, with its subtree, to every ancestor that now
 *  counts it. The fold calls this when an edge to the child arrives or when
 *  the child's kind becomes counted.
 *
 *  The child's descendant row already holds its whole subtree, so in a tree
 *  each ancestor gains the child's direct plus descendant totals once. That
 *  is exact only when no ancestor already counts part of that subtree, which
 *  is true when no session in it has a second parent edge. An ownership
 *  adoption can give a workflow a second parent, so that rare case rebuilds
 *  each affected ancestor from the distinct sessions it counts.
 *
 *  An error needs no such guard: marking an ancestor twice has no effect, and
 *  the child's own error rows already stand for every failure under it. */
export function propagateEligibleChild(db: Database, childId: string, parentId?: string): void {
  const kind = sessionSummaryKind(db, childId)
  if (kind !== undefined && !isLaunchedDescendantKind(kind)) return
  const failure = db.query<{ reason: string }, [string]>(
    "select reason from session_summary_error where session_id = ? and scope in ('budget', 'descendants') order by scope limit 1",
  ).get(childId)?.reason
  if (failure !== undefined) propagateDescendantError(db, childId, failure, parentId)
  // A child whose creation is unreadable has no kind, but it can still be a
  // counted child. Its error marks its ancestors; its usage stays uncounted.
  if (kind === undefined) return
  const ancestors = ancestorIds(db, childId, parentId)
  if (ancestors.length === 0) return
  if (subtreeHasSecondParent(db, childId)) {
    for (const ancestorId of ancestors) recomputeDescendantUsage(db, ancestorId)
    return
  }
  const usage = addUsage(readUsageRow(db, "session_summary_direct", childId), readUsageRow(db, "session_summary_descendant", childId))
  for (const ancestorId of ancestors) addUsageRow(db, "session_summary_descendant", ancestorId, usage)
}

/** Tells whether the session or any session it counts has more than one
 *  parent edge. A session with one parent edge has one path into it. */
function subtreeHasSecondParent(db: Database, sessionId: string): boolean {
  return db.query<{ present: number }, [string]>(`
    with recursive subtree(session_id) as (
      select ?
      union
      select edge.child_id from subtree
      join session_summary_edge edge on edge.parent_id = subtree.session_id
      join session_summary_kind kind on kind.session_id = edge.child_id
      where kind.kind in (${LAUNCHED_DESCENDANT_KINDS_SQL})
    )
    select 1 present from subtree
    join session_summary_edge edge on edge.child_id = subtree.session_id
    group by subtree.session_id having count(*) > 1 limit 1`).get(sessionId) != null
}

/** Rebuilds one ancestor's descendant totals from the distinct sessions that
 *  it counts, so a session that it reaches by two paths counts once. */
function recomputeDescendantUsage(db: Database, ancestorId: string): void {
  db.query(`
    with recursive descendants(session_id) as (
      select edge.child_id from session_summary_edge edge
      join session_summary_kind kind on kind.session_id = edge.child_id
      where edge.parent_id = ? and kind.kind in (${LAUNCHED_DESCENDANT_KINDS_SQL})
      union
      select edge.child_id from descendants
      join session_summary_edge edge on edge.parent_id = descendants.session_id
      join session_summary_kind kind on kind.session_id = edge.child_id
      where kind.kind in (${LAUNCHED_DESCENDANT_KINDS_SQL})
    )
    insert or replace into session_summary_descendant
    select ?, coalesce(sum(total_cost), 0), coalesce(sum(total_billed_cost), 0),
      coalesce(max(price_unavailable), 0), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
    from descendants join session_summary_direct using (session_id)
    where session_id <> ?`).run(ancestorId, ancestorId, ancestorId)
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    totalCost: left.totalCost + right.totalCost,
    totalBilledCost: left.totalBilledCost + right.totalBilledCost,
    priceUnavailable: left.priceUnavailable || right.priceUnavailable,
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
    totalOutputTokens: left.totalOutputTokens + right.totalOutputTokens,
  }
}

/** Marks every ancestor that counts this session as having unknown
 *  descendant usage. A session without a kind can be a counted child whose
 *  creation is unreadable, so its ancestors are marked too. */
export function propagateDescendantError(db: Database, sessionId: string, reason: string, parentId?: string): void {
  const kind = sessionSummaryKind(db, sessionId)
  if (kind !== undefined && !isLaunchedDescendantKind(kind)) return
  for (const ancestorId of ancestorIds(db, sessionId, parentId)) putSummaryError(db, ancestorId, "descendants", reason)
}

function ancestorIds(db: Database, childId: string, parentId?: string): string[] {
  const rows = parentId === undefined
    ? db.query<{ session_id: string }, [string, string]>(`
      with recursive ancestors(session_id) as (
        select parent_id from session_summary_edge where child_id = ?
        union
        select edge.parent_id
        from ancestors
        join session_summary_kind kind on kind.session_id = ancestors.session_id and kind.kind in (${LAUNCHED_DESCENDANT_KINDS_SQL})
        join session_summary_edge edge on edge.child_id = ancestors.session_id
      )
      select session_id from ancestors where session_id <> ?`).all(childId, childId)
    : db.query<{ session_id: string }, [string, string, string, string]>(`
      with recursive ancestors(session_id) as (
        select ? where exists (
          select 1 from session_summary_edge where parent_id = ? and child_id = ?
        )
        union
        select edge.parent_id
        from ancestors
        join session_summary_kind kind on kind.session_id = ancestors.session_id and kind.kind in (${LAUNCHED_DESCENDANT_KINDS_SQL})
        join session_summary_edge edge on edge.child_id = ancestors.session_id
      )
      select session_id from ancestors where session_id <> ?`).all(parentId, parentId, childId, childId)
  return rows.map((row) => row.session_id)
}

function addUsageRow(db: Database, table: "session_summary_direct" | "session_summary_descendant", sessionId: string, usage: UsageTotals): void {
  db.query(`insert into ${table}
      (session_id, total_cost, total_billed_cost, price_unavailable, input_tokens, output_tokens)
      values (?, ?, ?, ?, ?, ?)
      on conflict(session_id) do update set
        total_cost = total_cost + excluded.total_cost,
        total_billed_cost = total_billed_cost + excluded.total_billed_cost,
        price_unavailable = max(price_unavailable, excluded.price_unavailable),
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens`).run(
    sessionId,
    usage.totalCost,
    usage.totalBilledCost,
    usage.priceUnavailable ? 1 : 0,
    usage.totalInputTokens,
    usage.totalOutputTokens,
  )
}

function readUsageRow(db: Database, table: "session_summary_direct" | "session_summary_descendant", sessionId: string): UsageTotals {
  const row = db.query<{
    total_cost: number
    total_billed_cost: number
    price_unavailable: number
    input_tokens: number
    output_tokens: number
  }, [string]>(`select total_cost, total_billed_cost, price_unavailable, input_tokens, output_tokens from ${table} where session_id = ?`).get(sessionId)
  return row ? {
    totalCost: row.total_cost,
    totalBilledCost: row.total_billed_cost,
    priceUnavailable: row.price_unavailable !== 0,
    totalInputTokens: row.input_tokens,
    totalOutputTokens: row.output_tokens,
  } : EMPTY_USAGE
}

export function putSummaryError(db: Database, sessionId: string, scope: SessionSummaryScope, reason: string): void {
  db.query("insert or ignore into session_summary_error values (?, ?, ?)").run(sessionId, scope, reason)
}

export function hasSummaryError(db: Database, sessionId: string, scope: SessionSummaryScope): boolean {
  return db.query<{ present: number }, [string, string]>("select 1 present from session_summary_error where session_id = ? and scope = ?").get(sessionId, scope) != null
}

export function readSummaryErrors(db: Database, sessionId: string): SessionSummaryErrors {
  const rows = db.query<{ scope: SessionSummaryScope; reason: string }, [string]>("select scope, reason from session_summary_error where session_id = ?").all(sessionId)
  const errors = new Map(rows.map((row) => [row.scope, row.reason]))
  const budget = errors.get("budget")
  const duration = errors.get("duration")
  const diffStats = errors.get("diffStats")
  const descendants = errors.get("descendants")
  const generation = errors.get("generation")
  return {
    ...(budget === undefined ? {} : { budget }),
    ...(duration === undefined ? {} : { duration }),
    ...(diffStats === undefined ? {} : { diffStats }),
    ...(descendants === undefined ? {} : { descendants }),
    ...(generation === undefined ? {} : { generation }),
  }
}
