import { createComponent, createRoot, createSignal, For, Show } from "solid-js"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import { createBlockDisclosure, type BlockDisclosure } from "./block-disclosure.js"
import { Block, TurnFoldBlock } from "./blocks.js"
import { ClientExtensionsProvider } from "./client-extensions.js"
import type { WebModuleClient } from "../web-module-client.js"
import { Markdown } from "./markdown-view.js"
import type { SessionChangesController } from "../../../src/protocol/client/session-changes.js"
import type { FileChangeBody } from "../../../src/protocol/client/file-change-body.js"
import type { ChangesReviewTarget } from "../../../src/protocol/client/host-contract.js"
import { FileDiff } from "./file-diff.js"
import { ChangesContent } from "./changes-content.js"
import { createElement, insert, textContent, nodes } from "./render-ownership-host-fixture.js"
import { ActivityStatus } from "./activity-status.js"
import { Transcript } from "./transcript.js"
import { createTranscriptTiming, RowTime, TranscriptClock } from "./row-time.js"
import { blockEndTimes } from "../client/tool-runs.js"
import { presentedBlock } from "../client/presented-block-fixture.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { createTurnMutationMetadata, TurnChanges } from "./turn-changes.js"
import { turnCalls } from "../client/turn-folds.js"
import type { MutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"
import type { TurnFold } from "../client/turn-folds.js"
import { ClientContext, type ClientContextValue } from "./client-context.js"
import type { ClientViewState } from "../client/view-state.js"
import { statusView } from "../../../tests/helpers/runtime-views.js"
import { fakeClient, fakeClientActions, fakePanelSettings, fakeRuntimeSession, fakeViewState } from "./client-context-fixture.js"
import type { ReadingState } from "../../../src/protocol/client/reading-state.js"
import type { SessionMemory } from "../client/session-residents.js"
import { agentGroupClient } from "./agent-group-fixture.js"

export const reviewWindow = createElement("root").ownerDocument.defaultView

/** Publishes resident frames through the production transcript and its row
 *  ownership. `restored` is the place a reload handed this mount. */
export function mountToolGroup(initial: readonly FrontendOutputBlock[], restored?: ReadingState, showThinking = false, canOpenFiles = false, evidenceReader?: MutationEvidenceReader) {
  const noop = () => {}
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const mutationCallbacks = new Set<() => void>()
  const shims = {
    getComputedStyle: () => ({ lineHeight: "20" }),
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    MutationObserver: class {
      constructor(private readonly callback: () => void) {}
      observe() { mutationCallbacks.add(this.callback) }
      disconnect() { mutationCallbacks.delete(this.callback) }
    },
    CSS: { escape: (value: string) => value },
    // A touch the tests send is a plain `{ touches }`, which no sideways drag reads as its own.
    TouchEvent: class { readonly touches: readonly unknown[] = [] },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
  }
  const originals = Object.keys(shims).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name, value] of Object.entries(shims)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  return createRoot(dispose => {
    const [state, setState] = createSignal(fakeViewState({
      sessionId: "render-ownership", blocks: initial, roleAssignments: () => undefined,
      subscribeRoleAssignments: () => noop, subscribeStatus: () => noop,
      groups: {}, bodies: {}, streamingToolText: {}, visibleMessageCount: 0,
      atTail: true, localSubmissions: [], hasBefore: false, status: "ready",
      transcriptAvailable: true, activity: "executing_tools", interruptible: true,
      settledOutputPosition: null, appliedOutputPosition: 1, startBlockIndex: 0, windowGeneration: 0,
      settings: fakePanelSettings({ showThinking }),
    }))
    const [attention, setAttention] = createSignal<{ readonly sessionId: string; readonly sequence: number }>()
    let jumps = 0
    const pageRequests: ((loaded: boolean) => void)[] = []
    const openedFiles: string[] = []
    const detached: string[] = []
    const terminated: string[] = []
    let requestedPages = 0
    const actions = fakeClientActions({
      canOpenFiles, openFile: (path) => { openedFiles.push(path) }, working: () => false, hydrateBody: noop, hydrateGroup: noop, mutationEvidence: evidenceReader,
      detachBash: id => { detached.push(id) }, terminateBackground: id => { terminated.push(id) },
      loadOlder: () => new Promise<boolean>(resolve => { pageRequests.push(resolve); requestedPages += 1 }), jumpToLatest: () => { jumps++ },
    })
    const memories = new Map<string, SessionMemory>()
    const residents = fakeRuntimeSession({
      onLeave: () => noop,
      memory: (id) => {
        let memory = memories.get(id)
        if (memory === undefined) { memory = {}; memories.set(id, memory) }
        return memory
      },
    })
    let readPlace: () => ReadingState | undefined = () => undefined
    const readingPlace: ClientContextValue["readingPlace"] = { restored, track: (read) => { readPlace = read; return noop } }
    const client = fakeClient({ state, actions, residents, readingPlace, attention })
    const root = createElement("root")
    insert(root, createComponent(ClientContext.Provider, {
      value: client,
      get children() { return createComponent(Transcript, {}) },
    }))
    const withClass = (name: string) => nodes(root).filter(node => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(name))
    return {
      dispose() {
        dispose()
        frames.clear()
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else Reflect.deleteProperty(globalThis, name)
        }
      },
      publish: (changes: Partial<ClientViewState>) => setState({ ...state(), ...changes }),
      attend: () => setAttention((previous) => ({ sessionId: state().sessionId ?? "", sequence: (previous?.sequence ?? 0) + 1 })),
      jumps: () => jumps,
      /** How many older pages the transcript asked for. */
      pageRequests: () => requestedPages,
      /** Settles the oldest page request still open. */
      settlePage: (loaded: boolean) => pageRequests.shift()?.(loaded),
      /** The reading place a reload saves now. */
      reading: () => readPlace(),
      /** Reports a transcript mutation to its observers, as the browser does after a render. */
      mutate() {
        for (const notify of mutationCallbacks) notify()
      },
      /** Runs the animation frame callbacks requested so far. */
      frame() {
        const pending = [...frames.values()]
        frames.clear()
        for (const run of pending) run(0)
      },
      viewport: () => withClass("transcript")[0],
      wrapper: () => nodes(root).find(node => node.properties["data-tool-stretch"] !== undefined),
      header: () => withClass("tool-head")[0]?.children.find(node => node.tag === "button"),
      preview: () => withClass("live-preview")[0],
      details: () => withClass("tool-detail"),
      fileLinks: () => withClass("tool-file-link"),
      openedFiles: () => openedFiles,
      detached: () => detached,
      terminated: () => terminated,
      liveMarkers: () => withClass("marker-dot").filter(node => node.properties.class === "marker-dot live" || (typeof node.properties.classList === "object" && node.properties.classList !== null && "live" in node.properties.classList && node.properties.classList.live === true)).length,
      text: () => textContent(root),
      elements: () => nodes(root),
      /** Each rendered row by its key, with the node that renders it. */
      rows: () => withClass("row").flatMap(node => typeof node.properties["data-block"] === "string" ? [{ id: node.properties["data-block"], node }] : []),
      /** Whether the first tool group shows its calls. */
      groupOpen: () => withClass("tool-head")[0]?.children.find(node => node.tag === "button")?.properties["aria-expanded"],
      /** Whether the way back to the tail shows, which a reader away from it sees. */
      awayFromTail: () => withClass("jump-latest").length > 0,
      /** Whether the turn fold line shows its work, or undefined with no fold. */
      foldOpen: () => withClass("turn-fold")[0]?.properties["aria-expanded"],
      toggleFold() {
        const click = withClass("turn-fold")[0]?.properties.onClick
        if (typeof click !== "function") throw new Error("Missing turn fold")
        click()
      },
      toggle() {
        const click = withClass("tool-head")[0]?.children.find(node => node.tag === "button")?.properties.onClick
        if (typeof click !== "function") throw new Error("Missing tool group disclosure")
        click()
      },
    }
  })
}

