import { randomUUID } from "node:crypto"
import { contentEvidence, previewText, type ContentEvidence } from "../../infra/content-evidence.js"
import type { InFlightWrite, StoredFact } from "../../infra/event-store-types.js"
import type { MutationDiff } from "../../infra/mutation-diff.js"
import { buildMutationFileEvidence, type MutationFileEvidence } from "../../infra/mutation-evidence.js"
import type { StageSessionContentNodes } from "../../infra/session-content.js"
import { redactSecretsPrefix } from "../../infra/redact-secrets.js"
import { parseFileMutationFact, type FileMutationFact, type FileMutationOrigin } from "./file-mutation-facts.js"
import {
  createFileMutationOperationItem,
  operationCellSwap,
  stageFileMutationOperation,
  type FileMutationOperationHeader,
  type FileMutationOperationCell,
  type FileMutationOperationEvidence,
  type FilePreconditionProof,
} from "./file-mutation-operation.js"
import type { FileChangeObservationInput, FileLineStats } from "./file-mutation-types.js"

export interface FileMutationFactWriter {
  stageSessionContentNodes?: StageSessionContentNodes
  record(fact: FileMutationFact, contentRows?: undefined, inFlight?: readonly InFlightWrite[]): Promise<StoredFact | null>
  transaction(fn: () => void): Promise<void>
  swapInFlight?(kind: string, key: string, expectedRaw: string | null, payload: unknown | null): Promise<boolean>
}

/** The in-flight kind a prepared mutation is held under. */
export const FILE_MUTATION_IN_FLIGHT_KIND = "file.mutation"

type FileMutationContent = string | Uint8Array
export type FileMutationPreparedFact = Extract<FileMutationFact, { type: "file.mutation.prepared" }>
type CurrentPreparedFact = Extract<FileMutationPreparedFact, { version: 2 }>
type FileMutationAccessEvidence = Pick<Extract<FileMutationFact, { type: "file.changed"; version: 4 }>["payload"], "beforeAccess" | "afterAccess">
type FileMutationOutcome = Extract<FileMutationFact, { type: "file.mutation.settled" }>["payload"]["outcome"]
export type CurrentFileMutationOutcome = Exclude<FileMutationOutcome, "attributed_after_later_mutation">

interface FileMutationOperationState {
  header: FileMutationOperationHeader | null
  readonly items: readonly ReturnType<typeof createFileMutationOperationItem>[]
}

export interface PreparedFileMutation {
  readonly mutationId: string
  readonly operationId: string
  readonly fact: CurrentPreparedFact
  readonly state: FileMutationOperationState
  readonly evidence?: MutationFileEvidence
}

export interface FileMutationContext {
  sessionEventWriter?: FileMutationFactWriter
  origin: FileMutationOrigin
}


type FileChange = Omit<FileChangeObservationInput, "mutationId" | "toolUseId" | "modelRequestId" | "parentToolUseId">

export interface FileMutationPlan {
  readonly conflictMarkers?: boolean
  readonly change: FileChange
  readonly evidence: FileMutationOperationEvidence
  readonly origin?: FileMutationOrigin
}

/** Durably records the complete ordered recovery plan before any item publishes bytes. */
export async function prepareFileMutationOperation(
  context: FileMutationContext,
  plans: readonly FileMutationPlan[],
): Promise<readonly PreparedFileMutation[]> {
  if (plans.length === 0) throw new Error("File mutation operation has no items")
  const operationId = context.origin.kind === "tool_call" ? context.origin.toolUseId : randomUUID()
  const facts = plans.map(({ change, evidence, origin }) => preparedFact(randomUUID(), operationId, {
    ...change, beforeContent: evidence.beforeSnapshot?.content ?? null,
  }, origin ?? context.origin))
  const writer = context.sessionEventWriter
  const stage = writer?.stageSessionContentNodes?.bind(writer)
  if (writer && !stage) throw new Error("File mutation evidence staging is unavailable")
  const evidence: (MutationFileEvidence | undefined)[] = []
  for (const [index, fact] of facts.entries()) {
    // SAFETY: facts maps plans without filtering.
    const plan = plans[index]!
    evidence.push(stage ? await prepareEvidence(fact, plan, stage) : undefined)
  }
  const cell = {
    version: 3,
    operationId,
    cursor: 0,
    items: facts.map((fact, index) => {
      // SAFETY: facts maps plans without filtering, so both arrays have the same dense indexes.
      const plan = plans[index]!
      return { ...createFileMutationOperationItem(fact, plan.evidence), ...(evidence[index] ? { candidateEvidence: evidence[index] } : {}) }
    }),
  } satisfies FileMutationOperationCell
  const header = stage ? await stageFileMutationOperation(cell, stage) : null
  const state: FileMutationOperationState = { items: cell.items, header }
  if (context.sessionEventWriter) {
    if (!context.sessionEventWriter.swapInFlight) throw new Error("File mutation operation was not stored")
    if (!await context.sessionEventWriter.swapInFlight(FILE_MUTATION_IN_FLIGHT_KIND, operationId, null, header)) {
      throw new Error("File mutation operation changed before preparation")
    }
  }
  return facts.map((fact, index) => ({ mutationId: fact.payload.mutationId, operationId, fact, state, ...(evidence[index] ? { evidence: evidence[index] } : {}) }))
}

