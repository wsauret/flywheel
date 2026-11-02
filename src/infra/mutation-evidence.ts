import { dirname } from "node:path"
import { Schema } from "effect"
import { buildMutationDiff, mutationDiffLineCounts, type MutationDiffTarget } from "./mutation-diff.js"
import {
  buildSessionContent, buildSessionContentManifest, readSessionContentRecords,
  assertSessionContentReferenceSync, assertSessionContentManifestSync,
  type ReadSessionContentNodeSync,
  type ReadSessionContentNode, type StageSessionContentNodes, type SessionContentUnavailable,
} from "./session-content.js"
import {
  MutationFileEvidenceSchema, MutationDisplayFileEvidenceSchema, MutationEvidenceEntrySchema,
  MutationEvidenceSchema, MutationEvidenceSampleSchema, MUTATION_EVIDENCE_SUMMARY_BYTES,
} from "./mutation-evidence-schema.js"

export type MutationFileEvidence = typeof MutationFileEvidenceSchema.Type
export type MutationDisplayFileEvidence = typeof MutationDisplayFileEvidenceSchema.Type
export type MutationEvidenceEntry = typeof MutationEvidenceEntrySchema.Type
export type MutationEvidence = typeof MutationEvidenceSchema.Type
const decodeFile = Schema.decodeUnknownSync(MutationFileEvidenceSchema, { onExcessProperty: "error" })
const decodeEntry = Schema.decodeUnknownSync(MutationEvidenceEntrySchema, { onExcessProperty: "error" })
const decodeSummary = Schema.decodeUnknownSync(MutationEvidenceSchema, { onExcessProperty: "error" })

/** Prove a per-file settlement before its owning transaction commits. */
export function assertMutationFileEvidence(value: unknown, read: ReadSessionContentNodeSync): void {
  const file = decodeFile(value)
  if (file.patch.kind === "retained") assertSessionContentReferenceSync(file.patch.reference, read)
}

/** Manifest records are typed file descriptors, not opaque content identities. */
export function assertMutationEvidence(value: unknown, read: ReadSessionContentNodeSync): void {
  const evidence = decodeSummary(value)
  let applied = 0
  let retainedFiles = 0
  let notApplied = 0
  let unknownChanges = 0
  let removedDirectories = 0
  assertSessionContentManifestSync(evidence.manifest, read, record => {
    const entry = decodeEntry(JSON.parse(record))
    if (entry.kind === "removed_directory") removedDirectories += 1
    else if (entry.kind === "applied" || entry.kind === "display") {
      applied += 1
      if (entry.file.patch.kind === "retained") retainedFiles += 1
      if (entry.file.patch.kind === "retained") assertSessionContentReferenceSync(entry.file.patch.reference, read)
    } else if (entry.kind === "omitted") unknownChanges += 1
    else notApplied += 1
  })
  if (applied !== evidence.applied || retainedFiles !== evidence.retainedFiles || notApplied !== evidence.notApplied) throw new Error("Mutation evidence count mismatch")
  if (unknownChanges !== (evidence.unknownChanges ?? 0)) throw new Error("Unknown change count mismatch")
  if (removedDirectories !== (evidence.removedDirectories ?? 0)) throw new Error("Removed directory count mismatch")
}

function identity(endpoint: MutationDiffTarget["before"]): MutationFileEvidence["before"] {
  return endpoint.kind === "absent" ? null : {
    bytes: Buffer.byteLength(endpoint.text),
    sha256: new Bun.CryptoHasher("sha256").update(endpoint.text).digest("hex"),
  }
}

/** Retain the existing patch policy, then stage all patch chunks before returning.
 * Unchanged endpoints return null. This does not authorize or publish a file change. */
export async function buildMutationFileEvidence(
  input: MutationDiffTarget & {
    readonly mutationId: string; readonly displayPath?: string; readonly conflictMarkers?: boolean
    readonly action?: string; readonly reach?: string; readonly name?: string
  },
  stage: StageSessionContentNodes,
): Promise<MutationFileEvidence | null> {
  if ((input.before.kind === "text" && !input.before.text.isWellFormed()) || (input.after.kind === "text" && !input.after.text.isWellFormed())) throw new Error("Mutation evidence must be strict UTF-8")
  const diff = buildMutationDiff([input])
  const file = diff.files[0]
  const omission = diff.omissions[0]
  let patch: MutationFileEvidence["patch"]
  if (file) patch = { kind: "retained", reference: await buildSessionContent(file.unifiedDiff, stage) }
  else if (omission) patch = { kind: "omitted", reason: omission.reason }
  else return null
  const counts = mutationDiffLineCounts(file?.unifiedDiff ?? "")
  const omittedLines = file?.omittedLines ?? 0
  const change = input.before.kind === "absent" ? "added" : input.after.kind === "absent" ? "removed" : "modified"
  return decodeFile({
    version: 1, mutationId: input.mutationId, path: input.path, displayPath: input.displayPath ?? input.path,
    change, before: identity(input.before), after: identity(input.after),
    retainedLines: counts.rendered, renderedLines: counts.rendered + omittedLines, omittedLines,
    addedLines: counts.added, removedLines: counts.removed, patch, conflictMarkers: input.conflictMarkers ?? false,
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.reach === undefined ? {} : { reach: input.reach }),
    ...(input.name === undefined ? {} : { name: input.name }),
  })
}

/** Builds evidence for observed bytes. Binary identities must be computed by
 * the scanning Worker so large binary files never hash on the runtime thread. */