let measurementMounts = 0
let restoreMeasurements = () => {}
const measurements = new Map<object, { height: number; resize: () => void }>()

function acquireMeasurements() {
  if (measurementMounts++ > 0) return
  const originals = ["getComputedStyle", "ResizeObserver"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ lineHeight: "20" }) })
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class implements ResizeObserver {
    readonly elements = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) {}
    observe(element: Element) {
      const entry = { height: 0, resize: () => this.callback([], this) }
      measurements.set(element, entry)
      this.elements.add(element)
      Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => entry.height })
      entry.resize()
    }
    unobserve(element: Element) { measurements.delete(element); this.elements.delete(element) }
    disconnect() { for (const element of this.elements) this.unobserve(element) }
  } })
  restoreMeasurements = () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}

/** Publishes the same broad inputs the transcript gives a row-local turn card. */
export function mountTurnChanges(initial: TurnFold, onHydrate?: (id: string) => void, evidenceReader?: MutationEvidenceReader) {
  return createRoot(dispose => {
    const [fold, setFold] = createSignal(initial)
    const [bodies, setBodies] = createSignal<{ readonly [id: string]: HydratedOutputBlockBody }>({})
    const hydrationRequests: string[] = []
    const disclosure = createBlockDisclosure()
    const root = createElement("root")
    const metadata = createTurnMutationMetadata(() => turnCalls(fold()), () => evidenceReader, bodies)
    if (evidenceReader) insert(root, createComponent(TurnFoldBlock, { get fold() { return fold() }, get metadata() { return metadata() }, onToggle() {} }))
    insert(root, createComponent(TurnChanges, {
      get fold() { return fold() },
      get bodies() { return bodies() },
      get metadata() { return metadata() },
      evidenceReader,
      sessionId: "render-ownership", disclosure, projectRoot: "/project", executionCwd: "/project",
      onHydrate(id) { hydrationRequests.push(id); onHydrate?.(id) },
    }))
    return {
      dispose, setFold, setBodies, hydrationRequests, disclosure,
      text: () => textContent(root), html: () => nodes(root).map(node => node.properties.innerHTML ?? "").join(""),
      click(label: string) {
        const handler = nodes(root).find(node => node.tag === "button" && textContent(node) === label)?.properties.onClick
        if (typeof handler !== "function") throw new Error(`Missing turn control: ${label}`)
        handler()
      },
    }
  })
}