async function prepareEvidence(fact: CurrentPreparedFact, plan: FileMutationPlan, stage: StageSessionContentNodes): Promise<MutationFileEvidence> {
  const payload = fact.payload
  const unavailable: MutationFileEvidence = {
    version: 1, mutationId: payload.mutationId, path: payload.path, displayPath: payload.displayPath,
    change: payload.changeKind === "created" ? "added" : payload.changeKind === "deleted" ? "removed" : "modified",
    before: payload.before && { bytes: payload.before.bytes, sha256: payload.before.sha256 },
    after: payload.after && { bytes: payload.after.bytes, sha256: payload.after.sha256 },
    retainedLines: 0, renderedLines: 0, omittedLines: 0, addedLines: 0, removedLines: 0,
    patch: { kind: "unavailable" }, conflictMarkers: false,
  }
  let before: string | null
  let after: string | null
  try {
    before = plan.evidence.beforeSnapshot === null ? null : mutationText(plan.evidence.beforeSnapshot.content)
    after = plan.change.afterContent === null ? null : mutationText(plan.change.afterContent)
  } catch {
    // Binary Bash publications have exact identities but cannot supply a UTF-8 inverse.
    return unavailable
  }
  return await buildMutationFileEvidence({
    mutationId: payload.mutationId, path: payload.path, displayPath: payload.displayPath,
    conflictMarkers: plan.conflictMarkers ?? false,
    before: before === null ? { kind: "absent" } : { kind: "text", text: before },
    after: after === null ? { kind: "absent" } : { kind: "text", text: after },
  }, stage) ?? unavailable
}

/** Atomically records captured endpoint access and retires the cell after verified publication.
 * `after` is the actual readback proof, or verified absence after deletion, never planned metadata. */
export async function settleFileMutation(
  context: Pick<FileMutationContext, "sessionEventWriter">,
  prepared: PreparedFileMutation,
  after: FilePreconditionProof,
): Promise<void> {
  if (!context.sessionEventWriter) return
  const writer = context.sessionEventWriter
  const evidence = prepared.evidence
  if (!evidence) throw new Error("File mutation has no staged evidence")
  const expected = evidence.after
  if (expected === null ? after.kind !== "absent" : after.kind !== "file" || after.bytes !== expected.bytes || after.sha256 !== expected.sha256) {
    throw new Error("File mutation readback does not match staged evidence")
  }
  const operation = prepared.state.header
  if (!operation) throw new Error(`File mutation operation is not active (${prepared.fact.payload.displayPath})`)
  const current = prepared.state.items[operation.cursor]
  if (current?.evidence.mutationId !== prepared.mutationId) {
    throw new Error(`File mutation settlement is out of order (${prepared.fact.payload.displayPath})`)
  }
  const nextCursor = operation.cursor + 1
  const next = nextCursor === operation.plan.entries ? null : { ...operation, cursor: nextCursor }
  const transition: readonly InFlightWrite[] = [operationCellSwap(prepared.operationId, JSON.stringify(operation), next)]
  const facts = fileMutationCompletionFacts(prepared.fact, "applied", {
    beforeAccess: current.precondition.kind === "absent" ? null : current.precondition.access,
    afterAccess: after.kind === "absent" ? null : after.access,
  }, { evidence })
  let transactionRan = false
  await writer.transaction(() => {
    transactionRan = true
    for (const [index, fact] of facts.entries()) {
      void writer.record(parseFileMutationFact(fact), undefined, index === facts.length - 1 ? transition : undefined)
    }
  })
  if (!transactionRan) throw new Error(`File mutation settlement was not stored (${prepared.fact.payload.displayPath})`)
  prepared.state.header = next
}

/** Atomically records a proven refusal. `operation` retires the current item plus untouched suffix;
 * `item` retires the current item alone and moves the cell to the next item, which still publishes. */
