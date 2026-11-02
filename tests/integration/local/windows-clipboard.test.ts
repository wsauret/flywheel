import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi"

import { windowsClipboard } from "../../../src/infra/windows-clipboard.js"

const onWindows = process.platform === "win32"

/** Reads the clipboard through its own declarations rather than through the
 *  writer's.
 *
 *  A reader shared with the writer would only prove the two agree with each
 *  other. What has to be proven is that the clipboard itself holds the text, so
 *  this is deliberately an independent path to the same place. */
async function readClipboardText(): Promise<string | undefined> {
  // The clipboard is a single-owner global, so reading it contends exactly like
  // writing it. An oracle that gave up on the first refusal would report a
  // failure of the resource as a failure of the writer.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = readClipboardTextOnce()
    if (text !== undefined) return text
    await Bun.sleep(2 * (attempt + 1))
  }
  return undefined
}

function readClipboardTextOnce(): string | undefined {
  const CF_UNICODETEXT = 13
  const user32 = dlopen("user32.dll", {
    OpenClipboard: { args: [FFIType.ptr], returns: FFIType.i32 },
    CloseClipboard: { args: [], returns: FFIType.i32 },
    GetClipboardData: { args: [FFIType.u32], returns: FFIType.ptr },
    IsClipboardFormatAvailable: { args: [FFIType.u32], returns: FFIType.i32 },
  }).symbols
  const kernel32 = dlopen("kernel32.dll", {
    GlobalLock: { args: [FFIType.ptr], returns: FFIType.ptr },
    GlobalUnlock: { args: [FFIType.ptr], returns: FFIType.i32 },
    GlobalSize: { args: [FFIType.ptr], returns: FFIType.u64 },
  }).symbols
  if (!user32.IsClipboardFormatAvailable(CF_UNICODETEXT)) return undefined
  if (!user32.OpenClipboard(null)) return undefined
  try {
    const handle = user32.GetClipboardData(CF_UNICODETEXT)
    if (!handle) return undefined
    const size = Number(kernel32.GlobalSize(handle))
    const locked = kernel32.GlobalLock(handle)
    if (!locked) return undefined
    try {
      const view = new DataView(toArrayBuffer(locked, 0, size))
      let text = ""
      for (let offset = 0; offset + 1 < size; offset += 2) {
        const unit = view.getUint16(offset, true)
        if (unit === 0) break
        text += String.fromCharCode(unit)
      }
      return text
    } finally {
      kernel32.GlobalUnlock(handle)
    }
  } finally {
    user32.CloseClipboard()
  }
}

describe("windows clipboard", () => {
  // The clipboard belongs to whoever is at the keyboard, and these cases
  // replace it. Whatever text was there is put back afterwards.
  let borrowed: string | undefined
  beforeAll(async () => { if (onWindows) borrowed = await readClipboardText() })
  afterAll(async () => { if (onWindows && borrowed !== undefined) await windowsClipboard()?.writeText(borrowed) })

  test.skipIf(!onWindows)("puts text on the clipboard where anything else can read it", async () => {
    const clipboard = windowsClipboard()
    expect(clipboard).toBeDefined()
    const text = `flywheel clipboard ${crypto.randomUUID()}`

    expect(await clipboard?.writeText(text)).toBe(true)

    expect(await readClipboardText()).toBe(text)
  })

  test.skipIf(!onWindows)("carries text no byte-oriented copy would survive", async () => {
    // The format holds UTF-16, which a JavaScript string already is. An emoji
    // is a surrogate pair, so a copy that walked bytes or assumed one unit per
    // character would corrupt exactly this.
    const text = "tabs\tnewlines\nquotes \"'` emoji 🎡 CJK 日本語 accents éü"

    expect(await windowsClipboard()?.writeText(text)).toBe(true)

    expect(await readClipboardText()).toBe(text)
  })

  test.skipIf(!onWindows)("replaces what was there rather than appending to it", async () => {
    const clipboard = windowsClipboard()
    await clipboard?.writeText("the first value, which is longer")

    await clipboard?.writeText("second")

    expect(await readClipboardText()).toBe("second")
  })

  test.skipIf(!onWindows)("writes an empty string as an empty clipboard, not a failure", async () => {
    expect(await windowsClipboard()?.writeText("")).toBe(true)
    expect(await readClipboardText()).toBe("")
  })

  test.skipIf(!onWindows)("takes the clipboard back on every copy of a burst", async () => {
    // The clipboard is a single-owner global, so a burst contends with itself
    // and with anything else holding it. Every copy has to land.
    const clipboard = windowsClipboard()
    const results: boolean[] = []
    for (let index = 0; index < 25; index += 1) {
      results.push((await clipboard?.writeText(`burst ${index}`)) ?? false)
    }

    expect(results.every(Boolean)).toBe(true)
    expect(await readClipboardText()).toBe("burst 24")
  })

  test.skipIf(onWindows)("is absent on platforms whose clipboard is a program", () => {
    expect(windowsClipboard()).toBeUndefined()
  })
})
