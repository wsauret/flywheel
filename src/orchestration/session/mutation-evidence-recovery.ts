import { Schema } from "effect"
import {
  CorruptEventRowError, type AsyncEventStateReadSurface, type AsyncEventWriter,
  type InFlightRecord, type StoredFact,
} from "../../infra/event-store-types.js"
import { asRecord } from "../../infra/record.js"
import { MutationDiffSchema, type MutationDiff } from "../../infra/mutation-diff.js"
import { buildMutationDiffEntries } from "../../infra/mutation-diff-evidence.js"
import { buildMutationEvidence, type MutationEvidenceEntry, type MutationFileEvidence } from "../../infra/mutation-evidence.js"
import type { StageSessionContentNodes } from "../../infra/session-content.js"
import { ReviewNoticeMutationSchema } from "../../infra/review-notice.js"
import { AgentSystemMessageV1DataSchema, AgentSystemMessageV2DataSchema } from "../../infra/events.js"
import { parseStoredSessionRuntimeFact } from "../../infra/runtime-fact-parser.js"
import { MutationEvidenceResultDetailsSchema } from "../../infra/runtime-mutation-evidence.js"
import { parseConversationTreeFact } from "./conversation/conversation-facts.js"
import { parseFileMutationFact } from "./file-mutation-facts.js"
import { parseFileMutationOperationCell, parseFileMutationOperationHeader, stageFileMutationOperation, type FileMutationOperationHeader } from "./file-mutation-operation.js"
import { decodeLegacyFinalizedToolResultCheckpoint, FinalizedToolResultCheckpointSchema, UnversionedFinalizedToolResultCheckpointSchema, type FinalizedToolResultCheckpoint } from "./finalized-tool-result-checkpoint.js"

const decodeDiff = Schema.decodeUnknownSync(MutationDiffSchema, { onExcessProperty: "error" })
const decodeUnversionedCheckpoint = Schema.decodeUnknownSync(UnversionedFinalizedToolResultCheckpointSchema, { onExcessProperty: "error" })
const decodeCheckpoint = Schema.decodeUnknownSync(FinalizedToolResultCheckpointSchema, { onExcessProperty: "error" })
const decodeReviews = Schema.decodeUnknownSync(Schema.Array(ReviewNoticeMutationSchema), { onExcessProperty: "error" })
const historicalFamilies = new Set(["tool.result.recorded", "tool.execution_output.recorded", "file.artifact.recorded", "chat.entries.appended", "agent.system_message.recorded"])

interface HistoricalMutationFields { readonly [key: string]: unknown }

function validateMutationFields(value: HistoricalMutationFields): void {
  if (value.mutation !== undefined) decodeDiff(value.mutation)
  for (const key of ["conflicts", "conflictMarkers"]) if (value[key] !== undefined) Schema.decodeUnknownSync(Schema.Array(Schema.String))(value[key])
  if (value.notApplied !== undefined) Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })), { onExcessProperty: "error" })(value.notApplied)
  const { mutation: _mutation, conflicts: _conflicts, conflictMarkers: _markers, notApplied: _notApplied, ...details } = value
  Schema.decodeUnknownSync(MutationEvidenceResultDetailsSchema)(details)
}

function hasOneRetainedTarget(diff: MutationDiff, source: { readonly path: unknown; readonly displayPath: unknown }): boolean {
  return [...diff.files, ...diff.omissions].filter(file => file.path === source.path || file.path === source.displayPath).length === 1
}

/** Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16.
 * Construct beside the owning writer, never across a state transport. Construction
 * performs no reads. Only selected historical values stage content. SQLite facts
 * remain immutable; converted cells use their exact old raw text as the CAS token.
 * Storage failures propagate. Unreadable history yields a bounded typed gap. */
