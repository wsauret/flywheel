import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import type { ChatInput, ChatInputLike } from "../../../../src/infra/chat-input.js"
import { createHistory, mountPrompt, typeAsHuman } from "./prompt-area-fixture.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Up in an empty prompt: a message this terminal holds, the queued
 *  message the runtime gives back, or history, in that order. */
describe("Composer recall on Up", () => {
  it("recalls a queued message into the prompt on Up while active", async () => {
    const [foregroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const image = { marker: "[Image #1]", mediaType: "image/png", data: "abc" }
    const recalled = { text: "revise this [Image #1]", attachments: [image] }
    let submitted: unknown
    const result = await mountPrompt({
      draftCache,
      foregroundId,
      agentState: () => "active",
      onRecallQueued: () => recalled,
      onSubmit: (input) => { submitted = input; return true },
    })

    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("revise this [Image #1]")
      expect(draftCache.get("chat-1").attachments).toEqual([image])
      expect(result.captureCharFrame()).toContain("revise this")

      result.mockInput.pressEnter()
      await Bun.sleep(0)
      await result.renderOnce()

      expect(submitted).toEqual(recalled)
      expect(draftCache.hasDraft("chat-1")).toBe(false)
    } finally {
      result.renderer.destroy()
    }
  })

  it.each(["chat-1", undefined])("recalls local input before the next key in the same input batch (owner: %s)", async (sessionId) => {
    const draftCache = createDraftCache()
    const image = { marker: "[Image #1]", mediaType: "image/png", data: "bytes" }
    const recalled = { text: "retry [Image #1]", attachments: [image] }
    let remaining: ChatInput | null = recalled
    let submitted: ChatInputLike | undefined
    const result = await mountPrompt({
      draftCache,
      foregroundId: () => sessionId,
      agentState: () => "idle",
      onRecallLocal: () => { const input = remaining; remaining = null; return input ? { kind: "input", input } : null },
      onRecallQueued: () => { throw new Error("Idle recall must remain local") },
      onSubmit: (input) => { submitted = input; return true },
    })
    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      result.mockInput.pressKey("x")
      result.mockInput.pressArrow("right")
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("retry [Image #1]x")
      expect(remaining).toBeNull()
      result.mockInput.pressEnter()
      expect(submitted).toEqual({ text: `${recalled.text}x`, attachments: [image] })
    } finally { result.renderer.destroy() }
  })

  it("leaves the prompt, the queued recall, and history alone when Up meets a message that waits for the connection", async () => {
    const draftCache = createDraftCache()
    let asked = 0
    let queuedRecalls = 0
    const result = await mountPrompt({
      draftCache,
      foregroundId: () => "chat-1",
      agentState: () => "active",
      history: createHistory(["earlier history entry"]),
      onRecallLocal: () => { asked += 1; return { kind: "waiting", notice: "waits" } },
      onRecallQueued: () => { queuedRecalls += 1; return null },
    })
    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      await result.renderOnce()
      expect(asked).toBe(1)
      expect(queuedRecalls).toBe(0)
      expect(draftCache.hasDraft("chat-1")).toBe(false)
      expect(result.captureCharFrame()).not.toContain("earlier history entry")
    } finally { result.renderer.destroy() }
  })

  it("keeps a recalled message with its own session when recall settles after a session switch", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const recall = deferred<ChatInputLike | null>()
    const result = await mountPrompt({
      draftCache,
      foregroundId,
      agentState: () => "active",
      onRecallQueued: () => recall.promise,
    })

    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      await Bun.sleep(0)

      setForegroundId("chat-2")
      await Bun.sleep(0)
      await typeAsHuman(result.mockInput, "typed in chat two")
      await result.renderOnce()

      recall.resolve({ text: "queued for chat one" })
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("queued for chat one")
      expect(draftCache.get("chat-2").text).toBe("typed in chat two")
      expect(result.captureCharFrame()).toContain("typed in chat two")
      expect(result.captureCharFrame()).not.toContain("queued for chat one")
    } finally {
      result.renderer.destroy()
    }
  })

  it("merges a recalled message after the same prompt was typed into", async () => {
    const [foregroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const recall = deferred<ChatInputLike | null>()
    const result = await mountPrompt({
      draftCache,
      foregroundId,
      agentState: () => "active",
      onRecallQueued: () => recall.promise,
    })

    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      await Bun.sleep(0)
      await typeAsHuman(result.mockInput, "typed while recalling")
      await result.renderOnce()

      recall.resolve({ text: "queued earlier" })
      await Bun.sleep(0)
      await result.renderOnce()

      expect(draftCache.get("chat-1").text).toBe("typed while recalling\n\nqueued earlier")
      const frame = result.captureCharFrame()
      expect(frame).toContain("typed while recalling")
      expect(frame).toContain("queued earlier")
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not open the history browser when an empty recall settles after a session switch", async () => {
    const [foregroundId, setForegroundId] = createSignal<string | undefined>("chat-1")
    const draftCache = createDraftCache()
    const recall = deferred<ChatInputLike | null>()
    const result = await mountPrompt({
      draftCache,
      foregroundId,
      agentState: () => "active",
      history: createHistory(["earlier history entry"]),
      onRecallQueued: () => recall.promise,
    })

    try {
      await result.renderOnce()
      result.mockInput.pressArrow("up")
      await Bun.sleep(0)

      setForegroundId("chat-2")
      await Bun.sleep(0)
      await result.renderOnce()

      recall.resolve(null)
      await Bun.sleep(0)
      await result.renderOnce()

      expect(result.captureCharFrame()).not.toContain("earlier history entry")
    } finally {
      result.renderer.destroy()
    }
  })
})