export async function retireFileMutationNotApplied(
  context: Pick<FileMutationContext, "sessionEventWriter">,
  prepared: PreparedFileMutation,
  scope: "operation" | "item" = "operation",
): Promise<void> {
  if (!context.sessionEventWriter) return
  const writer = context.sessionEventWriter
  const operation = prepared.state.header
  if (!operation) throw new Error(`File mutation operation is not active (${prepared.fact.payload.displayPath})`)
  const current = prepared.state.items[operation.cursor]
  if (current?.evidence.mutationId !== prepared.mutationId) {
    throw new Error(`File mutation settlement is out of order (${prepared.fact.payload.displayPath})`)
  }
  const nextCursor = operation.cursor + 1
  const next = scope === "operation" || nextCursor === operation.plan.entries ? null : { ...operation, cursor: nextCursor }
  const transition: readonly InFlightWrite[] = [operationCellSwap(prepared.operationId, JSON.stringify(operation), next)]
  const facts = fileMutationCompletionFacts(prepared.fact, "not_applied", null)
  let transactionRan = false
  await writer.transaction(() => {
    transactionRan = true
    for (const [index, fact] of facts.entries()) {
      void writer.record(parseFileMutationFact(fact), undefined, index === facts.length - 1 ? transition : undefined)
    }
  })
  if (!transactionRan) throw new Error(`File mutation refusal was not stored (${prepared.fact.payload.displayPath})`)
  prepared.state.header = next
}

export function fileMutationCompletionFacts(
  prepared: FileMutationPreparedFact,
  outcome: CurrentFileMutationOutcome,
  access: FileMutationAccessEvidence | null,
  options: { includeChange?: boolean; includeArtifact?: boolean; mutationDiff?: MutationDiff; evidence?: MutationFileEvidence } = {},
): readonly FileMutationFact[] {
  const includeChange = options.includeChange ?? outcome === "applied"
  const includeArtifact = options.includeArtifact ?? includeChange
  const facts: FileMutationFact[] = []
  if (includeChange) facts.push(changedFact(prepared, access))
  if (includeArtifact) {
    if (options.evidence) {
      facts.push({
        type: "file.artifact.recorded", version: 4, actor: "flywheel",
        payload: {
          mutationId: prepared.payload.mutationId, artifactId: `mutation:${prepared.payload.mutationId}`,
          ownerKind: prepared.version === 2 && prepared.payload.origin.kind === "user_undo" ? "runtime" : "tool_call",
          ownerId: prepared.version === 2 ? prepared.payload.operationId : prepared.payload.toolUseId,
          artifactKind: "mutation_diff", path: prepared.payload.path, evidence: options.evidence,
        },
      })
    } else if (prepared.version === 2 && prepared.payload.origin.kind === "user_undo") {
      if (!options.mutationDiff) throw new Error(`Operator mutation has no diff evidence (${prepared.payload.mutationId})`)
      facts.push({
        type: "file.artifact.recorded",
        version: 3,
        actor: "flywheel",
        payload: {
          mutationId: prepared.payload.mutationId,
          artifactId: `mutation:${prepared.payload.mutationId}`,
          ownerKind: "runtime",
          ownerId: prepared.payload.operationId,
          artifactKind: "mutation_diff",
          path: prepared.payload.path,
          mutation: options.mutationDiff,
        },
      })
    } else if (prepared.payload.after) facts.push(artifactFact(prepared))
  }
  // No settlement fact: its only effect was to remove the preparation from the
  // pending set, which retiring the in-flight cell now does. The type stays
  // readable so a store written before this still replays.
  if (facts.length === 0) facts.push(settlementFact(prepared.payload.mutationId, outcome))
  return facts
}

function settlementFact(mutationId: string, outcome: CurrentFileMutationOutcome): FileMutationFact {
  return {
    type: "file.mutation.settled",
    version: 1,
    actor: "flywheel",
    payload: { mutationId, outcome },
  }
}

function preparedFact(
  mutationId: string,
  operationId: string,
  change: FileChange,
  origin: FileMutationOrigin,
): CurrentPreparedFact {
  const before = change.beforeContent === null ? null : contentPolicy(change.beforeContent)
  const after = change.afterContent === null ? null : contentPolicy(change.afterContent)
  const diff = change.diffContent === undefined ? undefined : contentPolicy(change.diffContent)
  const lineStats = change.lineStats ?? computeLineStats(change.beforeContent, change.afterContent, change.diffContent)
  const fact: CurrentPreparedFact = {
    type: "file.mutation.prepared",
    version: 2,
    actor: "flywheel",
    payload: {
      mutationId,
      path: change.path,
      displayPath: change.displayPath,
      changeKind: change.changeKind,
      before,
      after,
      ...(diff ? { diff } : {}),
      ...(lineStats ? { lineStats } : {}),
      operationId,
      origin,
    },
  }
  parseFileMutationFact(fact)
  return fact
}

