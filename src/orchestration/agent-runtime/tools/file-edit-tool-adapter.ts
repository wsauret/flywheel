import { errorMessage } from "../../../infra/error-message.js"
import { PersistenceWriteRefused } from "../../../infra/event-store-types.js"
import { buildMutationDiff, type MutationDiffEndpoint, truncateUnifiedDiff } from "../../../infra/mutation-diff.js"
import { buildMutationEvidence, type MutationEvidenceEntry } from "../../../infra/mutation-evidence.js"
import { formatFileSamples, summarizeFileSamples } from "../../../infra/not-applied-files.js"
import { truncateUtf8Prefix } from "../../../infra/output/truncate-output.js"
import { readSessionContentRange, type StageSessionContentNodes } from "../../../infra/session-content.js"
import { FileEditRefusal, publishFileEdits, type FileEditOperationOptions, type FileEditPublication, type FileEditPublicationOutcome, type PlannedFileEdit } from "../../file-edits/file-edit-operation.js"
import { settleFileMutationArtifact } from "./file-mutation-artifact.js"
import type { FileReadStaleness, LineRange } from "./file-read-ledger.js"
import { resolveToolPath } from "./tool-paths.js"
import type { ToolContext, ToolResult } from "./types.js"

interface ToolFileEditPlan extends PlannedFileEdit {
  readonly changedLines?: LineRange
}

const MODEL_DIFF_LINE_LIMIT = 120

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** What publishing as a tool call reads of the call's context. */
type ToolPublicationContext = Pick<ToolContext, "executionCwd" | "signal" | "sessionEventWriter" | "toolUseId" | "modelRequestId" | "parentToolUseId" | "readLedger" | "projectionReader" | "gitAiAttribution" | "attributionIdentity">

/** Publishes through the shared publisher as this tool call: every item carries the call's origin, and each
 * settled item feeds Git AI attribution and the read ledger. Paths resolve against `context.executionCwd`
 * and stay the display paths. Throws what the publisher throws. */
export async function publishToolFileEditOutcome<Plan extends PlannedFileEdit>(context: ToolPublicationContext, options:Pick<FileEditOperationOptions<Plan>, "paths" | "admit" | "plan" | "withQueues" | "onPrepared" | "expected">): Promise<FileEditPublicationOutcome<Plan>> {
  const resolvedPaths = new Map(options.paths.map(path => [path, resolveToolPath(context.executionCwd, path)]))
  return publishFileEdits({
    executionCwd: context.executionCwd,
    signal: context.signal,
    sessionEventWriter: context.sessionEventWriter,
    ...(context.toolUseId ? { origin: {
      kind: "tool_call" as const,
      toolUseId: context.toolUseId,
      ...(context.modelRequestId ? { modelRequestId: context.modelRequestId } : {}),
      ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
    } } : {}),
  }, {
    ...options,
    resolvePath: (_cwd, path) => resolvedPaths.get(path)!, // SAFETY: resolvedPaths is built from the exact options.paths that publishFileEdits resolves.
    onSettled: async (publication) => {
      const { authority } = publication.plan.admitted
      settleFileMutationArtifact(context, {
        path: authority.canonicalPath,
        beforeContent: authority.snapshot?.content ?? "",
        afterContent: publication.bytes ?? "",
      })
      if (publication.bytes === undefined) context.readLedger?.forget(authority.canonicalPath)
      else context.readLedger?.recordPublished(authority.canonicalPath, publication.bytes, await context.projectionReader?.capturePosition() ?? 0)
    },
  })
}

/** Collect the publication-owned descriptors without recomputing their endpoints. */
export function publicationEvidence(publications: readonly FileEditPublication[]): MutationEvidenceEntry[] {
  return publications.flatMap(publication => publication.mutation?.evidence
    ? [{ kind: "applied" as const, file: publication.mutation.evidence }] : [])
}

/** Build the final summary after settlements. A refused summary does not undo the settled files. */
export async function settledMutationEvidence(entries: Iterable<MutationEvidenceEntry>, stage: StageSessionContentNodes) {
  try {
    return await buildMutationEvidence(entries, stage)
  } catch (error) {
    if (error instanceof PersistenceWriteRefused) error.stage = "final-result"
    throw error
  }
}

/** Bound the complete model text envelope, including JSON escaping on a single long line. */
export function boundedMutationReport(text: string): string {
  const maxBytes = 16 * 1024
  if (Buffer.byteLength(JSON.stringify({ content: text })) <= maxBytes) return text
  const suffix = "\n(Change details not shown. Open Session Changes.)"
  let low = 0
  let high = Buffer.byteLength(text)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify({ content: truncateUtf8Prefix(text, middle) + suffix })) <= maxBytes) low = middle
    else high = middle - 1
  }
  return truncateUtf8Prefix(text, low) + suffix
}

function textEndpoint(bytes: Uint8Array | undefined): MutationDiffEndpoint | undefined {
  if (bytes === undefined) return { kind: "absent" }
  try { return { kind: "text", text: utf8Decoder.decode(bytes) } } catch { return undefined }
}

