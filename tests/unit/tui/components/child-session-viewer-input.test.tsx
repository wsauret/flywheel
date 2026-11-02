/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it, mock } from "bun:test"
import { createSignal } from "solid-js"
import { testRender, useKeyboard } from "@opentui/solid"
import { ChildSessionViewer, createChildSessionViewerInput as createInput } from "../../../../src/tui/components/child-session-viewer.js"
import { createTerminalChatSubmissions } from "../../../../src/tui/hooks/create-chat-submissions.js"
import { createComposerReturns } from "../../../../src/protocol/client/composer-returns.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { normalizeChatInput } from "../../../../src/infra/chat-input.js"
import { childBodyProps, viewerSurface } from "./_child-session-viewer-fixtures.js"
import { transcriptOf } from "../_output-window-transcript.js"
import { ComposerBody, ComposerFrame, composerBodyGeometry } from "../../../../src/tui/components/composer-frame.js"
import { ThemeProvider, useTheme } from "../../../../src/tui/context/theme.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createPromptBorderChunks } from "../../../../src/tui/components/composer-border-labels.js"
import { TickPoolProvider } from "../../../../src/tui/context/tick-pool-context.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

async function createChildSessionViewerInput(deps: { onClose: () => void; onSubmit: (text: string) => Promise<boolean>; dispatchCommand?: (text: string) => Promise<boolean> }, openModel = () => {}) {
  const input = createInput({ onClose: deps.onClose, dispatchCommand: deps.dispatchCommand ?? (async () => false) })
  input.bindMessaging({ admits: () => true, shown: () => true, send: deps.onSubmit })
  function Prompt() {
    const { theme } = useTheme()
    useKeyboard(input.onKey)
    const border = createPromptBorderChunks({ theme, lineWidth: () => 80, idle: () => false, status: () => null,
      layout: () => ({ modelLabel: "Child model high", hints: [], update: undefined, sessionsClickHint: null }) })
    return <ComposerFrame theme={theme} width={80} bodyHeight={composerBodyGeometry(80, input.lines()).height}
      topRightChunks={border.topRightChunks} bottomLeftChunks={border.bottomLeftChunks} bottomRightChunks={border.bottomRightChunks} controls={border.controls} actions={{ model: openModel }}>
      <ComposerBody theme={theme} width={80} lines={input.lines()} text={input.text()} placeholder="Message this subagent"
        attach={(prompt) => { input.attach(prompt); prompt.focus() }} onSubmit={input.submit} />
    </ComposerFrame>
  }
  const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider><Prompt /></TickPoolProvider></ThemeProvider>, { width: 80, height: 12 })
  renders.push(render)
  await render.renderOnce()
  return input
}

