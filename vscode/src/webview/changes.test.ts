import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, test, mock } from "bun:test"
import type { HostMessage, ViewMessage } from "../../../src/protocol/client/editor-host.js"
import type { ClientSummary } from "../../../src/protocol/client/host-contract.js"
import { createInputReload } from "../../../webview/src/client/input-reload.js"
import { editorInputReloadStorage } from "../../../webview/src/client/input-reload-storage.js"
import type { ComposerCheckpoint } from "../../../webview/src/client/input-reload-checkpoint.js"
import type { FrontendQuestionBlock } from "../../../webview/src/client/question-answer.js"

interface TestComposer {
  type(text: string): void
  text(): string
  attach(name: string): Promise<void>
  remove(name: string): void
  attachmentCount(): number
  clickQuestion(label: string): void
  typeQuestion(label: string, text: string): void
  capture(): ComposerCheckpoint
  adopt(checkpoint: ComposerCheckpoint): void
  settle(): Promise<void>
  dispose(): void
  readonly sent: readonly unknown[]
  readonly questionAnswers: readonly unknown[]
}
// The browser fixture compiles under its own JSX project, not the editor host's.
const browserFixture = new URL("../../../webview/src/app/composer-submission-loader-fixture.ts", import.meta.url).href
const { mountComposerSubmission }: { mountComposerSubmission(options?: { question: FrontendQuestionBlock }): TestComposer } = await import(browserFixture)

const callbacks = new Map<string, (path?: unknown) => Promise<void>>()
const diagnostics: string[] = []
const IDENTITY = "ab".repeat(32)
const SERVED = `client served from /runtime/webview/editor (${IDENTITY})`
const panels: ReturnType<typeof panel>[] = []
const sidebars: ReturnType<typeof panel>[] = []
/** What a status page posts when a person chooses an action. */
type PageMessage = { readonly type: "pageAction"; readonly id: string }
const filesystemWrites: unknown[] = []
const clipboardWrites: string[] = []
const executed: unknown[][] = []

function panel() {
  const messages: HostMessage[] = []
  const disposed = new Set<() => void>()
  let receive: ((message: ViewMessage | PageMessage) => void) | undefined
  let reveals = 0
  return {
    messages,
    get reveals() { return reveals },
    reveal() { reveals++ },
    send(message: ViewMessage | PageMessage) { receive?.(message) },
    dispose() { for (const listener of disposed) listener(); disposed.clear() },
    onDidDispose(listener: () => void) { disposed.add(listener); return { dispose() { disposed.delete(listener) } } },
    webview: {
      options: {}, html: "", cspSource: "test:",
      asWebviewUri: (uri: { path: string }) => uri.path,
      onDidReceiveMessage(listener: (message: ViewMessage | PageMessage) => void) { receive = listener; return { dispose() { receive = undefined } } },
      postMessage(message: HostMessage) { messages.push(message); return Promise.resolve(true) },
    },
  }
}

// oxlint-disable-next-line anti-slop/no-module-mocking -- boundary: VS Code supplies this module only inside its extension host; this faithful webview/command port leaves ChatViewProvider and its routing real
mock.module("vscode", () => ({
  Uri: { file: (path: string) => ({ path }), joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join("/") }) },
  ViewColumn: { Active: -1 },
  commands: {
    registerCommand(id: string, run: (path?: unknown) => Promise<void>) { callbacks.set(id, run); return { dispose() { callbacks.delete(id) } } },
    getCommands: async () => [...callbacks.keys()],
    executeCommand: async (...args: unknown[]) => { executed.push(args) },
  },
  env: { clipboard: { writeText: async (text: string) => { clipboardWrites.push(text) } } },
  window: {
    createWebviewPanel() { const view = panel(); panels.push(view); return view },
    // The sidebar view is resolved by VS Code once the provider is registered.
    registerWebviewViewProvider(_viewType: string, provider: { resolveWebviewView(view: unknown): void }) {
      const view = panel()
      sidebars.push(view)
      provider.resolveWebviewView(view)
      return { dispose() {} }
    },
  },
  workspace: { fs: { writeFile(...args: unknown[]) { filesystemWrites.push(args); throw new Error("The editor must not restore files") } } },
}))
const vscode = await import("vscode")
const { ChatViewProvider } = await import("./chat-view.js")

