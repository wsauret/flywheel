import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createInputReload } from "./input-reload.js"
import { editorInputReloadStorage } from "./input-reload-storage.js"
import { checkpointOutbox, type InputReloadCheckpoint } from "./input-reload-checkpoint.js"
import { headlessClient } from "./session-host-loader-fixture.js"
import { selectionConnection } from "./session-selection-fixture.js"
import { Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { createInputFocus } from "./input-reload-dom.js"

test("semantic focus survives an involuntary blur and follows explicit focus changes", () => {
  class Field extends EventTarget {
    dataset: DOMStringMap = {}
    selectionStart = 3
    selectionEnd = 9
    selectionDirection = "backward"
    scrollTop = 12
    scrollLeft = 4
  }
  const names = ["HTMLElement", "HTMLTextAreaElement", "HTMLInputElement"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: Field })
  const document = Object.assign(new EventTarget(), { activeElement: new Field() })
  const composer = new Field()
  composer.dataset.inputFocus = "composer:chat"
  const search = new Field()
  search.dataset.inputFocus = "search"
  class Root extends Field {
    ownerDocument = document
    contains = (element: unknown) => element === composer || element === search
  }
  // The page's HTMLElement is Field here, so the stand-in root is one; the
  // check carries that to the type.
  const root = new Root()
  if (!(root instanceof HTMLElement)) throw new Error("the stand-in root is not the page's HTMLElement")
  const focus = createInputFocus(root, undefined)
  const enter = (field: Field) => {
    document.activeElement = field
    document.dispatchEvent(new Event("focusin"))
  }
  const blur = (field: Field) => {
    document.activeElement = new Field()
    const event = new Event("focusout")
    Object.defineProperties(event, { target: { value: field }, relatedTarget: { value: null } })
    root.dispatchEvent(event)
  }
  try {
    enter(composer)
    blur(composer)
    expect(focus.capture()).toEqual({ key: "composer:chat", start: 3, end: 9, direction: "backward", scrollTop: 12, scrollLeft: 4 })
    enter(search)
    expect(focus.capture()?.key).toBe("search")
    blur(search)
    expect(focus.capture()?.key).toBe("search")
    enter(new Field())
    expect(focus.capture()).toBeUndefined()
    enter(composer)
    const escape = new Event("keydown")
    Object.defineProperty(escape, "key", { value: "Escape" })
    root.dispatchEvent(escape)
    blur(composer)
    expect(focus.capture()).toBeUndefined()
  } finally {
    focus.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("another mismatch before Composer mounts carries its unadopted input checkpoint forward, and the handed waiting message goes out again on the first lane", async () => {
  const names = ["document", "sessionStorage", "HTMLElement"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } })
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Object })
  const waiting = [{ sessionId: "cold-chat", id: "submission-1", input: { text: "lost with the lane", submissionIds: ["submission-1"] }, timestamp: 5 }]
  let saved: InputReloadCheckpoint = { version: 1, scope: "headless", composer: { sessionId: "cold-chat", active: { text: "not adopted yet", attachments: [] }, drafts: {}, questions: {} }, outbox: waiting }
  let consumed = 0
  const committed = deferred()
  const connection = selectionConnection()
  headlessClient.setConnection(connection)
  const client = headlessClient.mountForTest({
    inputStorage: { load: async () => saved, save: async (value) => { saved = value }, consume: async () => { consumed++ } },
    socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    capabilities: { replacement: { prepare: async () => {}, commit: async () => { committed.resolve() } } },
  })
  try {
    await Promise.resolve()
    headlessClient.mismatch()
    await committed.promise
    assert.equal(saved.composer?.active.text, "not adopted yet")
    // The first lane sent the waiting message again under its identity, so
    // the runtime answered it and nothing waits for the next page.
    assert.deepEqual(connection.dispatched.filter((command) => command.type === "session.send"), [{ type: "session.send", sessionId: "cold-chat", input: waiting[0]!.input }])
    assert.equal(saved.outbox, undefined)
    assert.equal(consumed, 0)
  } finally {
    client.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("a message the runtime has not answered when the page is replaced goes to the next page", async () => {
  const names = ["document", "sessionStorage", "HTMLElement"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } })
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Object })
  const waiting = [{ sessionId: "cold-chat", id: "submission-1", input: { text: "never answered", submissionIds: ["submission-1"] }, timestamp: 5 }]
  let saved: InputReloadCheckpoint = { version: 1, scope: "headless", outbox: waiting }
  const committed = deferred()
  const connection = selectionConnection()
  // The runtime never answers the send, as when the page is replaced
  // before the lane carries the answer back.
  const dispatch: typeof connection.dispatch = (command) => command.type === "session.send" ? new Promise<never>(() => {}) : connection.dispatch(command)
  headlessClient.setConnection({ ...connection, dispatch })
  const client = headlessClient.mountForTest({
    inputStorage: { load: async () => saved, save: async (value) => { saved = value }, consume: async () => {} },
    socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    capabilities: { replacement: { prepare: async () => {}, commit: async () => { committed.resolve() } } },
  })
  try {
    await Promise.resolve()
    headlessClient.mismatch()
    await committed.promise
    assert.deepEqual(saved.outbox, waiting)
  } finally {
    client.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("a message on its way survives every way the page goes away, not only a reload for a newer client", async () => {
  // A person's reload, a tab closed and opened again, and a page the browser
  // discards run no code the page can rely on, so the store must already
  // hold what waits. The store here keeps one record per tab, as the
  // browser's does: a save replaces it and a consume removes it.
  const names = ["document", "sessionStorage", "HTMLElement"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } })
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Object })
  const handed = { sessionId: "cold-chat", id: "submission-1", input: { text: "handed over", submissionIds: ["submission-1"] }, timestamp: 5 }
  let stored: InputReloadCheckpoint | undefined = { version: 1, scope: "headless", reading: { sessionId: "cold-chat", following: true, open: [] }, outbox: [handed] }
  const storage = { load: async () => stored, save: async (value: InputReloadCheckpoint) => { stored = value }, consume: async () => { stored = undefined } }
  const connection = selectionConnection()
  // The runtime never answers a send, as while the connection is silent.
  const sends: unknown[] = []
  const dispatch: typeof connection.dispatch = (command) => {
    if (command.type !== "session.send") return connection.dispatch(command)
    sends.push(command.input)
    return new Promise<never>(() => {})
  }
  headlessClient.setConnection({ ...connection, dispatch })
  let page = headlessClient.mountForTest({ inputStorage: storage, socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)), capabilities: {} })
  try {
    await waitUntil(() => headlessClient.session?.sessionId === "cold-chat" && sends.length === 1)
    await headlessClient.session.send("typed on this page")
    // Adoption drops the place it restored, but keeps every message that
    // still waits: the handed one and the one sent here.
    await waitUntil(() => stored?.outbox?.length === 2)
    assert.deepEqual(stored?.outbox?.map((entry) => entry.input.text), ["handed over", "typed on this page"])
    assert.equal(stored?.reading, undefined)
    // The person reloads: no replacement ran. The next page shows both
    // queued and sends them again in order, the second once the first
    // settles, and the store keeps both while they wait.
    page.dispose()
    sends.length = 0
    const earlier = headlessClient.session
    page = headlessClient.mountForTest({ inputStorage: storage, socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)), capabilities: {} })
    await waitUntil(() => headlessClient.session !== earlier && headlessClient.session.sessionId === "cold-chat" && sends.length === 1)
    assert.deepEqual(sends, [handed.input])
    assert.deepEqual(headlessClient.session.localSubmissions.map((entry) => entry.input.text), ["handed over", "typed on this page"])
    assert.deepEqual(stored?.outbox?.map((entry) => entry.input.text), ["handed over", "typed on this page"])
  } finally {
    page.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("the store holds nothing once nothing waits", async () => {
  const names = ["document", "sessionStorage", "HTMLElement"] as const
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } })
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: Object })
  let stored: InputReloadCheckpoint | undefined
  let writes = 0
  const storage = { load: async () => stored, save: async (value: InputReloadCheckpoint) => { stored = value; writes++ }, consume: async () => { stored = undefined; writes++ } }
  const connection = selectionConnection()
  headlessClient.setConnection(connection)
  const earlier = headlessClient.session
  const page = headlessClient.mountForTest({ inputStorage: storage, socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)), capabilities: {} })
  try {
    await waitUntil(() => headlessClient.session !== earlier && headlessClient.session.sessionId === "cold-chat")
    await headlessClient.session.send("answered at once")
    await waitUntil(() => stored === undefined && writes === 2)
    // A page with nothing waiting writes nothing more as the session changes.
    connection.publishCatalog()
    await Promise.resolve()
    assert.equal(writes, 2)
  } finally {
    page.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) await Bun.sleep(1)
  assert.ok(condition(), "the condition never held")
}