function changedFact(prepared: FileMutationPreparedFact, access: FileMutationAccessEvidence | null): FileMutationFact {
  if (prepared.version === 2 && access) return {
    type: "file.changed",
    version: 4,
    actor: "flywheel",
    payload: { ...prepared.payload, ...access },
  }
  return prepared.version === 2 ? {
    type: "file.changed",
    version: 3,
    actor: "flywheel",
    payload: prepared.payload,
  } : {
    type: "file.changed",
    version: 2,
    actor: "flywheel",
    payload: prepared.payload,
  }
}

function artifactFact(prepared: FileMutationPreparedFact): FileMutationFact {
  const after = prepared.payload.after
  if (!after) throw new Error(`Cannot record an artifact without after evidence (${prepared.payload.mutationId})`)
  const origin = prepared.version === 1 ? prepared.payload : prepared.payload.origin
  if (!("toolUseId" in origin)) throw new Error("File snapshot artifact requires a tool origin")
  return {
    type: "file.artifact.recorded",
    version: 2,
    actor: "flywheel",
    payload: {
      mutationId: prepared.payload.mutationId,
      artifactId: `file:${prepared.payload.mutationId}`,
      ownerKind: "tool_call",
      ownerId: origin.toolUseId,
      artifactKind: "file_snapshot",
      path: prepared.payload.path,
      bytes: after.bytes,
      sha256: after.sha256,
      preview: after.preview,
      metadata: {
        changeKind: prepared.payload.changeKind,
        displayPath: prepared.payload.displayPath,
      },
    },
  }
}

function mutationText(content: FileMutationContent): string {
  return typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)
}

export function computeLineStats(
  beforeContent: FileMutationContent | null,
  afterContent: FileMutationContent | null,
  diffContent?: string,
): FileLineStats | undefined {
  const diffStats = diffContent === undefined ? undefined : lineStatsFromUnifiedDiff(diffContent)
  if (diffStats) return diffStats
  if (beforeContent === null && afterContent !== null) {
    return { added: countContentLines(afterContent), modified: 0, removed: 0 }
  }
  return undefined
}

function lineStatsFromUnifiedDiff(diffContent: string): FileLineStats | undefined {
  const totals = { added: 0, modified: 0, removed: 0 }
  let hunkAdded = 0
  let hunkRemoved = 0
  let inHunk = false
  let hasLineStats = false
  const flushHunk = (): void => {
    if (hunkAdded === 0 && hunkRemoved === 0) return
    const modified = Math.min(hunkRemoved, hunkAdded)
    totals.added += hunkAdded - modified
    totals.modified += modified
    totals.removed += hunkRemoved - modified
    hasLineStats = true
  }
  for (const line of diffContent.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      if (inHunk) flushHunk()
      inHunk = true
      hunkAdded = 0
      hunkRemoved = 0
      continue
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue
    if (line.startsWith("-") && !line.startsWith("---")) {
      hunkRemoved += 1
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) hunkAdded += 1
  }
  if (inHunk) flushHunk()
  return hasLineStats ? totals : undefined
}

function countContentLines(content: FileMutationContent): number {
  if (typeof content === "string") return countStringLines(content)
  if (content.length === 0) return 0
  // An indexed loop counts 8 MB in about 4 ms. A for-of loop goes through the
  // iterator protocol and takes about 70 ms on the executor main thread. A
  // repeated indexOf(10) is faster for sparse newlines but takes as long as
  // the for-of loop when most bytes are newlines.
  let lines = 0
  for (let index = 0; index < content.length; index += 1) if (content[index] === 10) lines += 1
  return content[content.length - 1] === 10 ? lines : lines + 1
}

function countStringLines(content: string): number {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (normalized.length === 0) return 0
  const lines = normalized.split("\n")
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
}


function contentPolicy(content: FileMutationContent): ContentEvidence {
  const evidence = contentEvidence(content)
  let text: string
  try {
    text = mutationText(content)
  } catch {
    return { ...evidence, preview: "" }
  }
  return { ...evidence, preview: redactedPreview(text) }
}

/** The characters of a file the first preview attempt redacts. Most files settle their preview within it. */
const PREVIEW_PREFIX_LENGTH = 4096

/** The preview of the redacted text with each whitespace run collapsed to one
 *  space, read from the shortest doubling prefix that settles it, so a file
 *  of megabytes is not redacted and scanned whole for 240 characters. A
 *  redacted prefix is the start of the whole redaction, so it collapses to the
 *  start of the collapsed whole. A prefix that previewText cuts is longer than
 *  the preview, so the preview is the same as the preview of the whole text. */
function redactedPreview(text: string): string {
  for (let length = PREVIEW_PREFIX_LENGTH; ; length *= 2) {
    const prefix = redactSecretsPrefix(text, length)
    const collapsed = prefix.text.replace(/\s+/g, " ").trim()
    const preview = previewText(collapsed)
    if (prefix.whole || preview !== collapsed) return preview
  }
}

