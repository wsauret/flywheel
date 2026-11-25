import { listedSessionChangeFile, type ChangesDiffState, type ChangesSummaryState, type ChangesUndoState, type SessionChangesController, type SessionChangesSnapshot } from "./session-changes.js"
import type { SessionChangeFile, SessionChangesUndoResult } from "../../session/session-changes-protocol-types.js"

/** Whether a canonical file path is outside the project's Flywheel state directory.
 * Runtime callers resolve the state directory's physical identity before calling. */
export function isReviewableSessionFile(filePath: string, stateDirectory: string): boolean {
  const fold = (value: string) => /^[A-Za-z]:/.test(stateDirectory) ? value.toLowerCase() : value
  return fold(filePath) !== fold(stateDirectory) && pathInside(filePath, stateDirectory) === undefined
}

/** The changes label uses the last known count, never the request status. */
export function sessionChangesLabel(summary: ChangesSummaryState | undefined): string {
  const data = summary && "data" in summary ? summary.data : undefined
  return data ? `Changes (${data.fileCount}${data.unknownFileMutationGaps > 0 ? "+" : ""})` : "Changes"
}

/** The part of `filePath` under `root`, or undefined when the file is not
 *  inside it. Both paths are absolute paths from the runtime, so this compares
 *  text and never resolves anything. It keeps the path's own separators, and
 *  it compares a Windows drive path without case, as Windows does. A host
 *  opens only a file inside the session's directory, so this also says which
 *  changed files a client can offer to open. */
export function pathInside(filePath: string, root: string): string | undefined {
  const base = root.replace(/[\\/]+$/, "")
  const fold = (value: string): string => (/^[A-Za-z]:/.test(base) ? value.toLowerCase() : value)
  const inside = base !== ""
    && filePath.length > base.length + 1
    && /[\\/]/.test(filePath.charAt(base.length))
    && fold(filePath.slice(0, base.length)) === fold(base)
    && !/(^|[\\/])\.\.([\\/]|$)/.test(filePath.slice(base.length + 1))
  return inside ? filePath.slice(base.length + 1) : undefined
}

/** What the review shows for one file, as the controller's current snapshot
 *  leaves it. Every client draws a file's section from this one reading. */
export interface SessionChangeFileView {
  /** The file as the snapshot's list now holds it, else the row's own file. */
  readonly file: SessionChangeFile
  /** The path as the person knows it: relative to the root inside it. */
  readonly label: string
  /** The agents that changed the file; see `sessionChangeWritersLabel`. */
  readonly writers: string | undefined
  /** The file's net diff once it reads. */
  readonly diff: Extract<ChangesDiffState, { status: "ready" }> | undefined
  /** The one line shown in place of a diff that has not read. */
  readonly statusLine: string | undefined
  /** This file's Undo, while one is confirming, in flight, or settled. */
  readonly undo: ChangesUndoState | undefined
  /** The line under the header while this file's Undo is in flight or settled.
   *  A transport failure is an unknown outcome, never a refusal. */
  readonly undoLine: string | undefined
  readonly canUndo: boolean
  /** Whether the held confirmation of this file's Undo can be confirmed. */
  readonly canConfirmUndo: boolean
  readonly undoUnavailableReason: string | undefined
  readonly canSetViewed: boolean
  /** Whether this file's Viewed write is in flight. */
  readonly viewedSubmitting: boolean
  /** Why this file's last Viewed write did not land as asked. */
  readonly viewedMessage: string | undefined
}

/** Reads one file of the review from the controller and its snapshot, by
 *  the file id of the row's own `rowFile`. The work does not grow with the
 *  number of listed files. The result is a value: a client reads it again
 *  after each change. */
