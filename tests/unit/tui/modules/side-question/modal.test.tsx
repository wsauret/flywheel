/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { sideQuestionDomain, sideQuestionRequestDomain, type SideQuestionView } from "../../../../../src/protocol/modules/side-question.js"
import type { DomainReader } from "../../../../../src/protocol/protocol-module.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"
import type { FrontendMutation } from "../../../../../src/protocol/app-service-types.js"
import type { TuiControllerHost } from "../../../../../src/tui/tui-module.js"
import type { Renderable, TextareaRenderable, ScrollBoxRenderable as ScrollBox } from "@opentui/core"
const { createSignal, createRoot } = await import("solid-js")
const { testRender } = await import("@opentui/solid")
const { ThemeProvider, useTheme } = await import("../../../../../src/tui/context/theme.js")
const { SideQuestionModal } = await import("../../../../../src/tui/modules/side-question/modal.js")
const { createSideQuestionModel } = await import("../../../../../src/tui/modules/side-question/model.js")
const { createSideQuestionSurface } = await import("../../../../../src/tui/modules/side-question/surface.js")
const { createModalStack } = await import("../../../../../src/tui/components/modal-stack.js")
const { createTextAttributes, ScrollBoxRenderable } = await import("@opentui/core")
const { ComposerBody } = await import("../../../../../src/tui/components/composer-frame.js")
const { createComposerFocus } = await import("../../../../../src/tui/hooks/create-composer-focus.js")

const query: TuiControllerHost["client"]["query"] = async () => { throw new Error("side question must not query") }

function sideQuestionReader(view: () => SideQuestionView | null | undefined): DomainReader {
  return moduleDomainReader((domain) => {
    const snapshot = view()
    if (!snapshot) return undefined
    if (domain.domain === sideQuestionDomain.domain) return { revision: snapshot.revision, exchanges: snapshot.exchanges }
    if (domain.domain === sideQuestionRequestDomain.domain) return { current: snapshot.current }
    return undefined
  })
}

