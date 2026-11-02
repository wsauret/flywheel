import type { MutationDiff } from "../../infra/mutation-diff.js"
import type { MutationEvidence, MutationFileEvidence, MutationDisplayFileEvidence } from "../../infra/mutation-evidence.js"
import { formatConflictMarkers, formatFileSamples, formatNotAppliedFiles, mutationEvidenceItems } from "../../infra/not-applied-files.js"
import { TOOL_PREVIEW_LINE_LIMIT, type ProvisionalDiff, type ProvisionalDiffFile, type ToolPresentation } from "../../infra/output-blocks.js"
import type { FrontendToolEntry, FrontendToolStreamingText } from "../app-service-types.js"
import type { HydratedOutputBlockBody } from "../transcript-protocol-types.js"
import type { MutationFilesEntry } from "../mutation-evidence-protocol-types.js"
import { formatBytes } from "./attachments.js"
import type { MutationFilesView, MutationPatchView } from "./mutation-evidence.js"

export type FileChangeBody =
  | { readonly kind: "actual"; readonly mutationEvidence: MutationEvidence; readonly pendingProposal?: Extract<FileChangeBody, { kind: "proposed" }> }
  | { readonly kind: "net"; readonly diff: MutationDiff }
  | { readonly kind: "advisory"; readonly message: string }
  | { readonly kind: "proposed"; readonly proposedDiff: ProvisionalDiff }
  | { readonly kind: "unavailable" }

export type MutationDiffRow =
  | { readonly path: string; readonly kind: "context"; readonly text: string; readonly oldLine: number; readonly newLine: number }
  | { readonly path: string; readonly kind: "remove"; readonly text: string; readonly oldLine: number }
  | { readonly path: string; readonly kind: "add"; readonly text: string; readonly newLine: number }

interface FileDiffRow {
  readonly id: string
  readonly kind: "add" | "remove" | "context"
  readonly text: string
  readonly partial: boolean
  readonly oldLine?: number
  readonly newLine?: number
}

export interface FileDiffFile {
  readonly id: string
  readonly path?: string
  readonly action: "add" | "delete" | "update"
  readonly presentation: "write" | "edit"
  readonly movePath?: string
  readonly rows: readonly FileDiffRow[]
  readonly renderedLines: number
  /** Source omissions plus retained rows outside the selected window. */
  readonly omittedLines: number
  readonly sourceOmittedLines: number
  readonly expanded: boolean
  readonly evidence?: MutationFileEvidence | MutationDisplayFileEvidence
  readonly evidenceStatus?: MutationPatchView["status"] | "omitted"
  readonly omissionReason?: string
}

/** Selects actual metadata without reading patches. A pendingProposal remains explicitly
 * proposed until the caller has actual bytes to show; it is never an applied diff. */
export function selectFileChangeBody(
  tool: FrontendToolEntry,
  streaming: FrontendToolStreamingText | undefined,
  hydrated?: HydratedOutputBlockBody,
): FileChangeBody {
  const body = hydrated?.blockId === `tool:${tool.id}` ? hydrated : undefined
  const mutationEvidence = body?.mutationEvidence ?? tool.mutationEvidence
  if (mutationEvidence !== undefined && presentsAsFileChange(tool)) {
    const proposedDiff = streaming !== undefined && "proposedDiff" in streaming
      ? streaming.proposedDiff : tool.proposedDiff ?? body?.proposedDiff
    return {
      kind: "actual", mutationEvidence,
      ...(proposedDiff === undefined ? {} : { pendingProposal: { kind: "proposed" as const, proposedDiff } }),
    }
  }
  if (isShellMutationEntry(tool)) return { kind: "unavailable" }
  if (tool.fileChangeKind === undefined || tool.status === "error") return { kind: "unavailable" }
  if (tool.status === "completed") return { kind: "unavailable" }
  if (streaming?.previewCheck !== undefined) {
    return { kind: "advisory", message: streaming.previewCheck }
  }
  const proposedDiff = streaming !== undefined && "proposedDiff" in streaming
    ? streaming.proposedDiff
    : tool.proposedDiff ?? body?.proposedDiff
  if (proposedDiff !== undefined) return { kind: "proposed", proposedDiff }
  return { kind: "unavailable" }
}

/** Whether a row is a shell command whose input declared that it mutates project
 *  files. It is one from the moment that declaration streams, before its
 *  changes land, and stays one when it settles without changing a file. */