async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve() }

/** Waits for the page the runtime's bundle names; the mount resolves it over the socket. */
async function served(view: ReturnType<typeof panel>) {
  while (!/webview\.js/.test(view.webview.html)) await new Promise(resolve => setTimeout(resolve, 1))
}

// The host learns where the client lives from the account service, so the
// test is one: it answers every attach with a fixed bundle.
const directory = mkdtempSync(join(tmpdir(), "flywheel-chat-view-"))
const target = { socketPath: join(directory, "runtime.sock"), projectRoot: "/project", credential: "test" }
const client = { kind: "client", target, ensureRuntime: async () => {} } as const
let respondClient: ((socket: net.Socket) => void) | undefined
const server = net.createServer(socket => {
  socket.once("data", () => {
    if (respondClient) respondClient(socket)
    else socket.end(`{"flywheel":"account.client","dir":"/runtime/webview/editor","identity":"${IDENTITY}"}\n`)
  })
})
beforeAll(() => new Promise<void>(resolve => server.listen(target.socketPath, resolve)))
afterAll(() => { server.close(); rmSync(directory, { recursive: true, force: true }) })

test("all Changes command IDs and the sheet capability open the one shared editor review without writing files", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
  const sidebar = sidebars.at(-1)!
  const opened = panels.length
  let picks = 0
  const registrations = host.registerChangesCommands(async (_title, run) => { picks++; await run({ id: "picked-session", title: "Picked" }) })
  const mounted = async (review: { readonly sessionId: string; readonly path?: string }) => {
    const editor = panels[opened]!
    await served(editor)
    editor.send({ type: "ready" })
    await settle()
    assert.deepEqual(editor.messages.at(-1), { type: "hostCommands", ids: [...callbacks.keys()], review })
  }
  try {
    for (const [id, path, mounts] of [
      ["flywheel.openAllChanges", undefined, true],
      // The same target shows the editor again and keeps its page.
      ["flywheel.revertTurn", undefined, false],
      ["flywheel.openChangeDiff", "/repo/file.txt", true],
      ["flywheel.revertFile", "/repo/file.txt", false],
    ] as const) {
      await callbacks.get(id)?.(path)
      if (mounts) await mounted({ sessionId: "picked-session", ...(path ? { path } : {}) })
    }
    const editor = panels[opened]!
    assert.equal(panels.length, opened + 1)
    assert.equal(editor.reveals, 3)
    assert.match(editor.webview.html, /\/runtime\/webview\/editor\/webview\.js/)
    // The page states what the client offers at every attach and what it
    // checks at mount: the bundle's identity and this host's contract.
    assert.match(editor.webview.html, new RegExp(`data-client-identity="${IDENTITY}"`))
    assert.match(editor.webview.html, /data-host-contract="2"/)
    assert.deepEqual(editor.webview.options, { enableScripts: true, localResourceRoots: [{ path: "/runtime/webview/editor" }] })
    assert.equal(picks, 4)
    const review = { sessionId: "from-sheet" } as const
    sidebar.send({ type: "capability", requestId: 1, request: { name: "openChanges", target: review } })
    await settle()
    await mounted(review)
    assert.equal(panels.length, opened + 1)
    assert.ok(sidebar.messages.some(message => message.type === "capability.result" && message.ok))
    assert.deepEqual(filesystemWrites, [])
    assert.equal(diagnostics.filter(line => line === SERVED).length, 3)

    // A closed editor is not reused: the next request opens a new one.
    editor.dispose()
    host.openChanges(review)
    assert.equal(panels.length, opened + 2)
  } finally {
    sidebar.dispose()
    host.dispose()
    for (const registration of registrations) registration.dispose()
  }
})

