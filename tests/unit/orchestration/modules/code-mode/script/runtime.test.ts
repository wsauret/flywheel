import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Schema } from "effect"
import type { CodeModeToolDescriptor } from "../../../../../../src/orchestration/modules/code-mode/descriptors.js"
import type { CodeModeResult } from "../../../../../../src/orchestration/modules/code-mode/result-format.js"
import {
  makeScriptRuntime,
  toolFailure,
  unknownTool,
  type ConsoleLogView,
  type ScriptRuntimeOptions,
} from "../../../../../../src/orchestration/modules/code-mode/script/runtime.js"

const tool = (name: string): CodeModeToolDescriptor => ({ name, path: name.split("."), description: `${name} tool`, inputSchema: { type: "object" } })

const runtime = (names: readonly string[], options: Partial<ScriptRuntimeOptions> = {}) => makeScriptRuntime({
  descriptors: names.map(tool),
  call: (name) => Effect.succeed(name),
  maxToolCalls: 50,
  maxLogBytes: 50 * 1024,
  ...options,
})

const run = (code: string, names: readonly string[] = [], options: Partial<ScriptRuntimeOptions> = {}) =>
  Effect.runPromise(runtime(names, options).execute(code))

const value = async (code: string, names: readonly string[] = [], options: Partial<ScriptRuntimeOptions> = {}) => {
  const result = await run(code, names, options)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const failure = async (code: string, names: readonly string[] = [], options: Partial<ScriptRuntimeOptions> = {}) => {
  const result = await run(code, names, options)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

class UnsafeHostError extends Schema.TaggedError<UnsafeHostError>()("UnsafeHostError", { reason: Schema.String }) {}

describe("Code Mode host failure boundary", () => {
  test("a refused call keeps its message as a ToolFailure", async () => {
    const error = await failure("return await tools.host.call({})", ["host.call"], { call: () => Effect.fail(toolFailure("File not found: /scratch/report.json")) })
    expect(error).toStrictEqual({ kind: "ToolFailure", message: "File not found: /scratch/report.json" })
  })

  test("an unknown host failure or defect reaches the script with no host text", async () => {
    for (const cause of [
      Effect.fail(new UnsafeHostError({ reason: "Authorization: typed-secret" })),
      Effect.die(new Error("postgres://user:defect-secret@example.invalid")),
    ]) {
      const result = await run("return await tools.host.call({})", ["host.call"], { call: () => cause })
      expect(result).toStrictEqual({ ok: false, error: { kind: "ToolFailure", message: "Tool execution failed" } })
    }
  })

  test("a caught tool failure is an Error value with its message", async () => {
    const caught = await value(
      `try { await tools.host.call({}); return "no" } catch (e) { return { isError: e instanceof Error, message: e.message } }`,
      ["host.call"],
      { call: () => Effect.fail(toolFailure("Refused")) },
    )
    expect(caught).toStrictEqual({ isError: true, message: "Refused" })
  })

  test("interrupting the run interrupts the calls it started", async () => {
    const started = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const fiber = Effect.runFork(runtime(["host.call"], {
      call: () => Effect.sync(() => started.resolve()).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
      ),
    }).execute("const pending = tools.host.call({}); return await pending"))
    await started.promise
    const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))
    expect(Exit.hasInterrupts(exit)).toBe(true)
    await interrupted.promise
  })
})

