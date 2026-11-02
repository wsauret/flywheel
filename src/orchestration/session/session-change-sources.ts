import { createFactParser } from "../../infra/event-registry.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import type { MutationFileEvidence, MutationDisplayFileEvidence } from "../../infra/mutation-evidence.js"
import type { SessionContentReference } from "../../infra/session-content.js"
import { SESSION_CONTENT_WINDOW_BYTES } from "../../infra/session-content-schema.js"
import { FileMutationFactSchemas, type FileMutationFact } from "./file-mutation-facts.js"
import { StoredSessionRuntimeFactSchemas, type SessionRuntimeFact, type ToolContentReferenceFact } from "./session-runtime-event-types.js"

type ReviewFact = FileMutationFact | Extract<SessionRuntimeFact | ToolContentReferenceFact, { type: "tool.result.recorded" | "tool.execution_output.recorded" }>
const parseFact = createFactParser([...FileMutationFactSchemas, ...StoredSessionRuntimeFactSchemas])

/** Historical boundary: strict family parsing without tool-content hydration. */
export function readChangeFact(event: StoredFact): ReviewFact {
  return parseFact<ReviewFact>({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
}

/** What one mutation kept of one file's patch. A writer keeps at most 1,000
 * rendered lines of a patch and states the rest in `omittedLines`, and it
 * omits a patch whose hunks hold a recognized credential. */
export type RetainedPatch =
  | { readonly kind: "patch"; readonly unifiedDiff: string; readonly omittedLines?: number }
  | { readonly kind: "sensitive" }
  | { readonly kind: "unretained" }

/** A selected file's descriptor is small; its patch bytes remain in session content. */
export type RetainedPatchSource = RetainedPatch | { readonly kind: "evidence"; readonly evidence: MutationFileEvidence | MutationDisplayFileEvidence }

const UNRETAINED: RetainedPatch = Object.freeze({ kind: "unretained" })
const SENSITIVE: RetainedPatch = Object.freeze({ kind: "sensitive" })

/** Returns the one complete retained patch, or no patch when it cannot restore the file exactly. */
export function completePatch(retained: RetainedPatch): string | undefined {
  return retained.kind === "patch" && retained.omittedLines === undefined ? retained.unifiedDiff : undefined
}

/** Read exact retained bytes in bounded windows. Verify the complete logical hash,
 * length, strict UTF-8, and continuation before accepting any patch text.
 * Missing or corrupt evidence returns undefined; storage-service failures propagate. */
export async function readPatchContent(reader: AsyncEventStateReadSurface, sessionId: string, reference: SessionContentReference): Promise<string | undefined> {
  if (!reader.readSessionContentRange) return undefined
  const parts: Buffer[] = []
  const hasher = new Bun.CryptoHasher("sha256")
  let offset = 0
  do {
    const length = Math.min(SESSION_CONTENT_WINDOW_BYTES, reference.bytes - offset)
    const range = await reader.readSessionContentRange(sessionId, reference, offset, length)
    if (range.kind !== "available" || range.offset !== offset) return undefined
    const bytes = Buffer.from(range.base64, "base64")
    const end = offset + length
    if (bytes.toString("base64") !== range.base64 || bytes.byteLength !== length
      || range.nextOffset !== (end < reference.bytes ? end : null)) return undefined
    hasher.update(bytes)
    parts.push(bytes)
    offset = end
  } while (offset < reference.bytes)
  if (hasher.digest("hex") !== reference.sha256) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts))
  } catch { return undefined }
}

/** Resolve one selected descriptor for legacy full-patch consumers. Paged clients
 * use the descriptor directly and never call this materializing adapter. */
export async function resolveRetainedPatch(reader: AsyncEventStateReadSurface, sessionId: string, source: RetainedPatchSource): Promise<RetainedPatch> {
  if (source.kind !== "evidence") return source
  const { evidence } = source
  if (evidence.patch.kind !== "retained") return evidence.patch.kind === "omitted" && evidence.patch.reason === "sensitive" ? SENSITIVE : UNRETAINED
  const unifiedDiff = await readPatchContent(reader, sessionId, evidence.patch.reference)
  return unifiedDiff === undefined ? UNRETAINED : { kind: "patch", unifiedDiff, ...(evidence.omittedLines > 0 ? { omittedLines: evidence.omittedLines } : {}) }
}