/** Exercises timing publication with the same row-local clock inputs as the transcript. */
export function mountTimedRows(initial: readonly FrontendOutputBlock[]) {
  return createRoot(dispose => {
    const timing = createTranscriptTiming(() => false)
    let endReads = 0
    const publish = (blocks: readonly FrontendOutputBlock[]) => timing.publish(blockEndTimes(blocks), new Set())
    publish(initial)
    const root = createElement("root")
    insert(root, createComponent(TranscriptClock.Provider, {
      value: { now: () => 100000, running: timing.running, end: id => { endReads++; return timing.end(id) } },
      get children() { return For({
        each: initial,
        children: (block: FrontendOutputBlock) => createComponent(RowTime, { timestamp: block.timestamp, id: blockIdentity(block) }),
      }) },
    }))
    return { dispose, publish, reads: () => endReads, text: () => textContent(root) }
  })
}

interface ActivityFrame {
  readonly sessionId: string | undefined
  readonly activity: import("../../../src/protocol/app-service-types.js").FrontendActivity
  readonly transcriptAvailable: boolean
  readonly atTail: boolean
  readonly settledOutputPosition: import("../../../src/protocol/status-protocol-types.js").StatusView["settledOutputPosition"]
  readonly appliedOutputPosition: number | null
  readonly transcriptText: string
  readonly waitingOn?: string
  readonly activityStartedAt?: number | null
  readonly now?: number
}