test("side question renders canonical streaming views and sends identity-bound actions", async () => {
  const earlierAnswer = `Earlier answer\n${Array.from({ length: 40 }, (_, index) => `Retained line ${index}`).join("\n")}`
  const [view, setView] = createSignal<SideQuestionView | null>(null)
  const requests: unknown[] = []
  const copied: string[] = []
  const destinations: string[] = []
  let refusal: string | undefined
  const read = sideQuestionReader(view)
  const answered = async (request: FrontendMutation) => { requests.push(request); return refusal ? { ok: false as const, error: refusal } : { ok: true as const, destinationSessionId: "fork" } }
  const dispatch = runtimeDispatch({ "side-question.ask": answered, "side-question.clear": answered, "side-question.keep": answered, "side-question.stop": answered })
  let model: ReturnType<typeof createSideQuestionModel> | undefined
  let colors: ReturnType<typeof useTheme>["theme"] | undefined
  let closed = 0
  function Harness() {
    colors = useTheme().theme
    model = createSideQuestionModel({
      enabled: () => true, read, client: { dispatch, query }, clipboard: { copy: async (text: string) => { copied.push(text) } },
      navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: (id: string) => { destinations.push(id) } },
      showToast: () => {},
    }, "parent", () => { closed++ })
    return <SideQuestionModal model={model} />
  }
  const rendered = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 90, height: 35 })
  try {
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Temporary · no tools")
    expect(rendered.captureCharFrame()).toContain("Ask a side question")
    if (!model) throw new Error("Model did not mount")
    model.setDraft("  why?  ")
    await model.ask()
    expect(requests).toEqual([{ type: "side-question.ask", sessionId: "parent", question: "why?" }])
    setView({ revision: 2, exchanges: [{ id: "old", question: "Earlier", answer: earlierAnswer }], current: { id: "live", question: "why?", answer: "", state: "running" } })
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Waiting for an answer")
    setView({ ...view()!, revision: 3, current: { id: "live", question: "why?", answer: "**Live** answer", state: "running" } })
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Live answer")
    expect(rendered.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("Live") && (span.attributes & createTextAttributes({ bold: true })) !== 0)).toBe(true)
    model.key({ name: "tab" })
    expect(model.focus()).toBe(1)
    model.key({ name: "enter" })
    expect(model.selected()?.id).toBe("old")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Earlier answer")
    expect(rendered.captureCharFrame()).toContain("Answering...")
    const tree: Renderable[] = [rendered.renderer.root]
    let answerScroll: InstanceType<typeof ScrollBoxRenderable> | undefined
    while (tree.length) {
      const element = tree.pop()!
      if (element instanceof ScrollBoxRenderable) { answerScroll = element; break }
      tree.push(...element.getChildren())
    }
    if (!answerScroll) throw new Error("Answer scroll did not mount")
    model.scroll.scrollTo(5)
    await rendered.renderOnce()
    const scrollBefore = answerScroll.scrollTop
    expect(scrollBefore).toBeGreaterThan(0)
    const browsedFrame = rendered.captureCharFrame()
    setView({ ...view()!, revision: 4, current: { id: "live", question: "why?", answer: "More streaming", state: "running" } })
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toBe(browsedFrame)
    expect(rendered.captureCharFrame()).not.toContain("More streaming")
    expect(answerScroll.scrollTop).toBe(scrollBefore)
    await model.copy()
    expect(copied).toEqual([earlierAnswer])
    await model.clear()
    expect(requests.at(-1)).toEqual({ type: "side-question.clear", sessionId: "parent", revision: 4 })
    await model.keep()
    expect(requests.at(-2)).toEqual({ type: "side-question.keep", sessionId: "parent", exchangeId: "old" })
    expect(requests.at(-1)).toEqual({ type: "side-question.stop", sessionId: "parent", requestId: "live" })
    expect(destinations).toEqual(["fork"])
    expect(closed).toBe(1)
    model.key({ name: "tab" })
    expect(model.focus()).toBe(2)
    model.key({ name: "enter" })
    expect(model.selected()?.id).toBe("live")
    setView({ ...view()!, current: { id: "live", question: "why?", answer: "Partial", state: "stopped" } })
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Stopped")
    const stoppedCount = requests.length
    await model.keep()
    expect(requests).toHaveLength(stoppedCount)
    await model.copy()
    expect(copied.at(-1)).toBe("Partial")
    setView({ ...view()!, current: { id: "live", question: "why?", answer: "", state: "error", error: "Provider refused" } })
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Provider refused")
    await model.keep()
    expect(requests).toHaveLength(stoppedCount)
    const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.some((span) => span.text.includes("Temporary") && span.fg.equals(colors!.textMuted))).toBe(true)
    expect(spans.some((span) => span.text.includes("Provider refused") && span.fg.equals(colors!.error))).toBe(true)
    rendered.resize(42, 32)
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Keep as fork")
    expect(rendered.captureCharFrame()).toContain("Close")
    const requestCount = requests.length
    model.setDraft(" ".repeat(4))
    await model.ask()
    model.setDraft("x".repeat(8001))
    await model.ask()
    expect(requests).toHaveLength(requestCount)
    model.setDraft("")
    refusal = "History changed. Try again."
    await model.clear()
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("History changed. Try again.")
  } finally { rendered.renderer.destroy() }
})