export function isShellMutationEntry(tool: Pick<FrontendToolEntry, "declaresMutation">): boolean {
  return tool.declaresMutation === true
}

/** Shows settled command output when a declared mutation has no landed evidence.
 * Active foreground or managed work keeps its existing running presentation. */
export function showsShellMutationOutput(
  tool: FrontendToolEntry,
  active: boolean,
  hydrated?: HydratedOutputBlockBody,
): boolean {
  if (!isShellMutationEntry(tool) || tool.status === "pending" || tool.status === "streaming"
    || active) return false
  const body = selectFileChangeBody(tool, undefined, hydrated)
  return body.kind !== "actual" || (body.mutationEvidence.applied === 0 && body.mutationEvidence.omissions === 0)
}

/** Whether a row renders as a file-change card, with per-file evidence leading its
 *  body: a registered file change, or a shell command that declared mutations.
 *  Every client routes a row to its file-change presentation through this. */
export function presentsAsFileChange(tool: Pick<FrontendToolEntry, "declaresMutation" | "fileChangeKind">): boolean {
  return tool.fileChangeKind !== undefined || isShellMutationEntry(tool)
}

/** The one line a shell mutation's row shows in place of its command until it settles. */
export const SHELL_MUTATION_RUNNING = "bash command is running…"

type ShellMutationRow = Pick<FrontendToolEntry, "declaresMutation" | "mutationEvidence" | "presentation" | "status">

/** Whether a shell mutation's row still shows the running line: its input is
 *  arriving, or `active` foreground or managed work runs it, and no change has
 *  landed. A compact row retains the same bounded evidence metadata. */
export function isShellMutationRunning(tool: Omit<ShellMutationRow, "presentation">, active: boolean): boolean {
  const landed = tool.mutationEvidence !== undefined
  return isShellMutationEntry(tool) && !landed && (active || tool.status === "pending" || tool.status === "streaming")
}

/** Names a running shell mutation as an Edit without its command, landed shell
 *  files as Write when all were added and otherwise Edit, and a shell mutation
 *  that settled with nothing landed as the plain command it ran. */
export function rowPresentation(tool: ShellMutationRow, active: boolean = false): ToolPresentation {
  if (!isShellMutationEntry(tool)) return tool.presentation
  if (isShellMutationRunning(tool, active)) return { name: "Edit", detail: SHELL_MUTATION_RUNNING }
  const evidence = tool.mutationEvidence
  if (evidence === undefined) return tool.presentation
  const writesOnly = evidence.added > 0 && evidence.modified === 0 && evidence.removed === 0 && evidence.retainedFiles > 0
  return { name: writesOnly ? "Write" : "Edit", detail: shellMutationFiles(tool) ?? tool.presentation.detail }
}

export type FileWritePolicy = "all" | "added" | "none"

/** Selects source presentation for Write tools and landed shell additions, never patch additions. */
export function rowWritePolicy(tool: Pick<FrontendToolEntry, "fileChangeKind" | "declaresMutation">): FileWritePolicy {
  return tool.fileChangeKind === "create" ? "all" : isShellMutationEntry(tool) ? "added" : "none"
}

/** The files a shell mutation changed, as one line, once its changes land; the
 *  row's detail then names files rather than a command. */
export function shellMutationFiles(tool: Pick<FrontendToolEntry, "mutationEvidence">): string | undefined {
  return tool.mutationEvidence !== undefined ? fileChangeDetail({ kind: "actual", mutationEvidence: tool.mutationEvidence })
    : undefined
}

/** The line a row shows, open or folded, for files a mutating command changed
 *  on the same lines as a concurrent project change: the published file holds
 *  conflict markers around those lines. The command's model-facing result
 *  states them with the same line. */
export function conflictMarkersNotice(evidence: MutationEvidence): string {
  return formatConflictMarkers({ total: evidence.conflictMarkers,
    samples: evidence.samples.filter(sample => sample.kind === "applied" && sample.conflictMarkers).map(sample => sample.path) }, "client")
}

/** The line a row shows, open or folded, for files whose change a mutating
 *  command made but Flywheel kept out of the project, with each reason. The
 *  command's model-facing result states them with the same line. */
export function notAppliedNotice(evidence: MutationEvidence): string {
  // SAFETY: buildMutationEvidence copies the required reason from every not_applied entry into its sample.
  return formatNotAppliedFiles({ total: evidence.notApplied,
    samples: evidence.samples.flatMap(sample => sample.kind === "not_applied" ? [{ path: sample.path, reason: sample.reason! }] : []) }, "client")
}