test("the clipboard capability writes through VS Code's system clipboard", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  try {
    host.openChanges({ sessionId: "clipboard-test" })
    const view = panels.at(-1)!
    await served(view)
    view.send({ type: "capability", requestId: 1, request: { name: "writeClipboardText", text: "session-full-id" } })
    await settle()
    assert.deepEqual(clipboardWrites, ["session-full-id"])
    assert.ok(view.messages.some(message => message.type === "capability.result" && message.requestId === 1 && message.ok))
  } finally {
    host.dispose()
  }
})

test("replacement retains the old page during preparation, swaps only on correlated commit, and refuses stale commits", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  const original = mountComposerSubmission({ question: {
    kind: "question", toolUseId: "ask", timestamp: 1,
    questions: [{ question: "Which?", multiSelect: false, choices: [{ kind: "option", choiceId: "file", label: "File", requiresText: true }] }],
  } })
  try {
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
    const view = sidebars.at(-1)!
    await served(view)
    view.send({ type: "ready" })
    await settle()
    const oldHtml = view.webview.html
    const generation = Number(/data-page-generation="(\d+)"/.exec(oldHtml)?.[1])
    let answer = (_socket: net.Socket) => {}
    const requested = new Promise<net.Socket>((resolve) => { answer = resolve })
    respondClient = answer
    let nativeState: unknown
    const storage = editorInputReloadStorage({
      // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native editor state returns opaque saved bytes
      getState: () => nativeState,
      setState: (state) => { nativeState = state },
    }, "editor")
    const invoke = async (requestId: number, name: "prepareReload" | "commitReload") => {
      view.send({ type: "capability", requestId, request: { name, generation, transactionId: 1 } })
      while (!view.messages.some(message => message.type === "capability.result" && message.requestId === requestId)) await new Promise(resolve => setTimeout(resolve, 1))
      assert.ok(view.messages.some(message => message.type === "capability.result" && message.requestId === requestId && message.ok))
    }
    const reload = createInputReload({
      prepare: () => invoke(7, "prepareReload"), settled: original.settle,
      capture: () => ({ version: 1, scope: "editor", composer: original.capture() }),
      save: storage.save, hold: () => () => {},
      commit: () => invoke(8, "commitReload"),
      report: (message) => { throw new Error(message) },
    })
    const replacement = reload.replace()
    const socket = await requested
    assert.equal(view.webview.html, oldHtml)
    host.command({ type: "insertText", text: "still editable" })
    assert.deepEqual(view.messages.at(-1), { type: "command", command: { type: "insertText", text: "still editable" } })
    original.type("typed during preparation")
    await original.attach("first.txt")
    await original.attach("second.txt")
    original.remove("first.txt")
    original.clickQuestion("File")
    original.typeQuestion("File: Which?", "choice during preparation")
    socket.end(`{"flywheel":"account.client","dir":"/runtime/new/editor","identity":"${"cd".repeat(32)}"}\n`)
    await replacement
    assert.match(view.webview.html, /\/runtime\/new\/editor\/webview\.js/)
    const saved = await storage.load()
    assert.ok(saved?.composer)
    original.dispose()
    const successor = mountComposerSubmission()
    try {
      successor.adopt(saved.composer)
      assert.equal(successor.text(), "typed during preparation")
      assert.equal(successor.attachmentCount(), 1)
      assert.equal(successor.capture().active.attachments[0]?.marker, "[File #2 second.txt]")
      assert.equal(successor.capture().active.attachments[0]?.data, btoa("contents"))
      assert.deepEqual(successor.capture().questions, saved.composer.questions)
      assert.equal(successor.questionAnswers.length, 0)
      assert.equal(successor.sent.length, 0)
      assert.notEqual(await storage.load(), undefined, "the checkpoint remains saved until adoption")
      await storage.consume()
      assert.equal(await storage.load(), undefined)
    } finally { successor.dispose() }
    const replacementHtml = view.webview.html
    view.send({ type: "capability", requestId: 9, request: { name: "commitReload", generation, transactionId: 1 } })
    await settle()
    assert.equal(view.webview.html, replacementHtml)
    assert.ok(view.messages.some(message => message.type === "capability.result" && message.requestId === 9 && !message.ok))
  } finally {
    original.dispose()
    respondClient = undefined
    host.dispose()
  }
})

