import { describe, expect, test } from "bun:test"
import { createPasteBurstController } from "../../../../src/tui/hooks/paste-burst.js"

function harness(platform: NodeJS.Platform = "darwin") {
  const typed: string[] = []
  const pasted: string[] = []
  const burst = createPasteBurstController({
    insertTyped: (text) => { typed.push(text) },
    applyPaste: (text) => { pasted.push(text) },
    platform,
    schedule: () => undefined,
    cancel: () => {},
  })
  return { burst, typed, pasted }
}

describe("createPasteBurstController", () => {
  test("holds one ASCII character and flushes it as typing", () => {
    const { burst, typed } = harness()
    expect(burst.onCharacter("a", 100)).toBe(true)
    expect(typed).toEqual([])
    burst.flushDue(108)
    expect(typed).toEqual(["a"])
  })

  test("emits two fast ASCII characters as one paste", () => {
    const { burst, pasted } = harness()
    burst.onCharacter("a", 100)
    burst.onCharacter("b", 104)
    burst.flushDue(112)
    expect(pasted).toEqual(["ab"])
  })

  test("accumulates characters, Enter, and Tab while active", () => {
    const { burst, pasted } = harness()
    burst.onCharacter("a", 100)
    burst.onCharacter("b", 101)
    burst.onCharacter("c", 102)
    expect(burst.onControl("\n", 103)).toBe(true)
    expect(burst.onControl("\t", 104)).toBe(true)
    burst.flushDue(112)
    expect(pasted).toEqual(["abc\n\t"])
  })

  test("flushes before modified input and clears classification", () => {
    const { burst, pasted } = harness()
    burst.onCharacter("a", 100)
    burst.onCharacter("b", 101)
    burst.flushBeforeModifiedInput()
    expect(pasted).toEqual(["ab"])
    expect(burst.onControl("\n", 102)).toBe(false)
  })

  test("keeps Enter suppressed for 120 ms after a burst", () => {
    const { burst } = harness()
    burst.onCharacter("a", 100)
    burst.onCharacter("b", 101)
    burst.flushDue(109)
    expect(burst.newlineShouldInsert(221)).toBe(true)
    expect(burst.newlineShouldInsert(222)).toBe(false)
  })

  test("never holds the first non-ASCII character", () => {
    const { burst, typed } = harness()
    expect(burst.onCharacter("界", 100)).toBe(false)
    expect(typed).toEqual(["界"])
  })

  test("retro-captures only a whitespace or 16-character prefix", () => {
    const { burst } = harness()
    expect(burst.decideRetroCapture("ab", 2)).toBeUndefined()
    expect(burst.decideRetroCapture("a b", 2)).toEqual({ start: 1, text: " b" })
    expect(burst.decideRetroCapture("1234567890abcdef", 16)).toEqual({ start: 0, text: "1234567890abcdef" })
  })

  test("snapshot preserves pending text and clear/dispose stop it", () => {
    const { burst, typed, pasted } = harness()
    burst.onCharacter("a", 100)
    expect(burst.snapshot()).toBe("a")
    burst.clear()
    expect(burst.snapshot()).toBe("")
    burst.onCharacter("b", 200)
    burst.dispose()
    burst.flushDue(300)
    expect(typed).toEqual([])
    expect(pasted).toEqual([])
  })

  test("uses the longer active idle timeout on Windows", () => {
    const { burst, pasted } = harness("win32")
    burst.onCharacter("a", 100)
    burst.onCharacter("b", 101)
    burst.flushDue(110)
    expect(pasted).toEqual([])
    burst.flushDue(161)
    expect(pasted).toEqual(["ab"])
  })

  test("keeps one timer armed while characters arrive and rearms only for the remaining idle delay", () => {
    const delays: number[] = []
    const callbacks: Array<() => void> = []
    let now = 100
    let cancels = 0
    const burst = createPasteBurstController({
      platform: "darwin",
      insertTyped: () => {},
      applyPaste: () => {},
      now: () => now,
      schedule: (callback, delay) => {
        callbacks.push(callback)
        delays.push(delay)
        const handle = setTimeout(() => {}, 1_000)
        clearTimeout(handle)
        return handle
      },
      cancel: () => { cancels += 1 },
    })

    burst.onCharacter("a", 100)
    burst.onCharacter("b", 104)
    burst.onCharacter("c", 107)
    expect(delays).toEqual([8])
    expect(cancels).toBe(0)
    now = 108
    callbacks.shift()?.()
    expect(delays).toEqual([8, 7])
  })
})
