import type { ToolAction } from "@infra/workflow-types.js"
import { fg as stFg, type TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { UNDERLINE } from "@tui/utils/text-attributes.js"
import { highlightShellCommand } from "./shell-command-highlight.js"

// Per-action styling for the tool-row detail string. Keeps the two-tone
// look: the verb (Read/List/Search) is colored by the row component, and the
// detail here stays plain text — only the search/list scope connective (" in ")
// is dimmed. shell_exec is the exception: its detail is a raw command line, so
// it delegates to the shell tokenizer.

// Files where the basename is the point: show just the filename (with any
// trailing line-range suffix like `:1-20`), dropping the directory the way
// the detail renderer does for Read.
const FILE_ACTIONS = new Set<ToolAction>([
  "file_read",
  "file_write",
  "file_edit",
  "handoff_write",
])

/** Abbreviate a workspace file path to its basename (plus any `:1-20` range
 *  suffix). Only a row that links to the file abbreviates: the directory stays
 *  reachable through the link. A row whose detail names a resource instead of a
 *  file (a skill id, `skill_id/path`) carries no link and keeps it whole. */
function abbreviateLinkedPath(detail: string, linkUri: string | undefined): string {
  return linkUri ? detail.slice(detail.lastIndexOf("/") + 1) : detail
}

// search/list detail is `"pattern" in dir [filter]`: plain text throughout,
// with just the " in " connective dimmed so the scope reads as secondary.
function highlightScoped(detail: string, theme: TuiTheme): TextChunk[] {
  const match = /^(.*?)( in )(.*)$/.exec(detail)
  const [, pattern, connective, scope] = match ?? []
  // The three groups are non-optional in the pattern, so a successful match
  // always yields all three; guarding on `connective` narrows them to string.
  if (connective === undefined || pattern === undefined || scope === undefined) {
    return [stFg(theme.text)(detail)]
  }
  return [
    stFg(theme.text)(pattern),
    stFg(theme.textMuted)(connective),
    stFg(theme.text)(scope),
  ]
}

// A nested Code Mode call's detail is `[key=value, ...]` built by
// nestedExecutePresentation, not a shell command line: values may contain
// spaces, so token-based shell highlighting breaks mid-value. Color the keys
// as the accent and keep values plain; brackets, equals, and separators are
// muted structure. The display string carries no quoting, so a value that
// itself contains `, key=` text is ambiguous; the split heuristic below can
// mis-accent such a value. Accepted: the cost is one wrongly colored word in
// a summary row, and disambiguating would mean carrying structured segments
// through the presentation wire schema.
export function highlightExecuteInputs(detail: string, theme: TuiTheme): TextChunk[] {
  const match = /^\[(.*)\]$/.exec(detail)
  const inner = match?.[1]
  if (inner === undefined) return [stFg(theme.text)(detail)]
  const chunks: TextChunk[] = [stFg(theme.textMuted)("[")]
  // Split only before the next `key=`; a comma inside a value stays in it.
  const pairs = inner.split(/, (?=[A-Za-z_$][\w$]*=)/)
  for (const [idx, pair] of pairs.entries()) {
    if (idx > 0) chunks.push(stFg(theme.textMuted)(", "))
    const eq = pair.indexOf("=")
    if (eq === -1) {
      chunks.push(stFg(theme.text)(pair))
      continue
    }
    chunks.push(stFg(theme.chatCodeFunction)(pair.slice(0, eq)))
    chunks.push(stFg(theme.textMuted)("="))
    chunks.push(stFg(theme.text)(pair.slice(eq + 1)))
  }
  chunks.push(stFg(theme.textMuted)("]"))
  return chunks
}

export function highlightToolDetail(action: ToolAction, detail: string, theme: TuiTheme, linkUri?: string): TextChunk[] {
  if (action === "shell_exec") return highlightShellCommand(detail, theme)
  if (action === "search" || action === "list") return highlightScoped(detail, theme)
  if (FILE_ACTIONS.has(action)) return [stFg(theme.text)(abbreviateLinkedPath(detail, linkUri))]
  return [stFg(theme.text)(detail)]
}

// Make every chunk part of a single OSC 8 hyperlink and underline it, so a
// multi-chunk highlighted path stays clickable as one navigable unit.
export function linkifyChunks(chunks: TextChunk[], url: string): TextChunk[] {
  return chunks.map((c) => ({
    ...c,
    link: { url },
    attributes: (c.attributes ?? 0) | UNDERLINE,
  }))
}
