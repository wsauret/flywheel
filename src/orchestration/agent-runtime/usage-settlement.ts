import { Schema } from "effect"
import { InFlightSwapConflictError } from "../../infra/event-store-types.js"
import type { AsyncEventStateReadSurface, InFlightWrite } from "../../infra/event-store-types.js"
import type { UsageAuthority } from "../../infra/llm/usage-authority.js"
import { decodeUsageEntry, migrateUncoveredUsageEntry, UsageEntrySchema } from "../../infra/llm/usage-entry.js"
import { Log } from "../../infra/log.js"
import { isRecord } from "../../infra/record.js"
import { ProviderRequestIdentitySchema } from "../session/provider-request-audit-types.js"
import type { SessionFactWriter } from "../session/session-fact-writer.js"
import { durableOwnerId, type DurableOwner } from "../../infra/durable-owner.js"

export const USAGE_SETTLEMENT_IN_FLIGHT_KIND = "usage.settlement"

const log = Log.create({ service: "usage-settlement" })

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

const UsageSettlementDraftFields = {
  budgetStreamId: NonEmptyString,
  requestId: NonEmptyString,
  identity: ProviderRequestIdentitySchema,
  turn: PositiveInt,
  /** The attempt of an agent of a workflow that made the request. */
  workflowAttemptId: Schema.optionalKey(NonEmptyString),
  parentToolUseId: Schema.optionalKey(NonEmptyString),
} as const

const UsageSettlementDraftSchema = Schema.Struct({ entry: UsageEntrySchema, ...UsageSettlementDraftFields })

/** One attempt's settlement record: the entry it settles as, with the request identity its session facts need. */
export type UsageSettlementDraft = typeof UsageSettlementDraftSchema.Type

// Remove after 2027-04-30. Earlier builds wrote `pending` cells with no serving attribution before the wire attempt,
// and `measured` or unstated cells whose entry predates coverage.
const PendingCheckpointV1Schema = Schema.Struct({
  state: Schema.Literal("pending"),
  attemptId: NonEmptyString,
  requestId: NonEmptyString,
  profileId: NonEmptyString,
  budgetStreamId: NonEmptyString,
  identity: ProviderRequestIdentitySchema,
  turn: PositiveInt,
})
const MeasuredCheckpointV1Schema = Schema.Struct({ entry: Schema.Unknown, ...UsageSettlementDraftFields })

/** A durable settlement cell: a draft, or an older build's pending cell, which names no serving candidate and so can
 *  only be retired. */
type UsageSettlementCheckpoint =
  | { readonly kind: "draft"; readonly draft: UsageSettlementDraft }
  | { readonly kind: "legacy-pending"; readonly attemptId: string; readonly identity: UsageSettlementDraft["identity"] }

const decodeDraftFields = Schema.decodeUnknownSync(UsageSettlementDraftSchema, { onExcessProperty: "error" })
function decodeDraft(value: unknown): UsageSettlementDraft {
  const draft = decodeDraftFields(value)
  return { ...draft, entry: decodeUsageEntry(draft.entry) }
}

/** Reads current or retained settlement cells without settling or charging them, converting older shapes.
 *  Throws on unreadable evidence. */
export function decodeUsageSettlementCheckpoint(stored: unknown): UsageSettlementCheckpoint {
  let value = stored
  // Remove after 2027-04-30. Earlier checkpoints named the workflow attempt stepId.
  if (isRecord(stored) && "stepId" in stored) {
    const { stepId, ...rest } = stored
    value = { ...rest, workflowAttemptId: stepId }
  }
  if (isRecord(value) && value.state === "pending") {
    const pending = Schema.decodeUnknownSync(PendingCheckpointV1Schema, { onExcessProperty: "error" })(value)
    return { kind: "legacy-pending", attemptId: pending.attemptId, identity: pending.identity }
  }
  if (isRecord(value) && (value.state === "measured" || (isRecord(value.entry) && !("coverage" in value.entry)))) {
    const { state: _state, ...fields } = value
    const legacy = Schema.decodeUnknownSync(MeasuredCheckpointV1Schema, { onExcessProperty: "error" })(fields)
    return { kind: "draft", draft: { ...legacy, entry: migrateUncoveredUsageEntry(legacy.entry) } }
  }
  return { kind: "draft", draft: decodeDraft(value) }
}
export type UsageSettlementRetirement = Extract<InFlightWrite, { readonly op: "drop" }>

export interface UsageAuthorityGeneration {
  readonly profileId: string
  readonly authorityIncarnation: string
}

interface UsageSettlementAuthority {
  append: UsageAuthority["append"]
  dispose(): void
}

export interface UsageSettlementAuthorityLease extends UsageAuthorityGeneration {
  append: UsageAuthority["append"]
  release(): Promise<void>
}