/** The files a change touches, as the one line a collapsed row can say about
 *  it. A file tool's presentation has no detail of its own: the paths sit in
 *  the diff, and a row whose diff is folded away then reads as a bare "Edit".
 *  Actual and proposed bodies both know their files; an advisory or an
 *  unavailable body names none. */
export function fileChangeDetail(body: FileChangeBody): string | undefined {
  if (body.kind === "actual") {
    const evidence = body.mutationEvidence
    const items = mutationEvidenceItems(evidence)
    return items.total === 0 ? undefined : formatFileSamples(items, { kind: evidence.notApplied > 0 ? "mixed" : "changed", audience: "client" })
  }
  const paths = body.kind === "proposed"
      ? body.proposedDiff.files.flatMap((file) => (file.path === undefined ? [] : [file.path]))
      : []
  return paths.length > 0 ? paths.join(", ") : undefined
}

type RemovedDirectoryEntry = Extract<MutationFilesEntry, { kind: "removed_directory" }>

/** One removed directory's line: `scratch/dl/ (delete, 454 files, 12 MB)`. */
export function removedDirectoryLabel(directory: Pick<RemovedDirectoryEntry, "displayPath" | "files" | "bytes">): string {
  return `${directory.displayPath}/ (delete, ${directory.files} file${directory.files === 1 ? "" : "s"}, ${formatBytes(directory.bytes)})`
}

/** The loaded removed directories of a manifest page and where each file shows. */
export interface RemovedDirectoryGroups {
  /** Each directory with the indexes of the `files` it held, which show only under it. */
  readonly directories: readonly { readonly directory: RemovedDirectoryEntry; readonly members: readonly number[] }[]
  /** The indexes of the `files` that show at their own place. */
  readonly ungrouped: readonly number[]
}

/** Group `files` under the removed directory that holds them. Canonical paths decide, because a display
 *  path relative to an execution directory inside or above the directory loses the prefix relation. */
