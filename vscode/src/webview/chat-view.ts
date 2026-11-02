import { randomBytes } from "node:crypto"
import * as vscode from "vscode"

import type { ClientBundle } from "../../../src/protocol/account-attach.js"
import type { CapabilityRequest, HostMessage, ViewMessage } from "../../../src/protocol/client/editor-host.js"
import { HOST_CONTRACT_VERSION, type ChangesReviewTarget, type ClientCommand, type ClientSummary } from "../../../src/protocol/client/host-contract.js"
import { resolveContainedPath } from "../runtime/contained-path.js"
import { resolveEditorClient } from "../runtime/editor-client.js"
import type { RuntimeSocketTarget } from "../runtime/node-socket.js"
import { SocketBridge } from "./socket-bridge.js"
import { statusPage, statusPageHtml, type PageActionId, type StatusPage } from "./status-page.js"

/** What the panel holds: a status page while there is no runtime to serve a
 *  client, or the client of the runtime at `target`. */
export type PanelContent =
  | { readonly kind: "page"; readonly page: StatusPage }
  | { readonly kind: "client"; readonly target: RuntimeSocketTarget; readonly ensureRuntime: () => Promise<void> }

/** What a status page posts when a person chooses one of its actions. */
type PageMessage = { readonly type: "pageAction"; readonly id: PageActionId }