export async function buildMutationBytesEvidence(
  input: { readonly mutationId: string; readonly path: string; readonly displayPath?: string; readonly before: Uint8Array | undefined; readonly after: Uint8Array | undefined; readonly conflictMarkers?: boolean; readonly binary?: { readonly before: MutationFileEvidence["before"]; readonly after: MutationFileEvidence["after"] } },
  stage: StageSessionContentNodes,
): Promise<MutationFileEvidence | null> {
  if (input.binary) {
    return decodeFile({
      version: 1, mutationId: input.mutationId, path: input.path, displayPath: input.displayPath ?? input.path,
      change: input.before === undefined ? "added" : input.after === undefined ? "removed" : "modified",
      before: input.binary.before, after: input.binary.after,
      retainedLines: 0, renderedLines: 0, omittedLines: 0, addedLines: 0, removedLines: 0,
      patch: { kind: "unavailable" }, conflictMarkers: input.conflictMarkers ?? false,
    })
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const before = input.before === undefined ? undefined : decoder.decode(input.before)
  const after = input.after === undefined ? undefined : decoder.decode(input.after)
  return buildMutationFileEvidence({
    mutationId: input.mutationId, path: input.path, displayPath: input.displayPath ?? input.path,
    conflictMarkers: input.conflictMarkers ?? false,
    before: before === undefined ? { kind: "absent" } : { kind: "text", text: before },
    after: after === undefined ? { kind: "absent" } : { kind: "text", text: after },
  }, stage)
}

/** Build one settled-prefix manifest. Applied files alone contribute change and
 * line totals. Not-applied entries carry reasons and no filesystem authority.
 * Each removed directory entry precedes the entries it holds; samples name the
 * directory in place of those entries. */
export async function buildMutationEvidence(entries: Iterable<MutationEvidenceEntry>, stage: StageSessionContentNodes): Promise<MutationEvidence> {
  const totals = { applied: 0, retainedFiles: 0, omissions: 0, notApplied: 0, added: 0, modified: 0, removed: 0, addedLines: 0, removedLines: 0, conflictMarkers: 0 }
  let unknownChanges = 0
  const removedDirectories = new Set<string>()
  let filesInRemovedDirectories = 0
  const samples: (typeof MutationEvidenceSampleSchema.Type)[] = []
  function* records(): Generator<string> {
    for (const raw of entries) {
      const entry = decodeEntry(raw)
      if (entry.kind === "removed_directory") {
        removedDirectories.add(entry.path)
        if (samples.length < 3) samples.push({ kind: "removed_directory", path: entry.displayPath, files: entry.files, bytes: entry.bytes })
        yield JSON.stringify(entry)
        continue
      }
      const grouped = removedDirectories.size > 0 && inRemovedDirectory(entry.kind === "applied" || entry.kind === "display" ? entry.file.path : entry.path, removedDirectories)
      if (grouped) filesInRemovedDirectories += 1
      if (entry.kind === "applied" || entry.kind === "display") {
        totals.applied += 1
        if (entry.file.patch.kind === "retained") totals.retainedFiles += 1
        totals[entry.file.change] += 1
        totals.addedLines += entry.file.addedLines
        totals.removedLines += entry.file.removedLines
        if (entry.file.patch.kind !== "retained" || entry.file.omittedLines > 0) totals.omissions += 1
        if (entry.file.conflictMarkers) totals.conflictMarkers += 1
      } else if (entry.kind === "omitted") {
        totals.omissions += 1
        unknownChanges += 1
      } else totals.notApplied += 1
      if (!grouped && samples.length < 3) samples.push(entry.kind === "applied" || entry.kind === "display"
        ? { kind: "applied", path: entry.file.displayPath, ...(entry.file.conflictMarkers ? { conflictMarkers: true } : {}) }
        : { kind: entry.kind, path: entry.kind === "omitted" ? entry.displayPath : entry.path, reason: entry.reason })
      yield JSON.stringify(entry)
    }
  }
  const manifest = await buildSessionContentManifest(records(), stage)
  const summary = {
    version: 2 as const, manifest, ...totals, ...(unknownChanges > 0 ? { unknownChanges } : {}),
    ...(removedDirectories.size > 0 ? { removedDirectories: removedDirectories.size, filesInRemovedDirectories } : {}), samples,
  }
  while (Buffer.byteLength(JSON.stringify(summary)) > MUTATION_EVIDENCE_SUMMARY_BYTES && samples.length > 0) samples.pop()
  return decodeSummary(summary)
}

/** Whether `path` lies below one of `directories`, all in the same path form. */
function inRemovedDirectory(path: string, directories: ReadonlySet<string>): boolean {
  for (let child = path, parent = dirname(path); parent !== child && parent !== "."; child = parent, parent = dirname(parent)) {
    if (directories.has(parent)) return true
  }
  return false
}

/** Read only selected file pages. Invalid descriptors yield unavailable, not
 * a partially successful page. Storage-service errors propagate to the caller. */
export async function readMutationEvidenceFiles(
  evidence: MutationEvidence, offset: number, limit: number, read: ReadSessionContentNode,
): Promise<SessionContentUnavailable | { readonly kind: "available"; readonly files: readonly MutationEvidenceEntry[]; readonly nextOffset: number | null }> {
  const summary = decodeSummary(evidence)
  const page = await readSessionContentRecords(summary.manifest, offset, limit, read)
  if (page.kind === "unavailable") return page
  try {
    return { kind: "available", files: page.records.map(record => decodeEntry(JSON.parse(record))), nextOffset: page.nextOffset }
  } catch {
    return { kind: "unavailable", reason: "corrupt" }
  }
}