test("surface owns typing, close, session-switch cleanup and stale request identity", async () => {
  const modal = createModalStack()
  const [sessionId, setSessionId] = createSignal<string | undefined>("parent")
  const [enabled, setEnabled] = createSignal(true)
  const [view, setView] = createSignal<SideQuestionView | undefined>({ revision: 1, exchanges: [], current: { id: "first", question: "Q", answer: "", state: "running" } })
  const requests: unknown[] = []
  const read = sideQuestionReader(view)
  const answered = async (request: FrontendMutation) => { requests.push(request); return { ok: true as const } }
  const dispatch = runtimeDispatch({ "side-question.ask": answered, "side-question.clear": answered, "side-question.keep": answered, "side-question.stop": answered })
  let dispose = () => {}
  const open = createRoot((release) => {
    dispose = release
    return createSideQuestionSurface({ enabled, read, modal, client: { dispatch, query: async () => { throw new Error("No queries") } }, foregroundId: sessionId, auth: () => undefined, projectRoot: () => "", appVersion: "0.0.0-test", showToast: () => {}, clipboard: { copy: async () => {} }, navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} } })
  })
  open()
  const content = () => {
    const entry = modal.stack.at(-1)
    return typeof entry?.element === "function" ? entry.element() : entry?.element
  }
  let parentInput: TextareaRenderable | undefined
  let parentScroll: ScrollBox | undefined
  function Harness() {
    const { theme } = useTheme()
    const attachFocus = createComposerFocus(() => modal.stack.length === 0, sessionId)
    return <box flexDirection="column">
      <scrollbox ref={(scroll: ScrollBox) => { parentScroll = scroll }} height={3} scrollY>
        <text>{"parent line\n".repeat(30)}</text>
      </scrollbox>
      <ComposerBody theme={theme} width={88} lines={3} text="unsent parent draft" placeholder="" onSubmit={() => { throw new Error("Parent must not submit") }} attach={(input) => { parentInput = input; input.setText("unsent parent draft"); attachFocus(input) }} />
      {content()}
    </box>
  }
  const rendered = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 90, height: 60 })
  try {
    await rendered.renderOnce()
    if (!parentScroll || !parentInput) throw new Error("Parent controls did not mount")
    parentScroll.scrollTo(5)
    await rendered.renderOnce()
    const parentOffset = parentScroll.scrollTop
    expect(parentInput.focused).toBe(false)
    await rendered.mockInput.typeText("quiet question")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("quiet question")
    expect(requests).toHaveLength(0)
    expect(parentInput.plainText).toBe("unsent parent draft")
    expect(parentScroll.scrollTop).toBe(parentOffset)
    let consumed = false
    modal.input({ name: "q", sequence: "q", preventDefault: () => { consumed = true } })
    expect(consumed).toBe(false)
    modal.input({ name: "tab", preventDefault: () => { consumed = true } })
    expect(consumed).toBe(true)
    modal.input({ name: "tab", shift: true })
    modal.paste(" paste")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("quiet question paste")
    const staleKey = modal.stack.at(-1)?.onKey
    modal.input({ name: "escape" })
    expect(requests).toEqual([{ type: "side-question.stop", sessionId: "parent", requestId: "first" }])
    expect(modal.stack).toHaveLength(0)
    await rendered.renderOnce()
    expect(parentInput.focused).toBe(true)
    expect(parentInput.plainText).toBe("unsent parent draft")
    expect(parentScroll.scrollTop).toBe(parentOffset)
    setView({ revision: 2, exchanges: [], current: { id: "second", question: "Next", answer: "", state: "running" } })
    open()
    await rendered.renderOnce()
    staleKey?.({ name: "escape" })
    expect(modal.stack).toHaveLength(1)
    expect(requests).toHaveLength(1)
    setSessionId("other")
    await rendered.renderOnce()
    expect(requests.at(-1)).toEqual({ type: "side-question.stop", sessionId: "parent", requestId: "second" })
    expect(modal.stack).toHaveLength(0)
    setView({ revision: 3, exchanges: [], current: { id: "second", question: "Next", answer: "Done", state: "done" } })
    open()
    await rendered.renderOnce()
    await rendered.mockInput.typeText("follow up")
    await rendered.mockInput.pressKey("RETURN")
    await rendered.renderOnce()
    expect(requests.at(-1)).toEqual({ type: "side-question.ask", sessionId: "other", question: "follow up" })
    expect(parentInput.plainText).toBe("unsent parent draft")
    setView({ revision: 4, exchanges: [], current: { id: "admitted", question: "Follow up", answer: "", state: "running" } })
    await rendered.renderOnce()
    const beforeDisable = requests.length
    setEnabled(false)
    dispose()
    await rendered.renderOnce()
    expect(modal.stack).toHaveLength(0)
    expect(requests).toHaveLength(beforeDisable)
  } finally { rendered.renderer.destroy(); dispose() }
})

