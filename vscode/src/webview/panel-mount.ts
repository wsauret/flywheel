import { randomBytes } from "node:crypto"
import * as vscode from "vscode"

import type { ClientBundle } from "../../../src/protocol/account-attach.js"
import type { CapabilityRequest, HostMessage, ViewMessage } from "../../../src/protocol/client/editor-host.js"
import { HOST_CONTRACT_VERSION, type ChangesReviewTarget, type ClientSummary } from "../../../src/protocol/client/host-contract.js"
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

export type MountView = Pick<vscode.WebviewView, "webview" | "onDidDispose" | "visible">

/** The session a Changes editor reviews and the project that session belongs
 *  to. They are written together, from the client that named the session, so
 *  a review never pairs one project's session with another project. */
export interface Review {
  readonly projectRoot: string
  readonly target: ChangesReviewTarget
}

/** What a mount reads from and reports to the panel that owns it. */
export interface MountOwner {
  /** The panel's one content. A mount keeps no copy of it. */
  readonly content: () => PanelContent
  readonly onDiagnostic: (message: string) => void
  readonly onPageAction: (id: PageActionId) => void
  readonly openChanges: (target: ChangesReviewTarget) => void
  /** Only the chat panel's mount takes these: a review page publishes no
   *  summary and receives no commands. */
  readonly onReady?: () => void
  readonly onSummary?: (summary: ClientSummary) => void
}

/** One webview that shows its owner's content: the chat panel, or the
 *  Changes editor with the review it holds. It owns the webview's document,
 *  pumps runtime bytes between it and the account-service socket, and answers
 *  the client's requests for what only the editor can do. */
export class PanelMount {
  private bridge: SocketBridge | undefined
  /** The bundle the current page was mounted from, once one is. */
  private bundle: ClientBundle | undefined
  /** Counts every page mount, so a resolution that finishes after the view
   *  moved on, to a newer mount or to disposal, sets nothing. */
  private generation = 0
  private prepared: { readonly generation: number; readonly transactionId: number; readonly bundle: ClientBundle } | undefined
  private readonly disposables: vscode.Disposable[] = []
  /** Set once the client has mounted. Commands posted before that would land
   *  on a page with nothing listening. */
  private listening = false
  /** Set when the account service did not name its client, so a recovered
   *  service can mount it again. */
  private clientFailed = false

  constructor(private readonly view: MountView, private readonly owner: MountOwner, private review?: Review) {
    view.webview.onDidReceiveMessage((message: ViewMessage | PageMessage) => {
      void this.onMessage(message).catch((cause: unknown) => {
        owner.onDiagnostic(`chat view message failed: ${describe(cause)}`)
      })
    }, undefined, this.disposables)
    this.render()
  }

  get ready(): boolean {
    return this.listening
  }

  get visible(): boolean {
    return this.view.visible === true
  }

  /** Puts the owner's content in the view: a page at once, or a client
   *  mounted from the runtime it names. */
  render(): void {
    const content = this.owner.content()
    if (content.kind === "client") {
      void this.serve()
      return
    }
    this.showPage(content.page)
  }

  /** Follows a new owner content without replacing a mounted client: the
   *  document stays, and with it everything the person set on it, such as
   *  the reading position, a draft, and open rows. Channels of a runtime the
   *  owner no longer serves end, reported, so the client attaches again in
   *  place through the current one; while the owner shows a page, the client
   *  keeps what it has and reconnects by itself. A view with no client
   *  document, still loading or failed, has nothing to keep and renders. */
  follow(): void {
    if (this.bridge === undefined) {
      this.render()
      return
    }
    const target = this.runtimeTarget()
    if (target === undefined || sameRuntime(this.bridge.target, target)) return
    this.bridge.end("The Flywheel runtime of this window changed.")
    this.bridge = new SocketBridge(target, (message) => this.post(message))
    this.owner.onDiagnostic(`a kept client page attaches again through the account service at ${target.socketPath}`)
  }

  /** Mounts the client again when the account service had not named it, as
   *  after the service recovers. A client already mounted is left alone. */
  retryClient(): void {
    if (this.clientFailed && this.owner.content().kind === "client") void this.serve()
  }

  /** Points this Changes editor at `review`. The client reads its target
   *  once, at mount, so a new target mounts the client again; the same
   *  target keeps the page as it is. */
  retarget(review: Review): void {
    if (this.review?.projectRoot === review.projectRoot && this.review.target.sessionId === review.target.sessionId && this.review.target.path === review.target.path) return
    this.review = review
    this.render()
  }

  post(message: HostMessage): void {
    void this.view.webview.postMessage(message)
  }

  dispose(): void {
    this.generation++
    this.listening = false
    this.bridge?.dispose()
    this.bridge = undefined
    for (const disposable of this.disposables.splice(0)) disposable.dispose()
  }