test("a failed replacement preparation reports failure without swapping the page", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  try {
    host.openChanges({ sessionId: "failed-reload" })
    const view = panels.at(-1)!
    await served(view)
    const oldHtml = view.webview.html
    const generation = Number(/data-page-generation="(\d+)"/.exec(oldHtml)?.[1])
    respondClient = (socket) => { socket.end('{"flywheel":"account.client","error":"unavailable"}\n') }
    view.send({ type: "capability", requestId: 10, request: { name: "prepareReload", generation, transactionId: 2 } })
    while (!view.messages.some(message => message.type === "capability.result" && message.requestId === 10)) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(view.webview.html, oldHtml)
    assert.ok(view.messages.some(message => message.type === "capability.result" && message.requestId === 10 && !message.ok))
  } finally { respondClient = undefined; host.dispose() }
})

test("a version-1 client reload request replaces its rejected bundle on a version-2 host", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  try {
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
    const view = sidebars.at(-1)!
    await served(view)
    const oldHtml = view.webview.html
    respondClient = socket => socket.end(`{"flywheel":"account.client","dir":"/runtime/successor/editor","identity":"${"ef".repeat(32)}"}\n`)
    view.send({ type: "capability", requestId: 11, request: { name: "reload" } })
    while (!view.messages.some(message => message.type === "capability.result" && message.requestId === 11)) await new Promise(resolve => setTimeout(resolve, 1))
    assert.match(view.webview.html, /\/runtime\/successor\/editor\/webview\.js/)
    assert.notEqual(view.webview.html, oldHtml)
    assert.ok(view.messages.some(message => message.type === "capability.result" && message.requestId === 11 && message.ok))
  } finally { respondClient = undefined; host.dispose() }
})

test("the panel goes from a status page to the client and keeps the commands asked for on the way", async () => {
  const actions: string[] = []
  const host = new ChatViewProvider(line => diagnostics.push(line), id => { actions.push(id) })
  vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
  const view = sidebars.at(-1)!
  try {
    // Before the runtime listens the panel says what the editor is doing,
    // and a command asked for there has no client to reach.
    assert.match(view.webview.html, /Starting Flywheel/)
    host.insertText("dropped")
    await settle()
    view.send({ type: "pageAction", id: "log" })
    await settle()
    assert.deepEqual(actions, ["log"])

    host.show(client)
    host.insertText("kept")
    await served(view)
    view.send({ type: "ready" })
    await settle()
    assert.deepEqual(view.messages.filter(message => message.type === "command"), [{ type: "command", command: { type: "insertText", text: "kept" } }])

    // A runtime that goes away puts its page back without a reload.
    host.show({ kind: "page", page: { title: "Flywheel could not start", body: "cause", actions: [] } })
    assert.match(view.webview.html, /Flywheel could not start/)
    assert.doesNotMatch(view.webview.html, /webview\.js/)
  } finally {
    view.dispose()
    host.dispose()
  }
})

test("the setup checklist's review step is marked by a review, not by a command that found nothing to review", async () => {
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: client })
  const reviewed = () => executed.filter(args => args[0] === "setContext" && args[1] === "flywheel.reviewedChanges")
  executed.length = 0
  let chats: { id: string; title: string }[] = []
  const registrations = host.registerChangesCommands(async (_title, run) => { for (const chat of chats) await run(chat) })
  try {
    await callbacks.get("flywheel.openAllChanges")?.()
    assert.deepEqual(reviewed(), [])
    chats = [{ id: "one", title: "One" }]
    await callbacks.get("flywheel.openAllChanges")?.()
    assert.deepEqual(reviewed(), [["setContext", "flywheel.reviewedChanges", true]])
  } finally {
    host.dispose()
    for (const registration of registrations) registration.dispose()
  }
})

