import { describe, expect, it } from "bun:test"
import { createDraftCache, type ComposerDraft } from "../../../../src/tui/hooks/create-draft-cache.js"

describe("createDraftCache", () => {
  it("stores draft text, collapsed pastes, and attachments per session", () => {
    const cache = createDraftCache()
    const paste = { start: 3, end: 20, text: "expanded paste" }
    const image = { marker: "[Image #1]", mediaType: "image/png", data: "abc" }
    const draft: ComposerDraft = { text: "A [Image #1]", pastes: [paste], attachments: [image] }

    cache.set("session-a", draft)
    cache.set("session-b", { text: "B", pastes: [], attachments: [] })

    expect(cache.get("session-a")).toEqual({ text: "A [Image #1]", pastes: [paste], attachments: [image] })
    expect(cache.get("session-b")).toEqual({ text: "B", pastes: [], attachments: [] })
  })

  it("clears only the submitted session draft", () => {
    const cache = createDraftCache()
    cache.set("session-a", { text: "A", pastes: [], attachments: [] })
    cache.set("session-b", { text: "B", pastes: [], attachments: [] })

    cache.clear("session-a")

    expect(cache.hasDraft("session-a")).toBe(false)
    expect(cache.get("session-a")).toEqual({ text: "", pastes: [], attachments: [] })
    expect(cache.get("session-b").text).toBe("B")
  })

  it("reports drafts from text, collapsed pastes, or attachments", () => {
    const cache = createDraftCache()

    expect(cache.hasDraft("empty")).toBe(false)
    cache.set("empty", { text: "", pastes: [], attachments: [] })
    expect(cache.hasDraft("empty")).toBe(false)

    cache.set("text", { text: "hi", pastes: [], attachments: [] })
    cache.set("paste", { text: "", pastes: [{ start: 0, end: 8, text: "expanded" }], attachments: [] })
    cache.set("image", { text: "", pastes: [], attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "abc" }] })

    expect(cache.hasDraft("text")).toBe(true)
    expect(cache.hasDraft("paste")).toBe(true)
    expect(cache.hasDraft("image")).toBe(true)
  })

  it("phase15a adopts only the pending draft and preserves numbered attachments", () => {
    const cache = createDraftCache()
    const image = { marker: "[Image #1]", mediaType: "image/png", data: "abc" }
    cache.set("durable", { text: "[Image #1]", pastes: [], attachments: [image] })
    cache.set("pending", { text: "[Image #1]", pastes: [], attachments: [image] })
    cache.adopt("pending", "durable")
    expect(cache.get("durable").text).toBe("[Image #1]\n\n[Image #2]")
    expect(cache.get("durable").attachments.map((item) => item.marker)).toEqual(["[Image #1]", "[Image #2]"])
    expect(cache.hasDraft("pending")).toBe(false)
  })

  it("stores question drafts by session and tool call without mixing prompt drafts", () => {
    const cache = createDraftCache()
    const draft = {
      tab: 1,
      cursor: 2,
      answers: [{ picked: [], freeformPicked: true }],
      editorText: [["", "", "Amber"]],
    }

    cache.questions.set("session-a", "question-a", draft)
    cache.set("session-a", { text: "prompt", pastes: [], attachments: [] })

    expect(cache.questions.get("session-a", "question-a")).toEqual(draft)
    expect(cache.questions.get("session-b", "question-a")).toBeUndefined()
    expect(cache.questions.get("session-a", "question-b")).toBeUndefined()
    expect(cache.get("session-a").text).toBe("prompt")

    cache.questions.clear("session-a", "question-a")
    expect(cache.questions.get("session-a", "question-a")).toBeUndefined()
    expect(cache.get("session-a").text).toBe("prompt")
  })

  it("starts from a handed snapshot and answers every draft and question form it holds", () => {
    const question = { tab: 0, cursor: 1, answers: [{ picked: [1], freeformPicked: false }], editorText: [["x"]] }
    const cache = createDraftCache({
      drafts: { "session-a": { text: "A", pastes: [], attachments: [], caret: 0 } },
      questionDrafts: { "session-b": { "call-1": question } },
    })
    cache.set("session-c", { text: "C", pastes: [], attachments: [] })

    expect(cache.get("session-a")).toEqual({ text: "A", pastes: [], attachments: [], caret: 0 })
    expect(cache.questions.get("session-b", "call-1")).toEqual(question)
    expect(cache.snapshot()).toEqual({
      drafts: { "session-a": { text: "A", pastes: [], attachments: [], caret: 0 }, "session-c": { text: "C", pastes: [], attachments: [] } },
      questionDrafts: { "session-b": { "call-1": question } },
    })
  })
})