export function removedDirectoryGroups(entries: readonly MutationFilesEntry[], files: readonly { readonly path: string }[]): RemovedDirectoryGroups {
  const directories = entries.flatMap(entry => entry.kind === "removed_directory" ? [{ directory: entry, members: new Array<number>() }] : [])
  const ungrouped: number[] = []
  for (const [index, file] of files.entries()) {
    const group = directories.find(({ directory }) => file.path.startsWith(`${directory.path}/`) || file.path.startsWith(`${directory.path}\\`))
    if (group) group.members.push(index)
    else ungrouped.push(index)
  }
  return { directories, ungrouped }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Parses renderer-neutral rows from canonical unified diffs. */
export function parseMutationDiffRows(mutation: MutationDiff): MutationDiffRow[] {
  const rows: MutationDiffRow[] = []
  for (const file of mutation.files) {
    let oldLine: number | undefined
    let newLine: number | undefined
    for (const line of file.unifiedDiff.split("\n")) {
      const header = HUNK_HEADER.exec(line)
      if (header !== null) {
        oldLine = Number(header[1])
        newLine = Number(header[2])
        continue
      }
      if (oldLine === undefined || newLine === undefined) continue
      if (line.startsWith("+")) {
        rows.push({ path: file.path, kind: "add", text: line.slice(1), newLine })
        newLine += 1
      } else if (line.startsWith("-")) {
        rows.push({ path: file.path, kind: "remove", text: line.slice(1), oldLine })
        oldLine += 1
      } else if (line.startsWith(" ")) {
        rows.push({ path: file.path, kind: "context", text: line.slice(1), oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
    }
  }
  return rows
}

/** Preserves producer row identities and unknown coordinates without inventing line numbers. */
function parseProvisionalDiffRows(file: ProvisionalDiffFile) {
  const rows: FileDiffRow[] = []
  let omittedLines = 0
  for (const hunk of file.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    omittedLines += hunk.omittedBefore + hunk.omittedAfter
    for (const line of hunk.lines) {
      rows.push({
        ...line,
        ...(line.kind !== "add" && oldLine !== undefined ? { oldLine } : {}),
        ...(line.kind !== "remove" && newLine !== undefined ? { newLine } : {}),
      })
      if (line.kind !== "add" && oldLine !== undefined) oldLine += 1
      if (line.kind !== "remove" && newLine !== undefined) newLine += 1
    }
  }
  return { rows, omittedLines }
}

/** Derives independent sections from a proposal or one reader-owned page.
 * Missing bytes stay inside an actual section. This function never requests content. */
export function fileDiffFiles(
  body: FileChangeBody,
  expanded: boolean | ((file: { readonly id: string; readonly path?: string }) => boolean) = false,
  writes: FileWritePolicy = "none",
  evidenceView?: { readonly files: MutationFilesView; readonly patch?: MutationPatchView },
): FileDiffFile[] {
  if (body.kind === "net") {
    return body.diff.files.map(file => {
      const allRows = parseMutationDiffRows({ version: 1, files: [file], omissions: [] })
      const id = file.path
      const isExpanded = typeof expanded === "function" ? expanded({ id, path: file.path }) : expanded
      const selected = isExpanded ? allRows : allRows.slice(0, TOOL_PREVIEW_LINE_LIMIT)
      return {
        id, path: file.path,
        action: file.change === "added" ? "add" : file.change === "removed" ? "delete" : "update",
        presentation: "edit", expanded: isExpanded,
        rows: selected.map(({ path: _path, ...row }, index) => ({ ...row, id: `${id}:${index}`, partial: false })),
        omittedLines: allRows.length - selected.length + (file.omittedLines ?? 0),
        renderedLines: allRows.length, sourceOmittedLines: file.omittedLines ?? 0,
      }
    })
  }
  if (body.kind === "unavailable" || body.kind === "advisory") return []
  if (body.kind === "actual") {
    return evidenceView?.files.files.flatMap(entry => {
      if (entry.kind !== "applied" && entry.kind !== "display") return []
      const file = entry.file
      const patch = file.patch.kind === "retained" && evidenceView.patch?.reference.root === file.patch.reference.root
        && evidenceView.patch.reference.sha256 === file.patch.reference.sha256 && evidenceView.patch.reference.bytes === file.patch.reference.bytes
        ? evidenceView.patch : undefined
      const isExpanded = typeof expanded === "function" ? expanded({ id: file.path, path: file.displayPath }) : expanded
      // A collapsed file shows its page preview, so it has its final rows before any patch read.
      const text = isExpanded ? patch?.text : entry.preview
      const allRows = text === undefined ? [] : parseMutationDiffRows({ version: 1, files: [{ path: file.path, change: file.change, unifiedDiff: text }], omissions: [] })
      const selected = isExpanded ? allRows : allRows.slice(0, TOOL_PREVIEW_LINE_LIMIT)
      return [{
        id: file.path, path: file.displayPath,
        action: file.change === "added" ? "add" as const : file.change === "removed" ? "delete" as const : "update" as const,
        presentation: writes === "all" || (writes === "added" && file.change === "added") ? "write" as const : "edit" as const,
        rows: selected.map(({ path: _path, ...row }, index) => ({
          ...row, id: `${file.path}:${index}`,
          partial: isExpanded && patch !== undefined && !patch.complete && !patch.text.endsWith("\n") && index === allRows.length - 1,
        })),
        renderedLines: file.retainedLines, sourceOmittedLines: file.omittedLines,
        omittedLines: file.omittedLines + file.retainedLines - selected.length,
        expanded: isExpanded, evidence: file,
        evidenceStatus: file.patch.kind === "omitted" ? "omitted" as const : file.patch.kind === "unavailable" ? "unavailable" as const
          : isExpanded ? patch?.status ?? "idle" as const : entry.preview === undefined ? "idle" as const : "ready" as const,
        ...(file.patch.kind === "omitted" ? { omissionReason: file.patch.reason } : {}),
      }]
    }) ?? []
  }
  const files = body.proposedDiff.files.map((file) => ({ ...file, ...parseProvisionalDiffRows(file) }))
  return files.map((file) => {
    const isExpanded = typeof expanded === "function" ? expanded(file) : expanded
    const rows = isExpanded ? file.rows : file.rows.slice(0, TOOL_PREVIEW_LINE_LIMIT)
    return {
      id: file.id,
      ...(file.path !== undefined ? { path: file.path } : {}),
      action: file.action,
      presentation: writes === "all" ? "write" : "edit",
      ...("movePath" in file && file.movePath !== undefined ? { movePath: file.movePath } : {}),
      rows,
      renderedLines: file.rows.length,
      sourceOmittedLines: file.omittedLines,
      omittedLines: file.omittedLines + file.rows.length - rows.length,
      expanded: isExpanded,
    }
  })
}
