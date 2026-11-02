import type { ChangesDiffState, ChangesSummaryState } from "./session-changes.js"
import type { SessionChangeFile, SessionChangesUndoResult } from "../session-changes-protocol-types.js"

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

/** The prompt offers the review only when its last known count is positive. */
export function sessionChangesPromptLabel(summary: ChangesSummaryState | undefined): string | undefined {
  const data = summary && "data" in summary ? summary.data : undefined
  return data && data.fileCount > 0 ? sessionChangesLabel(summary) : undefined
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

/** The agents a file header names: the launched sessions that changed the
 *  file, by the titles their own views show. The reviewed session's own
 *  changes name nobody, so a chat's own edits read as before. Past two
 *  names, the rest are counted. */
export function sessionChangeWritersLabel(file: Pick<SessionChangeFile, "writers">): string | undefined {
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

/** Match a host's relative target against canonical list paths on either platform. */
export function sessionChangeNamesPath(target: string, executionCwd: string, entryPath: string): boolean {
  const normalize = (path: string): string => {
    const segments: string[] = []
    for (const segment of path.split(/[\\/]+/)) {
      if (segment === "" || segment === ".") continue
      if (segment === "..") segments.pop()
      else segments.push(segment)
    }
    return segments.join("/")
  }
  return normalize(/^(?:[\\/]|[A-Za-z]:)/.test(target) ? target : `${executionCwd}/${target}`) === normalize(entryPath)
}

/** The one line shown under a header whose diff is not rendered. */
export function sessionChangeDiffStatusLine(diff: ChangesDiffState | undefined): string {
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
