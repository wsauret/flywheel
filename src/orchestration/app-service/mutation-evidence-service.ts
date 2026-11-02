import { Schema } from "effect"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { unifiedDiffPreview } from "../../infra/mutation-diff.js"
import type { MutationEvidenceEntry } from "../../infra/mutation-evidence.js"
import { MutationEvidenceEntrySchema } from "../../infra/mutation-evidence-schema.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../infra/output-blocks.js"
import { mutationEvidenceDisplayPaths } from "../../infra/output/display-paths.js"
import { readSessionContentRecords } from "../../infra/session-content.js"
import { MUTATION_FILE_PREVIEW_BYTES, MutationFilesQuerySchema, MutationPatchWindowQuerySchema, type MutationFilesEntry, type MutationFilesQuery, type MutationFilesResult, type MutationPatchWindowQuery, type MutationPatchWindowResult } from "../../protocol/mutation-evidence-protocol-types.js"
import { fitMutationEvidenceWindow } from "../../protocol/mutation-evidence-window.js"
import type { SessionManager } from "../session/manager.js"
import { readRecordedExecutionCwd } from "../session/session-execution-directory.js"

const decodeEntry = Schema.decodeUnknownSync(MutationEvidenceEntrySchema, { onExcessProperty: "error" })
const encodedBytes = (result: unknown): number => Buffer.byteLength(JSON.stringify(result))

/** Read immutable evidence in the requested session only. Construction performs
 * no reads. Missing or corrupt evidence is explicit; storage-service failures
 * and budgets too small for one item reject rather than return empty progress. */
export function createMutationEvidenceService(deps: {
  readonly reader: AsyncEventStateReadSurface
  readonly manager: Pick<SessionManager, "read">
  readonly projectRoot: string
}) {
  async function requireSession(sessionId: string) {
    const session = await deps.manager.read(sessionId)
    if (!session) throw new Error("Session is unavailable")
    return session
  }
  /** A retained patch whose leading bytes are missing or corrupt is served as unavailable. */
  async function withPreview(sessionId: string, entry: MutationEvidenceEntry): Promise<MutationFilesEntry> {
    if ((entry.kind !== "applied" && entry.kind !== "display") || entry.file.patch.kind !== "retained") return entry
    const readRange = deps.reader.readSessionContentRange
    if (!readRange) throw new Error("Session content range reads are unavailable")
    const { reference } = entry.file.patch
    const range = await readRange.call(deps.reader, sessionId, reference, 0, Math.min(reference.bytes, MUTATION_FILE_PREVIEW_BYTES))
    if (range.kind === "unavailable") return entry.kind === "applied"
      ? { kind: "applied", file: { ...entry.file, patch: { kind: "unavailable" } } }
      : { kind: "display", file: { ...entry.file, patch: { kind: "unavailable" } } }
    const complete = range.nextOffset === null
    const prefix = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.from(range.base64, "base64"), { stream: !complete })
    return { ...entry, preview: unifiedDiffPreview(prefix, complete, { lines: TOOL_PREVIEW_LINE_LIMIT, encodedBytes: MUTATION_FILE_PREVIEW_BYTES }) }
  }
  return {
    async files(input: MutationFilesQuery): Promise<MutationFilesResult> {
      const query = Schema.decodeUnknownSync(MutationFilesQuerySchema)(input)
      const session = await requireSession(query.sessionId)
      const readNode = deps.reader.readSessionContentNode
      if (!readNode) throw new Error("Session content node reads are unavailable")
      const page = await readSessionContentRecords(query.manifest, query.offset, query.maxFiles, hash => readNode.call(deps.reader, query.sessionId, hash))
      const identity = { sessionId: query.sessionId, manifest: query.manifest, requestedOffset: query.offset }
      if (page.kind === "unavailable") return fitMutationEvidenceWindow({ ...identity, ...page }, query.maxBytes, encodedBytes)
      let entries
      try {
        entries = page.records.map(record => decodeEntry(JSON.parse(record)))
      } catch {
        return fitMutationEvidenceWindow({ ...identity, kind: "unavailable", reason: "corrupt" }, query.maxBytes, encodedBytes)
      }
      const executionCwd = await readRecordedExecutionCwd(session, deps.projectRoot, deps.reader)
      const files: MutationFilesEntry[] = []
      let bytes = 0
      for (const entry of entries) {
        const file = mutationEvidenceDisplayPaths(entry, executionCwd)
        const served = query.previews === true ? await withPreview(query.sessionId, file) : file
        files.push(served)
        bytes += encodedBytes(served)
        // Files past the window are dropped by the fit, so their previews are not read.
        if (bytes > query.maxBytes) break
      }
      return fitMutationEvidenceWindow({
        ...identity, kind: "available", offset: query.offset,
        totalFiles: query.manifest.entries, totalBytes: query.manifest.bytes,
        files, nextOffset: files.length === entries.length ? page.nextOffset : query.offset + files.length,
      }, query.maxBytes, encodedBytes)
    },
    async patchWindow(input: MutationPatchWindowQuery): Promise<MutationPatchWindowResult> {
      const query = Schema.decodeUnknownSync(MutationPatchWindowQuerySchema)(input)
      await requireSession(query.sessionId)
      const readRange = deps.reader.readSessionContentRange
      if (!readRange) throw new Error("Session content range reads are unavailable")
      const page = await readRange.call(deps.reader, query.sessionId, query.reference, query.offset, query.maxBytes)
      const identity = { sessionId: query.sessionId, reference: query.reference, requestedOffset: query.offset }
      return fitMutationEvidenceWindow(page.kind === "unavailable"
        ? { ...identity, ...page }
        : { ...identity, ...page, totalBytes: query.reference.bytes, servedBytes: Buffer.from(page.base64, "base64").length },
      query.maxBytes, encodedBytes)
    },
  }
}
export type MutationEvidenceService = ReturnType<typeof createMutationEvidenceService>