test("a reloaded page gets its own channels, and the old page's streams close", async () => {
  // A service that names its client and holds every runtime channel open.
  const runtime = { ...target, socketPath: join(directory, "held.sock") }
  const held: net.Socket[] = []
  const service = net.createServer(socket => {
    socket.once("data", (bytes) => {
      if (bytes.toString().includes('"intent":"client"')) {
        socket.end(`{"flywheel":"account.client","dir":"/runtime/webview/editor","identity":"${IDENTITY}"}\n`)
        return
      }
      held.push(socket)
      socket.write('{"flywheel":"account.attach.ready"}\n')
    })
  })
  await new Promise<void>(resolve => service.listen(runtime.socketPath, resolve))
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: { kind: "client", target: runtime, ensureRuntime: async () => {} } })
  vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
  const view = sidebars.at(-1)!
  const opened = () => view.messages.filter(message => message.type === "socket.opened").length
  try {
    await served(view)
    view.send({ type: "ready" })
    await settle()
    view.send({ type: "socket.open", id: 1 })
    while (opened() < 1) await new Promise(resolve => setTimeout(resolve, 1))

    // Developer: Reload Webviews: the same view, a new page, the same ids.
    view.send({ type: "ready" })
    await settle()
    view.send({ type: "socket.open", id: 1 })
    while (opened() < 2) await new Promise(resolve => setTimeout(resolve, 1))
    while (!held[0]!.destroyed && held[0]!.readyState !== "closed") await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(held.length, 2)
    assert.ok(!held[1]!.destroyed)
  } finally {
    host.dispose()
    for (const socket of held) socket.destroy()
    service.close()
  }
})