/** Adapts the shared publisher to model result text, read evidence and settled attribution. */
export async function publishToolFileEdits(context: ToolContext, options: Pick<FileEditOperationOptions<ToolFileEditPlan>, "paths" | "admit" | "plan" | "withQueues"> & { readonly label: string }): Promise<ToolResult> {
  const warnings: string[] = []
  try {
    const writer = context.sessionEventWriter
    const stage = writer?.stageSessionContentNodes?.bind(writer)
    if (writer && !stage) throw new FileEditRefusal("File mutation evidence staging is unavailable")
    const result = await publishToolFileEditOutcome(context, {
      ...options,
      onPrepared: async (publications) => {
        for (const publication of publications) {
          const warning = await readWarning(context, publication.plan)
          if (warning) warnings.push(warning)
        }
      },
    })
    const committed = result.status === "uncertain" && result.settlement === "committed" ? [...result.committedPrefix, result.current] : result.committedPrefix
    const changedFiles = committed.map(publication => publication.plan.admitted.path)
    const remainingFiles = result.untouchedSuffix.map(publication => publication.plan.admitted.path)
    const entries = publicationEvidence(committed)
    if (result.status === "not_applied") entries.push({ kind: "not_applied", path: result.current.plan.admitted.path, reason: result.reason === "cancelled" ? "publication was interrupted" : errorMessage(result.error) })
    entries.push(...result.untouchedSuffix.map(publication => ({ kind: "not_applied" as const, path: publication.plan.admitted.path, reason: "publication stopped before this file" })))
    const mutationEvidence = stage && entries.length > 0 ? await settledMutationEvidence(entries, stage) : undefined
    const details = {
      changedFiles: summarizeFileSamples(changedFiles), remainingFiles: summarizeFileSamples(remainingFiles),
      ...(mutationEvidence ? { mutationEvidence } : {}),
    }
    if (result.status === "completed") {
      return {
        content: boundedMutationReport([...(await Promise.all(result.committedPrefix.slice(0, 3).map(publication => describePublication(context, publication)))).flat(), ...(changedFiles.length > 3 ? [`and ${changedFiles.length - 3} more files (open Session Changes)`] : []), ...warnings].join("\n")),
        outcome: "ok",
        details: { ...details, indeterminateFiles: summarizeFileSamples([]) },
      }
    }
    const path = result.current.plan.admitted.path
    const progress = [
      `Durably committed: ${changedFiles.length > 0 ? formatFileSamples(details.changedFiles) : "none"}`,
      `Untouched: ${remainingFiles.length > 0 ? formatFileSamples(details.remainingFiles) : "none"}`,
    ]
    if (result.status === "uncertain") {
      const state = result.publication === "unknown" ? "the file may have changed"
        : result.settlement === "pending" ? "the change was applied but is not durably settled"
          : "the change was applied and durably settled, but result observation failed"
      return {
        content: boundedMutationReport([`${options.label} failed at ${path}: ${state}: ${errorMessage(result.error)}`, ...progress].join("\n")),
        outcome: "error",
        details: {
          ...details, indeterminateFiles: summarizeFileSamples(result.publication === "unknown" ? [path] : []),
          current: { path, status: result.status, stage: result.stage, publication: result.publication, settlement: result.settlement, error: errorMessage(result.error) },
        },
      }
    }
    const retirementError = result.retirementError === undefined ? undefined : errorMessage(result.retirementError)
    return {
      content: boundedMutationReport([
        result.reason === "cancelled"
          ? `${options.label} interrupted before ${path} was published: the file was not changed`
          : `${options.label} failed at ${path}: the change was not applied: ${errorMessage(result.error)}`,
        ...(retirementError === undefined ? [] : [`Checkpoint retirement failed: ${retirementError}`]),
        ...progress,
      ].join("\n")),
      outcome: result.reason === "cancelled" && retirementError === undefined ? "interrupted" : "error",
      details: {
        ...details, indeterminateFiles: summarizeFileSamples([]),
        current: { path, status: result.status, reason: result.reason, ...(result.error === undefined ? {} : { error: errorMessage(result.error) }), ...(retirementError === undefined ? {} : { retirementError }) },
      },
    }
  } catch (error) {
    if (error instanceof PersistenceWriteRefused) throw error
    if (error instanceof FileEditRefusal) return { content: boundedMutationReport(error.message), outcome: "error" }
    let message = errorMessage(error)
    if (context.sessionEventWriter && !context.toolUseId && message === "File mutation publication requires an origin") message = "file-mutating tool dispatched without toolUseId"
    for (const path of options.paths) message = message.replaceAll(resolveToolPath(context.executionCwd, path), path)
    return { content: boundedMutationReport(`${options.label} failed: ${message}`), outcome: context.signal?.aborted ? "interrupted" : "error" }
  }
}