test("unknown or malformed stored input remains opaque and saved until successful adoption", async () => {
  let state: unknown
  let writes = 0
  const storage = editorInputReloadStorage({
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native editor state returns opaque persisted bytes
    getState: () => state,
    setState: (value) => { state = value; writes++ },
  }, "project")
  for (const unreadable of [null, { version: 99, scope: "project" }, { version: 1, scope: "project", composer: { active: "broken" } }]) {
    state = unreadable
    await assert.rejects(storage.load())
    assert.equal(state, unreadable)
    assert.equal(writes, 0)
  }
  await storage.save({ version: 1, scope: "project", composer: { active: { text: "saved", attachments: [] }, drafts: {}, questions: {} } })
  assert.equal((await storage.load())?.composer?.active.text, "saved")
  assert.equal(writes, 1)
  await storage.consume()
  assert.equal(await storage.load(), undefined)
})

test("a checkpoint that a page before waiting messages saved restores none, and a current one keeps them", async () => {
  // The editor keeps opaque bytes. The first are the shape that a page
  // before waiting messages saved: no `outbox` field.
  let bytes = JSON.stringify({ version: 1, scope: "project", composer: { active: { text: "draft", attachments: [] }, drafts: {}, questions: {} } })
  const storage = editorInputReloadStorage({
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native editor state returns opaque persisted bytes
    getState: () => JSON.parse(bytes),
    setState: (value) => { bytes = JSON.stringify(value) },
  }, "project")
  const previous = await storage.load()
  assert.deepEqual(previous === undefined ? undefined : checkpointOutbox(previous), [])
  const outbox = [{ sessionId: "chat", id: "submission-1", input: { text: "words [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0KGgo=" }], submissionIds: ["submission-1"] }, timestamp: 3 }]
  await storage.save({ version: 1, scope: "project", outbox })
  const current = await storage.load()
  assert.deepEqual(current === undefined ? undefined : checkpointOutbox(current), outbox)
})

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test("replacement prepares before capture, saves the latest accepted revision, and holds only at commit", async () => {
  const preparation = deferred()
  const attachment = deferred()
  const writing = deferred()
  const commit = deferred()
  let text = "first"
  let held = false
  let captures = 0
  const saved: InputReloadCheckpoint[] = []
  const reload = createInputReload({
    prepare: () => preparation.promise,
    settled: () => attachment.promise,
    capture: () => { captures++; return { version: 1, scope: text } },
    save: async (value) => { saved.push(value); if (saved.length === 1) await writing.promise },
    hold: () => { held = true; return () => { held = false } },
    commit: () => commit.promise,
    report: () => {},
  })
  const work = reload.replace()
  expect(captures).toBe(0)
  text = "during preparation"
  preparation.resolve()
  await Promise.resolve()
  expect(captures).toBe(0)
  attachment.resolve()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(saved[0]?.scope).toBe("during preparation")
  expect(held).toBe(false)
  text = "during save"
  writing.resolve()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(saved.at(-1)?.scope).toBe("during save")
  expect(held).toBe(true)
  commit.resolve()
  await work
  expect(held).toBe(true)
})

test("save or commit refusal retains owners and releases the commit hold", async () => {
  for (const failure of ["prepare", "save", "commit"]) {
    let held = false
    const errors: string[] = []
    const fail = () => { throw new Error("secret input must not enter the report") }
    const reload = createInputReload({
      prepare: async () => { if (failure === "prepare") fail() },
      settled: async () => {},
      capture: () => ({ version: 1, scope: "project" }),
      save: async () => { if (failure === "save") fail() },
      hold: () => { held = true; return () => { held = false } },
      commit: async () => { if (failure === "commit") fail() },
      report: (message) => errors.push(message),
    })
    await reload.replace()
    expect(held).toBe(false)
    expect(errors).toEqual(["Flywheel could not replace this client. Your unsent input is still here."])
  }
})
