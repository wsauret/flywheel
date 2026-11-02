import { describe, expect, it } from "bun:test"

import {
  ATTACHMENT_LIMITS, attachmentKind, attachmentMarker, attachmentRefusalMessage, base64ByteLength, bytesToBase64, decodeUtf8Text, formatBytes, nextAttachmentOrdinal,
} from "../../../../src/protocol/client/attachments.js"

describe("attachmentKind", () => {
  it("reads images and text from the declared type", () => {
    expect(attachmentKind("image/png", "shot.png")).toBe("image")
    expect(attachmentKind("image/heic", "IMG_1.HEIC")).toBe("image")
    expect(attachmentKind("text/plain; charset=utf-8", "a.txt")).toBe("text")
    expect(attachmentKind("application/json", "a.json")).toBe("text")
  })
  it("falls back to the name when the browser reports no type", () => {
    expect(attachmentKind("", "notes.md")).toBe("text")
    expect(attachmentKind("", "Dockerfile.log")).toBe("text")
    expect(attachmentKind("", ".gitignore")).toBe("text")
  })
  it("refuses kinds no provider conversion carries", () => {
    expect(attachmentKind("application/pdf", "paper.pdf")).toBeUndefined()
    expect(attachmentKind("application/zip", "bundle.zip")).toBeUndefined()
    expect(attachmentKind("", "movie.mov")).toBeUndefined()
  })
})

describe("markers", () => {
  it("names images by number and files by number and name", () => {
    expect(attachmentMarker("image", 1)).toBe("[Image #1]")
    expect(attachmentMarker("text", 2, "rows.csv")).toBe("[File #2 rows.csv]")
    expect(attachmentMarker("text", 3)).toBe("[File #3]")
  })
  it("numbers past the highest marker a message already shows", () => {
    expect(nextAttachmentOrdinal([])).toBe(1)
    expect(nextAttachmentOrdinal(["[Image #1]", "[File #4 a.txt]", "[Image #2]"])).toBe(5)
  })
})

describe("bytes", () => {
  it("decodes UTF-8 and refuses bytes that are not", () => {
    expect(decodeUtf8Text(new TextEncoder().encode("héllo"))).toBe("héllo")
    expect(decodeUtf8Text(new Uint8Array([0xff, 0xfe, 0x00, 0x80]))).toBeUndefined()
  })
  it("encodes base64 the way Buffer does and reports the encoded byte length", () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251)
    const encoded = bytesToBase64(bytes)
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"))
    expect(base64ByteLength(encoded)).toBe(bytes.length)
    expect(base64ByteLength(Buffer.from("ab").toString("base64"))).toBe(2)
  })
  it("formats sizes for a chip", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(840 * 1024)).toBe("840 KB")
    expect(formatBytes(2.3 * 1024 * 1024)).toBe("2.3 MB")
    expect(formatBytes(ATTACHMENT_LIMITS.textMaxBytes)).toBe("1 MB")
  })
})

describe("attachmentRefusalMessage", () => {
  it("names the file and what is accepted", () => {
    expect(attachmentRefusalMessage("paper.pdf", { reason: "kind", mediaType: "application/pdf" })).toBe("Flywheel can attach images and text files. paper.pdf is application/pdf.")
    expect(attachmentRefusalMessage("blob", { reason: "kind", mediaType: "" })).toBe("Flywheel can attach images and text files. blob is of an unknown type.")
    expect(attachmentRefusalMessage("big.log", { reason: "size", limitBytes: ATTACHMENT_LIMITS.textMaxBytes })).toBe("big.log is too large to attach. The limit is 1 MB.")
    expect(attachmentRefusalMessage("x.png", { reason: "message-size", limitBytes: ATTACHMENT_LIMITS.messageMaxBytes })).toBe("x.png would take this message past 8 MB of attachments. Send what is attached first.")
  })
})
