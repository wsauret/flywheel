import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import type { ChatInputLike } from "../../../../src/infra/chat-input.js"
import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"
import type { ComposerHandle, ComposerProps } from "../../../../src/tui/components/composer-types.js"
import { createComposerPopupKeySlot } from "../../../../src/tui/hooks/create-composer-popup-key-slot.js"
import type { ForegroundTarget } from "../../../../src/tui/hooks/shell-state.js"
import { createSessionCreator } from "../../../../src/tui/hooks/create-session-creator.js"
import { createTabState } from "../../../../src/tui/hooks/create-tabs.js"
import { mountPrompt, typeAsHuman } from "./prompt-area-fixture.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe("Composer draft loading", () => {
  it.each([
    ["/code-revew", "enter", "/code-review "],
    ["/pair", "enter", "/fly.raindrop-audit "],
    ["/settings", "enter", "/settings "],
    ["/config", "enter", "/config "],
    ["/quit", "enter", "/quit"],
    ["/zzzzqq", "enter", "/zzzzqq"],
    ["/set", "tab", "/settings "],
    ["/set", "down", "/config "],
    ["/set", "up", "/config "],
    ["/set", "click", "/config "],
    ["/set", "hover", "/settings "],
    ["/set", "escape", "/set"],
    ["/set", "down-wheel", "/settings "],
    ["/set", "query-change", "/settings "],
    ["/set", "catalog-change", "/settings "],
    ["/set", "shift-enter", "/set\n"],
  ])("handles %s with %s through the visible popup selection", async (query, gesture, expected) => {
    const draftCache = createDraftCache()
    draftCache.set("chat-1", { text: query, pastes: [], attachments: [] })
    const [catalog, setCatalog] = createSignal<ComposerProps["slashCatalog"]>([
      { id: "settings", value: "/settings", title: "Settings", footer: "/settings" },
      { id: "config", value: "/config", title: "Settings", footer: "/config" },
      { id: "review", value: "/code-review", title: "Code Review", footer: "/code-review" },
      { id: "audit", value: "/fly.raindrop-audit", title: "Repair findings", footer: "/fly.raindrop-audit" },
    ])
    const submissions: ChatInputLike[] = []
    const promptPopupKeySlot = createComposerPopupKeySlot()
    const result = await mountPrompt({
      draftCache, foregroundId: () => "chat-1", slashCatalog: catalog, promptPopupKeySlot,
      kittyKeyboard: gesture === "shift-enter" || gesture === "escape",
      dispatchableNames: () => [...catalog().map(row => row.value.slice(1)), "quit"],
      onSubmit: (input) => { submissions.push(input); return true },
    })
    try {
      await result.renderOnce()
      const initiallyOwnsEnter = promptPopupKeySlot.input({ name: "return" })
      expect(promptPopupKeySlot.input({ name: "tab" })).toBe(query !== "/quit" && query !== "/zzzzqq")
      if (gesture === "tab") {
        expect(promptPopupKeySlot.input({ name: "tab" })).toBe(true)
        result.mockInput.pressTab()
        expect(draftCache.get("chat-1").text).toBe("/settings ")
      }
      if (gesture === "down" || gesture === "up" || gesture === "query-change" || gesture === "catalog-change" || gesture === "down-wheel") {
        result.mockInput.pressArrow(gesture === "up" ? "up" : "down")
        expect(promptPopupKeySlot.input({ name: "return" })).toBe(true)
      }
      if (gesture === "query-change") {
        result.mockInput.pressKey("x")
        result.mockInput.pressBackspace()
        expect(promptPopupKeySlot.input({ name: "return" })).toBe(true)
      }
      if (gesture === "catalog-change") {
        setCatalog(catalog().filter(row => row.id !== "config"))
        expect(promptPopupKeySlot.input({ name: "return" })).toBe(true)
      }
      if (gesture === "hover" || gesture === "click" || gesture === "down-wheel") {
        const lines = result.captureCharFrame().split("\n")
        const row = lines.findIndex(line => line.includes("/config"))
        expect(row).toBeGreaterThanOrEqual(0)
        const column = lines[row]!.indexOf("/config")
        if (gesture === "down-wheel") await result.mockMouse.scroll(column, row, "down")
        else await result.mockMouse.moveTo(column, row)
        expect(promptPopupKeySlot.input({ name: "return" })).toBe(true)
        if (gesture === "click") await result.mockMouse.click(column, row)
      }
      if (gesture === "escape") {
        // Escape cancels the completion: the menu closes and no dimmed
        // completion hint takes its place.
        result.mockInput.pressEscape()
        await result.renderOnce()
        expect(result.captureCharFrame()).not.toContain("/settings")
        expect(result.captureCharFrame()).not.toContain("/config")
      }
      if (gesture === "shift-enter") {
        expect(promptPopupKeySlot.input({ name: "return", shift: true })).toBe(false)
        result.mockInput.pressEnter({ shift: true })
        await result.renderOnce()
        expect(submissions).toEqual([])
        expect(draftCache.get("chat-1").text).toBe(expected)
      } else {
        if (gesture !== "click") {
          expect(submissions).toEqual([])
          result.mockInput.pressEnter()
        }
        expect(submissions).toEqual([{ text: expected }])
        expect(draftCache.hasDraft("chat-1")).toBe(false)
      }
      expect(initiallyOwnsEnter).toBe(query !== "/quit" && query !== "/zzzzqq")
    } finally { result.renderer.destroy() }
  })

  it("shows a dragged image marker and sends its bytes only once after Enter", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "composer-drag-"))
    const file = path.join(directory, "photo.png")
    fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))
    const draftCache = createDraftCache()
    const submissions: ChatInputLike[] = []
    const pasted = "long pasted context\n".repeat(30)
    const sent = Promise.withResolvers<void>()
    const result = await mountPrompt({
      draftCache, foregroundId: () => "chat-1",
      onSubmit: (input) => {
        // The shell refuses an empty prompt, as `handleComposerSubmit` does.
        // When the image has loaded before the first Enter, that Enter sends
        // at once, and the second Enter reaches the empty prompt it left.
        if (!input.text.trim() && !input.attachments?.length) return false
        submissions.push(input)
        if (typeof input !== "string" && input.attachments?.length) {
          sent.resolve()
        }
        return true
      },
    })
    try {
      await result.renderOnce()
      await result.mockInput.pasteBracketedText(pasted)
      await result.mockInput.pasteBracketedText(file)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("[Image #1]")
      expect(result.captureCharFrame()).not.toContain(file)
      result.mockInput.pressEnter()
      result.mockInput.pressEnter()
      await sent.promise
      await result.renderOnce()

      expect(submissions).toHaveLength(1)
      expect(submissions[0]).toMatchObject({
        text: `${pasted}[Image #1]`,
        attachments: [{ marker: "[Image #1]", mediaType: "image/png" }],
      })
      const submission = submissions[0]
      expect(typeof submission === "object" ? submission.attachments?.[0]?.data.length : 0).toBeGreaterThan(0)
      expect(draftCache.hasDraft("chat-1")).toBe(false)
    } finally {
      result.renderer.destroy()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("adopts a reused foreground session into its live edited buffer and preserves both drafts on the next edit and focus switch", async () => {
    const request = Promise.withResolvers<{ ok: true; sessionId: string }>()
    const draftCache = createDraftCache()
    let handle: ComposerHandle = { adoptDraft: draftCache.adopt, persistDraft: () => {}, appendInput: () => {} }
    const h = createRoot((dispose) => {
      const [foregroundTarget, setForegroundTarget] = createSignal<ForegroundTarget>({ kind: "session", sessionId: "reuse" })
      const foregroundId = createMemo(() => { const target = foregroundTarget(); return target.kind === "session" ? target.sessionId : undefined })
      const signals = {
        foregroundTarget, foregroundId,
        setForegroundTarget: (target: ForegroundTarget | undefined) => { if (target) setForegroundTarget(target) },
        setForegroundId: (sessionId: string | undefined) => { if (sessionId) setForegroundTarget({ kind: "session", sessionId }) },
        sessionShortTitle: () => "", statusView: () => undefined, questionView: () => undefined, outputView: () => undefined,
      }
      const tabs = createTabState({ signals, sessions: () => [] })
      tabs.openSessionTab("reuse")
      const creator = createSessionCreator({
        signals, ...tabs, draftCache, adoptDraft: (key, id) => handle.adoptDraft(key, id),
        appService: { dispatch: async () => request.promise },
        seedSessionCatalogRow: () => {}, startKnownEmptyTranscript: () => {}, retireTransientSession: () => {}, showToast: () => {},
      })
      return { ...creator, signals, dispose, draftKey: () => { const target = foregroundTarget(); return target.kind === "pending" ? target.key : target.sessionId } }
    })
    const result = await mountPrompt({ draftCache, foregroundId: h.draftKey, ref: (value) => { handle = value } })
    try {
      await result.renderOnce()
      await typeAsHuman(result.mockInput, "destination")
      const opening = h.startChat()
      const pendingKey = h.draftKey()
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("destination")
      await typeAsHuman(result.mockInput, "incoming")
      expect(draftCache.get(pendingKey).text).toBe("incoming")
      h.signals.setForegroundId("reuse")
      await result.renderOnce()
      await typeAsHuman(result.mockInput, " edited")
      request.resolve({ ok: true, sessionId: "reuse" })
      expect(await opening).toEqual({ kind: "stale", sessionId: "reuse" })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("destination edited")
      expect(result.captureCharFrame()).toContain("incoming")
      await typeAsHuman(result.mockInput, " more")
      expect(draftCache.get("reuse").text).toBe("destination edited\n\nincoming more")
      h.signals.setForegroundId("other")
      await result.renderOnce()
      h.signals.setForegroundId("reuse")
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("incoming more")
      expect(draftCache.get("reuse").text).toBe("destination edited\n\nincoming more")
      expect(draftCache.hasDraft(pendingKey)).toBe(false)
    } finally {
      result.renderer.destroy()
      h.dispose()
    }
  })

  it.each([false, true])("keeps a newer live draft separate from a failed initial message (navigated: %s)", async (navigated) => {
    const request = Promise.withResolvers<{ ok: false; error: string }>()
    const entered = Promise.withResolvers<void>()
    const draftCache = createDraftCache()
    let handle: ComposerHandle = { adoptDraft: draftCache.adopt, persistDraft: () => {}, appendInput: () => {} }
    const h = createRoot((dispose) => {
      const [foregroundTarget, setForegroundTarget] = createSignal<ForegroundTarget>()
      const foregroundId = createMemo(() => { const target = foregroundTarget(); return target?.kind === "session" ? target.sessionId : undefined })
      const signals = {
        foregroundTarget, foregroundId, setForegroundTarget,
        setForegroundId: (sessionId: string | undefined) => setForegroundTarget(sessionId ? { kind: "session", sessionId } : undefined),
        sessionShortTitle: () => "", statusView: () => undefined, questionView: () => undefined, outputView: () => undefined,
      }
      const tabs = createTabState({ signals, sessions: () => [] })
      tabs.openSessionTab("other")
      draftCache.set("other", { text: "other draft", pastes: [], attachments: [] })
      const creator = createSessionCreator({
        signals, ...tabs, draftCache, adoptDraft: (key, id) => handle.adoptDraft(key, id),
        appService: { dispatch: async () => { entered.resolve(); return request.promise } },
        seedSessionCatalogRow: () => {}, startKnownEmptyTranscript: () => {}, retireTransientSession: () => {}, showToast: () => {},
      })
      return { ...creator, ...tabs, signals, dispose, draftKey: () => { const target = foregroundTarget(); return target?.kind === "pending" ? target.key : target?.sessionId } }
    })
    let opening: ReturnType<typeof h.startChat> | undefined
    let submission: ChatInputLike | undefined
    const newer = "newer draft\n".repeat(30)
    const result = await mountPrompt({
      draftCache, foregroundId: h.draftKey, ref: (value) => { handle = value },
      onSubmit: (input) => {
        if (!opening) queueMicrotask(() => { opening = h.startChat(input) })
        else submission = input
        return true
      },
      onRecallLocal: () => { const input = h.recallFailedChat(); return input ? { kind: "input", input } : null },
    })
    try {
      await result.renderOnce()
      await result.mockInput.pasteBracketedText("original message")
      result.mockInput.pressEnter()
      await entered.promise
      const pendingKey = h.draftKey()!
      if (navigated) h.signals.setForegroundId("later")
      await result.renderOnce()
      await result.mockInput.pasteBracketedText(newer)
      request.resolve({ ok: false, error: "creation failed" })
      expect(await opening).toEqual({ kind: "failed" })
      await result.renderOnce()
      expect(h.signals.foregroundId()).toBe(navigated ? "later" : undefined)
      expect(result.captureCharFrame()).toContain("[Pasted")
      expect(draftCache.get("other").text).toBe("other draft")
      expect(h.hasPendingTab(pendingKey)).toBe(false)
      expect(draftCache.hasDraft(pendingKey)).toBe(false)
      expect(h.recallFailedChat()).toEqual({ text: "original message" })
      expect(h.recallFailedChat()).toBeNull()
      result.mockInput.pressEnter()
      expect(submission).toEqual({ text: newer })
    } finally {
      result.renderer.destroy()
      h.dispose()
    }
  })

  it("wires drafts through draftCache instead of SessionStore", async () => {
    const [source, types] = await Promise.all([
      Bun.file("src/tui/components/composer.tsx").text(),
      Bun.file("src/tui/components/composer-types.ts").text(),
    ])

    expect(source).not.toContain("sessionStore")
    expect(types).not.toContain("sessionStore")
    expect(types).toContain("draftCache: DraftCache")
    expect(source).toContain("props.draftCache.set")
    expect(source).toContain("props.draftCache.get")
    expect(source).toContain("props.draftCache.clear")
  })

  it("clears the origin draft and keeps the destination draft when submit switches the foreground", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    draftCache.set("chat-2", { text: "destination draft", pastes: [], attachments: [] })
    // Mirrors /clear: the command backgrounds the origin tab synchronously
    // inside onSubmit, so the foreground changes before handleSubmit resumes.
    const result = await mountPrompt({
      draftCache,
      foregroundId,
      onSubmit: () => { setForegroundId("chat-2"); return true },
    })

    try {
      await result.renderOnce()
      await typeAsHuman(result.mockInput, "/clear")
      await result.renderOnce()

      result.mockInput.pressEnter()
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.hasDraft("chat-1")).toBe(false)
      expect(draftCache.get("chat-2").text).toBe("destination draft")
      const frame = result.captureCharFrame()
      expect(frame).toContain("destination draft")
      expect(frame).not.toContain("/clear")
    } finally {
      result.renderer.destroy()
    }
  })

  it.each([
    ["at submit", () => false],
    ["after the command settles", () => ({ accepted: Promise.resolve(false) })],
  ] satisfies [string, ComposerProps["onSubmit"]][])("retains input rejected %s in the prompt and draft", async (_when, onSubmit) => {
    const [foregroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const result = await mountPrompt({ draftCache, foregroundId, onSubmit })

    try {
      await result.renderOnce()
      await typeAsHuman(result.mockInput, "keep rejected text")
      await result.renderOnce()

      result.mockInput.pressEnter()
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("keep rejected text")
      expect(result.captureCharFrame()).toContain("keep rejected text")
    } finally {
      result.renderer.destroy()
    }
  })

  it("preserves text typed before the initial foreground chat finishes starting", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>()
    const draftCache = createDraftCache()
    const result = await mountPrompt({ draftCache, foregroundId })

    try {
      await result.renderOnce()
      await result.mockInput.typeText("keep me")
      await Bun.sleep(10)
      await result.renderOnce()

      setForegroundId("chat-1")
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("keep me")
      expect(result.captureCharFrame()).toContain("keep me")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the prompt until the question dock replaces it in one frame, ignores keys meanwhile, and keeps the draft", async () => {
    const [question, setQuestion] = createSignal<QuestionBlock | undefined>()
    const draftCache = createDraftCache()
    const result = await mountPrompt({ draftCache, foregroundId: () => "chat-1", pendingQuestion: question })

    try {
      await result.renderOnce()
      await typeAsHuman(result.mockInput, "before")
      // A keystroke schedules a frame, and a slow host can still be painting
      // it here. A question that docks while that frame is in flight is laid
      // out by it, so the next frame would already show the dock. Finish the
      // frames first, so the question docks on the frame that this test counts.
      await result.renderOnce()
      setQuestion({
        kind: "question",
        toolUseId: "tool-question",
        questions: [{
          question: "Continue?",
          choices: [{ kind: "option", choiceId: "yes", label: "Yes" }, { kind: "freeform", label: "Other" }],
          multiSelect: false,
        }],
        timestamp: 1,
      })
      await result.renderOnce()
      // The prompt stays on screen while the dock measures itself, and the
      // prompt area then swaps to the dock in one frame. A key the question
      // does not claim must not reach the prompt in between.
      expect(result.captureCharFrame()).toContain("> before")
      expect(result.captureCharFrame()).not.toContain("Continue?")
      result.mockInput.pressBackspace()
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Continue?")
      expect(result.captureCharFrame()).not.toContain("> before")
      setQuestion(undefined)
      await result.renderOnce()
      await typeAsHuman(result.mockInput, " after")
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("before after")
      expect(result.captureCharFrame()).toContain("before after")
    } finally {
      result.renderer.destroy()
    }
  })

  it("moves unsent question text into the prompt when the question leaves without this client's answer", async () => {
    const [question, setQuestion] = createSignal<QuestionBlock | undefined>()
    const draftCache = createDraftCache()
    const result = await mountPrompt({ draftCache, foregroundId: () => "chat-1", pendingQuestion: question })

    try {
      await result.renderOnce()
      await typeAsHuman(result.mockInput, "before")
      setQuestion({
        kind: "question",
        toolUseId: "tool-question",
        questions: [{
          question: "Continue?",
          choices: [{ kind: "option", choiceId: "yes", label: "Yes" }, { kind: "freeform", label: "Other" }],
          multiSelect: false,
        }],
        timestamp: 1,
      })
      await result.renderOnce()
      draftCache.questions.set("chat-1", "tool-question", { tab: 0, cursor: 1, answers: [{ picked: [], freeformPicked: true }], editorText: [["", "Amber draft"]] })
      setQuestion(undefined)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("before\n\nAmber draft")
      expect(draftCache.questions.get("chat-1", "tool-question")).toBeUndefined()
      expect(result.captureCharFrame()).toContain("Amber draft")
    } finally {
      result.renderer.destroy()
    }
  })

  it("preserves typed multiline drafts when switching sessions", async () => {
    const multilineDraft = ["line one", "line two", "line three", "line four", "line five"].join("\n")
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    draftCache.set("chat-1", { text: multilineDraft, pastes: [], attachments: [] })
    const result = await mountPrompt({ draftCache, foregroundId })

    try {
      await result.renderOnce()
      await Bun.sleep(20)
      setForegroundId("chat-2")
      await Bun.sleep(20)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe(multilineDraft)
      expect(draftCache.get("chat-1").pastes).toEqual([])
      expect(result.captureCharFrame()).not.toContain("[Pasted")

      setForegroundId("chat-1")
      await Bun.sleep(20)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe(multilineDraft)
      expect(draftCache.get("chat-1").pastes).toEqual([])
      expect(result.captureCharFrame()).toContain("line one")
      expect(result.captureCharFrame()).not.toContain("[Pasted")
    } finally {
      result.renderer.destroy()
    }
  })

  it("drops a clipboard image that resolves after a session switch", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const clipboardResult = deferred<{ mediaType: string; data: string } | null>()
    const result = await mountPrompt({ draftCache, foregroundId, clipboardImage: clipboardResult.promise })

    try {
      await result.renderOnce()
      result.mockInput.pressKey("v", { ctrl: true })
      await Bun.sleep(0)

      setForegroundId("chat-2")
      await Bun.sleep(0)
      await result.renderOnce()

      clipboardResult.resolve({ mediaType: "image/png", data: "abc" })
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").attachments).toEqual([])
      expect(draftCache.get("chat-2").attachments).toEqual([])
      expect(result.captureCharFrame()).not.toContain("[Image #1]")
    } finally {
      result.renderer.destroy()
    }
  })
})
