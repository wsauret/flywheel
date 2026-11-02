import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PasteEvent } from "@opentui/core"

import { createPromptAttachments } from "../../../../src/tui/hooks/composer-attachments.js"

function createFakeTextarea(initialText = "") {
  let plainText = initialText
  let cursor = initialText.length
  let nextId = 1
  let nextTypeId = 1
  const marks: Array<{ id: number; start: number; end: number; styleId?: number; typeId?: number; virtual?: boolean }> = []
  const destroyListeners: Array<() => void> = []
  const textarea = {
    get plainText() { return plainText },
    set plainText(value: string) { plainText = value; cursor = value.length },
    editBuffer: {
      getCursorPosition: () => ({ offset: cursor }),
      setCursorByOffset: (offset: number) => { cursor = offset },
    },
    extmarks: {
      registerType: () => nextTypeId++,
      create: (mark: { start: number; end: number; styleId?: number; typeId?: number; virtual?: boolean }) => {
        marks.push({ id: nextId, ...mark })
        nextId += 1
        return nextId - 1
      },
      delete: (id: number) => {
        const index = marks.findIndex((mark) => mark.id === id)
        if (index < 0) return false
        marks.splice(index, 1)
        return true
      },
      getAllForTypeId: (typeId: number) => marks.filter((mark) => mark.typeId === typeId),
    },
    once: (event: string, listener: () => void) => {
      if (event === "destroyed") destroyListeners.push(listener)
      return textarea
    },
    deleteRange: (startLine: number, startColumn: number, endLine: number, endColumn: number) => {
      const offset = (line: number, column: number) => {
        let result = 0
        for (let index = 0; index < line; index += 1) result = plainText.indexOf("\n", result) + 1
        return result + column
      }
      const start = offset(startLine, startColumn)
      const end = offset(endLine, endColumn)
      plainText = plainText.slice(0, start) + plainText.slice(end)
      cursor = start
    },
    insertText: (text: string) => {
      plainText = plainText.slice(0, cursor) + text + plainText.slice(cursor)
      cursor += text.length
    },
  }
  return {
    textarea,
    marks,
    destroy: () => { for (const listener of destroyListeners.splice(0)) listener() },
  }
}