describe("Code Mode tool paths", () => {
  test("dotted names nest, and a dotted bracket segment names the same tool", async () => {
    const names = ["api.issues.list"]
    expect(await value(`return [await tools.api.issues.list({}), await tools.api["issues.list"]({}), await tools["api.issues"].list({})]`, names))
      .toEqual(["api.issues.list", "api.issues.list", "api.issues.list"])
    expect(await value(`return [Object.keys(tools.api), Object.keys(tools.api.issues), Object.keys(tools["api.issues"])]`, names))
      .toEqual([["issues"], ["list"], ["list"]])
  })

  test("enumerates namespaces and tools in catalog order through Object.keys and for...in", async () => {
    const names = ["github.list_issues", "github.get_issue", "memory.search", "playwright.navigate"]
    expect(await value(`return Object.keys(tools)`, names)).toEqual(["github", "memory", "playwright"])
    expect(await value(`const names = []; for (const ns in tools) for (const name in tools[ns]) names.push(ns + "." + name); return names`, names)).toEqual(names)
  })

  test("an unknown namespace fails to enumerate with UnknownTool", async () => {
    const error = await failure(`return Object.keys(tools.nonexistent)`, ["github.list_issues"])
    expect(error.kind).toBe("UnknownTool")
    expect(error.message).toContain("Unknown tool namespace 'nonexistent'")
  })

  test("a namespace without its own tool is not callable", async () => {
    const error = await failure(`return await tools.issues({})`, ["issues.list"])
    expect(error.kind).toBe("UnknownTool")
    expect(error.message).toContain("Tool 'issues' is not callable")
    expect(await value(`return await tools.issues({}).catch((e) => "recovered: " + e.message)`, ["issues.list"]))
      .toBe("recovered: Tool 'issues' is not callable.")
  })

  test("a name outside the catalog goes to the host, whose UnknownTool answer keeps its suggestions", async () => {
    const asked: string[] = []
    const error = await failure(`return await tools.later.arrived({})`, ["github.list_issues"], {
      call: (name) => Effect.suspend(() => {
        asked.push(name)
        return Effect.fail(unknownTool(name))
      }),
    })
    expect(asked).toEqual(["later.arrived"])
    expect(error).toStrictEqual({
      kind: "UnknownTool",
      message: "Unknown tool 'later.arrived'.",
      suggestions: ["The tool may have been removed or renamed. Use searchCatalog to find available tools."],
    })
  })

  test("a call takes exactly one input object", async () => {
    for (const call of ["tools.notes.echo()", "tools.notes.echo({}, {})"]) {
      const error = await failure(`return await ${call}`, ["notes.echo"])
      expect(error).toStrictEqual({ kind: "InvalidToolInput", message: "Tool 'notes.echo' expects exactly one input object." })
    }
  })

  test("tool input crosses as JSON data, so a conditional undefined field drops", async () => {
    const received: unknown[] = []
    await value(
      `return await tools.adapter.call({ q: undefined, limit: 0 / 0, rate: 1 / 0, items: [1, undefined, 2], holes: [1, , 3] })`,
      ["adapter.call"],
      { call: (_, input) => Effect.sync(() => received.push(input)) },
    )
    expect(received).toStrictEqual([{ limit: null, rate: null, items: [1, null, 2], holes: [1, null, 3] }])
  })

  test("an argument that is not data fails with InvalidDataValue, and an un-awaited call says to await it", async () => {
    expect(await failure(`return await tools.notes["echo"]({ id: tools.notes.echo({}) })`, ["notes.echo"])).toStrictEqual({
      kind: "InvalidDataValue",
      message: "Arguments for tool 'notes.echo' contains an un-awaited Promise; await tool calls (e.g. `const result = await tools.ns.tool(...)`) before using their results. (line 1, col 14)",
      location: { line: 1, column: 14 },
    })
    for (const argument of ["() => 1", "1n"]) {
      expect((await failure(`return searchCatalog({ query: ${argument} })`)).message).toStartWith("Arguments for tool 'searchCatalog' must contain data only.")
    }
  })
})

describe("Code Mode tool-call budget and searchCatalog", () => {
  test("every call, searchCatalog included, spends the per-run budget, and a new run starts with a full one", async () => {
    const script = runtime(["host.echo"], { maxToolCalls: 2 })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await Effect.runPromise(script.execute(`searchCatalog({}); await tools.host.echo({}); return await tools.host.echo({})`))
      expect(result).toStrictEqual({ ok: false, error: { kind: "ToolCallLimitExceeded", message: "Execution exceeded its tool-call limit of 2." } })
    }
  })

  test("searchCatalog is a synchronous, shadowable global", async () => {
    expect(await value(`return [typeof searchCatalog, searchCatalog({ query: "echo" }).items.map((item) => item.path)]`, ["host.echo", "host.other"]))
      .toEqual(["function", ["tools.host.echo"]])
    expect(await value(`const searchCatalog = () => "local"; return searchCatalog()`)).toBe("local")
    expect(await value(`return searchCatalog({ query: undefined }).items.length`, ["host.echo"])).toBe(1)
  })

  test("rejects invalid search input as InvalidToolInput", async () => {
    for (const input of [`{ limit: 0.5 }`, `{ offset: -1 }`, `{ offset: 0.5 }`, `{ offset: ${Number.MAX_SAFE_INTEGER + 1} }`, `{ offset: "1" }`, `{ namespace: 7 }`]) {
      const error = await failure(`return searchCatalog(${input})`, ["orders.lookup"])
      expect(error.kind).toBe("InvalidToolInput")
      expect(error.message).toStartWith("Invalid input for tool 'searchCatalog': ")
    }
  })
})

