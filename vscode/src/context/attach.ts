import * as vscode from "vscode"

import { describeDiagnostics, relativePath } from "./editor-context.js"

/** Pickers for attaching context by hand, in VS Code's own quick pick so
 *  that attaching context feels native in the editor. The file picker is in
 *  `file-picker.ts`. */

/** Symbols, for pointing at a function rather than a file. */
export async function pickSymbol(): Promise<string | undefined> {
  const query = await vscode.window.showInputBox({
    title: "Add a symbol to the Flywheel message",
    prompt: "Search workspace symbols",
    placeHolder: "Type part of a name",
  })
  if (!query) return undefined

  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query,
  )
  if (!symbols || symbols.length === 0) {
    void vscode.window.showInformationMessage(`Flywheel: no symbols matched "${query}".`)
    return undefined
  }

  const items = symbols.slice(0, 200).map((symbol) => ({
    label: `$(symbol-${vscode.SymbolKind[symbol.kind]?.toLowerCase() ?? "misc"}) ${symbol.name}`,
    description: `${relativePath(symbol.location.uri)}:${symbol.location.range.start.line + 1}`,
    symbol,
  }))

  const picked = await vscode.window.showQuickPick(items, { title: "Add a symbol", matchOnDescription: true })
  if (!picked) return undefined
  return `${picked.symbol.name} (${relativePath(picked.symbol.location.uri)}:${picked.symbol.location.range.start.line + 1})`
}

/** The problems the language server is reporting, so a turn can start from the
 *  errors rather than from a description of them. */
export async function pickProblems(): Promise<string | undefined> {
  const withProblems = vscode.languages.getDiagnostics()
    .filter(([, diagnostics]) => diagnostics.some((entry) => entry.severity <= vscode.DiagnosticSeverity.Warning))

  if (withProblems.length === 0) {
    void vscode.window.showInformationMessage("Flywheel: no errors or warnings reported.")
    return undefined
  }

  const items = withProblems.map(([uri, diagnostics]) => {
    const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length
    const warnings = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length
    return {
      label: `$(${errors > 0 ? "error" : "warning"}) ${relativePath(uri)}`,
      description: [errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""].filter(Boolean).join(", "),
      uri,
    }
  }).toSorted((left, right) => left.label.localeCompare(right.label))

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Add problems to the Flywheel message",
  })
  if (!picked || picked.length === 0) return undefined

  return picked
    .map((item) => describeDiagnostics(item.uri))
    .filter((text): text is string => text !== undefined)
    .join("\n\n")
}
