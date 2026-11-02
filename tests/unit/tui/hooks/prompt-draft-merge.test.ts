import { describe, expect, it } from "bun:test"
import { mergeComposerDrafts, replaceDraftMarker } from "../../../../src/tui/hooks/composer-draft-merge.js"
import type { ComposerDraft } from "../../../../src/tui/hooks/create-draft-cache.js"

function draft(text: string, overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return { text, pastes: [], attachments: [], ...overrides }
}

function image(marker: string, data = marker): ComposerDraft["attachments"][number] {
  return { marker, mediaType: "image/png", data }
}

describe("mergeComposerDrafts", () => {
  it("reserves destination pending image markers when merging ready images", () => {
    const merged = mergeComposerDrafts(draft("[Image #1]"), draft("[Image #1]", { attachments: [image("[Image #1]")] }))
    expect(merged.text).toBe("[Image #1]\n\n[Image #2]")
    expect(merged.attachments[0]?.marker).toBe("[Image #2]")
  })

  it("preserves collapsed text ranges when a failed image becomes a path", () => {
    const marker = "[Image #1]"
    const placeholder = "[Pasted 5 lines]"
    const input = draft(marker + placeholder, { pastes: [{ start: marker.length, end: marker.length + placeholder.length, text: "expanded" }] })
    const result = replaceDraftMarker(input, marker, "/long/image/path.png")
    expect(result.text.slice(result.pastes[0]?.start, result.pastes[0]?.end)).toBe(placeholder)
    expect(result.pastes[0]?.text).toBe("expanded")
  })
  it("renumbers a recalled file marker and keeps its name", () => {
    const current = draft("mine [Image #2]", { attachments: [image("[Image #2]")] })
    const recalled = draft("theirs [File #1 notes.md] [Image #2]", { attachments: [
      { marker: "[File #1 notes.md]", mediaType: "text/markdown", data: "bm90ZXM=", name: "notes.md" },
      image("[Image #2]", "recalled-image"),
    ] })

    const merged = mergeComposerDrafts(current, recalled)

    expect(merged.text).toBe("mine [Image #2]\n\ntheirs [File #3 notes.md] [Image #4]")
    expect(merged.attachments.map((item) => item.marker)).toEqual(["[Image #2]", "[File #3 notes.md]", "[Image #4]"])
  })

  it("keeps both inputs with one blank line between them", () => {
    const merged = mergeComposerDrafts(draft("typed later"), draft("recalled earlier"))

    expect(merged.text).toBe("typed later\n\nrecalled earlier")
  })

  it("adds no separator when either side has no text", () => {
    expect(mergeComposerDrafts(draft(""), draft("recalled")).text).toBe("recalled")
    expect(mergeComposerDrafts(draft("typed"), draft("")).text).toBe("typed")
  })

  it("leaves current paste ranges covering their own text", () => {
    const current = draft("see [Pasted 10 lines] now", { pastes: [{ start: 4, end: 21, text: "long paste" }] })

    const merged = mergeComposerDrafts(current, draft("recalled"))

    expect(merged.pastes[0]).toEqual({ start: 4, end: 21, text: "long paste" })
    expect(merged.text.slice(4, 21)).toBe("[Pasted 10 lines]")
  })

  it("shifts recalled paste ranges so they still cover their own text", () => {
    const recalled = draft("keep [Pasted 3 lines] here", { pastes: [{ start: 5, end: 21, text: "recalled paste" }] })

    const merged = mergeComposerDrafts(draft("typed"), recalled)

    const paste = merged.pastes[0]!
    expect(merged.text.slice(paste.start, paste.end)).toBe("[Pasted 3 lines]")
    expect(paste.text).toBe("recalled paste")
  })

  it("renumbers colliding recalled image markers in text and metadata", () => {
    const current = draft("mine [Image #1] and [Image #2]", { attachments: [image("[Image #1]"), image("[Image #2]")] })
    const recalled = draft("theirs [Image #1]", { attachments: [image("[Image #1]", "recalled-data")] })

    const merged = mergeComposerDrafts(current, recalled)

    expect(merged.text).toBe("mine [Image #1] and [Image #2]\n\ntheirs [Image #3]")
    expect(merged.attachments).toEqual([
      image("[Image #1]"),
      image("[Image #2]"),
      { marker: "[Image #3]", mediaType: "image/png", data: "recalled-data" },
    ])
  })

  it("keeps recalled paste ranges aligned when renumbering widens a marker", () => {
    const current = draft("a", { attachments: [image("[Image #9]")] })
    const recalled = draft("[Image #1] [Pasted 2 lines]", {
      pastes: [{ start: 11, end: 27, text: "recalled paste" }],
      attachments: [image("[Image #1]", "recalled-data")],
    })

    const merged = mergeComposerDrafts(current, recalled)

    expect(merged.text).toBe("a\n\n[Image #10] [Pasted 2 lines]")
    const paste = merged.pastes[0]!
    expect(merged.text.slice(paste.start, paste.end)).toBe("[Pasted 2 lines]")
    expect(merged.attachments[1]?.marker).toBe("[Image #10]")
  })
})