/** Mounts a sent row with the transcript owner's separately loaded body. */
export function mountUserMessage(initial: Extract<FrontendOutputBlock, { kind: "userMessage" }>, initialBody?: HydratedOutputBlockBody, disclosure: BlockDisclosure = createBlockDisclosure()) {
  acquireMeasurements()
  let disposed = false
  return createRoot((dispose) => {
    const [block, setBlock] = createSignal(initial)
    const [body, setBody] = createSignal(initialBody)
    const root = createElement("root")
    const hydrationRequests: string[] = []
    let imageLoads = 0
    insert(root, createComponent(Block, {
      get block() { return presentedBlock(block()) },
      get body() { return body() },
      sessionId: "render-ownership",
      disclosure,
      canOpenFiles: false,
      onOpenFile() {},
      onHydrate(id) { hydrationRequests.push(id) },
      onImageLoad() { imageLoads += 1 },
      onTerminateBackground() {},
      onDetachBash() {},
      working: () => false,
      onHydrateGroup() {},
      onSelectSession() {},
      roleAssignments: { get: () => undefined, subscribe: () => () => {} },
      statuses: { get: () => undefined, subscribe: () => () => {} },
      writeSyntaxTheme: "nord",
    }))
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        dispose()
        if (--measurementMounts === 0) restoreMeasurements()
      },
      setBlock, setBody, hydrationRequests, disclosure,
      measureHeight: (next: number) => {
        for (const node of nodes(root)) {
          const entry = measurements.get(node)
          if (entry) { entry.height = next; entry.resize() }
        }
      },
      toggleText: () => {
        const button = nodes(root).find(node => node.tag === "button" && /Show more|Show less/.test(textContent(node)))
        const click = button?.properties.onClick
        if (typeof click !== "function") throw new Error("Missing text disclosure control")
        click()
      },
      text: () => textContent(root),
      images: () => nodes(root).filter(node => node.tag === "img"),
      imageLoads: () => imageLoads,
    }
  })
}

/** Runs the actual block's computations under browser Solid ownership. */
export function mountTool(initial: FrontendToolEntry) {
  return createRoot((dispose) => {
    const [entry, setEntry] = createSignal(initial)
    const disclosure = createBlockDisclosure()
    const setOpen = (open: boolean) => disclosure.setOpen("render-ownership", `tool:${initial.id}`, open)
    setOpen(true)
    createComponent(Block, {
      get block() { return presentedBlock(entry()) },
      sessionId: "render-ownership",
      disclosure,
      canOpenFiles: false,
      onOpenFile() {},
      onHydrate() {},
      onTerminateBackground() {},
      onDetachBash() {},
      working: () => false,
      onHydrateGroup() {},
      onSelectSession() {},
      roleAssignments: { get: () => undefined, subscribe: () => () => {} },
      statuses: { get: () => undefined, subscribe: () => () => {} },
      writeSyntaxTheme: "nord",
    })
    return { setEntry, setOpen, dispose }
  })
}

/** Mounts the transcript status against live session activity. */
const DEFAULT_ACTIVITY_FRAME: ActivityFrame = {
  sessionId: "session-a",
  activity: "generating",
  transcriptAvailable: true,
  atTail: true,
  settledOutputPosition: 1,
  appliedOutputPosition: 0,
  transcriptText: "",
}