const noClipboard = { copy: async () => {}, readImage: async () => null }
const syntax = () => ({ resolveStyleId: () => undefined })
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("createPromptAttachments", () => {
  it("inserts image markers and returns image content on submit", () => {
    const { textarea } = createFakeTextarea("explain")
    const images = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    images.attach(textarea)

    const handled = images.handlePaste(new PasteEvent(Buffer.from("image-bytes"), { mimeType: "image/png" }))

    expect(handled).toBe(true)
    expect(textarea.plainText).toBe("explain [Image #1]")
    expect(images.toSubmission(textarea.plainText)).toEqual({
      text: "explain [Image #1]",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: Buffer.from("image-bytes").toString("base64") }],
    })
  })

  it("attaches a terminal-dragged macOS screenshot path without submitting the path", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-image-path-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "Screenshot 2026-09-22 at 12.24.53\u202FPM.png")
    fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))
    const dragged = `${file.replaceAll(" ", "\\ ")} `
    const { textarea } = createFakeTextarea("inspect")
    const data = Buffer.from("image-bytes").toString("base64")
    const read = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths.find((candidate) => candidate === file),
      readPathAttachment: () => read.promise,
    })
    attachments.attach(textarea)
    const handled = attachments.claimPasteText(dragged)

    expect(handled).toBe(true)
    expect(textarea.plainText).toBe("inspect[Image #1]")
    read.resolve({ attachment: { mediaType: "image/png", data, name: path.basename(file) } })
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(attachments.toSubmission(textarea.plainText).text).not.toContain("Screenshot")
    expect(attachments.serialize(textarea.plainText)).toMatchObject([{ marker: "[Image #1]", mediaType: "image/png", name: path.basename(file) }])
  })

  it("waits for pending image bytes and preserves the reserved ordinal", async () => {
    const first = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const second = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const reads = [first, second]
    const { textarea } = createFakeTextarea("compare ")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: () => reads.shift()!.promise,
    })
    attachments.attach(textarea)

    expect(attachments.claimPasteText("/scratch/first.png")).toBe(true)
    expect(attachments.claimPasteText("/scratch/second.jpg")).toBe(true)
    expect(textarea.plainText).toBe("compare [Image #1][Image #2]")
    const submission = attachments.prepareSubmission(textarea.plainText, "chat-1")
    let settled = false
    void submission.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    second.resolve({ attachment: { mediaType: "image/jpeg", data: "dHdv", name: "second.jpg" } })
    first.resolve({ attachment: { mediaType: "image/png", data: "b25l", name: "first.png" } })

    expect(await submission).toEqual({
      text: "compare [Image #1][Image #2]",
      attachments: [
        { marker: "[Image #1]", mediaType: "image/png", data: "b25l", name: "first.png" },
        { marker: "[Image #2]", mediaType: "image/jpeg", data: "dHdv", name: "second.jpg" },
      ],
    })
  })

  it("recovers the exact escaped screenshot path from a buffered key payload", async () => {
    const pasted = "/Users/alice/Desktop/Screenshot\\ 2026-09-22\\ at\\ 2.43.28\u202FPM.png "
    const resolved = path.resolve("/Users/alice/Desktop/Screenshot 2026-09-22 at 2.43.28\u202FPM.png")
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths.find((candidate) => candidate === resolved),
      readPathAttachment: async () => ({
        attachment: { mediaType: "image/png", data: "aGVsbG8=", name: "Screenshot 2026-09-22 at 2.43.28\u202FPM.png" },
      }),
    })
    attachments.attach(textarea)

    expect(attachments.claimPasteText(pasted)).toBe(true)
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(textarea.plainText).toBe("[Image #1]")
    expect(attachments.serialize(textarea.plainText)).toHaveLength(1)
  })

  it("attaches each image of a multi-file terminal drop and keeps other paths as text", async () => {
    const screenshot = "Shot at 2.43.28\u202FPM.png"
    const images = new Set([path.resolve("/scratch/one.png"), path.resolve(`/scratch/${screenshot}`)])
    const { textarea } = createFakeTextarea("compare ")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths.find((candidate) => images.has(candidate)),
      readPathAttachment: async (file) => ({ attachment: { mediaType: "image/png", data: "aW1n", name: path.basename(file) } }),
    })
    attachments.attach(textarea)

    expect(attachments.claimPasteText("/scratch/one.png /scratch/notes.txt\n/scratch/Shot\\ at\\ 2.43.28\u202FPM.png ")).toBe(true)
    expect(textarea.plainText).toBe("compare [Image #1] /scratch/notes.txt\n[Image #2] ")
    const submission = await attachments.prepareSubmission(textarea.plainText, "chat-1")

    expect(submission).toEqual({
      text: "compare [Image #1] /scratch/notes.txt\n[Image #2] ",
      attachments: [
        { marker: "[Image #1]", mediaType: "image/png", data: "aW1n", name: "one.png" },
        { marker: "[Image #2]", mediaType: "image/png", data: "aW1n", name: screenshot },
      ],
    })
  })

  // Windows strips a trailing space from a directory name, so this path cannot exist there.
  it.skipIf(process.platform === "win32")("keeps an existing single path whose folder name ends in a space", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-spaced-folder-"))
    temporaryDirectories.push(directory)
    fs.mkdirSync(path.join(directory, "album "))
    const file = path.join(directory, "album ", "photo.png")
    fs.writeFileSync(file, "png")
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths.find((candidate) => candidate === file),
      readPathAttachment: async () => ({ attachment: { mediaType: "image/png", data: "aW1n", name: "photo.png" } }),
    })
    attachments.attach(textarea)

    expect(attachments.claimPasteText(file)).toBe(true)
    expect(textarea.plainText).toBe("[Image #1]")
    expect(await attachments.prepareSubmission(textarea.plainText, "chat-1")).toMatchObject({ attachments: [{ marker: "[Image #1]", name: "photo.png" }] })
  })

  it("restores only the dropped path that fails to read", async () => {
    const warnings: string[] = []
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: async (file) => {
        if (file.endsWith("gone.png")) throw new Error("gone")
        return { attachment: { mediaType: "image/png", data: "aW1n", name: path.basename(file) } }
      },
      report: (message) => { warnings.push(message) },
    })
    attachments.attach(textarea)

    attachments.claimPasteText("/scratch/kept.png /scratch/gone\\ now/gone.png ")
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(textarea.plainText).toBe("[Image #1] /scratch/gone\\ now/gone.png ")
    expect(warnings).toEqual(["Could not attach gone.png. The file is no longer readable. The path remains in the draft."])
    expect(attachments.serialize(textarea.plainText)).toMatchObject([{ marker: "[Image #1]", name: "kept.png" }])
  })

  it("leaves a pasted text-file path as ordinary text", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-text-path-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "notes.txt")
    fs.writeFileSync(file, "notes")
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async () => undefined,
    })
    attachments.attach(textarea)
    const handled = attachments.claimPasteText(file)
    if (!handled) textarea.insertText(file)

    expect(textarea.plainText).toBe(file)
    for (let index = 0; index < 4; index += 1) await Promise.resolve()

    expect(handled).toBe(false)
    expect(textarea.plainText).toBe(file)
    expect(attachments.serialize(textarea.plainText)).toEqual([])
  })

  it("does not claim slash commands or ordinary pasted text", () => {
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    for (const text of ["/help", "/scratch/notes.txt", "some ordinary text", "/scratch/photo.png and more"]) {
      expect(attachments.claimPasteText(text)).toBe(false)
    }
    expect(textarea.plainText).toBe("")
  })

  it("restores a dragged path when the image cannot be read", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-failed-image-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "missing later.png")
    fs.writeFileSync(file, "image")
    const dragged = `${file.replaceAll(" ", "\\ ")} `
    const warnings: string[] = []
    const { textarea } = createFakeTextarea("inspect")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async () => file,
      readPathAttachment: async () => { throw new Error("gone") },
      report: (message) => { warnings.push(message) },
    })
    attachments.attach(textarea)

    attachments.claimPasteText(dragged)
    const submission = attachments.prepareSubmission(textarea.plainText, "chat-1")
    for (let index = 0; index < 4; index += 1) await Promise.resolve()

    expect(textarea.plainText).toBe(`inspect${dragged}`)
    expect(warnings).toEqual([`Could not attach ${path.basename(file)}. The file is no longer readable. The path remains in the draft.`])
    expect(await submission).toBeUndefined()
  })

  it("refuses decoder rejection without submitting the pending marker", async () => {
    const read = Promise.withResolvers<{ refusal: { reason: "unreadable" } }>()
    const warnings: string[] = []
    const { textarea } = createFakeTextarea("inspect ")
    const images = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: () => read.promise,
      report: (message) => { warnings.push(message) },
    })
    images.attach(textarea)
    images.claimPasteText("/scratch/broken.png")
    const submission = images.prepareSubmission(textarea.plainText, "chat-1")
    read.resolve({ refusal: { reason: "unreadable" } })

    expect(await submission).toBeUndefined()
    expect(textarea.plainText).toBe("inspect /scratch/broken.png")
    expect(warnings).toHaveLength(1)
    expect(images.serialize(textarea.plainText)).toEqual([])
  })

  it("drops a dragged image that resolves after the textarea is replaced", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-stale-image-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "stale.png")
    fs.writeFileSync(file, "image")
    const pending = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const first = createFakeTextarea("first")
    const replacement = createFakeTextarea("replacement")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async () => file,
      readPathAttachment: () => pending.promise,
    })
    attachments.attach(first.textarea)

    attachments.claimPasteText(file)
    first.destroy()
    attachments.attach(replacement.textarea)
    pending.resolve({ attachment: { mediaType: "image/png", data: "abc", name: path.basename(file) } })
    for (let index = 0; index < 4; index += 1) await Promise.resolve()

    expect(replacement.textarea.plainText).toBe("replacement")
    expect(first.textarea.plainText).toBe("first[Image #1]")
    expect(attachments.serialize(replacement.textarea.plainText)).toEqual([])
  })

  it("keeps literal path text when the same draft is replaced before detection settles", async () => {
    const file = "/scratch/stale.png"
    const pending = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async () => file,
      readPathAttachment: () => pending.promise,
    })
    attachments.attach(textarea)
    attachments.claimPasteText(file)
    attachments.invalidateClaims()
    textarea.plainText = "replacement"

    pending.resolve({ attachment: { mediaType: "image/png", data: "abc", name: "stale.png" } })
    for (let index = 0; index < 4; index += 1) await Promise.resolve()

    expect(textarea.plainText).toBe("replacement")
    expect(attachments.serialize(textarea.plainText)).toEqual([])
  })

  it("handles only image MIME paste events", () => {
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    const event = new PasteEvent(Buffer.from("/scratch/image.png"), { mimeType: "text/plain" })

    expect(attachments.handlePaste(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(textarea.plainText).toBe("")
  })

  it("drops a dragged image that resolves after the current draft is cleared", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cleared-image-"))
    temporaryDirectories.push(directory)
    const file = path.join(directory, "cleared.png")
    fs.writeFileSync(file, "image")
    const pending = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const { textarea } = createFakeTextarea("sent")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async () => file,
      readPathAttachment: () => pending.promise,
    })
    attachments.attach(textarea)

    attachments.claimPasteText(file)
    textarea.plainText = ""
    attachments.clear()
    pending.resolve({ attachment: { mediaType: "image/png", data: "abc", name: path.basename(file) } })
    for (let index = 0; index < 4; index += 1) await Promise.resolve()

    expect(textarea.plainText).toBe("")
    expect(attachments.serialize(textarea.plainText)).toEqual([])
  })

  it("refuses a captured external attachment sink after the draft changes and says the prompt is gone", () => {
    const { textarea } = createFakeTextarea("first")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    const append = attachments.captureAppender()

    textarea.plainText = "second"
    attachments.restore([])

    expect(append?.([{ mediaType: "image/png", data: "abc" }])).toEqual({ attached: 0, stopped: "prompt-gone" })
    expect(textarea.plainText).toBe("second")
  })

  it("binds a sink that a submitted command captures to the draft that follows the submission", () => {
    // `/attach` runs inside the submission of its own text, which then clears
    // that draft; the picked files belong in the prompt the person sees next.
    const { textarea } = createFakeTextarea("/attach")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    let append: ReturnType<typeof attachments.captureAppender>
    attachments.submit(() => { append = attachments.captureAppender(); return true }, () => {
      textarea.plainText = ""
      attachments.clear()
    })

    expect(append?.([{ mediaType: "image/png", data: "abc" }])).toEqual({ attached: 1, stopped: null })
    expect(textarea.plainText).toBe("[Image #1]")
  })

  it("applies the aggregate attachment budget to pasted image bytes", () => {
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    attachments.appendAll([{ mediaType: "image/png", data: Buffer.alloc(5 * 1024 * 1024).toString("base64") }])

    attachments.handlePaste(new PasteEvent(Buffer.alloc(4 * 1024 * 1024), { mimeType: "image/png" }))

    expect(attachments.serialize(textarea.plainText)).toHaveLength(1)
  })

  it("applies the per-image budget to pasted image bytes", () => {
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)

    attachments.handlePaste(new PasteEvent(Buffer.alloc(6 * 1024 * 1024), { mimeType: "image/png" }))

    expect(attachments.serialize(textarea.plainText)).toEqual([])
  })

  it("appends picked files with named markers until the message budget is reached and says the budget stopped it", () => {
    const { textarea } = createFakeTextarea("read")
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    attachments.attach(textarea)
    const small = Buffer.from("a,b\n1,2\n").toString("base64")
    const huge = Buffer.alloc(9 * 1024 * 1024).toString("base64")

    const attached = attachments.appendAll([
      { mediaType: "text/csv", data: small, name: "rows.csv" },
      { mediaType: "image/png", data: "aW1n" },
      { mediaType: "image/png", data: huge, name: "wall.png" },
    ])

    expect(attached).toEqual({ attached: 2, stopped: "message-size" })
    expect(textarea.plainText).toBe("read [File #1 rows.csv] [Image #2]")
    expect(attachments.toSubmission(textarea.plainText)).toEqual({
      text: "read [File #1 rows.csv] [Image #2]",
      attachments: [
        { marker: "[File #1 rows.csv]", mediaType: "text/csv", data: small, name: "rows.csv" },
        { marker: "[Image #2]", mediaType: "image/png", data: "aW1n" },
      ],
    })
  })

  it("prunes attachments whose marker was deleted", () => {
    const { textarea } = createFakeTextarea("keep [Image #1] drop")
    const images = createPromptAttachments(syntax, () => "chat-1", noClipboard)
    images.attach(textarea)
    images.restore([
      { marker: "[Image #1]", mediaType: "image/png", data: "kept" },
      { marker: "[Image #2]", mediaType: "image/png", data: "deleted" },
    ])

    expect(images.serialize(textarea.plainText)).toEqual([{ marker: "[Image #1]", mediaType: "image/png", data: "kept" }])
    expect(images.toSubmission(textarea.plainText)).toEqual({
      text: "keep [Image #1] drop",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "kept" }],
    })
  })

  it("does not attach a pending image after its marker is deleted", async () => {
    const read = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const { textarea } = createFakeTextarea()
    const attachments = createPromptAttachments(syntax, () => "chat-1", noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: () => read.promise,
    })
    attachments.attach(textarea)
    attachments.claimPasteText("/scratch/deleted.webp")
    textarea.plainText = ""
    attachments.reconcilePendingMarkers()
    textarea.plainText = "[Image #1]"

    read.resolve({ attachment: { mediaType: "image/webp", data: "abc", name: "deleted.webp" } })
    await attachments.prepareSubmission("[Image #1]", "chat-1")

    expect(attachments.serialize(textarea.plainText)).toEqual([])
    expect(await attachments.prepareSubmission(textarea.plainText, "chat-1")).toEqual({ text: "[Image #1]" })
  })

  it("keeps a loading image with its origin draft after a session switch", async () => {
    const read = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const settled = Promise.withResolvers<void>()
    let owner = "chat-1"
    const drafts = new Map<string, { text: string; attachments: Array<{ marker: string; mediaType: string; data: string; name?: string }> }>()
    const first = createFakeTextarea()
    const second = createFakeTextarea("other")
    const images = createPromptAttachments(syntax, () => owner, noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: () => read.promise,
      onBackgroundSettled: (id, marker, item) => {
        const draft = drafts.get(id)!
        if (draft.text.includes(marker) && typeof item !== "string") draft.attachments.push(item)
        settled.resolve()
      },
    })
    images.attach(first.textarea)
    images.claimPasteText("/scratch/origin.png")
    drafts.set(owner, { text: first.textarea.plainText, attachments: [] })
    owner = "chat-2"
    images.restore([])
    images.attach(second.textarea)
    read.resolve({ attachment: { mediaType: "image/png", data: "aW1n", name: "origin.png" } })
    await settled.promise

    expect(second.textarea.plainText).toBe("other")
    expect(drafts.get("chat-1")?.attachments).toHaveLength(1)
    owner = "chat-1"
    first.textarea.plainText = drafts.get("chat-1")!.text
    images.attach(first.textarea)
    images.restore(drafts.get("chat-1")!.attachments)
    expect(images.toSubmission(first.textarea.plainText)).toEqual({
      text: "[Image #1]",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "aW1n", name: "origin.png" }],
    })
  })

  it("moves a loading marker to an adopted session without reusing its existing ordinal", async () => {
    const read = Promise.withResolvers<{ attachment: { mediaType: string; data: string; name: string } }>()
    const complete = Promise.withResolvers<void>()
    let owner = "pending-chat"
    const settled: Array<{ owner: string; marker: string }> = []
    const { textarea } = createFakeTextarea()
    const images = createPromptAttachments(syntax, () => owner, noClipboard, {
      findImagePath: async (paths) => paths[0],
      readPathAttachment: () => read.promise,
      onBackgroundSettled: (id, marker) => { settled.push({ owner: id, marker }); complete.resolve() },
    })
    images.attach(textarea)
    images.claimPasteText("/scratch/incoming.png")
    expect(images.adoptPending("pending-chat", "chat-1", ["[Image #1]", "[Image #2]"]).get("[Image #1]")).toBe("[Image #3]")
    owner = "other-chat"
    read.resolve({ attachment: { mediaType: "image/png", data: "aW1n", name: "incoming.png" } })
    await complete.promise
    expect(settled).toEqual([{ owner: "chat-1", marker: "[Image #3]" }])
  })

  it("drops a clipboard image that resolves after the textarea is destroyed", async () => {
    let resolveImage!: (image: { mediaType: string; data: string }) => void
    const image = new Promise<{ mediaType: string; data: string }>((resolve) => { resolveImage = resolve })
    const clipboard = { copy: async () => {}, readImage: () => image }
    const { textarea, destroy } = createFakeTextarea("keep")
    const images = createPromptAttachments(syntax, () => "chat-1", clipboard)
    images.attach(textarea)

    const pendingPaste = images.pasteFromClipboard("chat-1")
    destroy()
    resolveImage({ mediaType: "image/png", data: "abc" })

    expect(await pendingPaste).toBe(false)
    expect(textarea.plainText).toBe("keep")
  })

  it("drops a clipboard image when the textarea is replaced before it resolves", async () => {
    let resolveImage!: (image: { mediaType: string; data: string }) => void
    const image = new Promise<{ mediaType: string; data: string }>((resolve) => { resolveImage = resolve })
    const clipboard = { copy: async () => {}, readImage: () => image }
    const first = createFakeTextarea("first")
    const replacement = createFakeTextarea("replacement")
    const images = createPromptAttachments(syntax, () => "chat-1", clipboard)
    images.attach(first.textarea)

    const pendingPaste = images.pasteFromClipboard("chat-1")
    first.destroy()
    images.attach(replacement.textarea)
    resolveImage({ mediaType: "image/png", data: "abc" })

    expect(await pendingPaste).toBe(false)
    expect(replacement.textarea.plainText).toBe("replacement")
    expect(images.serialize(replacement.textarea.plainText)).toEqual([])
  })
})
