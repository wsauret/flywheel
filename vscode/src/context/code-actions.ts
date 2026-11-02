import * as vscode from "vscode"

/** Offers Flywheel from the lightbulb, on the problem the user is already
 *  looking at.
 *
 *  This is the shortest path there is between noticing something wrong and
 *  asking for it to be fixed: no panel, no copy, no describing the error in
 *  prose. The action carries the diagnostic and its surrounding lines, so the
 *  turn starts from the actual failure rather than from a paraphrase of it. */
export class FlywheelCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite]

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = []

    // One action per real problem, named after it, because "Fix with Flywheel"
    // repeated four times tells the user nothing about which is which.
    for (const diagnostic of context.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)) {
      const action = new vscode.CodeAction(
        `Flywheel: fix "${truncate(diagnostic.message)}"`,
        vscode.CodeActionKind.QuickFix,
      )
      action.diagnostics = [diagnostic]
      action.command = {
        command: "flywheel.fixProblem",
        title: "Fix with Flywheel",
        arguments: [document.uri, diagnostic],
      }
      actions.push(action)
    }

    if (!range.isEmpty) {
      const explain = new vscode.CodeAction("Flywheel: explain this", vscode.CodeActionKind.RefactorRewrite)
      explain.command = { command: "flywheel.explainSelection", title: "Explain", arguments: [] }
      actions.push(explain)
    }

    return actions
  }
}

function truncate(message: string): string {
  const line = message.split("\n")[0] ?? message
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}