test("the Changes editor keeps its page across runtime changes and attaches to the project of its review", async () => {
  // Two lanes of the account service, as an executable setting that names a
  // development build gives: each names the client and holds every runtime
  // attach open, and each records the project the attach names.
  const attaches: { readonly lane: string; readonly projectRoot: string }[] = []
  const held: net.Socket[] = []
  const lanes = ["installed", "dev"].map((lane) => {
    const socketPath = join(directory, `${lane}.sock`)
    const service = net.createServer(socket => {
      socket.once("data", (bytes) => {
        const attach: { intent: string; projectRoot?: string } = JSON.parse(bytes.toString().split("\n")[0]!)
        if (attach.intent === "client") {
          socket.end(`{"flywheel":"account.client","dir":"/runtime/webview/editor","identity":"${IDENTITY}"}\n`)
          return
        }
        attaches.push({ lane, projectRoot: attach.projectRoot! })
        held.push(socket)
        socket.write('{"flywheel":"account.attach.ready"}\n')
      })
    })
    return { socketPath, service }
  })
  await Promise.all(lanes.map(({ service, socketPath }) => new Promise<void>(resolve => service.listen(socketPath, resolve))))
  const ensured: string[] = []
  const selecting = (sessionId: string): ClientSummary => ({
    health: { kind: "healthy" }, ready: true, sessionId, rootSessionId: sessionId, sessionTitle: undefined, executionCwd: undefined,
    activity: undefined, busy: false, budget: undefined, hasUsableProvider: true, providers: [], changes: undefined,
  })
  const runtime = (lane: number, projectRoot: string, start: string) => ({
    kind: "client", target: { socketPath: lanes[lane]!.socketPath, projectRoot, credential: "test" }, ensureRuntime: async () => { ensured.push(start) },
  }) as const
  const host = new ChatViewProvider(line => diagnostics.push(line), () => {}, { content: runtime(0, "/project", "first start") })
  vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, host)
  const sidebar = sidebars.at(-1)!
  const registrations = host.registerChangesCommands(async () => { throw new Error("the summary names the session") })
  const opened = panels.length
  const attach = async (view: ReturnType<typeof panel>, id: number) => {
    const before = attaches.length
    view.send({ type: "socket.open", id })
    while (attaches.length === before) await new Promise(resolve => setTimeout(resolve, 1))
    return attaches.at(-1)
  }
  const capability = async (view: ReturnType<typeof panel>, requestId: number, request: { readonly name: "ensureRuntime" }) => {
    view.send({ type: "capability", requestId, request })
    while (!view.messages.some(message => message.type === "capability.result" && message.requestId === requestId)) await new Promise(resolve => setTimeout(resolve, 1))
  }
  try {
    await served(sidebar)
    sidebar.send({ type: "ready" })
    await settle()
    sidebar.send({ type: "summary", summary: selecting("old-session") })
    await callbacks.get("flywheel.openAllChanges")?.()
    const editor = panels[opened]!
    await served(editor)
    editor.send({ type: "ready" })
    await settle()
    // The client page keeps its policy: only the nonce's script runs, beside
    // a transcript of untrusted model output.
    const nonce = /script-src 'nonce-([^']+)'/.exec(editor.webview.html)?.[1]
    assert.match(editor.webview.html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/)
    assert.ok(nonce !== undefined && editor.webview.html.includes(`<script nonce="${nonce}"`))
    assert.deepEqual(await attach(editor, 1), { lane: "installed", projectRoot: "/project" })
    const reviewing = editor.webview.html

    // The same project starts again, as after Try again: a status page, then
    // the client of the new start. The editor keeps its page, and with it the
    // person's reading position, and asks the new start for a lost runtime.
    host.show({ kind: "page", page: { title: "Starting Flywheel", body: "", actions: [] } })
    host.show(runtime(0, "/project", "second start"))
    await served(sidebar)
    assert.equal(editor.webview.html, reviewing)
    assert.ok(!editor.messages.some(message => message.type === "socket.closed"))
    await capability(editor, 1, { name: "ensureRuntime" })
    assert.deepEqual(ensured, ["second start"])

    // The panel moves to another project. The session the editor reviews
    // still exists, so the editor stays on it; the summary of the replaced
    // client goes with it.
    host.show(runtime(0, "/other", "third start"))
    assert.equal(host.latestSummary, undefined)
    await served(sidebar)
    assert.equal(editor.webview.html, reviewing)
    assert.deepEqual(await attach(editor, 2), { lane: "installed", projectRoot: "/project" })

    // A Changes command for the new project's session points the editor at
    // it: the session and its project change together.
    sidebar.send({ type: "ready" })
    await settle()
    sidebar.send({ type: "summary", summary: selecting("new-session") })
    await callbacks.get("flywheel.openAllChanges")?.()
    while (editor.webview.html === reviewing || !/webview\.js/.test(editor.webview.html)) await new Promise(resolve => setTimeout(resolve, 1))
    editor.send({ type: "ready" })
    await settle()
    assert.equal(panels.length, opened + 1)
    assert.deepEqual(editor.messages.at(-1), { type: "hostCommands", ids: [...callbacks.keys()], review: { sessionId: "new-session" } })
    assert.deepEqual(await attach(editor, 1), { lane: "installed", projectRoot: "/other" })

    // The executable setting moves the runtime to another lane. The editor
    // keeps its page; its channel ends, reported, so the client attaches again
    // in place through the new lane.
    const moved = editor.webview.html
    host.show(runtime(1, "/other", "fourth start"))
    while (!editor.messages.some(message => message.type === "socket.closed" && message.id === 1)) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(editor.webview.html, moved)
    assert.deepEqual(await attach(editor, 3), { lane: "dev", projectRoot: "/other" })
  } finally {
    for (const registration of registrations) registration.dispose()
    sidebar.dispose()
    host.dispose()
    for (const socket of held) socket.destroy()
    for (const { service } of lanes) service.close()
  }
})