describe("Code Mode console retention", () => {
  test("a log-only budget keeps a whole-line prefix and leaves a large return value and warnings whole", async () => {
    const result = await run(
      `console.log("first"); console.log("oversized"); console.log("x"); Promise.reject(new Error("boom")); return "r".repeat(100_000)`,
      [],
      { maxLogBytes: 8 },
    )
    expect(result).toMatchObject({
      ok: true,
      value: "r".repeat(100_000),
      truncated: true,
      logs: ["first", "[2 more console lines dropped after the 8-byte retention budget]"],
      warnings: [{ kind: "ExecutionFailure", message: "Unhandled rejection from an un-awaited promise: Error: boom" }],
    })
  })

  test.each<{ maxLogBytes: number; lines: string[]; kept: string[]; dropped: number }>([
    { maxLogBytes: 5, lines: ["é", "é", ""], kept: ["é"], dropped: 2 },
    { maxLogBytes: 0, lines: ["", "a", ""], kept: [], dropped: 3 },
    { maxLogBytes: 3, lines: ["long", "a", ""], kept: [], dropped: 3 },
    { maxLogBytes: 4, lines: ["é", ""], kept: ["é", ""], dropped: 0 },
  ])("retains a UTF-8 whole-line prefix: $maxLogBytes bytes, $lines", async ({ maxLogBytes, lines, kept, dropped }) => {
    const streamed: string[] = []
    const result = await run(`for (const line of ${JSON.stringify(lines)}) console.log(line); return null`, [], {
      maxLogBytes,
      onLog: (line) => streamed.push(line),
    })
    expect(streamed).toEqual(lines)
    expect(result.logs).toEqual(dropped ? [...kept, `[${dropped} more console lines dropped after the ${maxLogBytes}-byte retention budget]`] : kept)
    expect(result.truncated).toBe(dropped ? true : undefined)
  })

  test("streams each line while the program runs, before the call that follows it, with the run's own view", async () => {
    const events: string[] = []
    const views: ConsoleLogView[] = []
    const script = runtime(["host.call"], {
      maxLogBytes: 4,
      onLog: (line, view) => {
        events.push(`log ${line} retained=${view.retainedLineCount}`)
        views.push(view)
      },
      call: () => Effect.sync(() => { events.push("call") }),
    })
    const results: CodeModeResult[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      events.length = 0
      results.push(await Effect.runPromise(script.execute(`console.log("a"); await tools.host.call({}); console.log("b"); console.log("c"); return 1`)))
      expect(events).toEqual(["log a retained=1", "call", "log b retained=2", "log c retained=2"])
    }
    expect(results[0]).toStrictEqual({ ok: true, value: 1, logs: ["a", "b", "[1 more console lines dropped after the 4-byte retention budget]"], truncated: true })
    expect(results[1]).toStrictEqual(results[0])
    expect(views[0]).toBe(views[2])
    expect(views[0]).not.toBe(views[3])
    expect(Object.isFrozen(views[0])).toBe(true)
  })

  test("formats console values with the interpreter's own formatting", async () => {
    const result = await run(`console.log({ a: [1, "x"] }, Promise.resolve(1), 0 / 0); console.warn("careful"); return null`)
    expect(result.logs?.[1]).toBe("[warn] careful")
    expect(result.logs?.[0]).toStartWith(`{"a":[1,"x"]} `)
  })
})

describe("Code Mode TypeScript input", () => {
  test("keeps the source positions of runtime errors after stripping types", async () => {
    const error = await failure(`const identity = <T,>(value: T): T => value\nconst o: { x: number } | null = null\nreturn identity(o!.x)`)
    expect(error.location).toEqual({ line: 3, column: 17 })
  })

  test("reports a TypeScript parse error at its line in the submitted source", async () => {
    const error = await failure("const answer: number = 42\nreturn answer +")
    expect(error).toMatchObject({ kind: "ParseError", location: { line: 2, column: 1 } })
    expect(error.message).toStartWith("Failed to parse TypeScript: ")
  })

  test("accepts top-level await, return, and an implicit final expression", async () => {
    expect(await value(`const r: number = await Promise.resolve(1)\nreturn r + 1`)).toBe(2)
    expect(await value(`const x: number = 6\nx * 7`)).toBe(42)
  })
})

describe("Code Mode confinement", () => {
  test("exposes no host escape capability", async () => {
    expect(await value(`return [typeof globalThis, typeof process, typeof eval]`)).toEqual(["undefined", "undefined", "undefined"])
    for (const escape of [`require("fs")`, `Function("return process")()`]) {
      expect((await run(`return ${escape}`)).ok).toBe(false)
    }
  })
})
