import { createHash } from "node:crypto"
import { Schema } from "effect"
import { MutationDiffSchema, type MutationDiff } from "../../infra/mutation-diff.js"
import { MutationFileEvidenceSchema } from "../../infra/mutation-evidence-schema.js"
import type { MutationFileEvidence } from "../../infra/mutation-evidence.js"
import type { InFlightWrite } from "../../infra/event-store-types.js"
import type { ContainedFileMetadata, ContainedFileSnapshot } from "../../infra/descriptor-directory.js"
import { parseFileMutationFact, type FileMutationFact } from "./file-mutation-facts.js"
import { fileAccessProof, parseFileAccessProof, type FileAccessProof } from "./file-mutation-access.js"
import { buildSessionContent, buildSessionContentManifest, readSessionContentRange, readSessionContentRecords, type ReadSessionContentNode, type StageSessionContentNodes, type SessionContentManifestReference } from "../../infra/session-content.js"
import { SESSION_CONTENT_WINDOW_BYTES, SessionContentManifestReferenceSchema, SessionContentReferenceSchema } from "../../infra/session-content-schema.js"

type FileMutationPreparedFact = Extract<FileMutationFact, { type: "file.mutation.prepared" }>

export interface FileObjectProof {
  readonly kind: "file"
  readonly bytes: number
  readonly sha256: string
  readonly identity: string
  readonly linkCount: number
  readonly executable: boolean
  readonly access: FileAccessProof
}

export type FilePreconditionProof = { readonly kind: "absent" } | FileObjectProof
type FilePostconditionProof =
  | { readonly kind: "absent" }
  | (Omit<FileObjectProof, "identity" | "access"> & {
    readonly identity: { readonly kind: "new"; readonly replaced: string | null }
    readonly access: FileAccessProof | null
  })

export interface FileMutationOperationItem {
  readonly evidence: FileMutationPreparedFact["payload"]
  readonly precondition: FilePreconditionProof | null
  readonly postcondition: FilePostconditionProof | null
  readonly mayCreateMissingParents: boolean
  readonly mutationDiff?: MutationDiff
  readonly candidateEvidence?: MutationFileEvidence
}

/** Hydrated recovery plan, also the historical inline-cell shape. Only the header
 * is mutable in storage. Historical inline evidence crosses the writer's conversion boundary. */
export interface FileMutationOperationCell {
  readonly version: 1 | 2 | 3
  readonly operationId: string
  readonly cursor: number
  readonly items: readonly FileMutationOperationItem[]
}

/** The immutable root is the generation. Exact-header CAS binds progress to its plan. */
export interface FileMutationOperationHeader {
  readonly version: 3
  readonly operationId: string
  readonly plan: SessionContentManifestReference
  readonly cursor: number
}

export function parseFileMutationOperationHeader(value: unknown): FileMutationOperationHeader {
  if (!record(value) || value.version !== 3 || typeof value.operationId !== "string" || !value.operationId
    || !integer(value.cursor) || "items" in value) throw new Error("Invalid file mutation operation header")
  const plan = Schema.decodeUnknownSync(SessionContentManifestReferenceSchema, { onExcessProperty: "error" })(value.plan)
  if (plan.entries === 0 || value.cursor >= plan.entries) throw new Error("Invalid file mutation operation cursor")
  return { version: 3, operationId: value.operationId, plan, cursor: value.cursor }
}

/** Stages the ordered proof and evidence references once, before publication. */
export async function stageFileMutationOperation(cell: FileMutationOperationCell, stage: StageSessionContentNodes): Promise<FileMutationOperationHeader> {
  const references: string[] = []
  for (const item of cell.items) references.push(JSON.stringify(await buildSessionContent(JSON.stringify(item), stage)))
  const plan = await buildSessionContentManifest(references, stage)
  return { version: 3, operationId: cell.operationId, plan, cursor: cell.cursor }
}

/** Reads bounded immutable pages. Missing or corrupt pages never mean an empty plan. */
export async function readFileMutationOperation(header: FileMutationOperationHeader, read: ReadSessionContentNode): Promise<FileMutationOperationCell> {
  const items: FileMutationOperationItem[] = []
  let offset = 0
  while (offset < header.plan.entries) {
    const page = await readSessionContentRecords(header.plan, offset, Math.min(128, header.plan.entries - offset), read)
    if (page.kind !== "available") throw new Error(`File mutation plan is ${page.reason}`)
    for (const encodedReference of page.records) {
      const reference = Schema.decodeUnknownSync(SessionContentReferenceSchema, { onExcessProperty: "error" })(JSON.parse(encodedReference))
      const parts: Buffer[] = []
      let byteOffset = 0
      do {
        const range = await readSessionContentRange(reference, byteOffset, Math.min(SESSION_CONTENT_WINDOW_BYTES, reference.bytes - byteOffset), read)
        if (range.kind !== "available") throw new Error(`File mutation plan item is ${range.reason}`)
        parts.push(Buffer.from(range.base64, "base64"))
        byteOffset = range.nextOffset ?? reference.bytes
      } while (byteOffset < reference.bytes)
      const bytes = Buffer.concat(parts)
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new Error("File mutation plan item hash mismatch")
      items.push(parseItem(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), 3))
    }
    offset = page.nextOffset ?? header.plan.entries
  }
  return { version: 3, operationId: header.operationId, cursor: header.cursor, items }
}

export interface FileMutationOperationEvidence {
  readonly beforeSnapshot: ContainedFileSnapshot | null
  readonly postconditionAccess?: ContainedFileMetadata
  readonly mayCreateMissingParents?: boolean
}

