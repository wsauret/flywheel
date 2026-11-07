import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readFileAttachment } from "../../../../src/tui/utils/file-attachments.js"

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "flywheel-attach-")) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const noResize = async () => ({ kind: "unavailable" }) as const

describe("readFileAttachment", () => {
  it("reads a text file with its type and name", async () => {
    const path = join(dir, "rows.csv")
    await writeFile(path, "a,b\n1,2\n")
    expect(await readFileAttachment(path, noResize)).toEqual({ attachment: { mediaType: "text/csv", data: Buffer.from("a,b\n1,2\n").toString("base64"), name: "rows.csv" } })
  })
  it("requires image decoder validation and takes the resizer's answer", async () => {
    const path = join(dir, "shot.png")
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await writeFile(path, bytes)
    expect(await readFileAttachment(path, noResize)).toEqual({ refusal: { reason: "kind", mediaType: "image/png" } })
    expect(await readFileAttachment(path, async () => ({ kind: "unreadable", reason: "Input buffer contains unsupported image format" }))).toEqual({ refusal: { reason: "unreadable" } })
    const resized = await readFileAttachment(path, async () => ({ kind: "decoded", data: "c21hbGw=", mimeType: "image/jpeg", originalWidth: 4000, originalHeight: 3000, width: 2000, height: 1500, wasResized: true }))
    expect(resized).toEqual({ attachment: { mediaType: "image/jpeg", data: "c21hbGw=", name: "shot.png" } })
  })
  it("refuses kinds and bytes the message cannot carry", async () => {
    const pdf = join(dir, "paper.pdf")
    await writeFile(pdf, "%PDF-1.4")
    expect(await readFileAttachment(pdf, noResize)).toEqual({ refusal: { reason: "kind", mediaType: "application/pdf" } })
    const binary = join(dir, "blob.txt")
    await writeFile(binary, Buffer.from([0xff, 0xfe, 0x00, 0x80]))
    expect(await readFileAttachment(binary, noResize)).toEqual({ refusal: { reason: "unreadable" } })
    const heic = join(dir, "photo.heic")
    await writeFile(heic, "not really")
    expect(await readFileAttachment(heic, noResize)).toEqual({ refusal: { reason: "kind", mediaType: "image/heic" } })
  })
})
