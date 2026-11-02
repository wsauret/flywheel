import * as vscode from "vscode"

/** Turns what the editor knows into text the agent can act on.
 *
 *  The agent already has file tools, so this does not ship file contents it
 *  could read itself. What it ships is the part the agent cannot know: which
 *  file is open, what the user has selected, and what the language server is
 *  complaining about right now. A path and a line range is usually more useful
 *  than a paste, because it stays true while the agent edits.
 *
 *  Everything here is bounded. A selection can be an entire file and a project
 *  can have thousands of diagnostics, and a turn that spends its context window
 *  on an accidental select-all has been made worse, not better. */

/** Past this a selection is referenced rather than quoted. Roughly the size
 *  where a reader stops reading the paste and goes to the file. */
const MAX_QUOTED_LINES = 120
const MAX_DIAGNOSTICS = 20

export function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false)
}

function fence(language: string, body: string): string {
  // A body containing its own fence would end the block early and the rest
  // would render as prose. Use a longer fence than anything inside it.
  const longest = [...body.matchAll(/^`{3,}/gm)].reduce((max, m) => Math.max(max, m[0].length), 2)
  const rail = "`".repeat(Math.max(3, longest + 1))
  return `${rail}${language}\n${body}\n${rail}`
}

export function describeSelection(editor: vscode.TextEditor): string {
  const path = relativePath(editor.document.uri)
  const start = editor.selection.start.line + 1
  const end = editor.selection.end.line + 1
  const range = start === end ? `${start}` : `${start}-${end}`
  const body = editor.document.getText(editor.selection)
  const lines = body.split("\n")

  if (lines.length > MAX_QUOTED_LINES) {
    // Naming it beats pasting it: the agent can read the range itself, and a
    // huge paste crowds out the rest of the turn.
    return `${path}:${range} (${lines.length} lines selected)`
  }
  return `${path}:${range}\n${fence(editor.document.languageId, body)}`
}

/** What the language server is reporting for a file, worst first. */
export function describeDiagnostics(uri: vscode.Uri): string | undefined {
  const diagnostics = vscode.languages.getDiagnostics(uri)
    .filter((entry) => entry.severity <= vscode.DiagnosticSeverity.Warning)
    .toSorted((left, right) => left.severity - right.severity || left.range.start.line - right.range.start.line)
  if (diagnostics.length === 0) return undefined

  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS)
  const lines = shown.map((entry) => {
    const line = entry.range.start.line + 1
    const severity = entry.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"
    const source = entry.source ? `${entry.source}: ` : ""
    return `  ${severity} line ${line}: ${source}${entry.message.split("\n")[0]}`
  })
  const more = diagnostics.length > shown.length ? `\n  ...and ${diagnostics.length - shown.length} more` : ""
  return `Problems in ${relativePath(uri)}:\n${lines.join("\n")}${more}`
}

/** One diagnostic, with the code it is pointing at. */
export function describeProblem(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): string {
  const path = relativePath(document.uri)
  const line = diagnostic.range.start.line + 1
  // A couple of lines either side, because a diagnostic on its own rarely says
  // enough to act on.
  const from = Math.max(0, diagnostic.range.start.line - 3)
  const to = Math.min(document.lineCount - 1, diagnostic.range.end.line + 3)
  const body = document.getText(new vscode.Range(from, 0, to, document.lineAt(to).text.length))
  const source = diagnostic.source ? `${diagnostic.source}: ` : ""
  return [
    `Fix this problem in ${path}:${line}`,
    "",
    `${source}${diagnostic.message}`,
    "",
    `${path}:${from + 1}-${to + 1}`,
    fence(document.languageId, body),
  ].join("\n")
}