  /** Where this view's channels attach: the runtime the owner serves now,
   *  for the project of the review this view holds, or for the owner's own
   *  project. Undefined while the owner shows a page. */
  private runtimeTarget(): RuntimeSocketTarget | undefined {
    const content = this.owner.content()
    if (content.kind !== "client") return undefined
    return this.review === undefined ? content.target : { ...content.target, projectRoot: this.review.projectRoot }
  }

  private showPage(page: StatusPage): void {
    this.generation++
    this.prepared = undefined
    this.listening = false
    this.bundle = undefined
    this.bridge?.dispose()
    this.bridge = undefined
    this.view.webview.options = { enableScripts: true }
    this.view.webview.html = statusPageHtml(page, randomBytes(16).toString("base64"))
  }

  /** Mounts the runtime's client in the view: a loading page first, then the
   *  page whose script and stylesheet the runtime names. Version-1 clients
   *  also use this transition when their bundle is refused.
   *  A failure to learn the bundle shows the status page for it, which the
   *  next `retryClient` replaces. */
  private async serve(): Promise<void> {
    const target = this.runtimeTarget()
    if (target === undefined) return
    this.showPage({ ...statusPage({ kind: "starting" }), body: "Loading the Flywheel client." })
    const generation = this.generation
    this.clientFailed = false
    let bundle: ClientBundle
    try {
      bundle = await resolveEditorClient(target)
    } catch (cause) {
      if (generation !== this.generation) return
      const detail = describe(cause)
      this.owner.onDiagnostic(`client unavailable: ${detail}`)
      this.showPage(statusPage({ kind: "unavailable", failure: { kind: "client", detail } }))
      this.clientFailed = true
      return
    }
    if (generation !== this.generation) return
    this.bundle = bundle
    this.bridge = new SocketBridge(target, (message) => this.post(message))
    this.view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(bundle.dir)] }
    this.view.webview.html = this.clientHtml(bundle, target)
  }

  private async onMessage(message: ViewMessage | PageMessage): Promise<void> {
    if (message.type === "pageAction") {
      this.owner.onPageAction(message.id)
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
        this.post({ type: "hostCommands", ids, ...(this.review === undefined ? {} : { review: this.review.target }) })
        this.listening = true
        if (this.bundle) this.owner.onDiagnostic(`client served from ${this.bundle.dir} (${this.bundle.identity})`)
        this.owner.onReady?.()
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
        this.owner.onSummary?.(message.summary)
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
        this.owner.openChanges(request.target)
        return
      case "reload":
        // Version-1 clients remain reachable from older resident runtimes.
        // Remove this transition after 2027-01-19 with its protocol variant.
        await this.serve()
        return
      case "prepareReload": {
        const target = this.runtimeTarget()
        if (target === undefined || request.generation !== this.generation) throw new Error("The Flywheel page changed before replacement preparation.")
        this.prepared = undefined
        const bundle = await resolveEditorClient(target)
        if (request.generation !== this.generation) throw new Error("The Flywheel page changed during replacement preparation.")
        this.prepared = { generation: request.generation, transactionId: request.transactionId, bundle }
        return
      }
      case "commitReload": {
        const target = this.runtimeTarget()
        const prepared = this.prepared
        if (target === undefined || prepared === undefined || request.generation !== this.generation || prepared.generation !== request.generation || prepared.transactionId !== request.transactionId) throw new Error("The prepared Flywheel replacement is no longer current.")
        const html = this.clientHtml(prepared.bundle, target, this.generation + 1)
        this.view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(prepared.bundle.dir)] }
        this.view.webview.html = html
        this.generation++
        this.prepared = undefined
        this.listening = false
        this.bridge?.dispose()
        this.bundle = prepared.bundle
        this.bridge = new SocketBridge(target, (message) => this.post(message))
        return
      }
      case "ensureRuntime": {
        const content = this.owner.content()
        if (content.kind === "client") await content.ensureRuntime()
        return
      }
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

  /** The client page. Its script and stylesheet come from the runtime's build
   *  directory. The root carries the bundle's identity, which the client
   *  offers at every attach, and the host contract version this extension was
   *  built for, so a client that needs a newer host shows a notice instead of
   *  mounting. */
  private clientHtml(bundle: ClientBundle, target: RuntimeSocketTarget, generation = this.generation): string {
    const webview = this.view.webview
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
<div id="root" data-client-identity="${bundle.identity}" data-host-contract="${HOST_CONTRACT_VERSION}" data-page-generation="${generation}" data-input-scope="${Buffer.from(target.projectRoot).toString("base64url")}"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

/** Whether two targets reach the same runtime for the same project. A lane
 *  change, such as an executable setting that names a development build,
 *  moves the socket and its credential while the project stays. */
function sameRuntime(left: RuntimeSocketTarget, right: RuntimeSocketTarget): boolean {
  return left.socketPath === right.socketPath && left.credential === right.credential && left.projectRoot === right.projectRoot
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}