interface UsageSettlementReader {
  readonly readInFlight: AsyncEventStateReadSurface["readInFlight"]
}

type UsageSettlementOptions = {
  putInFlight(kind: string, key: string, payload: unknown): Promise<void>
  retire(retirement: UsageSettlementRetirement): Promise<void>
  /** Atomically publishes idempotent session facts and the supplied retirement. */
  publish(draft: UsageSettlementDraft, retirement: UsageSettlementRetirement): Promise<{ readonly kind: "published" | "duplicate" }>
} & (
  | { acquireAuthority(profileId: string): Promise<UsageSettlementAuthorityLease>; openAuthority?: never }
  | { openAuthority(profileId: string): UsageSettlementAuthority; acquireAuthority?: never }
)

export interface UsageSettlement {
  /** Persists the attempt's unmeasured record, with its serving attribution, before the provider wire attempt starts. */
  begin(draft: UsageSettlementDraft): Promise<void>
  /** Replaces the attempt's record with a measured one after the provider reports usage. */
  checkpoint(draft: UsageSettlementDraft): Promise<void>
  /** Settles the latest record of an attempt. An attempt the provider did not serve, which is still unmeasured,
   *  retires with no record. Missing records are a no-op. */
  settle(attemptId: string, outcome: { readonly served: boolean }): Promise<void>
  /** Resumes an already durable record without rerunning provider work. Skips an attempt that is still running in
   *  this process. */
  recover(payload: unknown): Promise<void>
}

interface SessionUsageSettlementOptions {
  readonly owner: DurableOwner
  readonly reader: UsageSettlementReader
  readonly writer: SessionFactWriter
  readonly acquireAuthority: (profileId: string) => Promise<UsageSettlementAuthorityLease>
  readonly onCommitted?: (entry: UsageSettlementDraft["entry"]) => void
}

function recordedTokens(entry: UsageSettlementDraft["entry"]) {
  if (entry.coverage === "unmeasured") {
    return { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, reasoningTokens: null, promptTokens: null }
  }
  const { input, output, cacheRead, cacheWrite, reasoning } = entry.tokens
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    reasoningTokens: reasoning,
    promptTokens: cacheRead === null ? null : input + cacheRead + cacheWrite,
  }
}

/** Creates the session-backed settlement saga and publishes audit and budget facts in one atomic batch. */
export function createSessionUsageSettlement(options: SessionUsageSettlementOptions): UsageSettlement {
  const putInFlight = options.writer.putInFlight
  const dropInFlight = options.writer.dropInFlight
  if (!putInFlight || !dropInFlight) throw new Error("Usage settlement requires in-flight persistence authority")
  return createUsageSettlement({
    putInFlight,
    retire: async (retirement) => dropInFlight(retirement.kind, retirement.key),
    acquireAuthority: options.acquireAuthority,
    publish: async (draft, retirement) => {
      const cell = (await options.reader.readInFlight(durableOwnerId(options.owner), retirement.kind))
        .find((record) => record.key === retirement.key)
      if (!cell) return { kind: "duplicate" }
      const guardedRetirement: InFlightWrite = {
        op: "swap",
        kind: retirement.kind,
        key: retirement.key,
        expectedRaw: cell.raw,
        payload: null,
      }
      try {
        await options.writer.transaction(() => {
          const { entry } = draft
          void options.writer.record({
            type: "model.usage.recorded",
            version: 5,
            actor: "provider",
            payload: {
              requestId: draft.requestId,
              attemptId: entry.attemptId,
              identity: draft.identity,
              turn: draft.turn,
              ...(draft.workflowAttemptId ? { workflowAttemptId: draft.workflowAttemptId } : {}),
              ...(draft.parentToolUseId ? { parentToolUseId: draft.parentToolUseId } : {}),
              coverage: entry.coverage,
              ...recordedTokens(entry),
            },
          })
          void options.writer.record({
            type: "model.usage.measured",
            version: 6,
            actor: "provider",
            payload: {
              ...entry,
              ...(draft.parentToolUseId ? { parentToolUseId: draft.parentToolUseId } : {}),
              budgetStreamId: draft.budgetStreamId,
            },
          }, undefined, [guardedRetirement])
        })
      } catch (error) {
        if (error instanceof InFlightSwapConflictError) return { kind: "duplicate" }
        throw error
      }
      options.onCommitted?.(draft.entry)
      return { kind: "published" }
    },
  })
}

/** Settles a profile-backed request that has no durable session.
 *
 * The profile Usage ledger remains authoritative and the caller receives the
 * committed entry for local totals. Process interruption can lose an unsettled
 * request because no session exists to own a recoverable checkpoint. */
