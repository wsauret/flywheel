import { CorruptEventRowError, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../infra/event-store-types.js"
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { Schema } from "effect"
import { asRecord } from "../../infra/record.js"
import { MutationEvidenceSchema } from "../../infra/mutation-evidence-schema.js"
import { readMutationEvidenceFiles, type MutationEvidence } from "../../infra/mutation-evidence.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { createFileLane, latestFileEditToken, netChange, type Change, type FileEditToken, type FileRow } from "./session-file-changes.js"
import { createSubtreeFold, type SubtreeRow } from "./session-subtree.js"
import { completePatch, readChangeFact, resolveRetainedPatch, type RetainedPatchSource } from "./session-change-sources.js"

// Per-file settlements own evidence. Literal historical tool results remain readable.
const CATALOG_TYPES = ["file.changed", "file.reviewed", "file.artifact.recorded", "tool.result.recorded", "tool.execution_output.recorded"]

function createSessionChangeReview(reader: AsyncEventStateReadSurface, sessionId: string) {
  const fileLane = createFileLane()
  type DiffSource = { readonly sessionId: string; readonly position: number; readonly eventId: string; readonly type: string }
  // Keyed by session as well: two sessions' calls may share a provider tool-use id.
  const runtimeDiffs = new Map<string, DiffSource>()
  const toolDiffs = new Map<string, DiffSource>()
  const diffKey = (owner: string, id: string) => `${owner}\u0000${id}`
  type Review = { readonly kind: "known"; readonly editToken: FileEditToken; readonly reviewed: boolean } | { readonly kind: "unknown" }
  const reviews = new Map<string, Review>()
  let sessionReviewUnknown = false

  /** Index only the location; a diff that does not decode is simply unretained. */
  function recoverFileId(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null || !("fileId" in payload)) return
    const fileId = payload.fileId
    return typeof fileId === "string" && /^file:.+/.test(fileId) ? fileId : undefined
  }

  function degradeReview(payload: unknown): void {
    const fileId = recoverFileId(payload)
    if (fileId) reviews.set(fileId, { kind: "unknown" })
    else sessionReviewUnknown = true
  }

  function consume(event: StoredFact): void {
    const source = { sessionId: event.sessionId, position: event.position, eventId: event.id, type: event.type }
    if (event.type === "file.artifact.recorded" && event.payload.artifactKind === "mutation_diff" && typeof event.payload.mutationId === "string") {
      runtimeDiffs.set(diffKey(event.sessionId, event.payload.mutationId), source)
    }
    // Viewed records belong to the session whose review recorded them, so a
    // launched session's own review leaves this one as it was.
    if (event.type === "file.reviewed" && event.sessionId !== sessionId) return
    let fact: ReturnType<typeof readChangeFact>
    try { fact = readChangeFact(event) } catch {
      if (event.type === "file.reviewed") degradeReview(event.payload)
      return
    }
    if (fact.type === "file.reviewed") {
      reviews.set(fact.payload.fileId, { kind: "known", editToken: fact.payload.editToken, reviewed: fact.payload.reviewed })
    } else if (fact.type === "tool.result.recorded") {
      if (asRecord(fact.payload.details)?.mutationEvidence) toolDiffs.set(diffKey(event.sessionId, fact.payload.toolUseId), source)
    } else if (fact.type === "tool.execution_output.recorded" && (fact.version === 3 || fact.version === 4) && fact.payload.mutationEvidence) {
      toolDiffs.set(diffKey(event.sessionId, fact.payload.toolUseId), source)
    }
  }

  function consumeRow({ fact: row, toolContent }: SubtreeRow): void {
    // A corrupt diff source is unretained, not an unknown gap; only file rows make history unknown.
    if (row instanceof CorruptEventRowError) {
      if (row.row.type === "file.changed") fileLane.consume(row)
      else if (row.row.type === "file.artifact.recorded") {
        try {
          const payload = JSON.parse(row.row.rawPayload)
          if (payload.artifactKind === "mutation_diff" && typeof payload.mutationId === "string") {
            runtimeDiffs.set(diffKey(row.sessionId, payload.mutationId), { sessionId: row.sessionId, position: row.position, eventId: row.row.eventId, type: row.row.type })
          }
        } catch { /* The corrupt artifact names no recoverable target. */ }
      }
      else if (row.row.type === "file.reviewed" && row.sessionId === sessionId) {
        try { degradeReview(JSON.parse(row.row.rawPayload)) } catch { sessionReviewUnknown = true }
      }
    }
    else if (row.type === "file.changed") fileLane.consume(row)
    else consume(hydrateToolContentFact(row, toolContent))
  }

  const fold = createSubtreeFold(reader, sessionId, { types: CATALOG_TYPES, content: "eager", consume: consumeRow })
  const lane = createOrderedLane()
  async function replay(): Promise<typeof api> {
    await lane.run(() => fold.advance())
    return api
  }

  async function readDiff(source: DiffSource, change: Change): Promise<RetainedPatchSource> {
    const slice = await reader.readSlice({ sessionId: source.sessionId, positions: [source.position], types: [source.type] }, true)
    const [stored] = slice.facts
    if (!stored || stored instanceof Error || slice.facts.length !== 1 || stored.id !== source.eventId) return { kind: "unretained" }
    const hydrated = hydrateToolContentFact(stored, slice.toolContent)
    try {
      const fact = readChangeFact(hydrated)
      if (fact.type === "tool.result.recorded") {
        const evidence = asRecord(fact.payload.details)?.mutationEvidence
        return evidence === undefined ? { kind: "unretained" }
          : await readManifestPatch(Schema.decodeUnknownSync(MutationEvidenceSchema)(evidence), change)
      }
      if (fact.type === "tool.execution_output.recorded" && (fact.version === 3 || fact.version === 4)) return fact.payload.mutationEvidence === undefined
        ? { kind: "unretained" }
        : await readManifestPatch(fact.payload.mutationEvidence, change)
      if (fact.type === "file.artifact.recorded" && fact.version === 4 && fact.payload.artifactKind === "mutation_diff" && fact.payload.mutationId === change.mutationId)
        return { kind: "evidence", evidence: fact.payload.evidence }
      return { kind: "unretained" }
    } catch {
      return { kind: "unretained" }
    }
  }

  async function readManifestPatch(evidence: MutationEvidence, change: Change): Promise<RetainedPatchSource> {
    const readNode = reader.readSessionContentNode
    if (!readNode) return { kind: "unretained" }
    const path = fileLane.files.find(file => file.changes.includes(change))?.path
    let selected: RetainedPatchSource | undefined
    let offset = 0
    do {
      const page = await readMutationEvidenceFiles(evidence, offset, 128, hash => readNode(change.sessionId, hash))
      if (page.kind !== "available") return { kind: "unretained" }
      for (const entry of page.files) {
        if (entry.kind === "not_applied" || entry.kind === "removed_directory") continue
        const target = entry.kind === "omitted" ? entry : entry.file
        if (target.path !== path && target.path !== change.displayPath
          && target.displayPath !== path && target.displayPath !== change.displayPath) continue
        if (selected !== undefined) return { kind: "unretained" }
        selected = entry.kind === "omitted"
          ? { kind: entry.reason === "sensitive" ? "sensitive" : "unretained" }
          : { kind: "evidence", evidence: entry.file }
      }
      offset = page.nextOffset ?? evidence.manifest.entries
    } while (offset < evidence.manifest.entries)
    return selected ?? { kind: "unretained" }
  }

  async function patchSourceFor(change: Change): Promise<RetainedPatchSource> {
    const runtime = change.mutationId === undefined ? undefined : runtimeDiffs.get(diffKey(change.sessionId, change.mutationId))
    const tool = change.toolUseId === undefined ? undefined : toolDiffs.get(diffKey(change.sessionId, change.toolUseId))
    const source = runtime ?? tool
    return source ? await readDiff(source, change) : { kind: "unretained" }
  }

  const retainedPatch = async (change: Change) => resolveRetainedPatch(reader, change.sessionId, await patchSourceFor(change))

  const api = Object.freeze({
    sessionId,
    /** The sessions whose changes this review holds: the session first, then
     *  every session it launched that the last replay found. */
    members: fold.members,
    /** The title of a session of this review, as its catalog row names it. */
    title: (id: string): string => fold.lineage()?.titles.get(id) ?? id,
    /** Every file this session or a session it launched changed, in the order of its first change, with
     *  each change in recorded order. A file whose net change is none stays. */
    files: (): readonly FileRow[] => fileLane.files,
    netFiles: fileLane.netFiles,
    file: fileLane.file,
    revision: fileLane.revision,
    /** Unreadable file rows of the whole review, or of one of its sessions. */
    unknownFileMutationGaps: (of?: string) => of === undefined ? fileLane.gaps.size : [...fileLane.gaps.values()].filter(gap => gap.sessionId === of).length,
    netChange,
    latestEditToken: latestFileEditToken,
    reviewStatus(file: FileRow): "viewed" | "unviewed" | "unknown" {
      if (sessionReviewUnknown) return "unknown"
      const latest = latestFileEditToken(file)
      const review = reviews.get(file.id)
      if (review?.kind === "unknown") return "unknown"
      return latest !== undefined && review?.kind === "known"
        && latest.position === review.editToken.position
        && latest.eventId === review.editToken.eventId
        && review.reviewed
        ? "viewed"
        : "unviewed"
    },
    /** Reads one indexed source fact. The runtime's own diff wins over the tool's. */
    retainedPatch,
    /** Read only the selected source descriptor, without loading patch chunks.
     * Per-file settlements supersede derived tool-result and background summaries. */
    patchSourceFor,
    /** The change's patch only when it restores the file exactly. */
    async patchFor(change: Change): Promise<string | undefined> {
      return completePatch(await retainedPatch(change))
    },
  })
  return { replay }
}

/** Acquire the held review of a session and every session it launched: their
 * file lane, their diff-source index, and this session's own Viewed records,
 * and fold only new bounded rows. No API admits paths, reads files, or claims that a diff can
 * restore bytes; restoration reads the indexed source through its asynchronous boundary. Malformed
 * diff evidence leaves the change unretained, never a session-wide failure.
 * Store read failures still propagate. */
export function getSessionChangeReview(reader: AsyncEventStateReadSurface, sessionId: string) {
  return heldProjection(reader, `session-change-review:${sessionId}`, () => createSessionChangeReview(reader, sessionId)).replay()
}

/** Session-close retention for the newest review assertion per stable file identity. */
export async function pruneSupersededFileReviewFacts(writer: AsyncEventWriter, sessionId: string): Promise<number> {
  return await writer.pruneSupersededKeyedEvents?.(`session:${sessionId}`, "file.reviewed", "$.fileId") ?? 0
}
export type SessionChangeReview = Awaited<ReturnType<typeof getSessionChangeReview>>