export function sessionChangeFileView(controller: Pick<SessionChangesController, "canUndo" | "canConfirmUndo" | "undoUnavailableReason" | "canSetViewed">, snapshot: SessionChangesSnapshot, rowFile: SessionChangeFile, root: string): SessionChangeFileView {
  const { fileId } = rowFile
  const file = listedSessionChangeFile(snapshot, fileId) ?? rowFile
  const diff = snapshot.diffs.get(fileId)
  const undo = snapshot.undo?.fileId === fileId ? snapshot.undo : undefined
  const viewed = snapshot.viewed?.fileId === fileId ? snapshot.viewed : undefined
  return {
    file,
    label: sessionChangePathLabel(file.path, root),
    writers: sessionChangeWritersLabel(file),
    diff: diff?.status === "ready" ? diff : undefined,
    statusLine: diff?.status === "ready" ? undefined : sessionChangeDiffStatusLine(diff),
    undo,
    undoLine: undo === undefined ? undefined : undoStateLine(undo),
    canUndo: controller.canUndo(fileId),
    canConfirmUndo: undo?.status === "confirming" && controller.canConfirmUndo(),
    undoUnavailableReason: controller.undoUnavailableReason(fileId),
    canSetViewed: controller.canSetViewed(fileId),
    viewedSubmitting: viewed?.status === "submitting",
    viewedMessage: viewed?.status === "refused" ? `Viewed refused: ${viewed.error}` : viewed?.status === "unknown" ? "Viewed outcome unknown; refreshing" : undefined,
  }
}

function undoStateLine(undo: ChangesUndoState): string | undefined {
  switch (undo.status) {
    case "confirming": return undefined
    case "submitting": return "Undoing..."
    case "unknown": return "Undo outcome unknown; refreshing"
    case "result": return undoResultLine(undo.result)
  }
}

/** The agents a file header names: the launched sessions that changed the
 *  file, by the titles their own views show. The reviewed session's own
 *  changes name nobody, so a chat's own edits read as before. Past two
 *  names, the rest are counted. */
function sessionChangeWritersLabel(file: Pick<SessionChangeFile, "writers">): string | undefined {
  const [first, second, ...rest] = file.writers.map(writer => writer.title)
  if (first === undefined) return undefined
  const named = second === undefined ? first : `${first}, ${second}`
  return rest.length === 0 ? `by ${named}` : `by ${named} +${rest.length}`
}

/** The path as the person knows it: relative to `root` inside it, unchanged elsewhere. */
export function sessionChangePathLabel(filePath: string, root: string): string {
  return pathInside(filePath, root) ?? filePath
}

/** One row of the review: a file, or the header of a removed folder. */
export type SessionChangesRow =
  | { readonly kind: "folder"; readonly key: string; readonly path: string; readonly files: number }
  | { readonly kind: "file"; readonly key: string; readonly file: SessionChangeFile }

/** The rows of a listed page in path order. The files under one removed folder follow its
 *  header and show only while `expanded` holds the header's key; a disclosure key of a file
 *  is its file id, which never collides with a folder key. */
export function sessionChangesRows(files: readonly SessionChangeFile[], expanded: ReadonlySet<string>): readonly SessionChangesRow[] {
  const rows: SessionChangesRow[] = []
  let previous: string | undefined
  for (const file of files) {
    const folder = file.folder
    const key = folder && `folder:${folder.path}`
    if (folder && key !== previous) rows.push({ kind: "folder", key: `folder:${folder.path}`, path: folder.path, files: folder.files })
    previous = key
    if (key === undefined || expanded.has(key)) rows.push({ kind: "file", key: file.fileId, file })
  }
  return rows
}

/** A removed folder's header: `d/sub/ (454 files)`. */
export function sessionChangeFolderLabel(row: Extract<SessionChangesRow, { kind: "folder" }>, root: string): string {
  return `${sessionChangePathLabel(row.path, root)}/ (${row.files} file${row.files === 1 ? "" : "s"})`
}

/** The one line shown under a header whose diff is not rendered. */
function sessionChangeDiffStatusLine(diff: ChangesDiffState | undefined): string {
  if (diff === undefined || diff.status === "loading") return "Loading..."
  if (diff.status === "error") return `Diff unavailable: ${diff.error}`
  if (diff.status === "unavailable" && diff.reason === "evidence") return "Change evidence is unavailable; Undo unavailable"
  if (diff.status === "unavailable" && diff.reason === "drifted") return "Changed outside this session since its last recorded write; Undo unavailable"
  return "Diff not retained; Undo unavailable"
}

/** `refused` wrote nothing; `uncertain` may have written and is never retried. */
export function undoResultLine(result: SessionChangesUndoResult): string {
  if (result.status === "completed") return "Undo completed"
  return `Undo ${result.status}: ${result.message}`
}