export function createMutationEvidenceRecovery(reader: AsyncEventStateReadSurface, writer: Pick<AsyncEventWriter, "stageSessionContentNodes" | "swapInFlight">) {
  const stage = (sessionId: string): StageSessionContentNodes => async nodes => {
    if (!writer.stageSessionContentNodes) throw new Error("Mutation evidence recovery requires local content staging")
    await writer.stageSessionContentNodes(sessionId, nodes)
  }

  async function entries(value: unknown, sessionId: string, identity: string) {
    const diff = decodeDiff(value)
    return buildMutationDiffEntries(diff, identity, stage(sessionId))
  }

  async function mutationFields(value: HistoricalMutationFields, sessionId: string, identity: string) {
    const { mutation, conflicts, conflictMarkers, notApplied, ...rest } = value
    const retained: MutationEvidenceEntry[] = mutation === undefined ? [] : await entries(mutation, sessionId, identity)
    if (conflictMarkers !== undefined) {
      const paths = Schema.decodeUnknownSync(Schema.Array(Schema.String))(conflictMarkers)
      for (const entry of retained) if (entry.kind === "display" && paths.includes(entry.file.path)) {
        retained[retained.indexOf(entry)] = { ...entry, file: { ...entry.file, conflictMarkers: true } }
      }
    }
    if (conflicts !== undefined) {
      const paths = Schema.decodeUnknownSync(Schema.Array(Schema.String))(conflicts)
      retained.push(...paths.map(path => ({ kind: "not_applied" as const, path, reason: "project changed while the command ran" })))
    }
    if (notApplied !== undefined) {
      const files = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })), { onExcessProperty: "error" })(notApplied)
      retained.push(...files.map(file => ({ kind: "not_applied" as const, ...file })))
    }
    return { ...rest, ...(mutation !== undefined || conflicts !== undefined || notApplied !== undefined
      ? { mutationEvidence: await buildMutationEvidence(retained, stage(sessionId)) } : {}) }
  }

  async function reviews(value: unknown, sessionId: string, identity: string) {
    const retained: MutationEvidenceEntry[] = []
    for (const [index, review] of decodeReviews(value).entries()) {
      if (review.mutation === undefined) continue
      const files = await entries(review.mutation, sessionId, `${identity}:${index}`)
      retained.push(...files.map(entry => entry.kind === "display"
        ? { ...entry, file: { ...entry.file, name: review.name, action: review.action, reach: review.reach } }
        : { ...entry, name: review.name, action: review.action, reach: review.reach }))
    }
    return buildMutationEvidence(retained, stage(sessionId))
  }

  async function fileEvidence(value: unknown, source: HistoricalMutationFields, sessionId: string): Promise<MutationFileEvidence> {
    const identity = Schema.decodeUnknownSync(Schema.Struct({
      mutationId: Schema.String, path: Schema.String, displayPath: Schema.String,
      changeKind: Schema.Literals(["created", "modified", "deleted"]),
      before: Schema.NullOr(Schema.Struct({ bytes: Schema.Number, sha256: Schema.String })),
      after: Schema.NullOr(Schema.Struct({ bytes: Schema.Number, sha256: Schema.String })),
    }))(source)
    const retained = await entries(value, sessionId, identity.mutationId)
    const targets = retained.filter(entry => entry.kind === "display" ? entry.file.path === identity.path || entry.file.path === identity.displayPath : entry.kind === "omitted" && (entry.path === identity.path || entry.path === identity.displayPath))
    const [target, ...otherTargets] = targets
    if (!target || otherTargets.length !== 0) throw new Error("Historical file evidence is missing or ambiguous")
    const common = {
      version: 1 as const, mutationId: identity.mutationId, path: identity.path, displayPath: identity.displayPath,
      change: identity.changeKind === "created" ? "added" as const : identity.changeKind === "deleted" ? "removed" as const : "modified" as const,
      before: identity.before, after: identity.after,
    }
    if (target.kind === "display") return { ...target.file, ...common }
    return { ...common, retainedLines: 0, renderedLines: 0, omittedLines: 0, addedLines: 0, removedLines: 0, conflictMarkers: false, patch: { kind: "omitted", reason: target.reason } }
  }

  async function changeIndex(sessionId: string, indexes: Map<string, Map<unknown, StoredFact>>): Promise<Map<unknown, StoredFact>> {
    const held = indexes.get(sessionId)
    if (held) return held
    const changed = await reader.readSlice({ sessionId, types: ["file.changed"] })
    const index = new Map<unknown, StoredFact>()
    for (const fact of changed.facts) if (!(fact instanceof Error) && !index.has(fact.payload.mutationId)) index.set(fact.payload.mutationId, fact)
    indexes.set(sessionId, index)
    return index
  }

  async function normalizeFact(event: StoredFact, indexes = new Map<string, Map<unknown, StoredFact>>()): Promise<StoredFact | CorruptEventRowError> {
    if (!historicalFamilies.has(event.type)) return event
    const p = event.payload
    const details = asRecord(p.details)
    const hasMutationFields = (value: HistoricalMutationFields | undefined) => value !== undefined
      && ["mutation", "conflicts", "conflictMarkers", "notApplied"].some(key => value[key] !== undefined)
    const oldResult = event.type === "tool.result.recorded" && event.version <= 2 && hasMutationFields(details)
    const oldOutput = event.type === "tool.execution_output.recorded" && event.version <= 2
      && ["mutation", "conflicts", "conflictMarkers", "notApplied"].some(key => p[key] !== undefined)
    const oldArtifact = event.type === "file.artifact.recorded" && event.version === 3
    const oldChat = event.type === "chat.entries.appended" && event.version < 7 && Array.isArray(p.entries)
      && p.entries.some(entry => asRecord(asRecord(entry)?.message)?.reviewMutations !== undefined)
    const oldSystem = event.type === "agent.system_message.recorded" && event.version === 1 && p.reviewMutations !== undefined
    const ownsEvidence = event.type === "tool.result.recorded"
      ? hasMutationFields(details) || details?.mutationEvidence !== undefined
      : event.type === "tool.execution_output.recorded"
        ? hasMutationFields(p) || p.mutationEvidence !== undefined
        : event.type === "file.artifact.recorded"
          ? p.artifactKind === "mutation_diff" || p.mutation !== undefined || p.evidence !== undefined
          : event.type === "chat.entries.appended"
            ? Array.isArray(p.entries) && p.entries.some(entry => {
              const message = asRecord(asRecord(entry)?.message)
              return message?.reviewMutations !== undefined || message?.mutationEvidence !== undefined
            })
            : p.reviewMutations !== undefined || p.mutationEvidence !== undefined
    if (!ownsEvidence) return event
    const envelope = { type: event.type, version: event.version, actor: event.actor, payload: p }
    try {
      if (event.type === "tool.result.recorded" || event.type === "tool.execution_output.recorded") parseStoredSessionRuntimeFact(envelope)
      else if (event.type === "file.artifact.recorded") parseFileMutationFact(envelope)
      else if (event.type === "chat.entries.appended") parseConversationTreeFact(envelope)
      else {
        if (event.version !== 1 && event.version !== 2) return factGap(event)
        Schema.decodeUnknownSync(event.version === 1 ? AgentSystemMessageV1DataSchema : AgentSystemMessageV2DataSchema, { onExcessProperty: "error" })(p)
      }
      if (oldResult && details) validateMutationFields(details)
      if (oldOutput) validateMutationFields(p)
    } catch { return factGap(event) }
    if (!oldResult && !oldOutput && !oldArtifact && !oldChat && !oldSystem) {
      return event
    }
    let next: StoredFact
    if (oldResult && details) {
      next = { ...event, version: event.version === 2 ? 4 : 3,
        payload: { ...p, details: await mutationFields(details, event.sessionId, event.id) } }
    } else if (oldOutput) {
      next = { ...event, version: event.version === 2 ? 4 : 3, payload: await mutationFields(p, event.sessionId, event.id) }
    } else if (oldArtifact) {
      const index = await changeIndex(event.sessionId, indexes)
      const source = index.get(p.mutationId)
      if (!source || source instanceof Error || source.payload.path !== p.path) return factGap(event)
      try { parseFileMutationFact({ type: source.type, version: source.version, actor: source.actor, payload: source.payload }) } catch { return factGap(event) }
      const { mutation, ...payload } = p
      // Metadata validation and missing target failures are historical gaps;
      // staging errors must remain write failures.
      const diff = decodeDiff(mutation)
      if (!hasOneRetainedTarget(diff, { path: source.payload.path, displayPath: source.payload.displayPath })) return factGap(event)
      const evidence = await fileEvidence(mutation, source.payload, event.sessionId)
      next = { ...event, version: 4, payload: { ...payload, evidence } }
    } else if (oldChat) {
      const updated = []
      const parsed = parseConversationTreeFact(envelope)
      if (parsed.type !== "chat.entries.appended") throw new Error("Expected conversation append")
      for (const entry of parsed.payload.entries) {
        if (entry.kind !== "message") { updated.push(entry); continue }
        const message = asRecord(entry.message)
        if (message?.reviewMutations === undefined) { updated.push(entry); continue }
        const { reviewMutations, ...rest } = message
        updated.push({ ...entry, message: { ...rest, mutationEvidence: await reviews(reviewMutations, event.sessionId, event.id) } })
      }
      next = { ...event, version: 7, payload: { ...p, entries: updated } }
    } else {
      const { reviewMutations, ...rest } = p
      next = { ...event, version: 2, payload: { ...rest, mutationEvidence: await reviews(reviewMutations, event.sessionId, event.id) } }
      Schema.decodeUnknownSync(AgentSystemMessageV2DataSchema)(next.payload)
    }
    return next
  }

  async function normalizeInFlight(sessionId: string, row: InFlightRecord): Promise<InFlightRecord> {
    if (row.kind !== "finalized-tool-result" && row.kind !== "file.mutation") return row
    const p = asRecord(row.payload)
    let legacy: unknown
    try {
      if (row.kind === "finalized-tool-result" && p?.version === 2) { decodeCheckpoint(p); return row }
      // Bare-key cells predate conversation metadata. Their family retires
      // them only from durable result evidence. Remove after 2027-04-17.
      if (row.kind === "finalized-tool-result" && p?.conversationId === undefined) {
        const checkpoint = decodeLegacyFinalizedToolResultCheckpoint(row.payload)
        if (checkpoint.toolUseId !== row.key) throw new Error("Historical finalized result key does not match its tool call")
        return row
      }
      if (row.kind === "file.mutation" && p?.version === 3 && p.items === undefined) { parseFileMutationOperationHeader(p); return row }
      if (row.kind === "finalized-tool-result") legacy = decodeUnversionedCheckpoint(row.payload)
      else {
        let cell
        try { cell = parseFileMutationOperationCell(row.payload) } catch {
          // The earlier per-file preparation cell has no inline patch to move.
          parseFileMutationFact({ type: "file.mutation.prepared", version: 1, actor: "flywheel", payload: row.payload })
          return row
        }
        for (const item of cell.items) if (item.mutationDiff && !hasOneRetainedTarget(item.mutationDiff, item.evidence)) throw new Error("Historical candidate evidence is missing or ambiguous")
        legacy = cell
      }
      if (row.kind === "finalized-tool-result") {
        const details = asRecord(decodeUnversionedCheckpoint(legacy).details)
        if (details) validateMutationFields(details)
        else if (decodeUnversionedCheckpoint(legacy).details !== undefined) throw new Error("Invalid finalized result details")
      }
    } catch {
      return { ...row, raw: "", payload: { kind: "degraded", reason: "Mutation evidence checkpoint is unreadable", rawSha256: hash(row.raw), rawBytes: Buffer.byteLength(row.raw) } }
    }
    let payload: FinalizedToolResultCheckpoint | FileMutationOperationHeader
    if (row.kind === "finalized-tool-result") {
      const checkpoint = decodeUnversionedCheckpoint(legacy)
      const details = asRecord(checkpoint.details)
      payload = decodeCheckpoint({ ...checkpoint, version: 2,
        ...(details ? { details: await mutationFields(details, sessionId, row.key) } : {}) })
    } else {
      const cell = parseFileMutationOperationCell(legacy)
      const items = []
      for (const item of cell.items) {
        const { mutationDiff, ...rest } = item
        items.push({ ...rest, ...(mutationDiff ? { candidateEvidence: await fileEvidence(mutationDiff, item.evidence, sessionId) } : {}) })
      }
      // Inline operation cells written before 2026-10-16 are converted beside the state writer. Remove this conversion after 2027-04-16.
      payload = await stageFileMutationOperation({ ...cell, version: 3, items }, stage(sessionId))
    }
    if (!writer.swapInFlight) throw new Error("Mutation evidence recovery requires exact-raw local cell swaps")
    if (!await writer.swapInFlight(sessionId, row.kind, row.key, row.raw, payload)) {
      const current = (await reader.readInFlight(sessionId, row.kind)).find(value => value.key === row.key)
      return current ? normalizeInFlight(sessionId, current) : { ...row, raw: "", payload: { kind: "degraded", reason: "Mutation evidence checkpoint was retired" } }
    }
    return { ...row, payload: { ...payload }, raw: JSON.stringify(payload) }
  }

  async function normalizeFacts(facts: readonly (StoredFact | CorruptEventRowError)[]) {
    const result: (StoredFact | CorruptEventRowError)[] = []
    const indexes = new Map<string, Map<unknown, StoredFact>>()
    for (const fact of facts) result.push(fact instanceof CorruptEventRowError ? boundedGap(fact) : await normalizeFact(fact, indexes))
    return result
  }

  const surface: AsyncEventStateReadSurface = {
    ...reader,
    async readLatestPayloadByAggregateAndType(aggregateId, type) {
      if (!historicalFamilies.has(type)) return reader.readLatestPayloadByAggregateAndType(aggregateId, type)
      const selected = await reader.readSlice({ aggregateId, types: [type], order: "desc", limit: 1 })
      const raw = selected.facts[0]
      if (!raw) return null
      const fact = raw instanceof CorruptEventRowError ? boundedGap(raw) : await normalizeFact(raw)
      if (fact instanceof CorruptEventRowError) throw fact
      return JSON.stringify(fact.payload)
    },
    async readLatestByAggregateAndTypes(aggregateId, types) {
      const facts = await normalizeFacts(await reader.readLatestByAggregateAndTypes(aggregateId, types))
      return facts.map(fact => { if (fact instanceof CorruptEventRowError) throw fact; return fact })
    },
    async readInFlight(sessionId, kinds, keyPrefix) {
      const result = []
      for (const row of await reader.readInFlight(sessionId, kinds, keyPrefix)) result.push(await normalizeInFlight(sessionId, row))
      return result
    },
    async readSlice(query, tolerant) {
      const result = await reader.readSlice(query, tolerant)
      const facts = await normalizeFacts(result.facts)
      if (!tolerant) {
        const error = facts.find((fact): fact is CorruptEventRowError => fact instanceof CorruptEventRowError)
        if (error) throw error
      }
      return { ...result, facts }
    },
    async readPage(query, upperPosition, afterPosition, tolerant, content, evidence) {
      const result = await reader.readPage(query, upperPosition, afterPosition, tolerant, content, evidence)
      const facts = await normalizeFacts(result.facts)
      if (!tolerant) {
        const error = facts.find((fact): fact is CorruptEventRowError => fact instanceof CorruptEventRowError)
        if (error) throw error
      }
      return { ...result, facts }
    },
  }
  return { reader: surface, normalizeFact, normalizeFacts, normalizeInFlight }
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function factGap(event: StoredFact): CorruptEventRowError {
  const raw = JSON.stringify(event.payload)
  const { aggregateId, seq, type, version, timestamp, actor, sessionId, id: eventId, position } = event
  return new CorruptEventRowError({ aggregateId, seq, type, version, timestamp, actor, sessionId, eventId, position,
    rawPayload: degradedPayload(event.type, event.payload, raw) }, "Mutation evidence is unavailable")
}

function boundedGap(error: CorruptEventRowError): CorruptEventRowError {
  let payload: unknown
  try { payload = JSON.parse(error.row.rawPayload) } catch { payload = undefined }
  return new CorruptEventRowError({ ...error.row, rawPayload: degradedPayload(error.row.type, payload, error.row.rawPayload) }, "Mutation evidence is unavailable")
}

function degradedPayload(type: string, value: unknown, raw: string): string {
  const payload = asRecord(value)
  // A corrupt per-file settlement still supersedes its older tool summary.
  const target = type === "file.artifact.recorded" && payload?.artifactKind === "mutation_diff" && typeof payload.mutationId === "string"
    ? { artifactKind: "mutation_diff", mutationId: payload.mutationId } : {}
  return JSON.stringify({ kind: "degraded", rawSha256: hash(raw), rawBytes: Buffer.byteLength(raw), ...target })
}