export function mountActivityStatus(initial: ActivityFrame = DEFAULT_ACTIVITY_FRAME) {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  let nextFrameId = 1
  let frames = new Map<number, FrameRequestCallback>()
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextFrameId
    nextFrameId += 1
    frames.set(id, callback)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  return createRoot((dispose) => {
    const [frame, setFrame] = createSignal<ActivityFrame>(initial)
    const root = createElement("root")
    insert(root, Show({
      get when(): string | undefined { return frame().sessionId },
      keyed: true as const,
      children: (_sessionId: string) => createComponent(TranscriptClock.Provider, {
        value: { now: () => frame().now ?? Date.now(), end: () => undefined },
        get children() { return createComponent(ActivityStatus, {
          get activity() { return frame().activity },
          get startedAt() { return frame().activityStartedAt },
          get transcriptAvailable() { return frame().transcriptAvailable },
          get atTail() { return frame().atTail },
          get settledOutputPosition() { return frame().settledOutputPosition },
          get appliedOutputPosition() { return frame().appliedOutputPosition },
          get waitingOn() { return frame().waitingOn },
        }) },
      }),
    }))
    const status = () => nodes(root).find(node => typeof node.properties.class === "string" && node.properties.class.split(" ").includes("activity-status"))
    const statusText = () => {
      const node = status()
      return node === undefined ? "" : textContent(node)
    }
    return {
      dispose() {
        dispose()
        globalThis.requestAnimationFrame = originalRequestAnimationFrame
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame
      },
      setFrame(next: ActivityFrame) { setFrame(next) },
      publish() { setFrame({ ...frame() }) },
      flushFrame() {
        const current = frames
        frames = new Map()
        for (const frameCallback of current.values()) {
          frameCallback(performance.now())
        }
      },
      pendingFrames: () => frames.size,
      statusExiting: () => {
        const classList = status()?.properties.classList
        return typeof classList === "object" && classList !== null && "hidden" in classList && classList.hidden === true
      },
      statusHidden: () => status()?.properties["aria-hidden"] === true,
      statusText,
      text: () => `${frame().transcriptText}${status()?.properties["aria-hidden"] === true ? "" : statusText()}`,
    }
  })
}

/** Mounts streaming Markdown using the host's opaque parsed-markup nodes. */
export function mountMarkdown(initial: string) {
  return createRoot((dispose) => {
    const [source, publish] = createSignal({ text: initial })
    const root = createElement("root")
    insert(root, createComponent(Markdown, { class: "markdown", get source() { return source().text } }))
    const body = () => nodes(root).find(node => node.properties.class === "markdown")
    return {
      dispose,
      publish: (text: string) => publish({ text }),
      children: () => [...body()?.childNodes ?? []],
      text: () => textContent(root),
    }
  })
}

