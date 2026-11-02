import { buildMutationEvidence, type MutationEvidenceEntry, type MutationFileEvidence } from "../../../../src/infra/mutation-evidence.js"
import { buildSessionContent, readSessionContentRange, type SessionContentNode, type StageSessionContentNodes } from "../../../../src/infra/session-content.js"
import { createMutationEvidenceReader, type MutationEvidenceHandle } from "../../../../src/protocol/client/mutation-evidence.js"
import type { RuntimeConnection } from "../../../../src/protocol/client/connection.js"
import type { RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import { unifiedDiffPreview, type MutationDiff } from "../../../../src/infra/mutation-diff.js"
import { MUTATION_FILE_PREVIEW_BYTES, type MutationFilesEntry, type MutationFilesQuery, type MutationFilesResult, type MutationPatchWindowQuery, type MutationPatchWindowResult } from "../../../../src/protocol/mutation-evidence-protocol-types.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../../../src/infra/output-blocks.js"
import { buildMutationDiffEntries } from "../../../../src/infra/mutation-diff-evidence.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** The collapsed preview the runtime serves for a patch's leading bytes, so a
 * client test builds the preview without importing the runtime. */
export function collapsedPreview(prefix: string, complete = true): string {
  return unifiedDiffPreview(prefix, complete, { lines: TOOL_PREVIEW_LINE_LIMIT, encodedBytes: MUTATION_FILE_PREVIEW_BYTES })
}

/** A real reader over a bounded in-memory transport. Tests control byte and
 * metadata windows without replacing the reader's acquisition or publication. */
export async function mutationEvidenceFixture(inputs: readonly {
  path: string
  patch?: string
  lines?: number
  change?: MutationFileEvidence["change"]
  omission?: "sensitive"
}[] | MutationDiff, options: { windowBytes?: number; pageFiles?: number; notApplied?: readonly { path: string; reason: string }[]; removedDirectories?: readonly { path: string; files: number; bytes: number }[] } = {}) {
  const nodes = new Map<string, SessionContentNode>()
  const stage: StageSessionContentNodes = async rows => { for (const row of rows) nodes.set(row.sha256, row.node) }
  const entries: MutationEvidenceEntry[] = (options.removedDirectories ?? []).map(directory => ({ kind: "removed_directory", ...directory, displayPath: directory.path }))
  if ("version" in inputs) entries.push(...await buildMutationDiffEntries(inputs, "display-fixture", stage))
  for (const input of "version" in inputs ? [] : inputs) {
    entries.push({ kind: "applied", file: {
      version: 1, mutationId: `mutation:${input.path}`, path: input.path, displayPath: input.path,
      change: input.change ?? "modified", before: null, after: null,
      retainedLines: input.lines ?? 2, renderedLines: input.lines ?? 2, omittedLines: 0,
      addedLines: 1, removedLines: input.change === "added" ? 0 : 1, conflictMarkers: false,
      patch: input.omission !== undefined ? { kind: "omitted", reason: input.omission }
        : input.patch === undefined ? { kind: "unavailable" }
        : { kind: "retained", reference: await buildSessionContent(input.patch, stage) },
    } })
  }
  entries.push(...(options.notApplied ?? []).map(entry => ({ kind: "not_applied" as const, ...entry })))
  const evidence = await buildMutationEvidence(entries, stage)
  const calls: RuntimeQuery[] = []
  const pending = new Set<Promise<unknown>>()
  let patchGate: Promise<void> | undefined
  let filesGate: Promise<void> | undefined
  let failure: "missing" | "corrupt" | "error" | undefined
  let filesFailed = false
  const windowWaiters = new Set<{ root: string; resolve: () => void }>()
  // The runtime derives each preview from the patch's leading bytes.
  const withPreview = async (entry: MutationEvidenceEntry): Promise<MutationFilesEntry> => {
    if ((entry.kind !== "applied" && entry.kind !== "display") || entry.file.patch.kind !== "retained") return entry
    // The runtime serves a patch whose stored bytes it cannot read as unavailable.
    if (failure === "missing" || failure === "corrupt") return entry.kind === "applied"
      ? { kind: "applied", file: { ...entry.file, patch: { kind: "unavailable" } } }
      : { kind: "display", file: { ...entry.file, patch: { kind: "unavailable" } } }
    const { reference } = entry.file.patch
    const range = await readSessionContentRange(reference, 0, Math.min(reference.bytes, MUTATION_FILE_PREVIEW_BYTES), async hash => nodes.get(hash) ?? null)
    if (range.kind !== "available") throw new Error("Expected fixture patch bytes")
    const complete = range.nextOffset === null
    const prefix = new TextDecoder().decode(Buffer.from(range.base64, "base64"), { stream: !complete })
    return { ...entry, preview: collapsedPreview(prefix, complete) }
  }
  const serveFiles = async (query: MutationFilesQuery): Promise<MutationFilesResult> => {
    await filesGate
    if (filesFailed) throw new Error("Read service disconnected")
    const files = await Promise.all(entries.slice(query.offset, query.offset + (options.pageFiles ?? 128)).map(entry => query.previews === true ? withPreview(entry) : entry))
    const end = query.offset + files.length
    return { kind: "available", sessionId: "session", manifest: query.manifest, requestedOffset: query.offset,
      offset: query.offset, totalFiles: entries.length, totalBytes: evidence.manifest.bytes, files,
      nextOffset: end === entries.length ? null : end }
  }
  const serveWindow = async (query: MutationPatchWindowQuery): Promise<MutationPatchWindowResult> => {
    for (const waiter of windowWaiters) {
      if (waiter.root !== query.reference.root) continue
      windowWaiters.delete(waiter)
      waiter.resolve()
    }
    await patchGate
    if (failure === "error") throw new Error("Read service disconnected")
    if (failure) return { kind: "unavailable", sessionId: "session", reference: query.reference, requestedOffset: query.offset, reason: failure }
    const result = await readSessionContentRange(query.reference, query.offset, options.windowBytes ?? 1024, async hash => nodes.get(hash) ?? null)
    const identity = { sessionId: "session", reference: query.reference, requestedOffset: query.offset }
    return result.kind === "unavailable" ? { ...result, ...identity }
      : { ...result, ...identity, totalBytes: query.reference.bytes, servedBytes: Buffer.from(result.base64, "base64").length }
  }
  // Each read is recorded and held pending until it settles, so settle() waits for it.
  const served = <Query extends RuntimeQuery, Result>(serve: (query: Query) => Promise<Result>) => (query: Query): Promise<Result> => {
    calls.push(query)
    const result = serve(query)
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  }
  const connection: Pick<RuntimeConnection, "query"> = { query: runtimeQuery({ mutationFiles: served(serveFiles), mutationPatchWindow: served(serveWindow) }) }
  const reader = createMutationEvidenceReader({ sessionId: "session", connection })
  const handles = new Set<MutationEvidenceHandle>()
  const open = reader.open
  reader.open = (ownerId, manifest, openOptions) => {
    const handle = open(ownerId, manifest, openOptions)
    handles.add(handle)
    return handle
  }
  return { reader, evidence, entries, calls,
    holdPatches(gate: Promise<void> | undefined) { patchGate = gate },
    /** Resolves when the reader next asks for a window of this patch content. */
    nextWindow(reference: { root: string }) {
      const waiter = Promise.withResolvers<void>()
      windowWaiters.add({ root: reference.root, resolve: waiter.resolve })
      return waiter.promise
    },
    holdFiles(gate: Promise<void> | undefined) { filesGate = gate },
    failPatches(value: typeof failure) { failure = value },
    failFiles(value: boolean) { filesFailed = value },
    async settle() {
      while (pending.size > 0) await Promise.allSettled(pending)
      for (const handle of handles) {
        if (handle.files.status === "loading") await handle.loadFiles()
        for (const entry of handle.files.files) {
          const patch = handle.patch(entry)
          if (patch?.view.status === "loading") await patch.continue()
        }
      }
    },
  }
}