/** Read evidence informs the model but never blocks publication. Per-item CAS owns race refusal. */
async function readWarning(context: ToolContext, plan: ToolFileEditPlan): Promise<string | undefined> {
  const { authority } = plan.admitted
  if (!context.readLedger || !authority.snapshot) return undefined
  const staleness = context.readLedger.staleness(authority.canonicalPath, authority.snapshot.content, plan.changedLines)
  if (!staleness) return undefined
  return describeStaleness(context, plan.admitted.path, authority.canonicalPath, staleness)
}

async function describeStaleness(context: ToolContext, path: string, canonicalPath: string, staleness: FileReadStaleness): Promise<string> {
  switch (staleness.kind) {
    case "unread":
      return `Warning: ${path} was not read in this session; the change was applied to the current file content.`
    case "uncovered":
      return `Warning: the last read of ${path} did not cover lines ${staleness.lines.start}-${staleness.lines.end}, which this change replaced.`
    case "changed":
      return `Warning: ${path} changed after it was last read${await changedBy(context, canonicalPath, staleness.sincePosition)}; the change was applied to the current content.`
  }
}

/** Names the recorded writer when a file.changed fact after the read explains the change. */
async function changedBy(context: ToolContext, canonicalPath: string, sincePosition: number): Promise<string> {
  if (!context.projectionReader || !context.sessionId) return ""
  const { facts } = await context.projectionReader.readSlice({ aggregateId: `session:${context.sessionId}`, types: ["file.changed"], afterPosition: sincePosition })
  for (const fact of facts.toReversed()) {
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
    if (fact instanceof Error) throw fact
    const payload = fact.payload
    if (typeof payload !== "object" || payload === null || !("path" in payload) || payload.path !== canonicalPath) continue
    const origin = "origin" in payload ? payload.origin : payload
    if (typeof origin !== "object" || origin === null) continue
    if ("kind" in origin && origin.kind === "user_undo") return " (reverted by the user)"
    const toolUseId = "toolUseId" in origin && typeof origin.toolUseId === "string" ? origin.toolUseId : undefined
    const parent = "parentToolUseId" in origin && typeof origin.parentToolUseId === "string" ? origin.parentToolUseId : undefined
    if (parent) return ` (written by a subagent under tool call ${parent})`
    if (toolUseId) return ` (written by tool call ${toolUseId})`
  }
  return ""
}

/** The model receives update hunks, creation size and deletion path. The UI retains the longer diff. */
async function describePublication(context: ToolContext, publication: FileEditPublication): Promise<string[]> {
  const path = publication.plan.admitted.path
  if (publication.bytes === undefined) return [`Deleted ${path}`]
  if (publication.plan.admitted.authority.snapshot === undefined) return [`Created ${path} (${publication.bytes.toString("utf8").split("\n").length} lines)`]
  const evidence = publication.mutation?.evidence
  if (!context.sessionEventWriter) {
    // Standalone callers have no retained content owner. This preview is never durable evidence.
    const before = textEndpoint(publication.plan.admitted.authority.snapshot?.content)
    const after = textEndpoint(publication.bytes)
    const mutation = buildMutationDiff(before && after ? [{ path, before, after }] : [])
    const file = mutation.files[0]
    return file ? describeUpdated(path, file.unifiedDiff, file.omittedLines ?? 0)
      : [`Updated ${path}`, mutation.omissions.length ? "(diff omitted: sensitive content)" : "(no textual change)"]
  }
  if (evidence?.patch.kind === "omitted") return [`Updated ${path}`, "(diff omitted: sensitive content)"]
  const reader = context.projectionReader ?? context.sessionEventStore
  const readNode = reader?.readSessionContentNode?.bind(reader)
  const sessionId = context.sessionId
  if (evidence?.patch.kind !== "retained" || !readNode || !sessionId) return [`Updated ${path}`]
  const range = await readSessionContentRange(evidence.patch.reference, 0, 16 * 1024, sha256 => readNode(sessionId, sha256))
  if (range.kind !== "available") return [`Updated ${path}`, "Change evidence is unavailable"]
  const patch = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.from(range.base64, "base64"), { stream: range.nextOffset !== null })
  return [...describeUpdated(path, patch, evidence.omittedLines, evidence.renderedLines), ...(range.nextOffset === null ? [] : ["(Change details not shown. Open Session Changes.)"])]
}

function describeUpdated(path: string, patch: string, omittedLines: number, totalRenderedLines?: number): string[] {
  const lines = patch.split("\n")
  const first = lines.findIndex(line => line.startsWith("@@"))
  const retained = truncateUnifiedDiff(first < 0 ? patch : lines.slice(first).join("\n"), MODEL_DIFF_LINE_LIMIT)
  const omitted = totalRenderedLines === undefined ? retained.omitted + omittedLines : totalRenderedLines - Math.min(retained.rendered, MODEL_DIFF_LINE_LIMIT)
  return [`Updated ${path}`, retained.text.trimEnd(), ...(omitted > 0 ? [`(${omitted} more diff lines not shown)`] : [])]
}