/** Mounts one agent group through its first disclosure and hydration. */
export function mountAgentGroup(initial: Extract<FrontendOutputBlock, { kind: "agentGroup" }>, extension?: WebModuleClient, admittedActions: readonly ("subagent.interrupt" | "subagent.resume")[] = [], failDetail = false) {
  return createRoot((dispose) => {
    const [children, setChildren] = createSignal<{ readonly children: readonly FrontendToolEntry[]; readonly total: number } | undefined>()
    const [block, setBlock] = createSignal(initial)
    const statusListeners = new Map<string, (view: import("../../../src/protocol/status-protocol-types.js").StatusView | undefined) => void>()
    const root = createElement("root")
    let hydrationRequests = 0
    const selectedSessions: string[] = []
    const terminated: string[] = []
    const controls = agentGroupClient(admittedActions, failDetail)
    insert(root, () => createComponent(ClientContext.Provider, {
      value: controls.client,
      get children() { return createComponent(ClientExtensionsProvider, {
      value: extension === undefined ? [] : [extension],
      get children() { return createComponent(Block, {
      get block() { return presentedBlock(block()) },
      sessionId: "render-ownership",
      disclosure: createBlockDisclosure(),
      canOpenFiles: false,
      onOpenFile() {},
      onHydrate() {},
      onTerminateBackground(id) { terminated.push(id) },
      onDetachBash() {},
      working: () => false,
      onHydrateGroup() { hydrationRequests += 1 },
      onSelectSession(sessionId) { selectedSessions.push(sessionId) },
      roleAssignments: { get: () => undefined, subscribe: () => () => {} },
      statuses: {
        get: () => undefined,
        subscribe(sessionId, listener) {
          statusListeners.set(sessionId, listener)
          return () => { statusListeners.delete(sessionId) }
        },
      },
      get group() { return children() },
      writeSyntaxTheme: "nord",
      }) },
    }) },
    }))
    const disclosure = () => {
      const found = nodes(root).find(node => node.tag === "button" && node.properties.class === "disclosure")
      if (!found) throw new Error("Missing agent group disclosure")
      return found
    }
    return {
      dispose() { dispose(); controls.dispose() },
      text: () => textContent(root),
      elements: () => nodes(root).filter(node => node.tag !== undefined),
      hydrationRequests: () => hydrationRequests,
      selectedSessions: () => selectedSessions,
      mutations: controls.mutations, terminated, failures: controls.failures, detailReads: controls.detailReads,
      heldDetails: controls.heldDetails, replaceAdmission: controls.replaceAdmission,
      click(label: string, menu = false) {
        const button = nodes(root).find(node => node.tag === "button" && node.properties["aria-label"] === label && (!menu || node.properties.role === "menuitem"))
        const handler = button?.properties.onClick
        if (typeof handler !== "function") throw new Error(`Missing subagent control: ${label}`)
        handler({})
      },
      expansionPending: () => disclosure().properties["data-expansion-pending"] === true,
      setChildren,
      setBlock,
      /** Publishes the status of a child that the card watches. */
      setChildStatus(sessionId: string, status: Pick<import("../../../src/protocol/status-protocol-types.js").StatusView, "waitingOnBackgroundWork" | "replyWaits" | "activeBackgroundCommands" | "activeForegroundBashToolCallIds">) {
        statusListeners.get(sessionId)?.({ ...statusView(), ...status })
      },
      open() {
        const handler = disclosure().properties.onClick
        if (typeof handler !== "function") throw new Error("Agent group disclosure has no click handler")
        handler({})
      },
    }
  })
}

/** Publishes provisional file bodies through the resident diff renderer. */
export function mountFileDiff(initial: FileChangeBody) {
  return createRoot(dispose => {
    const [body, publish] = createSignal(initial)
    const root = createElement("root")
    insert(root, createComponent(FileDiff, { get body() { return body() } }))
    return {
      dispose, publish,
      body: () => nodes(root).find(node => node.properties.class === "diff"),
      text: () => textContent(root),
    }
  })
}

/** Mounts the retained diff renderer used by the review. */
export function mountChanges(initial: Extract<FileChangeBody, { kind: "net" }>["diff"]) {
  return createRoot((dispose) => {
    const [changes, setChanges] = createSignal(initial)
    createComponent(FileDiff, {
      get body(): FileChangeBody { return { kind: "net", diff: changes() } },
      fileExpanded: () => true,
    })
    return { setChanges, dispose }
  })
}

/** Drives real review controls under browser Solid scheduling. Controls inside
 *  one file's card are addressed by that file's path. */