export function createProcessUsageSettlement(options: {
  readonly acquireAuthority: (profileId: string) => Promise<UsageSettlementAuthorityLease>
  readonly onCommitted: (entry: UsageSettlementDraft["entry"]) => void
}): UsageSettlement {
  return createUsageSettlement({
    putInFlight: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    acquireAuthority: options.acquireAuthority,
    publish: (draft) => {
      options.onCommitted(draft.entry)
      return Promise.resolve({ kind: "published" })
    },
  })
}

/** Replays all interrupted settlements for this session before new provider work starts. */
export async function recoverSessionUsageSettlements(options: SessionUsageSettlementOptions, settlement: UsageSettlement): Promise<void> {
  // A cell of an attempt that is live at any time during this recovery belongs to that attempt, which can settle while
  // recovery awaits an earlier cell and so leave the read payload stale. Every other cell is current: a live settle
  // leaves `liveAttempts` only after its cell is retired.
  const excluded = new Set(liveAttempts)
  recoveryExclusions.add(excluded)
  try {
    for (const { key, payload } of await options.reader.readInFlight(durableOwnerId(options.owner), USAGE_SETTLEMENT_IN_FLIGHT_KIND)) {
      if (!excluded.has(key)) await settlement.recover(payload)
    }
  } finally {
    recoveryExclusions.delete(excluded)
  }
}

/** The attempts whose provider work runs in this process. One resident account service owns serving, so a live
 *  attempt and a recovery that reads its cell run in one process. A side question settles under its parent's owner,
 *  whose next run recovers while the question can still be live. */
const liveAttempts = new Set<string>()
/** For each running session recovery, the attempts it leaves to their live owner: every attempt live at its start or
 *  begun since. */
const recoveryExclusions = new Set<Set<string>>()

/** Whether the attempt's provider work still runs in this process, so its settlement cell is a request in progress. */
export function isUsageAttemptLive(attemptId: string): boolean {
  return liveAttempts.has(attemptId)
}

/** Owns the record-before-act saga from one provider attempt to its exact profile ledger and atomic session publication. */
export function createUsageSettlement(options: UsageSettlementOptions): UsageSettlement {
  const drafts = new Map<string, UsageSettlementDraft>()
  const retirement = (attemptId: string): UsageSettlementRetirement => ({ op: "drop", kind: USAGE_SETTLEMENT_IN_FLIGHT_KIND, key: attemptId })

  const appendAndPublish = async (draft: UsageSettlementDraft): Promise<void> => {
    if (options.acquireAuthority) {
      const lease = await options.acquireAuthority(draft.entry.profileId)
      try {
        if (lease.profileId !== draft.entry.profileId) {
          throw new Error(`Usage authority profile mismatch: expected ${draft.entry.profileId}, received ${lease.profileId}`)
        }
        lease.append(draft.entry)
        await options.publish(draft, retirement(draft.entry.attemptId))
      } finally {
        await lease.release()
      }
      return
    }
    const authority = options.openAuthority(draft.entry.profileId)
    try {
      authority.append(draft.entry)
    } finally {
      authority.dispose()
    }
    await options.publish(draft, retirement(draft.entry.attemptId))
  }

  const record = async (value: UsageSettlementDraft): Promise<void> => {
    const draft = decodeDraft(value)
    await options.putInFlight(USAGE_SETTLEMENT_IN_FLIGHT_KIND, draft.entry.attemptId, draft)
    drafts.set(draft.entry.attemptId, draft)
  }

  return {
    async begin(value): Promise<void> {
      liveAttempts.add(value.entry.attemptId)
      for (const excluded of recoveryExclusions) excluded.add(value.entry.attemptId)
      await record(value)
    },
    checkpoint: record,
    async settle(attemptId, { served }): Promise<void> {
      const draft = drafts.get(attemptId)
      try {
        if (draft === undefined) return
        // Nothing was served: the provider refused the request or the connection failed before a response.
        if (!served && draft.entry.coverage === "unmeasured") await options.retire(retirement(attemptId))
        else await appendAndPublish(draft)
        drafts.delete(attemptId)
      } finally {
        liveAttempts.delete(attemptId)
      }
    },
    async recover(payload): Promise<void> {
      const checkpoint = decodeUsageSettlementCheckpoint(payload)
      if (checkpoint.kind === "legacy-pending") {
        log.warn("usage settlement retired a pending checkpoint from an earlier build; its usage is unknown", { attemptId: checkpoint.attemptId })
        await options.retire(retirement(checkpoint.attemptId))
        return
      }
      if (liveAttempts.has(checkpoint.draft.entry.attemptId)) return
      await appendAndPublish(checkpoint.draft)
    },
  }
}
