import type { ToolEntry, ToolPresentation } from "../../infra/output-blocks.js"
import type { ToolAction } from "../../infra/workflow-types.js"
import type { FrontendToolEntry } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import { isShellMutationEntry } from "./file-change-body.js"

/** The one rule for which tool calls fold into a run, and which reads merge
 *  into one row, so the terminal and the web client group a transcript the
 *  same way. The terminal reads a tool's action from the display registry it
 *  shares a process with; the web client reads the action the runtime put on
 *  the wire. Both hand it here. */

export type ToolRunCategory = "explore" | "exec" | "execute"

/** The group of one call, decided by the display action on its row (each
 *  tool's `action` in the tool display registry), in this order:
 *
 *  | Row                                       | Group   | Heading  |
 *  |-------------------------------------------|---------|----------|
 *  | inside a `code` script, or `code` itself  | execute | Executed |
 *  | shell call that declares mutations            | none    | own row  |
 *  | `shell_exec`, `ui_meta` (bookkeeping)     | exec    | Ran      |
 *  | `file_read`, `list`, `search`             | explore | Explored |
 *  | any other action                          | none    | own row  |
 *
 *  Any other action is an edit, a write, a handoff, Ask User, a benchmark,
 *  or a subagent steer or resume. A subagent dispatch and a workflow call
 *  never reach here: they project as agent blocks first. A row with no
 *  action, from a runtime older than its client, is a row of its own. */
export function toolRunCategoryFor(tool: {
  readonly name: string
  readonly action?: ToolAction | undefined
  readonly runCategoryOverride?: "execute" | undefined
  readonly declaresMutation?: FrontendToolEntry["declaresMutation"]
}): ToolRunCategory | null {
  if (tool.runCategoryOverride) return tool.runCategoryOverride
  // The code tool folds as an execute carrier in every path, including the
  // window-predecessor seed, which passes the raw block without an override.
  if (tool.name === "code") return "execute"
  // A shell command that declares mutations is an edit from the moment that
  // declaration streams, and edits stand alone: it never joins a run.
  if (isShellMutationEntry(tool)) return null
  if (tool.action === "shell_exec" || tool.action === "ui_meta") return "exec"
  if (tool.action === "file_read" || tool.action === "list" || tool.action === "search") return "explore"
  return null
}

/** A read that names something can merge with its neighbours. An eager read
 *  also merges before its name arrives so the existing row grows in place.
 *  Completed argument-less rows have nothing to fold. */
export function mergeableRead(tool: {
  readonly action?: ToolAction | undefined
  readonly presentation: ToolPresentation
  readonly status: ToolEntry["status"]
}): boolean {
  return tool.action === "file_read" && (tool.presentation.detail !== "" || tool.status === "streaming")
}

/** A file-linked row abbreviates to its basename; a row that names a resource
 *  (skill ids, `skill_id/path`) carries no link and keeps its identifier whole. */
export function readRowLabel(tool: { readonly presentation: ToolPresentation; readonly linkUri?: string | undefined }): string {
  const detail = tool.presentation.detail
  return tool.linkUri ? detail.slice(detail.lastIndexOf("/") + 1) : detail
}

/** The absolute path of the file a read row read, from the file link the
 *  runtime put on it, so a client can open that file. A read that names a
 *  resource, such as a skill, carries no file link and has no path. */
export function readRowPath(tool: { readonly action?: ToolAction | undefined; readonly linkUri?: string | undefined }): string | undefined {
  if (tool.action !== "file_read" || tool.linkUri?.startsWith("file:") !== true) return undefined
  const path = decodeURIComponent(new URL(tool.linkUri).pathname)
  // A Windows file URL keeps a slash before its drive letter.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

/** Two or more consecutive reads by one tool, shown as one row that names
 *  each thing read, so a transcript that read twelve files in a row is one
 *  line of file names and not twelve rows of "Read". A repeated file with
 *  different ranges shows each range, which is why the agent read it twice. */
export interface ReadRun {
  readonly kind: "readRun"
  /** The first member's identity, so a single read and the run it grows into
   *  are one row for the life of the transcript. */
  readonly id: string
  readonly presentation: { readonly name: string; readonly detail: string }
  /** Active while a member still runs; the first member's error otherwise
   *  wins, then an interruption, then completed. */
  readonly status: "active" | "error" | "interrupted" | "completed"
  readonly errorMessage?: string
  readonly members: readonly FrontendToolEntry[]
}

export type RunRow = FrontendToolEntry | ReadRun

/** The one fold of consecutive reads into rows, shared by every client. */
export function foldReadRuns<Entry extends FrontendToolEntry>(children: readonly Entry[]): (Entry | ReadRun)[] {
  const rows: (Entry | ReadRun)[] = []
  for (let index = 0; index < children.length;) {
    const first = children[index]
    if (first === undefined) break
    if (!mergeableRead(first)) {
      rows.push(first)
      index += 1
      continue
    }
    const members: FrontendToolEntry[] = []
    for (let cursor = index; cursor < children.length; cursor += 1) {
      const candidate = children[cursor]
      if (candidate === undefined || !mergeableRead(candidate) || candidate.presentation.name !== first.presentation.name) break
      members.push(candidate)
    }
    index += members.length
    if (members.length === 1) {
      rows.push(first)
      continue
    }
    const failed = members.find((member) => member.status === "error")
    const status = members.some((member) => member.status === "pending" || member.status === "streaming")
      ? "active"
      : failed !== undefined ? "error" : members.some((member) => member.status === "interrupted") ? "interrupted" : "completed"
    rows.push({
      kind: "readRun",
      id: blockIdentity(first),
      presentation: { name: first.presentation.name, detail: members.map(readRowLabel).join(", ") },
      status,
      ...(failed?.status === "error" ? { errorMessage: failed.errorMessage } : {}),
      members,
    })
  }
  return rows
}
