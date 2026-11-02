import { describe, expect, test } from "bun:test"
import { type Pointer, ptr, toArrayBuffer } from "bun:ffi"

import { createConsoleTextWriter } from "../../../src/infra/windows-console-output.js"

/** The three kernel32 calls, scripted. `accept` lists how many UTF-16 units
 *  each successive `WriteConsoleW` call takes; a missing entry takes all. The
 *  real library exists only on Windows, and what needs proving here is the
 *  write loop, which is platform-independent. */
function fakeKernel32(script: { readonly console?: boolean; readonly accept?: readonly number[] } = {}) {
  const lengths: number[] = []
  const handle = ptr(new Uint8Array(1))
  const symbols = {
    GetStdHandle: () => handle,
    GetConsoleMode: () => (script.console === false ? 0 : 1),
    WriteConsoleW: (_handle: Pointer, _text: Pointer, length: number, written: Pointer) => {
      lengths.push(length)
      const taken = Math.min(length, script.accept?.[lengths.length - 1] ?? length)
      // The kernel reports the count through the caller's out parameter.
      new Uint32Array(toArrayBuffer(written, 0, 4))[0] = taken
      return taken === 0 ? 0 : 1
    },
  }
  return { lengths, symbols }
}

describe("windows console output", () => {
  test("a frame reaches the console in one call", () => {
    const kernel32 = fakeKernel32()
    const write = createConsoleTextWriter(kernel32.symbols)
    expect(write?.("x".repeat(9000))).toBe(9000)
    expect(kernel32.lengths).toEqual([9000])
  })

  test("a partial write continues with the rest, and a refusal stops", () => {
    const kernel32 = fakeKernel32({ accept: [6000, 1000, 0] })
    const write = createConsoleTextWriter(kernel32.symbols)
    expect(write?.("x".repeat(9000))).toBe(7000)
    expect(kernel32.lengths).toEqual([9000, 3000, 2000])
  })

  test("a stream that is not a console gets no writer", () => {
    expect(createConsoleTextWriter(fakeKernel32({ console: false }).symbols)).toBeUndefined()
  })
})