/** The chat panel's host.
 *
 *  The client runs inside the webview: it holds the runtime connection, the
 *  ordered intake, and every piece of session state. This class owns the
 *  webview itself, pumps runtime bytes between it and the account-service
 *  socket, answers the client's requests for what only the editor can do, and
 *  keeps the summary the client publishes so the status bar and the diff
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
 *  a window reload. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** The panel lives in the secondary sidebar, beside the other agent panels,
   *  and falls back to the activity bar on VS Code older than 1.106, which has
   *  no `secondarySidebar` contribution point. Both ids are registered; the
   *  `when` clauses in the manifest decide which one is ever resolved. */
  public static readonly viewType = "flywheel.chat"
  public static readonly secondaryViewType = "flywheel.chatSecondary"
  public static readonly viewTypes = ["flywheel.chatSecondary", "flywheel.chat"] as const

  private view: Pick<vscode.WebviewView, "webview" | "onDidDispose" | "visible"> | undefined
  /** The one Changes editor this panel opened, while it is open. */
  private reviewEditor: { readonly panel: vscode.WebviewPanel; readonly host: ChatViewProvider } | undefined
  private bridge: SocketBridge | undefined
  /** The bundle the current page was mounted from, once one is. */
  private bundle: ClientBundle | undefined
  /** Counts every page mount, so a resolution that finishes after the view
   *  moved on, to a newer mount or to disposal, sets nothing. */
  private mount = 0
  private prepared: { readonly generation: number; readonly transactionId: number; readonly bundle: ClientBundle } | undefined
  private readonly disposables: vscode.Disposable[] = []
  /** Set once the client has mounted. Commands posted before that would land
   *  on a page with nothing listening. */
  private ready = false
  /** Commands asked for while the client mounts. A person who opens the
   *  panel with a command, the first time in a window, gets that command once
   *  the client listens rather than a panel that ignored it. */
  private readonly pending: ClientCommand[] = []
  /** Set when the account service did not name its client, so a recovered
   *  service can mount it again. */
  private clientFailed = false
  private summary: ClientSummary | undefined
  private readonly summaryListeners = new Set<(summary: ClientSummary) => void>()

  private review: ChangesReviewTarget | undefined
  private content: PanelContent

  constructor(
    private readonly onDiagnostic: (message: string) => void,
    private readonly onPageAction: (id: PageActionId) => void,
    options: { readonly review?: ChangesReviewTarget; readonly content?: PanelContent } = {},
  ) {
    this.review = options.review
    this.content = options.content ?? { kind: "page", page: statusPage({ kind: "starting" }) }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.mountView(view)
  }

  private mountView(view: Pick<vscode.WebviewView, "webview" | "onDidDispose" | "visible">): void {
    this.view = view
    view.webview.onDidReceiveMessage((message: ViewMessage | PageMessage) => {
      void this.onMessage(message).catch((cause: unknown) => {
        this.onDiagnostic(`chat view message failed: ${describe(cause)}`)
      })
    }, undefined, this.disposables)
    view.onDidDispose(() => {
      this.mount++
      this.bridge?.dispose()
      this.bridge = undefined
      this.view = undefined
      this.ready = false
    }, undefined, this.disposables)
    this.render(view)
  }

  /** Puts `content` in the panel: a page at once, or a client mounted from
   *  the runtime it names. Commands held for a client go with a page. */
  show(content: PanelContent): void {
    this.content = content
    if (content.kind === "page") this.pending.length = 0
    if (this.view) this.render(this.view)
  }

  /** Mounts the client again when the account service had not named it, as
   *  after the service recovers. A client already mounted is left alone. */
  retryClient(): void {
    if (this.clientFailed && this.view && this.content.kind === "client") void this.serve(this.view)
  }

  private render(view: Pick<vscode.WebviewView, "webview">): void {
    if (this.content.kind === "client") {
      void this.serve(view)
      return
    }
    this.showPage(view, this.content.page)
  }

  private showPage(view: Pick<vscode.WebviewView, "webview">, page: StatusPage): void {
    this.mount++
    this.prepared = undefined
    this.ready = false
    this.bundle = undefined
    this.bridge?.dispose()
    this.bridge = undefined
    view.webview.options = { enableScripts: true }
    view.webview.html = statusPageHtml(page, randomBytes(16).toString("base64"))
  }

  /** Mounts the runtime's client in `view`: a loading page first, then the
   *  page whose script and stylesheet the runtime names. Version-1 clients
   *  also use this transition when their bundle is refused.
   *  A failure to learn the bundle shows the status page for it, which the
   *  next `retryClient` replaces. */
  private async serve(view: Pick<vscode.WebviewView, "webview">): Promise<void> {
    if (this.content.kind !== "client") return
    const content = this.content
    this.showPage(view, { ...statusPage({ kind: "starting" }), body: "Loading the Flywheel client." })
    const mount = this.mount
    this.clientFailed = false
    let bundle: ClientBundle
    try {
      bundle = await resolveEditorClient(content.target)
    } catch (cause) {
      if (mount !== this.mount) return
      const detail = describe(cause)
      this.onDiagnostic(`client unavailable: ${detail}`)
      this.showPage(view, statusPage({ kind: "unavailable", failure: { kind: "client", detail } }))
      this.clientFailed = true
      return
    }
    if (mount !== this.mount) return
    this.bundle = bundle
    this.bridge = new SocketBridge(content.target, (message) => this.post(message))
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(bundle.dir)] }
    view.webview.html = this.clientHtml(view.webview, bundle)
  }

  /** Opens shared client content over the existing webview transport, never a reconstructed document.
   *  One Changes editor serves every request: a second request shows it
   *  again with the new target, so the tab strip never fills with editors
   *  that have the same title. */
  openChanges(target: ChangesReviewTarget): void {
    if (this.reviewEditor) {
      this.reviewEditor.host.retarget(target)
      this.reviewEditor.panel.reveal()
    } else {
      const panel = vscode.window.createWebviewPanel("flywheel.changes", "Flywheel Changes", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })
      const host = new ChatViewProvider(this.onDiagnostic, this.onPageAction, { review: target, content: this.content })
      this.reviewEditor = { panel, host }
      host.mountView(panel)
      panel.onDidDispose(() => { host.dispose(); this.reviewEditor = undefined })
    }
    // The setup checklist marks its review step from this, so a command that
    // found no chat to review does not mark it.
    void vscode.commands.executeCommand("setContext", "flywheel.reviewedChanges", true)
  }

  /** Points this Changes editor at `target`. The client reads its target
   *  once, at mount, so a new target mounts the client again; the same
   *  target keeps the page as it is. */
  private retarget(target: ChangesReviewTarget): void {
    if (this.review?.sessionId === target.sessionId && this.review.path === target.path) return
    this.review = target
    if (this.view) this.render(this.view)
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
    if (this.ready) this.post({ type: "command", command })
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
    return this.view?.visible === true
  }

  /** The last summary the client published, or undefined before the first. */
  get latestSummary(): ClientSummary | undefined {
    return this.summary
  }

  onSummary(listener: (summary: ClientSummary) => void): vscode.Disposable {
    this.summaryListeners.add(listener)
    if (this.summary) listener(this.summary)
    return { dispose: () => this.summaryListeners.delete(listener) }
  }

  private async onMessage(message: ViewMessage | PageMessage): Promise<void> {
    if (message.type === "pageAction") {
      this.onPageAction(message.id)
      return
    }
    if (this.bridge?.handle(message)) return
    switch (message.type) {
      case "ready": {
        // A page opens its channels only after this answer, so a channel
        // still open belongs to a page that a webview reload replaced without
        // disposing the view. Its socket holds a runtime stream nobody reads,
        // and its id would refuse the same id from the new page.
        this.bridge?.closeAll()
        // The client mounts only after it knows which commands this editor
        // carries, so it can hide a row for one it does not.
        const ids = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith("flywheel."))
        this.post({ type: "hostCommands", ids, ...(this.review === undefined ? {} : { review: this.review }) })
        this.ready = true
        if (this.bundle) this.onDiagnostic(`client served from ${this.bundle.dir} (${this.bundle.identity})`)
        for (const command of this.pending.splice(0)) this.command(command)
        return
      }
      case "capability": {
        try {
          await this.runCapability(message.request)
          this.post({ type: "capability.result", requestId: message.requestId, ok: true })
        } catch (cause) {
          this.post({ type: "capability.result", requestId: message.requestId, ok: false, error: describe(cause) })
        }
        return
      }
      case "summary":
        this.summary = message.summary
        for (const listener of this.summaryListeners) listener(message.summary)
        return
      case "socket.open":
      case "socket.data":
      case "socket.close":
        // A socket message with no bridge: the view is being torn down.
        return
    }
  }

  private async runCapability(request: CapabilityRequest): Promise<void> {
    switch (request.name) {
      case "openChanges":
        this.openChanges(request.target)
        return
      case "reload":
        // Version-1 clients remain reachable from older resident runtimes.
        // Remove this transition after 2027-01-19 with its protocol variant.
        if (this.view) await this.serve(this.view)
        return
      case "prepareReload": {
        if (!this.view || this.content.kind !== "client" || request.generation !== this.mount) throw new Error("The Flywheel page changed before replacement preparation.")
        this.prepared = undefined
        const bundle = await resolveEditorClient(this.content.target)
        if (!this.view || request.generation !== this.mount) throw new Error("The Flywheel page changed during replacement preparation.")
        this.prepared = { generation: request.generation, transactionId: request.transactionId, bundle }
        return
      }
      case "commitReload": {
        const prepared = this.prepared
        if (!this.view || this.content.kind !== "client" || prepared === undefined || request.generation !== this.mount || prepared.generation !== request.generation || prepared.transactionId !== request.transactionId) throw new Error("The prepared Flywheel replacement is no longer current.")
        const html = this.clientHtml(this.view.webview, prepared.bundle, this.mount + 1)
        this.view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(prepared.bundle.dir)] }
        this.view.webview.html = html
        this.mount++
        this.prepared = undefined
        this.ready = false
        this.bridge?.dispose()
        this.bundle = prepared.bundle
        this.bridge = new SocketBridge(this.content.target, (message) => this.post(message))
        return
      }
      case "ensureRuntime":
        if (this.content.kind === "client") await this.content.ensureRuntime()
        return
      case "openFile": {
        // The path arrives from a webview rendering model output, so it is
        // contained before it reaches the filesystem: a `..` path would
        // otherwise open a file outside the workspace, and an absolute one
        // would be silently reinterpreted as relative and open a real file
        // other than the one the transcript named.
        // The refusal is the request's result, and the client says it once in
        // its own notice, so the host shows no toast of its own.
        const resolved = resolveContainedPath(request.executionCwd, request.path)
        if (resolved === undefined) throw new Error(`Flywheel opens only files inside this chat's folder, and ${request.path} is outside it. Open the file from the Explorer or your file manager.`)
        await vscode.window.showTextDocument(vscode.Uri.file(resolved), { preview: true })
        return
      }
      case "openExternal":
        await vscode.env.openExternal(vscode.Uri.parse(request.url))
        return
      case "writeClipboardText":
        await vscode.env.clipboard.writeText(request.text)
        return
      case "runCommand": {
        // The id comes from the runtime's own notice or the client's command
        // panel, but it arrives here by way of a webview, so it is checked
        // against the commands this editor actually has rather than executed
        // on trust.
        if (!(await vscode.commands.getCommands(true)).includes(request.id)) {
          void vscode.window.showWarningMessage(`Flywheel asked for an action this editor does not have: ${request.id}`)
          throw new Error(`unknown command ${request.id}`)
        }
        await vscode.commands.executeCommand(request.id, ...request.args)
        return
      }
    }
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message)
  }

  dispose(): void {
    this.mount++
    this.reviewEditor?.panel.dispose()
    this.bridge?.dispose()
    for (const disposable of this.disposables) disposable.dispose()
    this.summaryListeners.clear()
  }

  /** The client page. Its script and stylesheet come from the runtime's build
   *  directory. The root carries the bundle's identity, which the client
   *  offers at every attach, and the host contract version this extension was
   *  built for, so a client that needs a newer host shows a notice instead of
   *  mounting. */
  private clientHtml(webview: vscode.Webview, bundle: ClientBundle, generation = this.mount): string {
    const dir = vscode.Uri.file(bundle.dir)
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dir, "webview.js"))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(dir, "webview.css"))
    // A nonce rather than a blanket allowance: the transcript renders model
    // output and tool results, which is untrusted text by construction.
    const nonce = randomBytes(16).toString("base64")
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<link href="${styles}" rel="stylesheet">
<title>Flywheel</title>
</head>
<body>
<div id="root" data-client-identity="${bundle.identity}" data-host-contract="${HOST_CONTRACT_VERSION}" data-page-generation="${generation}" data-input-scope="${this.content.kind === "client" ? Buffer.from(this.content.target.projectRoot).toString("base64url") : ""}"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