test.each([{ width: 100, height: 18 }, { width: 42, height: 24 }, { width: 42, height: 20 }, { width: 90, height: 35 }])("side question keeps answer, request status and controls visible at $width by $height", async (size) => {
  const [view, setView] = createSignal<SideQuestionView>({ revision: 1, exchanges: [], current: { id: "live", question: "Question", answer: Array.from({ length: 80 }, (_, index) => `Answer line ${index}`).join("\n"), state: "running" } })
  const requests: unknown[] = []
  const answered = async (request: FrontendMutation) => { requests.push(request); return { ok: true as const } }
  const dispatch = runtimeDispatch({ "side-question.ask": answered, "side-question.clear": answered, "side-question.keep": answered, "side-question.stop": answered })
  let model: ReturnType<typeof createSideQuestionModel> | undefined
  let colors: ReturnType<typeof useTheme>["theme"] | undefined
  function Harness() {
    colors = useTheme().theme
    model = createSideQuestionModel({ enabled: () => true, read: sideQuestionReader(view), client: { dispatch, query }, clipboard: { copy: async () => {} }, navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }, showToast: () => {} }, "parent", () => {})
    return <SideQuestionModal model={model} />
  }
  const rendered = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, size)
  try {
    await rendered.renderOnce()
    const frame = rendered.captureCharFrame()
    for (const label of ["Answer line", "Answering...", "Ask", "Copy", "Clear", "Stop", "Keep as fork", "Close", "Ask a question"]) expect(frame).toContain(label)
    if (!model) throw new Error("Model did not mount")
    model.scroll.scrollTo(30)
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Answering...")
    setView({ ...view(), current: { ...view().current!, state: "stopped" } })
    await rendered.renderOnce()
    expect(rendered.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("Stopped") && span.fg.equals(colors!.warning))).toBe(true)
    setView({ ...view(), current: { ...view().current!, state: "error", error: "Provider refused" } })
    await rendered.renderOnce()
    expect(rendered.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("Provider refused") && span.fg.equals(colors!.error))).toBe(true)
    await model.keep()
    expect(requests).toHaveLength(0)
  } finally { rendered.renderer.destroy() }
})

test("automatic retirement during ask admission leaves the admitted request running", async () => {
  const admitted = Promise.withResolvers<{ ok: true; requestId: string }>()
  const requests: unknown[] = []
  const dispatch = runtimeDispatch({ "side-question.ask": (request) => { requests.push(request); return admitted.promise } })
  const [enabled, setEnabled] = createSignal(true)
  const root = createRoot((dispose) => ({ dispose, model: createSideQuestionModel({ enabled, read: () => undefined, client: { dispatch, query }, clipboard: { copy: async () => {} }, navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }, showToast: () => {} }, "parent", dispose) }))
  root.model.setDraft("question")
  const asking = root.model.ask()
  setEnabled(false)
  root.dispose()
  admitted.resolve({ ok: true, requestId: "admitted" })
  await asking
  expect(requests).toEqual([{ type: "side-question.ask", sessionId: "parent", question: "question" }])
})

test("closing during ask admission stops only the admitted request after disposal", async () => {
  const admitted = Promise.withResolvers<{ ok: true; requestId: string }>()
  const requests: unknown[] = []
  const answered = async (request: FrontendMutation) => { requests.push(request); return { ok: true as const } }
  const dispatch = runtimeDispatch({ "side-question.ask": (request) => { requests.push(request); return admitted.promise }, "side-question.clear": answered, "side-question.keep": answered, "side-question.stop": answered })
  const root = createRoot((dispose) => {
    const model = createSideQuestionModel({ enabled: () => true, read: () => undefined, client: { dispatch, query }, clipboard: { copy: async () => {} }, navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }, showToast: () => {} }, "parent", dispose)
    return { model, dispose }
  })
  root.model.setDraft("question")
  const asking = root.model.ask()
  root.model.close()
  admitted.resolve({ ok: true, requestId: "admitted" })
  await asking
  expect(requests).toEqual([{ type: "side-question.ask", sessionId: "parent", question: "question" }, { type: "side-question.stop", sessionId: "parent", requestId: "admitted" }])
  root.dispose()
})
