import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { CodeMode } from "../../../../src/infra/code-mode/index.js"

describe("Flywheel Code Mode deviations", () => {
  test("a log-only cap preserves a large returned value and warnings", async () => {
    const result = await Effect.runPromise(CodeMode.execute({
      code: `console.log("first"); console.log("oversized"); console.log("x"); Promise.reject(new Error("boom")); return "r".repeat(100_000)`,
      limits: { maxLogBytes: 8 },
    }))
    expect(result).toMatchObject({
      ok: true,
      value: "r".repeat(100_000),
      truncated: true,
      logs: ["first", "[2 more console lines dropped after the 8-byte retention budget]"],
      warnings: [{ kind: "ExecutionFailure" }],
    })
  })

  test.each<{ maxLogBytes: number; lines: string[]; kept: string[]; dropped: number }>([
    { maxLogBytes: 5, lines: ["é", "é", ""], kept: ["é"], dropped: 2 },
    { maxLogBytes: 0, lines: ["", "a", ""], kept: [], dropped: 3 },
    { maxLogBytes: 3, lines: ["long", "a", ""], kept: [], dropped: 3 },
    { maxLogBytes: 4, lines: ["é", ""], kept: ["é", ""], dropped: 0 },
  ])("retains a UTF-8 whole-line prefix: $maxLogBytes bytes, $lines", async ({ maxLogBytes, lines, kept, dropped }) => {
    const streamed: string[] = []
    const result = await Effect.runPromise(CodeMode.execute({
      code: `for (const line of ${JSON.stringify(lines)}) console.log(line); return null`,
      limits: { maxLogBytes },
      onLog: (line) => Effect.sync(() => { streamed.push(line) }),
    }))
    expect(streamed).toEqual(lines)
    expect(result.logs).toEqual(dropped ? [...kept, `[${dropped} more console lines dropped after the ${maxLogBytes}-byte retention budget]`] : kept)
    expect(result.truncated).toBe(dropped ? true : undefined)
  })

  test("reused Effects isolate their stable readonly views and function sinks", async () => {
    const views: CodeMode.ConsoleLogView[] = []
    const observed: string[] = []
    const effect = CodeMode.execute({
      code: `console.log("a"); function log() { console.log("b"); console.log("c"); } log(); return 1`,
      limits: { maxLogBytes: 4 },
      onLog: (line, view) => Effect.sync(() => {
        observed.push(line)
        views.push(view)
        expect(view.retainedLineCount).toBe(Math.min(observed.length % 3 || 3, 2))
      }),
    })
    const first = await Effect.runPromise(effect)
    const second = await Effect.runPromise(effect)
    expect(observed).toEqual(["a", "b", "c", "a", "b", "c"])
    expect(first).toEqual(second)
    expect(views[0]).toBe(views[2])
    expect(views[3]).toBe(views[5])
    expect(views[0]).not.toBe(views[3])
    expect(Object.isFrozen(views[0])).toBe(true)
    expect(views[0]?.snapshot()).toEqual({ logs: first.logs, truncated: true })
    expect(views[0]?.retainedLineCount).toBe(2)
  })

  test("observes each append before interruption, including dropped lines", async () => {
    const observed: string[] = []
    const views: CodeMode.ConsoleLogView[] = []
    const exit = await Effect.runPromiseExit(CodeMode.execute({
      code: `console.log("kept"); console.log("dropped"); console.log("unreachable")`,
      limits: { maxLogBytes: 5 },
      onLog: (line, view) => Effect.gen(function* () {
        observed.push(line)
        views.push(view)
        if (line === "dropped") yield* Effect.interrupt
      }),
    }))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(observed).toEqual(["kept", "dropped"])
    expect(views.at(-1)?.snapshot()).toEqual({
      logs: ["kept", "[1 more console lines dropped after the 5-byte retention budget]"], truncated: true,
    })
  })

  test("the generic output cap still bounds logs, return values, and warnings", async () => {
    const result = await Effect.runPromise(CodeMode.execute({
      code: `console.log("x".repeat(40)); console.log("later"); Promise.reject(new Error("boom")); return "r".repeat(100)`,
      limits: { maxLogBytes: 100, maxOutputBytes: 20 },
    }))
    expect(result).toMatchObject({
      ok: true, truncated: true,
      logs: ["[2 more console lines dropped after the 20-byte retention budget]"],
      warnings: [{ kind: "Truncated" }],
    })
    if (result.ok) expect(result.value).toBe(`"${"r".repeat(19)} [result truncated: 102 bytes exceeds the 20-byte output limit; return a smaller value]`)
  })

  test.each([-1, 0.5, Infinity, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("validates maxLogBytes: %s", (maxLogBytes) => {
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxLogBytes } })).toThrow("maxLogBytes must be a safe integer greater than or equal to 0.")
  })

  test("bounds retained console lines without changing live streaming", async () => {
    const streamed: Array<string> = []
    const maxOutputBytes = 1_024
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `for (let index = 0; index < 10_000; index++) console.log("line", index); return null`,
        tools: {},
        limits: { maxOutputBytes },
        onLog: (line) => Effect.sync(() => streamed.push(line)).pipe(Effect.asVoid),
      }),
    )

    expect(streamed).toHaveLength(10_000)
    expect(result.truncated).toBe(true)
    expect(result.logs?.at(-1)).toMatch(/^\[\d+ more console lines dropped after the 1024-byte retention budget\]$/)
    const retained = result.logs?.slice(0, -1) ?? []
    expect(new TextEncoder().encode(retained.join("")).byteLength).toBeLessThanOrEqual(maxOutputBytes)
  })

  test("bounds retained empty console lines by per-line overhead", async () => {
    const maxOutputBytes = 256
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `for (let index = 0; index < 10_000; index++) console.log(); return null`,
        tools: {},
        limits: { maxOutputBytes },
      }),
    )

    expect(result.truncated).toBe(true)
    // Zero-byte lines still consume budget, so retention stays bounded.
    expect(result.logs?.length ?? 0).toBeLessThanOrEqual(maxOutputBytes + 1)
  })

  test("keeps TypeScript source positions after stripping", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `const identity = <T,>(value: T): T => value
class Escape {}
return identity(42)`,
        tools: {},
      }),
    )

    expect(result).toMatchObject({ ok: false, error: { location: { line: 2, column: 1 } } })

    const malformed = await Effect.runPromise(
      CodeMode.execute({ code: "const answer: number = 42\nreturn answer +", tools: {} }),
    )
    expect(malformed).toMatchObject({ ok: false, error: { location: { line: 2, column: 1 } } })
  })

  test("does not expose representative host escape capabilities", async () => {
    for (const name of ["globalThis", "process", "require", "eval", "Function"]) {
      const result = await Effect.runPromise(CodeMode.execute({ code: `return typeof ${name}`, tools: {} }))
      expect(result).toMatchObject({ ok: true, value: "undefined" })
    }
  })
})
