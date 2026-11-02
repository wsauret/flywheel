import { createHash } from "node:crypto"
import { isAbsolute, parse, relative, sep } from "node:path"
import { InFlightSwapConflictError, readCapturedFacts, type AsyncEventStateReadSurface, type EventStoreAppend, type GuardedAppendResult, type GuardedEventStoreAppend, type InFlightWrite, type StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { ContainedFileTooLargeError } from "../../infra/descriptor-directory.js"
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { withMutationQueueKeys } from "../../infra/file-mutation-queue.js"
import { readFileSnapshotUnder, readFileUnder } from "../../infra/write-file-under.js"
import { parseFileMutationFact, type FileMutationFact } from "./file-mutation-facts.js"
import {
  FILE_MUTATION_IN_FLIGHT_KIND,
  fileMutationCompletionFacts,
  type CurrentFileMutationOutcome,
  type FileMutationPreparedFact,
} from "./file-mutation-fact-writers.js"
import {
  operationCellSwap,
  parseFileMutationOperationCell,
  parseFileMutationOperationHeader,
  readFileMutationOperation,
  snapshotToFileObjectProof,
  type FileMutationOperationCell,
  type FileMutationOperationItem,
  type FileObjectProof,
  type FilePreconditionProof,
} from "./file-mutation-operation.js"
import { isSessionOwnerGone } from "./pid-lock.js"

const MUTATION_FACT_TYPES = [
  "file.mutation.prepared",
  "file.mutation.settled",
  "file.changed",
  "file.artifact.recorded",
] as const
const RECONCILE_ATTEMPTS = 4
const log = Log.create({ service: "file-mutation-recovery" })
/** Legacy prepared facts predate the in-flight operation cell. The one pass that adopts them is recorded on
 *  the migration ledger like every other historical adoption, so later startups read only live cells. */
// Markers named file-mutation-legacy-pending could hide preparations behind unrelated cells.
// Convert them by rescanning once under v2. Remove this conversion after 2027-04-21.
const LEGACY_PENDING_MIGRATION_ID = "file-mutation-legacy-pending:v2"
const MIGRATED_FACT_TYPE = "workspace.facts.migrated"

interface PendingOperationCell {
  readonly key: string
  readonly raw: string
  readonly cell: FileMutationOperationCell
}

export interface PendingFileMutationProjection {
  readonly pending: readonly FileMutationPreparedFact[]
  readonly changedMutationIds: ReadonlySet<string>
  readonly artifactMutationIds: ReadonlySet<string>
  readonly operations: readonly PendingOperationCell[]
  readonly legacyCellKeys: ReadonlyMap<string, string>
  readonly unreadableCells: readonly { readonly key: string; readonly reason: string }[]
}

export interface FileMutationRecoveryWriter {
  appendBatch(events: readonly EventStoreAppend[]): Promise<readonly StoredFact[]>
  appendBatchGuarded?(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
}

export class FileMutationRecoveryError extends Error {
  override readonly name = "FileMutationRecoveryError"

  constructor(readonly mutationId: string, readonly path: string, detail: string) {
    super(`Cannot safely reconcile file mutation ${mutationId} at ${path}: ${detail}`)
  }
}

export interface WorkspaceFileMutationRecoveryResult {
  readonly sessionId: string
  readonly failures: readonly FileMutationRecoveryError[]
}

/** Reads current operation cells strictly and salvages only the exact legacy
 * per-file payload written by earlier binaries. Unreadable cells stay intact. */
export async function loadSessionPendingFileMutations(store: AsyncEventStateReadSurface, sessionId: string, includeHistorical = true): Promise<PendingFileMutationProjection> {
  const historical = includeHistorical
    ? await loadHistoricalFileMutations(store, sessionId)
    : emptyPendingFileMutationProjection()
  const operations: PendingOperationCell[] = []
  const legacy: FileMutationPreparedFact[] = []
  const legacyCellKeys = new Map<string, string>()
  const unreadableCells: { key: string; reason: string }[] = []

  for (const row of await store.readInFlight(sessionId, FILE_MUTATION_IN_FLIGHT_KIND)) {
    try {
      const cell = await loadOperation(store, sessionId, row.payload)
      operations.push({ key: row.key, raw: row.raw, cell })
      continue
    } catch {
      // Strict-first historical salvage: only the prior prepared payload shape.
    }
    try {
      const fact = parseFileMutationFact({ type: "file.mutation.prepared", version: 1, actor: "flywheel", payload: row.payload })
      if (fact.type !== "file.mutation.prepared") throw new Error("not a preparation")
      legacy.push(fact)
      legacyCellKeys.set(fact.payload.mutationId, row.key)
    } catch (error) {
      unreadableCells.push({ key: row.key, reason: errorMessage(error) })
      log.warn("unreadable in-flight file mutation skipped", { sessionId, key: row.key, error: errorMessage(error) })
    }
  }

  const current = operations.map(({ cell }) => preparedFromItem(currentOperationItem(cell)))
  const seen = new Set([...current, ...legacy].map((fact) => fact.payload.mutationId))
  return {
    ...historical,
    operations,
    legacyCellKeys,
    unreadableCells,
    pending: [...current, ...legacy, ...historical.pending.filter((fact) => !seen.has(fact.payload.mutationId))],
  }
}

function emptyPendingFileMutationProjection(): PendingFileMutationProjection {
  return { pending: [], changedMutationIds: new Set(), artifactMutationIds: new Set(), operations: [], legacyCellKeys: new Map(), unreadableCells: [] }
}

async function loadHistoricalFileMutations(store: AsyncEventStateReadSurface, sessionId: string): Promise<PendingFileMutationProjection> {
  const { pending, changedMutationIds, artifactMutationIds } = await heldProjection(store, `file-mutation-history:${sessionId}`, () => createEventProjection(store, {
    aggregateId: `session:${sessionId}`,
    factTypes: MUTATION_FACT_TYPES,
    initialState: () => ({
      pending: new Map<string, FileMutationPreparedFact>(),
      preparedMutationIds: new Set<string>(),
      changedMutationIds: new Set<string>(),
      artifactMutationIds: new Set<string>(),
    }),
    reduce(state, event) {
      const fact = parseProjectionFact(event, parseFileMutationFact)
      switch (fact.type) {
        case "file.mutation.prepared":
          if (state.preparedMutationIds.has(fact.payload.mutationId)) throw new Error(`Duplicate file mutation preparation: ${fact.payload.mutationId}`)
          state.preparedMutationIds.add(fact.payload.mutationId)
          state.pending.set(fact.payload.mutationId, fact)
          break
        case "file.mutation.settled":
          state.pending.delete(fact.payload.mutationId)
          break
        case "file.changed":
          if ("mutationId" in fact.payload) state.changedMutationIds.add(fact.payload.mutationId)
          break
        case "file.artifact.recorded":
          if ("mutationId" in fact.payload) state.artifactMutationIds.add(fact.payload.mutationId)
          break
      }
      return state
    },
  })).replay()

  return { pending: [...pending.values()], changedMutationIds, artifactMutationIds, operations: [], legacyCellKeys: new Map(), unreadableCells: [] }
}

/** Settles only the attempted item in each operation, without attributing an
 * unproven publication. Retirement drops the untouched suffix. */
export async function reconcilePendingFileMutations(options: {
  sessionId: string
  store: AsyncEventStateReadSurface
  writer: FileMutationRecoveryWriter
  initial?: PendingFileMutationProjection
}): Promise<readonly FileMutationRecoveryError[]> {
  const initial = options.initial ?? await loadSessionPendingFileMutations(options.store, options.sessionId)
  const failures: FileMutationRecoveryError[] = initial.unreadableCells.map(row =>
    new FileMutationRecoveryError(row.key.slice(0, 128), "unknown", "Flywheel could not inspect this pending file operation. Its recovery record was kept; no remaining files were published."))
  const currentMutationIds = new Set<string>()
  for (const operation of initial.operations) {
    const item = currentOperationItem(operation.cell)
    currentMutationIds.add(item.evidence.mutationId)
    try {
      await reconcileOperation(options, operation)
    } catch (error) {
      failures.push(recoveryError(item.evidence.mutationId, item.evidence.path, error))
    }
  }
  for (const prepared of initial.pending) {
    if (currentMutationIds.has(prepared.payload.mutationId)) continue
    try {
      await reconcileLegacy(options, prepared.payload.mutationId, initial.legacyCellKeys.get(prepared.payload.mutationId))
    } catch (error) {
      failures.push(recoveryError(prepared.payload.mutationId, prepared.payload.path, error))
    }
  }
  return failures
}

export async function reconcileWorkspacePendingFileMutations(options: {
  projectRoot: string
  store: AsyncEventStateReadSurface
  writer: FileMutationRecoveryWriter
}): Promise<readonly WorkspaceFileMutationRecoveryResult[]> {
  const indexed = (await readCapturedFacts(options.store, { aggregateId: "workspace", types: [MIGRATED_FACT_TYPE] }))
    .some((fact) => typeof fact.payload === "object" && fact.payload !== null && "migrationId" in fact.payload && fact.payload.migrationId === LEGACY_PENDING_MIGRATION_ID)
  const historical = indexed ? [] : await readCapturedFacts(options.store, { types: MUTATION_FACT_TYPES })
  const sessionsWithCells = await options.store.sessionsWithInFlight(FILE_MUTATION_IN_FLIGHT_KIND)
  const sessionIds = new Set([
    ...sessionsWithCells,
    ...historical.filter((event) => event.type === "file.mutation.prepared").map((event) => event.sessionId),
  ])
  const results: WorkspaceFileMutationRecoveryResult[] = []
  for (const sessionId of [...sessionIds].sort()) {
    const initial = await loadSessionPendingFileMutations(options.store, sessionId, !indexed)
    if (initial.pending.length === 0 && initial.unreadableCells.length === 0) continue
    if (!isSessionOwnerGone(sessionId, options.projectRoot)) continue
    if (await options.store.readLatestPayloadByAggregateAndType(`session:${sessionId}`, "session.deleted") !== null) continue
    results.push({ sessionId, failures: await reconcilePendingFileMutations({ sessionId, store: options.store, writer: options.writer, initial }) })
  }
  let historicalCovered = true
  if (!indexed) {
    for (const sessionId of sessionIds) {
      const remaining = await loadSessionPendingFileMutations(options.store, sessionId)
      const coveredMutationIds = new Set([
        ...remaining.legacyCellKeys.keys(),
        ...remaining.operations.map(({ cell }) => currentOperationItem(cell).evidence.mutationId),
      ])
      if (remaining.pending.some(fact => !coveredMutationIds.has(fact.payload.mutationId))) {
        historicalCovered = false
        break
      }
    }
  }
  if (!indexed && historicalCovered) {
    await options.writer.appendBatch([{
      aggregateId: "workspace",
      type: MIGRATED_FACT_TYPE,
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "workspace",
      payload: { migrationId: LEGACY_PENDING_MIGRATION_ID, factTypes: MUTATION_FACT_TYPES, repaired: historical.filter((event) => event.type === "file.mutation.prepared").length },
    }])
  }
  return results
}

async function reconcileOperation(
  options: { sessionId: string; store: AsyncEventStateReadSurface; writer: FileMutationRecoveryWriter },
  initial: PendingOperationCell,
): Promise<void> {
  const aggregateId = `session:${options.sessionId}`
  let pending = initial
  for (let attempt = 1; attempt <= RECONCILE_ATTEMPTS; attempt += 1) {
    const { key, raw, cell } = pending
    try {
      const reconciled = await withMutationQueueKeys(cell.items.slice(cell.cursor).map(item => item.evidence.path), async () => {
        const current = (await options.store.readInFlight(options.sessionId, FILE_MUTATION_IN_FLIGHT_KIND)).find(candidate => candidate.key === key)
        if (!current) return true
        // A publisher can advance the cell while recovery waits. New evidence needs its own queue set.
        if (current.raw !== raw) return false
        const item = currentOperationItem(cell)
        const outcome = classifyOperationItem(item)
        const facts = fileMutationCompletionFacts(preparedFromItem(item), outcome, null, { mutationDiff: item.mutationDiff, evidence: item.candidateEvidence })
        const expectedSeq = await options.store.aggregateSeq(aggregateId) + 1
        const result = await appendRecoveryGuarded(options.writer, facts.map((fact, index) => recoveryAppend(
          aggregateId,
          fact,
          expectedSeq + index,
          index === facts.length - 1 ? [operationCellSwap(key, current.raw, null)] : undefined,
        )))
        if (result.kind === "stored" && outcome === "indeterminate") {
          log.warn("file mutation recovery settled an indeterminate outcome; no change was attributed", {
            sessionId: options.sessionId, mutationId: item.evidence.mutationId,
          })
        }
        return result.kind === "stored"
      })
      if (reconciled) return
    } catch (error) {
      if (!(error instanceof InFlightSwapConflictError)) throw error
    }
    const row = (await options.store.readInFlight(options.sessionId, FILE_MUTATION_IN_FLIGHT_KIND)).find(candidate => candidate.key === key)
    if (!row) return
    pending = { key, raw: row.raw, cell: await loadOperation(options.store, options.sessionId, row.payload) }
  }
  throw new FileMutationRecoveryError(initial.key, "unknown", "operation cell stayed contended")
}

async function reconcileLegacy(
  options: { sessionId: string; store: AsyncEventStateReadSurface; writer: FileMutationRecoveryWriter },
  mutationId: string,
  legacyCellKey?: string,
): Promise<void> {
  const aggregateId = `session:${options.sessionId}`
  for (let attempt = 1; attempt <= RECONCILE_ATTEMPTS; attempt += 1) {
    const projection = await loadSessionPendingFileMutations(options.store, options.sessionId)
    const prepared = projection.pending.find((candidate) => candidate.payload.mutationId === mutationId)
    if (!prepared) return
    const completion = projection.changedMutationIds.has(mutationId)
      ? fileMutationCompletionFacts(prepared, "applied", null, { includeChange: false, includeArtifact: !projection.artifactMutationIds.has(mutationId) })
      : fileMutationCompletionFacts(prepared, legacyRecoveryOutcome(prepared), null)
    // Cell retirement alone cannot settle a historical preparation's pending projection.
    const facts = completion.some(fact => fact.type === "file.mutation.settled")
      || !(await loadHistoricalFileMutations(options.store, options.sessionId)).pending.some(fact => fact.payload.mutationId === mutationId)
      ? completion
      : [...completion, {
        type: "file.mutation.settled", version: 1, actor: "flywheel",
        payload: { mutationId, outcome: "applied" },
      } satisfies FileMutationFact]
    const expectedSeq = await options.store.aggregateSeq(aggregateId) + 1
    const result = await appendRecoveryGuarded(options.writer, facts.map((fact, index) => recoveryAppend(
        aggregateId,
        fact,
        expectedSeq + index,
        index === facts.length - 1 && legacyCellKey
          ? [{ op: "drop", kind: FILE_MUTATION_IN_FLIGHT_KIND, key: legacyCellKey }]
          : undefined,
    )))
    if (result.kind === "stored") return
  }
  throw new FileMutationRecoveryError(mutationId, "unknown", "session aggregate stayed contended")
}

function currentOperationItem(cell: FileMutationOperationCell): FileMutationOperationItem {
  const item = cell.items[cell.cursor]
  if (!item) throw new Error("File mutation operation cursor has no current item")
  return item
}

async function loadOperation(store: AsyncEventStateReadSurface, sessionId: string, payload: unknown): Promise<FileMutationOperationCell> {
  if (typeof payload === "object" && payload !== null && "items" in payload) return parseFileMutationOperationCell(payload)
  const header = parseFileMutationOperationHeader(payload)
  const read = store.readSessionContentNode?.bind(store)
  if (!read) throw new Error("File mutation plan reader is unavailable")
  return readFileMutationOperation(header, hash => read(sessionId, hash))
}

function classifyOperationItem(item: FileMutationOperationItem): "not_applied" | "indeterminate" {
  if (!item.precondition) return "indeterminate"
  const observed = observe(item.evidence.path, proofBytes(item.precondition))
  if (!matchesPrecondition(observed, item.precondition)) return "indeterminate"
  if (observed.kind === "absent" && item.mayCreateMissingParents) return "indeterminate"
  return "not_applied"
}

type ObservedFile = { readonly kind: "absent" | "too_large" } | FileObjectProof

function observe(targetPath: string, maxBytes: number): ObservedFile {
  if (!isAbsolute(targetPath)) throw new Error("target path is not absolute")
  const root = parse(targetPath).root
  const relativePath = relative(root, targetPath).split(sep).join("/")
  try {
    const snapshot = readFileSnapshotUnder(root, relativePath, { maxBytes, noFollowBase: true })
    return snapshot ? snapshotToFileObjectProof(snapshot) : { kind: "absent" }
  } catch (error) {
    if (error instanceof ContainedFileTooLargeError) return { kind: "too_large" }
    throw error
  }
}

function matchesPrecondition(observed: ObservedFile, expected: FilePreconditionProof): boolean {
  return expected.kind === "absent"
    ? observed.kind === "absent"
    : observed.kind === "file" && sameObjectProof(observed, expected)
}


function sameObjectProof(left: FileObjectProof, right: FileObjectProof): boolean {
  return left.identity === right.identity && left.bytes === right.bytes && left.sha256 === right.sha256
    && left.linkCount === right.linkCount && left.executable === right.executable && sameAccess(left.access, right.access)
}

function sameAccess(left: FileObjectProof["access"], right: FileObjectProof["access"]): boolean {
  return left.kind === "posix"
    ? right.kind === "posix" && left.mode === right.mode
    : right.kind === "win32" && left.daclBase64 === right.daclBase64
}


function proofBytes(proof: FilePreconditionProof): number {
  return proof.kind === "file" ? proof.bytes : 0
}


function preparedFromItem(item: FileMutationOperationItem): FileMutationPreparedFact {
  const fact = parseFileMutationFact({ type: "file.mutation.prepared", version: "origin" in item.evidence ? 2 : 1, actor: "flywheel", payload: item.evidence })
  if (fact.type !== "file.mutation.prepared") throw new Error("Operation item did not contain preparation evidence")
  return fact
}

function recoveryAppend(aggregateId: string, fact: FileMutationFact, expectedSeq: number, inFlight?: readonly InFlightWrite[]): GuardedEventStoreAppend {
  const parsed = parseFileMutationFact(fact)
  const sessionId = aggregateId.slice("session:".length)
  return {
    aggregateId,
    type: parsed.type,
    version: parsed.version,
    timestamp: Date.now(),
    actor: parsed.actor,
    sessionId,
    payload: parsed.payload,
    expectedSeq,
    ...(inFlight ? { inFlight } : {}),
  }
}

function appendRecoveryGuarded(
  writer: FileMutationRecoveryWriter,
  events: readonly GuardedEventStoreAppend[],
): Promise<GuardedAppendResult> {
  if (!("appendBatchGuarded" in writer) || typeof writer.appendBatchGuarded !== "function") {
    throw new Error("File mutation recovery requires guarded append authority")
  }
  return writer.appendBatchGuarded(events)
}

function legacyRecoveryOutcome(prepared: FileMutationPreparedFact): CurrentFileMutationOutcome {
  const current = readRegularFileDigest(prepared)
  if (current.kind === "too_large") return "indeterminate"
  const currentSha256 = current.kind === "absent" ? null : current.sha256
  if (currentSha256 === prepared.payload.after?.sha256 || (currentSha256 === null && prepared.payload.after === null)) return "applied"
  if (currentSha256 === prepared.payload.before?.sha256 || (currentSha256 === null && prepared.payload.before === null)) return "not_applied"
  return "indeterminate"
}

function readRegularFileDigest(prepared: FileMutationPreparedFact):
  | { readonly kind: "absent" }
  | { readonly kind: "digest"; readonly sha256: string }
  | { readonly kind: "too_large" } {
  const targetPath = prepared.payload.path
  if (!isAbsolute(targetPath)) throw new FileMutationRecoveryError(prepared.payload.mutationId, targetPath, "target path is not absolute")
  const root = parse(targetPath).root
  const relativePath = relative(root, targetPath).split(sep).join("/")
  const maxBytes = Math.max(prepared.payload.before?.bytes ?? 0, prepared.payload.after?.bytes ?? 0)
  try {
    const content = readFileUnder(root, relativePath, { maxBytes, noFollowBase: true })
    return content === undefined ? { kind: "absent" } : { kind: "digest", sha256: createHash("sha256").update(content).digest("hex") }
  } catch (error) {
    if (error instanceof ContainedFileTooLargeError) return { kind: "too_large" }
    throw new FileMutationRecoveryError(prepared.payload.mutationId, targetPath, errorMessage(error))
  }
}

function recoveryError(mutationId: string, path: string, error: unknown): FileMutationRecoveryError {
  return error instanceof FileMutationRecoveryError ? error : new FileMutationRecoveryError(mutationId, path, errorMessage(error))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
