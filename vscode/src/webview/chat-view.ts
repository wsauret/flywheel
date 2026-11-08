import * as vscode from "vscode"

import type { ChangesReviewTarget, ClientCommand, ClientSummary } from "../../../src/protocol/client/host-contract.js"
import { statusPage, type PageActionId } from "./status-page.js"
import { PanelMount, type MountOwner, type MountView, type PanelContent } from "./panel-mount.js"

/** The chat panel's host.
 *
 *  The client runs inside the webview: it holds the runtime connection, the
 *  ordered intake, and every piece of session state. This class owns what
 *  the panel shows and the one Changes editor; each webview is a
 *  `PanelMount`, which pumps runtime bytes between it and the account-service
 *  socket and answers the client's requests for what only the editor can do.
 *  It keeps the summary the client publishes so the status bar and the diff
 *  review can paint from it. It reconciles nothing.
 *
 *  The client's bundle is the runtime's, not the extension's. The host asks
 *  the account service where it is and mounts the page from that directory
 *  with the bundle's identity written into it. The client offers that
 *  identity at every attach. When the runtime refuses it, the client prepares
 *  the successor, saves its input, then commits the prepared page.
 *
 *  The panel is the one place that says why there is no client. Until the
 *  runtime serves one it shows a status page, installing, starting, or
 *  unavailable, and it goes from that page to the client, and back, without
 *  a window reload. The Changes editor keeps its client through those pages;
 *  its client reconnects by itself, the way it does after any lost runtime. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** The panel lives in the secondary sidebar, beside the other agent panels,
   *  and falls back to the activity bar on VS Code older than 1.106, which has
   *  no `secondarySidebar` contribution point. Both ids are registered; the
   *  `when` clauses in the manifest decide which one is ever resolved. */
  public static readonly viewType = "flywheel.chat"
  public static readonly secondaryViewType = "flywheel.chatSecondary"
  public static readonly viewTypes = ["flywheel.chatSecondary", "flywheel.chat"] as const

  private chat: PanelMount | undefined
  /** The one Changes editor this panel opened, while it is open. */
  private reviewEditor: { readonly panel: vscode.WebviewPanel; readonly mount: PanelMount } | undefined
  /** Commands asked for while the client mounts. A person who opens the
   *  panel with a command, the first time in a window, gets that command once
   *  the client listens rather than a panel that ignored it. */
  private readonly pending: ClientCommand[] = []
  /** What the chat panel's current client last published. `show` replaces
   *  that client, so it ends the summary too. */
  private summary: ClientSummary | undefined
  private readonly summaryListeners = new Set<(summary: ClientSummary) => void>()
  private content: PanelContent
  private readonly owner: MountOwner

  constructor(
    onDiagnostic: (message: string) => void,
    onPageAction: (id: PageActionId) => void,
    options: { readonly content?: PanelContent } = {},
  ) {
    this.content = options.content ?? { kind: "page", page: statusPage({ kind: "starting" }) }
    this.owner = { content: () => this.content, onDiagnostic, onPageAction, openChanges: (target) => this.openChanges(target) }
  }

  resolveWebviewView(view: MountView): void {
    const mount = new PanelMount(view, {
      ...this.owner,
      onReady: () => { for (const command of this.pending.splice(0)) this.command(command) },
      onSummary: (summary) => {
        this.summary = summary
        for (const listener of this.summaryListeners) listener(summary)
      },
    })
    this.chat = mount
    view.onDidDispose(() => {
      mount.dispose()
      if (this.chat === mount) this.chat = undefined
    })
  }

  /** Puts `content` in the panel: a page at once, or a client mounted from
   *  the runtime it names. Commands held for a client go with a page. The
   *  Changes editor follows without a new page of its own. */
  show(content: PanelContent): void {
    this.content = content
    this.summary = undefined
    if (content.kind === "page") this.pending.length = 0
    this.chat?.render()
    this.reviewEditor?.mount.follow()
  }

  /** Mounts the client again when the account service had not named it, as
   *  after the service recovers. A client already mounted is left alone. */
  retryClient(): void {
    this.chat?.retryClient()
    this.reviewEditor?.mount.retryClient()
  }

  /** Opens shared client content over the existing webview transport, never a reconstructed document.
   *  One Changes editor serves every request: a second request shows it
   *  again with the new target, so the tab strip never fills with editors
   *  that have the same title. The session belongs to the project the panel
   *  serves now, whose client or catalog named it. */
  openChanges(target: ChangesReviewTarget): void {
    // Every caller reads a session from a client: a page has none to review.
    if (this.content.kind !== "client") return
    const review = { projectRoot: this.content.target.projectRoot, target }
    if (this.reviewEditor) {
      this.reviewEditor.mount.retarget(review)
      this.reviewEditor.panel.reveal()
    } else {
      const panel = vscode.window.createWebviewPanel("flywheel.changes", "Flywheel Changes", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })
      const record = { panel, mount: new PanelMount(panel, this.owner, review) }
      this.reviewEditor = record
      panel.onDidDispose(() => {
        record.mount.dispose()
        if (this.reviewEditor === record) this.reviewEditor = undefined
      })
    }
    // The setup checklist marks its review step from this, so a command that
    // found no chat to review does not mark it.
    void vscode.commands.executeCommand("setContext", "flywheel.reviewedChanges", true)
  }

  /** Every Changes command opens the same per-file review; only its confirmation can dispatch Undo.
   *  `flywheel.revertTurn` stays registered because keybindings and walkthroughs may still name it. */
  registerChangesCommands(pickSession: (title: string, run: (row: { readonly id: string; readonly title: string }) => Promise<void>) => Promise<void>): vscode.Disposable[] {
    const open = async (path?: unknown) => {
      const show = (sessionId: string) => this.openChanges({ sessionId, ...(typeof path === "string" ? { path } : {}) })
      if (this.latestSummary?.sessionId) show(this.latestSummary.sessionId)
      else await pickSession("Review changes in session", async row => { show(row.id) })
    }
    return [
      vscode.commands.registerCommand("flywheel.openAllChanges", () => open()),
      vscode.commands.registerCommand("flywheel.revertTurn", () => open()),
      vscode.commands.registerCommand("flywheel.openChangeDiff", (path: unknown) => open(path)),
      vscode.commands.registerCommand("flywheel.revertFile", (path: unknown) => open(path)),
    ]
  }

  /** Reveals the panel, creating it if it has never been opened.
   *
   *  `WebviewView.show` only exists once VS Code has resolved the view, so a
   *  command that relied on it did nothing at all until the user had already
   *  found the panel by hand. The `<viewId>.focus` command VS Code registers for
   *  every contributed view has no such precondition. */
  async reveal(): Promise<void> {
    // Only one of the two is contributed in any given window, so the other's
    // focus command does not exist. Trying both is cheaper than duplicating the
    // manifest's version gate here.
    for (const viewType of ChatViewProvider.viewTypes) {
      try {
        await vscode.commands.executeCommand(`${viewType}.focus`)
        return
      } catch {
        continue
      }
    }
  }

  /** Asks the client to do something with its own selection. A client that
   *  is still mounting gets it once it listens; a status page has no client,
   *  and the page itself is the answer. */
  command(command: ClientCommand): void {
    if (this.content.kind !== "client") return
    if (this.chat?.ready) this.chat.post({ type: "command", command })
    else this.pending.push(command)
  }

  /** Shows the panel, then asks the client for `command`. */
  revealCommand(command: ClientCommand): void {
    void this.reveal().then(() => this.command(command))
  }

  focusComposer(): void {
    this.revealCommand({ type: "focusComposer" })
  }

  insertText(text: string): void {
    this.revealCommand({ type: "insertText", text })
  }

  /** Whether a person can see the panel now. */
  get visible(): boolean {
    return this.chat?.visible === true
  }

  /** The last summary the current client published, or undefined before its first. */
  get latestSummary(): ClientSummary | undefined {
    return this.summary
  }

  onSummary(listener: (summary: ClientSummary) => void): vscode.Disposable {
    this.summaryListeners.add(listener)
    if (this.summary) listener(this.summary)
    return { dispose: () => this.summaryListeners.delete(listener) }
  }

  dispose(): void {
    this.reviewEditor?.panel.dispose()
    this.chat?.dispose()
    this.summaryListeners.clear()
  }
}