export function mountReview(controller: SessionChangesController, target?: ChangesReviewTarget, onOpenFile?: (path: string, executionCwd: string) => void) {
  return createRoot(dispose => {
    const root = createElement("root")
    const owner = createElement("div")
    owner.properties.class = "changes-editor"
    owner.properties.rectHeight = 40
    insert(root, owner)
    insert(owner, () => createComponent(ChangesContent, { controller, target, ...(onOpenFile ? { onOpenFile } : {}) }))
    const withClass = (node: ReturnType<typeof createElement>, name: string) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(name)
    const file = (path: string) => {
      // A header shows the path relative to the session's directory and keeps the full path in its title.
      const found = nodes(root).find(node => withClass(node, "changes-file") && nodes(node).some(child => withClass(child, "changes-file-path") && child.properties.title === path))
      if (!found) throw new Error(`Missing file card: ${path}`)
      return found
    }
    const button = (label: string, path?: string) => {
      const found = nodes(path === undefined ? root : file(path)).find(node => node.tag === "button" && (textContent(node) === label || node.properties["aria-label"] === label))
      if (!found) throw new Error(`Missing button: ${label}`)
      return found
    }
    const fileDescendant = (path: string, className: string) => {
      const found = nodes(file(path)).find(node => withClass(node, className))
      if (!found) throw new Error(`Missing ${className}: ${path}`)
      return found
    }
    const invoke = (node: ReturnType<typeof createElement>, name: string) => {
      const handler = node.properties.onClick
      if (typeof handler !== "function") throw new Error(`No click handler: ${name}`)
      handler({ stopPropagation() {} })
    }
    return {
      dispose,
      text: () => textContent(root),
      fileText: (path: string) => textContent(file(path)),
      headerText: (path: string, className: string) => textContent(fileDescendant(path, className)),
      changeLabel: (path: string) => fileDescendant(path, "changes-file-change").properties["aria-label"],
      copyPath(path: string) {
        const handler = fileDescendant(path, "changes-file-path").properties.onCopy
        if (typeof handler !== "function") throw new Error(`Missing path copy handler: ${path}`)
        let copied = ""
        handler({ clipboardData: { setData: (_type: string, text: string) => { copied = text } }, preventDefault() {} })
        return copied
      },
      fileNode: (path: string) => file(path),
      buttonNode: (label: string, path?: string) => button(label, path),
      fileBodyNode: (path: string) => fileDescendant(path, "changes-file-body"),
      diffNode: (path: string) => fileDescendant(path, "diff"),
      count: (className: string) => nodes(root).filter(node => withClass(node, className)).length,
      scrolled: (path: string) => file(path).properties.scrolledIntoView !== undefined,
      disabled: (label: string, path?: string) => button(label, path).properties.disabled === true,
      click(label: string, path?: string) {
        const node = button(label, path)
        if (node.properties.disabled) throw new Error(`Disabled button: ${label}`)
        invoke(node, label)
      },
      toggle(path: string) {
        const header = file(path).children.find(child => child.tag === "header")
        if (!header) throw new Error(`Missing header: ${path}`)
        invoke(header, `header ${path}`)
      },
      checked(path: string) {
        const input = nodes(file(path)).find(node => node.tag === "input" && node.properties.type === "checkbox")
        if (!input) throw new Error(`Missing Viewed checkbox: ${path}`)
        return input.properties.checked === true
      },
      viewedWorking: (path: string) => fileDescendant(path, "changes-file-viewed").properties["aria-busy"] === true,
      viewedDisabled(path: string) {
        const input = nodes(file(path)).find(node => node.tag === "input" && node.properties.type === "checkbox")
        if (!input) throw new Error(`Missing Viewed checkbox: ${path}`)
        return input.properties.disabled === true
      },
      setGeometry(entries: readonly { path: string; top: number; height: number }[]) {
        for (const entry of entries) {
          const section = file(entry.path)
          section.properties.rectTop = entry.top
          section.properties.rectHeight = entry.height
        }
      },
      scrollTop: () => owner.scrollTop,
      userScroll(value: number) {
        owner.scrollTop = value
        owner.dispatch("scroll")
      },
      /** Sends the scroll owner one event, such as the person's `wheel`. */
      ownerDispatch(type: string) { owner.dispatch(type) },
      key(path: string, key: string) {
        const header = file(path).children.find(child => child.tag === "header")
        const handler = header?.properties.onKeyDown
        if (typeof handler !== "function") throw new Error(`Missing header key handler: ${path}`)
        handler({ key })
      },
      setViewed(path: string, checked: boolean) {
        const input = nodes(file(path)).find(node => node.tag === "input" && node.properties.type === "checkbox")
        const handler = input?.properties.onChange
        if (typeof handler !== "function") throw new Error(`Missing Viewed checkbox handler: ${path}`)
        handler({ currentTarget: { checked }, stopPropagation() {} })
      },
    }
  })
}