describe("child session viewer input owner", () => {
  it("sends through the terminal owner and claims its unread return without a duplicate queued row", async () => {
    const sent: FrontendMutation[] = []
    const lanes = { onLane: () => () => {} }
    const dispatch = async (mutation: FrontendMutation) => { sent.push(mutation); return { ok: true as const } }
    const submissions = createTerminalChatSubmissions({
      lanes, dispatch: (sessionId, input) => dispatch({ type: "session.send", sessionId, input }), report: () => {},
    })
    const input = createInput({ onClose: () => {}, dispatchCommand: async () => false })
    const [transcript, setTranscript] = createSignal(transcriptOf([]))
    const surface = viewerSurface("subagent", { transcript: { ...transcript(), visibleRange: () => transcript().visibleRange() } })
    const render = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
      <ChildSessionViewer {...childBodyProps()} sessionId="child" input={input} createSurface={() => surface}
        active={() => true} focused={() => true} appService={{ dispatch: async () => { throw new Error("viewer bypassed its submission owner") }, query: async () => { throw new Error("unexpected query") } }}
        submissions={{ send: submissions.sendWithReceipt, recallQueued: submissions.recallQueued }}
        onClose={() => {}} showToast={() => {}} compactionThreshold={() => undefined} />
    </TickPoolProvider></ThemeProvider>, { width: 100, height: 32 })
    renders.push(render)
    try {
      await render.flush()
      input.onPaste("unread guidance")
      input.submit()
      await render.flush()
      const mutation = sent[0]
      if (mutation?.type !== "session.send") throw new Error("expected session.send")
      const submitted = normalizeChatInput(mutation.input)
      expect(submitted.submissionIds).toHaveLength(1)
      const id = submitted.submissionIds![0]!
      expect(submissions.ownsSubmission(id)).toBe(true)
      expect(input.text()).toBe("")
      const queued = { kind: "userMessage" as const, id: `person:${id}`, content: submitted.text, timestamp: 1, pending: true, injected: false, submissionIds: [id] }
      setTranscript(transcriptOf([queued]))
      submissions.observe("child", [queued], { startBlockIndex: 0 })
      await render.flush()
      expect(render.captureCharFrame().match(/unread guidance/g)).toHaveLength(1)
      const appended: string[] = []
      const claims: string[][] = []
      const returned = { noticeId: `returned-input:child:person:${id}`, sourceSessionId: "child", sourceName: "Child", input: submitted }
      const coordinator = createComposerReturns({
        client: { ...lanes, dispatch: async (claim) => { claims.push([...claim.submissionIds]); return { ok: true, kind: "claimed", items: [returned] } } },
        ownsSubmission: submissions.ownsSubmission, settled: submissions.settleReturned,
        append: (_parent, item) => { appended.push(item.input.text) }, report: () => {},
      })
      coordinator.own(["parent"])
      coordinator.observe("parent", { kind: "window", reason: "install", adopted: [{ kind: "system", id: returned.noticeId, message: "Child finished", timestamp: 2 }] })
      await Bun.sleep(0)
      expect(claims).toEqual([[id]])
      expect(appended).toEqual(["unread guidance"])
      coordinator.dispose()
    } finally { submissions.dispose() }
  })
  it.each([true, false])("waits for the send receipt before returning the finished viewer draft (accepted=%s)", async (accepted) => {
    const reply = Promise.withResolvers<boolean>()
    const moved: string[] = []
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: () => reply.promise })
    input.bindMessaging({ admits: () => true, shown: () => true, sessionId: () => "child", send: () => reply.promise, returnToParent: (_id, value) => { moved.push(typeof value === "string" ? value : value.text) } })
    input.onPaste("sent")
    input.submit()
    input.onPaste(" edits")
    input.finish()
    expect(moved).toEqual([])
    reply.resolve(accepted)
    await Bun.sleep(0)
    expect(moved).toEqual([accepted ? " edits" : "sent edits"])
    expect(input.text()).toBe("")
  })
  it("routes slash text through the command dispatcher, never to the agent, and keeps a refused command", async () => {
    const sent: string[] = []
    const dispatched: string[] = []
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async (text) => { sent.push(text); return true }, dispatchCommand: async (text) => { dispatched.push(text); return text === "/effort" } })
    for (const typed of ["/xyzzy", "/compact"]) {
      input.onPaste(typed)
      input.submit()
      await Bun.sleep(0)
      expect(input.text()).toBe(typed)
      for (let index = 0; index < typed.length; index++) input.onKey({ name: "backspace" })
    }
    input.onPaste("/effort")
    input.submit()
    await Bun.sleep(0)
    expect(input.text()).toBe("")
    expect(dispatched).toEqual(["/xyzzy", "/compact", "/effort"])
    expect(sent).toEqual([])
  })
  it("preserves edits made while submission awaits acknowledgement", async () => {
    const acknowledgement = Promise.withResolvers<boolean>()
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: () => acknowledgement.promise })
    input.onPaste("submitted")
    input.submit()
    input.onPaste(" newer")
    acknowledgement.resolve(true)
    await Bun.sleep(0)
    expect(input.text()).toBe(" newer")
    const moved: string[] = []
    input.bindMessaging({ admits: () => true, shown: () => true, sessionId: () => "child", send: async () => true, returnToParent: (_id, value) => { moved.push(typeof value === "string" ? value : value.text) } })
    input.finish()
    expect(moved).toEqual([" newer"])
  })
  it("keeps the normal model control clickable without the global shortcut strip", async () => {
    const openModel = mock(() => {})
    await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true }, openModel)
    const render = renders.at(-1)!
    const rows = render.captureCharFrame().split("\n")
    const y = rows.findIndex((row) => row.includes("Child model high"))
    const x = rows[y]!.indexOf("Child model high")
    expect(y).toBe(0)
    await render.mockMouse.pressDown(x + 1, y)
    await render.mockMouse.release(x + 1, y)
    expect(openModel).toHaveBeenCalledTimes(1)
    expect(render.captureCharFrame()).not.toContain("ctrl+n")
    expect(render.captureCharFrame()).not.toContain("sessions")
  })
  it("uses the ordinary frame geometry and grows for a multiline message", async () => {
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true })
    const render = renders.at(-1)!
    expect(composerBodyGeometry(80, input.lines())).toEqual({ width: 76, height: 3, top: 1 })
    // A terminal that reports no cursor colour gets the theme's primary colour.
    expect(render.renderer.getCursorState().color.equals(resolveTheme(flywheelTheme, "dark").primary)).toBe(true)
    input.onPaste("one\ntwo\nthree\nfour")
    await render.renderOnce()
    expect(input.lines()).toBe(4)
    expect(composerBodyGeometry(80, input.lines())).toEqual({ width: 76, height: 4, top: 0 })
    const frame = render.captureCharFrame()
    for (const line of ["one", "two", "three", "four"]) expect(frame).toContain(line)
    expect(frame).toContain(">")
  })

  it("claims keys inside the modal without leaking shortcuts or double typing", async () => {
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true })
    const modal = createModalStack()
    modal.push(null, { onKey: input.onKey, onPaste: input.onPaste })
    const parent = mock(() => {})
    const preventDefault = mock(() => {})
    await renders.at(-1)!.mockInput.typeText("a")
    expect(input.text()).toBe("a")
    for (const event of [{ name: "n", ctrl: true }, { name: "w", ctrl: true }]) {
      if (!modal.input({ ...event, preventDefault })) parent()
    }
    expect(parent).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it("preserves a multiline message and uses modified Enter for a newline", async () => {
    const submit = mock(async (_text: string) => true)
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: submit })
    input.onPaste("first\nsecond")
    input.onKey({ name: "return", shift: true })
    input.onPaste("third")
    input.onKey({ name: "return" })
    await Promise.resolve()
    expect(submit).toHaveBeenCalledWith("first\nsecond\nthird")
  })
  it("owns paste and submission without touching foreground input", async () => {
    const submit = mock(async (_text: string) => true)
    const close = mock(() => {})
    const input = await createChildSessionViewerInput({ onClose: close, onSubmit: submit })

    input.onPaste("inspect this")
    input.onKey({ name: "return" })
    await Promise.resolve()

    expect(submit).toHaveBeenCalledWith("inspect this")
    expect(close).not.toHaveBeenCalled()
  })

  it("routes transcript paging inside the viewer", async () => {
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true })
    const output = mock(() => {})
    input.bindOutput(output)

    input.onKey({ name: "pageup" })
    input.onKey({ name: "pagedown" })

    expect(output).toHaveBeenNthCalledWith(1, "page-up")
    expect(output).toHaveBeenNthCalledWith(2, "page-down")
  })

  it("closes the viewer on Escape and sends nothing", async () => {
    const submit = mock(async (_text: string) => true)
    const close = mock(() => {})
    const input = await createChildSessionViewerInput({ onClose: close, onSubmit: submit })

    input.onPaste("draft")
    input.onKey({ name: "escape" })

    expect(submit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("preserves the draft when admission refuses keyboard, paste, and submit", async () => {
    const [messageable, setMessageable] = createSignal(true)
    const submit = mock(async (_text: string) => true)
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: submit })
    input.bindMessaging({ admits: messageable, shown: messageable, send: submit })

    input.onPaste("visible draft")
    setMessageable(false)
    input.onPaste("hidden paste")
    input.onKey({ name: "h", sequence: "h" })
    input.onKey({ name: "return" })
    expect(input.text()).toBe("visible draft")
    expect(submit).not.toHaveBeenCalled()
  })
  it("recalls unread input on empty first-row Up and preserves intervening edits", async () => {
    const recalled = Promise.withResolvers<{ text: string } | null>()
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true })
    const recall = mock(() => recalled.promise)
    input.bindMessaging({ admits: () => true, shown: () => true, send: async () => true, sessionId: () => "child", recall })
    input.onKey({ name: "up" })
    input.onPaste("new draft")
    recalled.resolve({ text: "queued words" })
    await Bun.sleep(0)
    expect(input.text()).toBe("new draft\n\nqueued words")
    input.onKey({ name: "up" })
    expect(recall).toHaveBeenCalledTimes(1)
  })
  it("returns a recall that settles after finish to the parent draft", async () => {
    const recalled = Promise.withResolvers<{ text: string } | null>()
    const moved: string[] = []
    const input = await createChildSessionViewerInput({ onClose: () => {}, onSubmit: async () => true })
    input.bindMessaging({ admits: () => true, shown: () => true, send: async () => true, sessionId: () => "child", recall: () => recalled.promise,
      returnToParent: (_id, value) => { moved.push(typeof value === "string" ? value : value.text) } })
    input.onKey({ name: "up" })
    input.finish()
    recalled.resolve({ text: "recalled words" })
    await Bun.sleep(0)
    expect(moved).toEqual(["recalled words"])
    expect(input.text()).toBe("")
  })
})
