import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

import type { OwnedCommandResult } from "../../../../src/infra/owned-command.js"
import { createClipboard } from "../../../../src/tui/utils/clipboard.js"
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../../helpers/owned-command-fake.js"

const NOTHING = ownedCommandResult()

/** The clipboard reads the host platform and its installed tools directly, so a
 *  test states both instead of inheriting the machine it runs on. */
function onHost(platform: string, installed: readonly string[]): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true, writable: true })
  Bun.which = (name: string) => (installed.includes(name) ? `/usr/bin/${name}` : null)
}

const realPlatform = process.platform
const realWhich = Bun.which

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true, writable: true })
  Bun.which = realWhich
})

/** The path one AppleScript writes its image to. */
function scriptTarget(command: readonly string[]): string {
  const match = /POSIX file "([^"]+)"/.exec(command.at(-1) ?? "")
  if (!match?.[1]) throw new Error(`no image path in ${command.at(-1)}`)
  return match[1]
}

describe("copying text", () => {
  test("gives the text to the platform tool on its standard input, under a lease", async () => {
    onHost("darwin", ["pbcopy"])
    const runner = fakeOwnedCommandRunner(() => Promise.resolve(NOTHING))

    await createClipboard(runner.run).copy("copied text")

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.command).toEqual(["pbcopy"])
    expect(runner.calls[0]?.options?.stdin).toBe("copied text")
    expect(runner.calls[0]?.options?.timeoutMs).toBeGreaterThan(0)
  })

  test("settles only after the tool's container settles", async () => {
    onHost("darwin", ["pbcopy"])
    let release: (result: OwnedCommandResult) => void = () => {}
    const pending = new Promise<OwnedCommandResult>((settle) => { release = settle })
    const runner = fakeOwnedCommandRunner(() => pending)
    let copied = false

    const copy = createClipboard(runner.run).copy("copied text").then(() => { copied = true })
    await Promise.resolve()
    expect(copied).toBe(false)

    release(NOTHING)
    await copy
    expect(copied).toBe(true)
  })

  test("reports success even when the tool fails, and keeps using one resolved tool", async () => {
    onHost("linux", ["xclip"])
    const runner = fakeOwnedCommandRunner(() => Promise.resolve(ownedCommandResult("", 1)))
    const clipboard = createClipboard(runner.run)

    await clipboard.copy("first")
    await clipboard.copy("second")

    expect(runner.calls.map((call) => call.command)).toEqual([
      ["xclip", "-selection", "clipboard"],
      ["xclip", "-selection", "clipboard"],
    ])
    expect(runner.calls.map((call) => call.options?.stdin)).toEqual(["first", "second"])
  })

  test("launches nothing when the platform has no clipboard tool", async () => {
    onHost("linux", [])
    const runner = fakeOwnedCommandRunner(() => Promise.reject(new Error("a host without a tool must not launch")))

    await createClipboard(runner.run).copy("copied text")

    expect(runner.calls).toEqual([])
  })
})

describe("reading a clipboard image", () => {
  test("returns the bytes the mac tool wrote, and removes the temp file", async () => {
    onHost("darwin", ["osascript"])
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const targets: string[] = []
    const runner = fakeOwnedCommandRunner(async (command) => {
      const path = scriptTarget(command)
      targets.push(path)
      await Bun.write(path, png)
      return NOTHING
    })

    const image = await createClipboard(runner.run).readImage()

    expect(image).toEqual({ mediaType: "image/png", data: Buffer.from(png).toString("base64") })
    expect(targets).toHaveLength(1)
    expect(existsSync(targets[0] ?? "")).toBe(false)
  })

  test("removes the temp file of every format it tried when the clipboard holds no image", async () => {
    onHost("darwin", ["osascript"])
    const targets: string[] = []
    const runner = fakeOwnedCommandRunner((command) => {
      targets.push(scriptTarget(command))
      return Promise.resolve(ownedCommandResult("", 1))
    })

    const image = await createClipboard(runner.run).readImage()

    expect(image).toBeNull()
    expect(targets.length).toBeGreaterThan(1)
    expect(targets.filter((path) => existsSync(path))).toEqual([])
  })

  test("reads the raw output bytes on linux rather than a text view of them", async () => {
    onHost("linux", ["xclip"])
    // Not valid UTF-8: decoding these to text and back would corrupt the image.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81])
    const runner = fakeOwnedCommandRunner((command) =>
      Promise.resolve(command.includes("image/jpeg") ? ownedCommandResult(jpeg) : NOTHING))

    const image = await createClipboard(runner.run).readImage()

    expect(image).toEqual({ mediaType: "image/jpeg", data: Buffer.from(jpeg).toString("base64") })
  })

  test("reports no image without launching anything when the platform has no tool", async () => {
    onHost("linux", [])
    const runner = fakeOwnedCommandRunner(() => Promise.reject(new Error("a host without a tool must not launch")))

    expect(await createClipboard(runner.run).readImage()).toBeNull()
    expect(runner.calls).toEqual([])
  })
})
