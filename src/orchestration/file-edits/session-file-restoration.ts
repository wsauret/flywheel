import { applyPatch, parsePatch, reversePatch } from "diff"
import type { ContainedFileMetadata } from "../../infra/descriptor-directory.js"
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { fileAccessProof, type FileAccessProof } from "../session/file-mutation-access.js"
import type { SessionChangeReview } from "../session/session-change-review.js"
import { completePatch, readChangeFact, resolveRetainedPatch } from "../session/session-change-sources.js"
import { matchesEndpoint, type FileRow } from "../session/session-file-changes.js"
import type { FileEditAuthority } from "./file-edit-operation.js"


export type Reconstruction =
  | { readonly kind: "ready"; readonly original: string | undefined; readonly originalAccess: FileAccessProof | null; readonly sourceMutationIds: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: "drifted" | "unretained" }

/** A failed proof against retained history versus against the file on disk now. */
class ProofFailure extends Error {
  constructor(readonly reason: "drifted" | "unretained") { super(`Reconstruction proof failed: ${reason}`) }
}
function requireProof(condition: unknown, reason: ProofFailure["reason"]): asserts condition {
  if (!condition) throw new ProofFailure(reason)
}

export function sameAccess(left: FileAccessProof | null, right: FileAccessProof | null): boolean {
  if (left === null || right === null) return left === right
  return left.kind === "posix" && right.kind === "posix" ? left.mode === right.mode
    : left.kind === "win32" && right.kind === "win32" && left.daclBase64 === right.daclBase64
}
/** Applies one retained patch backwards. The diff parser throws on a hunk whose
 * body disagrees with its header even though the schema admits the text, and
 * such evidence is as unretained as a patch that does not apply. */
function applyReversed(text: string, patch: string): string | false {
  try {
    const patches = parsePatch(patch)
    const [target] = patches
    if (!target || patches.length !== 1) return false
    return applyPatch(text, reversePatch(target), { fuzzFactor: 0, autoConvertLineEndings: false })
  } catch { return false }
}
/** Publication metadata for a historical access proof. Throws when the proof cannot be restored exactly. */
export function accessMetadata(access: FileAccessProof | null): ContainedFileMetadata | undefined {
  if (access === null) return undefined
  if (access.kind === "posix") {
    requireProof((access.mode & ~0o777) === 0, "unretained")
    return access
  }
  const dacl = Buffer.from(access.daclBase64, "base64")
  requireProof(dacl.toString("base64") === access.daclBase64, "unretained")
  return { kind: "win32", dacl }
}

/** Walk every recorded change of one file backwards from the admitted current bytes
 * to the bytes before the reviewed session or a session it launched first
 * touched it. Each change reads its evidence from the session that recorded it. The caller owns the authority.
 * Current bytes or access that differ from the last recorded `after` are `drifted`;
 * any gap in chronology, identity, endpoint presence, or exact patch application is
 * `unretained`. Proof failures return `unavailable`; store read failures propagate. */
export async function reconstructOriginal(reader: AsyncEventStateReadSurface, review: SessionChangeReview, file: FileRow, authority: FileEditAuthority): Promise<Reconstruction> {
  try {
    const mutationIds = new Set<string>()
    const steps = []
    for (const [index, change] of file.changes.entries()) {
      const previous = file.changes[index - 1]
      requireProof(previous === undefined || change.source.position > previous.source.position, "unretained")
      const row = await readSource(reader, change.sessionId, { ...change.source, type: "file.changed" })
      const fact = readChangeFact(row)
      requireProof(fact.type === "file.changed" && fact.version === 4, "unretained")
      const payload = fact.payload
      requireProof(payload.path === file.path && payload.mutationId === change.mutationId && !mutationIds.has(payload.mutationId), "unretained")
      mutationIds.add(payload.mutationId)
      requireProof(payload.changeKind === "created" ? payload.before === null && payload.after !== null : payload.changeKind === "deleted" ? payload.before !== null && payload.after === null : payload.before !== null && payload.after !== null, "unretained")
      const source = await review.patchSourceFor(change)
      if (source.kind === "evidence") {
        const evidence = source.evidence
        if (evidence.before !== undefined && evidence.after !== undefined) {
          requireProof(evidence.path === payload.path && evidence.mutationId === payload.mutationId
            && evidence.patch.kind === "retained" && evidence.omittedLines === 0, "unretained")
          requireProof(sameEndpoint(evidence.before, payload.before) && sameEndpoint(evidence.after, payload.after), "unretained")
        }
      }
      const patch = completePatch(await resolveRetainedPatch(reader, change.sessionId, source))
      requireProof(patch !== undefined, "unretained")
      steps.push({ payload, patch })
    }
    const last = steps.at(-1)
    requireProof(last, "unretained")
    requireProof(authority.canonicalPath === file.path, "drifted")
    requireProof(!authority.snapshot || authority.text !== undefined, "drifted")
    let text = authority.text
    let bytes = authority.snapshot?.content
    let access = authority.snapshot ? fileAccessProof(authority.snapshot.metadata) : null
    requireProof(matchesEndpoint(bytes, last.payload.after) && sameAccess(access, last.payload.afterAccess), "drifted")
    for (const { payload, patch } of steps.toReversed()) {
      requireProof(matchesEndpoint(bytes, payload.after) && sameAccess(access, payload.afterAccess), "unretained")
      const restored = applyReversed(text ?? "", patch)
      requireProof(restored !== false, "unretained")
      const encoded = authority.encode(restored)
      requireProof(payload.before === null ? encoded.byteLength === 0 : matchesEndpoint(encoded, payload.before), "unretained")
      text = payload.before === null ? undefined : restored
      bytes = payload.before === null ? undefined : encoded
      access = payload.beforeAccess
      accessMetadata(access)
    }
    return { kind: "ready", original: text, originalAccess: access, sourceMutationIds: steps.map(step => step.payload.mutationId) }
  } catch (error) {
    if (error instanceof ProofFailure) return { kind: "unavailable", reason: error.reason }
    throw error
  }
}

function sameEndpoint(left: { readonly bytes: number; readonly sha256: string } | null, right: { readonly bytes: number; readonly sha256: string } | null): boolean {
  return left === null || right === null ? left === right : left.bytes === right.bytes && left.sha256 === right.sha256
}

async function readSource(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  source: { readonly position: number; readonly eventId: string; readonly type?: string },
): Promise<StoredFact> {
  const slice = await reader.readSlice({
    sessionId,
    positions: [source.position],
    ...(source.type ? { types: [source.type] } : {}),
  })
  const [row] = slice.facts
  requireProof(row !== undefined && !(row instanceof Error) && slice.facts.length === 1 && row.id === source.eventId, "unretained")
  return hydrateToolContentFact(row, slice.toolContent)
}