export function createFileMutationOperationItem(
  prepared: FileMutationPreparedFact,
  evidence: FileMutationOperationEvidence,
  mutationDiff?: MutationDiff,
): FileMutationOperationItem & { readonly precondition: FilePreconditionProof } {
  const snapshot = evidence.beforeSnapshot
  if ((snapshot === null) !== (prepared.payload.before === null)) throw new Error("File mutation before snapshot does not match content presence")
  return {
    evidence: prepared.payload,
    precondition: snapshot ? snapshotToFileObjectProof(snapshot) : { kind: "absent" },
    postcondition: expectedPostcondition(prepared, snapshot, evidence.postconditionAccess),
    mayCreateMissingParents: evidence.mayCreateMissingParents === true,
    ...(mutationDiff ? { mutationDiff } : {}),
  }
}


export function operationCellSwap(
  key: string,
  expectedRaw: string | null,
  next: FileMutationOperationHeader | null,
): InFlightWrite {
  return { op: "swap", kind: "file.mutation", key, expectedRaw, payload: next }
}

/** Strict decoder for historical inline operation cells. Call only at the reviewed
 * recovery boundary; malformed or newer cells remain stored unchanged. */
export function parseFileMutationOperationCell(value: unknown): FileMutationOperationCell {
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || typeof value.operationId !== "string" || value.operationId.length === 0
    || !integer(value.cursor) || !Array.isArray(value.items)) {
    throw new Error("Invalid file mutation operation cell")
  }
  const cursor = value.cursor
  const version = value.version
  const items = value.items.map(item => parseItem(item, version))
  if (items.length === 0 || cursor >= items.length) throw new Error("Invalid file mutation operation cursor")
  return { version, operationId: value.operationId, cursor, items }
}

function parseItem(value: unknown, version: 1 | 2 | 3): FileMutationOperationItem {
  if (!record(value)) throw new Error("Invalid file mutation operation item")
  if (version === 3 && value.mutationDiff !== undefined) throw new Error("Current file mutation cells cannot contain inline evidence")
  const fact = parseFileMutationFact({ type: "file.mutation.prepared", version: version === 3 ? (record(value.evidence) && "origin" in value.evidence ? 2 : 1) : version, actor: "flywheel", payload: value.evidence })
  if (fact.type !== "file.mutation.prepared") throw new Error("Invalid file mutation evidence")
  const candidateEvidence = value.candidateEvidence === undefined ? undefined
    : Schema.decodeUnknownSync(MutationFileEvidenceSchema, { onExcessProperty: "error" })(value.candidateEvidence)
  if (candidateEvidence && (candidateEvidence.mutationId !== fact.payload.mutationId || candidateEvidence.path !== fact.payload.path)) {
    throw new Error("File mutation candidate evidence identity mismatch")
  }
  return {
    evidence: fact.payload,
    precondition: parsePrecondition(value.precondition),
    postcondition: parsePostcondition(value.postcondition),
    mayCreateMissingParents: value.mayCreateMissingParents === true,
    ...(candidateEvidence ? { candidateEvidence } : {}),
    // Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16.
    ...(value.mutationDiff === undefined ? {} : { mutationDiff: Schema.decodeUnknownSync(MutationDiffSchema, { onExcessProperty: "error" })(value.mutationDiff) }),
  }
}

function parsePrecondition(value: unknown): FilePreconditionProof | null {
  if (value === null) return null
  if (record(value) && value.kind === "absent") return { kind: "absent" }
  return parseObjectProof(value)
}

function parsePostcondition(value: unknown): FilePostconditionProof | null {
  if (value === null) return null
  if (record(value) && value.kind === "absent") return { kind: "absent" }
  if (!record(value) || !record(value.identity) || value.identity.kind !== "new") {
    throw new Error("Invalid file mutation postcondition")
  }
  const replaced = value.identity.replaced
  if (replaced !== null && typeof replaced !== "string") throw new Error("Invalid file mutation postcondition")
  return {
    ...parseFileProof(value),
    identity: { kind: "new", replaced },
    access: value.access === null ? null : parseFileAccessProof(value.access),
  }
}


function parseObjectProof(value: unknown): FileObjectProof {
  if (!record(value) || typeof value.identity !== "string") throw new Error("Invalid file object proof")
  return {
    ...parseFileProof(value),
    identity: value.identity,
    access: parseFileAccessProof(value.access),
  }
}

function parseFileProof(value: unknown): Omit<FileObjectProof, "identity" | "access"> {
  if (!record(value) || value.kind !== "file" || !integer(value.bytes)
    || typeof value.sha256 !== "string" || value.sha256.length !== 64
    || !integer(value.linkCount) || typeof value.executable !== "boolean") {
    throw new Error("Invalid file object proof")
  }
  return {
    kind: "file",
    bytes: value.bytes,
    sha256: value.sha256,
    linkCount: value.linkCount,
    executable: value.executable,
  }
}

function expectedPostcondition(
  prepared: FileMutationPreparedFact,
  before: ContainedFileSnapshot | null,
  access: ContainedFileMetadata | undefined,
): FilePostconditionProof {
  const after = prepared.payload.after
  if (!after) return { kind: "absent" }
  return {
    kind: "file",
    bytes: after.bytes,
    sha256: after.sha256,
    identity: { kind: "new", replaced: before?.identity ?? null },
    linkCount: 1,
    executable: access?.kind === "posix" && (access.mode & 0o111) !== 0,
    access: access ? fileAccessProof(access) : null,
  }
}

export function snapshotToFileObjectProof(snapshot: ContainedFileSnapshot): FileObjectProof {
  return {
    kind: "file",
    bytes: snapshot.content.byteLength,
    sha256: createHash("sha256").update(snapshot.content).digest("hex"),
    identity: snapshot.identity,
    linkCount: snapshot.linkCount,
    executable: snapshot.executable,
    access: fileAccessProof(snapshot.metadata),
  }
}

function record(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
