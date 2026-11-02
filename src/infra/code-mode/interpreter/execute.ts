import { parse } from "acorn"
import { Cause, Effect, Scope } from "effect"
import { transformSync } from "amaro"
import type { ConsoleLogView, DataValue, Diagnostic, ExecuteOptions, ResolvedExecutionLimits, Result } from "../codemode.js"
import { copyIn, copyOut, ToolRuntime, type Services } from "../tool-runtime.js"
import type { Tools } from "../tools.js"
import { normalizeError } from "./errors.js"
import { InterpreterRuntimeError, isRecord, type ProgramNode } from "./model.js"
import { PromiseRuntime } from "./promises.js"
import { Interpreter } from "./runtime.js"

class RetainedLogs {
  readonly #maxBytes: number
  readonly #lines: Array<string> = []
  #retainedBytes = 0
  #droppedLines = 0
  readonly view: ConsoleLogView

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes
    const logs = this
    this.view = Object.freeze({
      get retainedLineCount() { return logs.#lines.length },
      snapshot: () => logs.logged(),
    })
  }

  append(line: string): void {
    if (this.#droppedLines > 0) {
      this.#droppedLines += 1
      return
    }
    // Per-line overhead bounds empty lines. The first overflow closes the prefix.
    const bytes = utf8ByteLength(line) + 1
    if (this.#retainedBytes + bytes > this.#maxBytes) {
      this.#droppedLines += 1
      return
    }
    this.#retainedBytes += bytes
    this.#lines.push(line)
  }

  logged(): { readonly logs?: Array<string>; readonly truncated?: true } {
    if (this.#droppedLines > 0) {
      return {
        logs: [...this.#lines, `[${this.#droppedLines} more console lines dropped after the ${this.#maxBytes}-byte retention budget]`],
        truncated: true,
      }
    }
    return this.#lines.length > 0 ? { logs: [...this.#lines] } : {}
  }
}

export const executeWithLimits = <const Provided extends Record<string, unknown>>(
  options: ExecuteOptions<Provided>,
  limits: ResolvedExecutionLimits,
  searchIndex: ToolRuntime.DiscoveryPlan["searchIndex"],
): Effect.Effect<Result, never, Services<Provided>> => {
  if (options.code.trim().length === 0) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ParseError", message: "Code cannot be empty." },
      toolCalls: [],
    })
  }

  // Allocate execution state inside suspension so reused Effects never share it.
  return Effect.suspend(() => {
    const tools = ToolRuntime.make(
      (options.tools ?? {}) as Tools<Services<Provided>>,
      limits.maxToolCalls,
      searchIndex,
      {
        onToolCallStart: options.onToolCallStart,
        onToolCallEnd: options.onToolCallEnd,
        onUnknownTool: options.onUnknownTool,
      },
    )
    const logs = new RetainedLogs(Math.min(
      limits.maxLogBytes ?? Number.POSITIVE_INFINITY,
      limits.maxOutputBytes ?? Number.POSITIVE_INFINITY,
    ))
    const logged = () => logs.logged()
    const appendAndObserve = (line: string): Effect.Effect<void, never, Services<Provided>> =>
      Effect.suspend(() => {
        logs.append(line)
        return options.onLog?.(line, logs.view) ?? Effect.void
      })
    // Set only after copy-out so timeouts cannot report invalid values as completed.
    let returned: { value: DataValue; promises: PromiseRuntime<Services<Provided>> } | undefined

    const base = Effect.acquireUseRelease(
      Scope.make("parallel"),
      (scope) =>
        Effect.gen(function* () {
          const program = parseProgram(options.code)
          const promises = new PromiseRuntime<Services<Provided>>(scope)
          const interpreter = new Interpreter<Services<Provided>>(
            tools.execute,
            tools.search,
            tools.keys,
            promises,
            appendAndObserve,
          )
          const value = yield* interpreter.run(program)
          const result = copyOut(copyIn(value, "Execution result"), "nullify") as DataValue
          returned = { value: result, promises }
          const warnings = yield* promises.interrupt()
          return {
            ok: true,
            value: result,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result
        }),
      (scope, exit) => Scope.close(scope, exit),
    )
    const timeoutMs = limits.timeoutMs
    const operation =
      timeoutMs === undefined
        ? base
        : base.pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.sync(() => {
                  if (returned === undefined) {
                    return {
                      ok: false,
                      error: { kind: "TimeoutExceeded", message: `Execution timed out after ${timeoutMs}ms.` },
                      ...logged(),
                      toolCalls: tools.calls,
                    } satisfies Result
                  }
                  // Keep the timeout warning first so truncation preserves it.
                  return {
                    ok: true,
                    value: returned.value,
                    warnings: [
                      {
                        kind: "TimeoutExceeded",
                        message: `The program returned, but background work was still running at the ${timeoutMs}ms timeout and was interrupted. Await all started promises.`,
                      },
                      ...returned.promises.diagnostics(),
                    ],
                    ...logged(),
                    toolCalls: tools.calls,
                  } satisfies Result
                }),
            }),
          )

    return operation.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed({
              ok: false,
              error: normalizeError(Cause.squash(cause)),
              ...logged(),
              toolCalls: tools.calls,
            } satisfies Result),
      ),
      Effect.map((result) =>
        limits.maxOutputBytes === undefined ? result : boundOutput(result, limits.maxOutputBytes),
      ),
    )
  })
}

const parseProgram = (code: string): ProgramNode => {
  const wrapped = `async function __codemode__() {\n${code}\n}`
  let stripped: string
  try {
    stripped = transformSync(wrapped, { mode: "strip-only" }).code
  } catch (cause) {
    const details = isRecord(cause) ? cause : {}
    const message = typeof details.message === "string" ? details.message : "Unknown syntax error"
    const submittedLines = code.split("\n").length
    const wrappedLine = typeof details.startLine === "number" ? details.startLine : 2
    const column = typeof details.startColumn === "number" ? details.startColumn : 0
    const line = Math.min(Math.max(1, wrappedLine - 1), submittedLines)
    throw new InterpreterRuntimeError(
      `Failed to parse TypeScript: ${message}`,
      { type: "ParseError", loc: { start: { line: line + 1, column }, end: { line: line + 1, column } } },
      "ParseError",
    )
  }

  const bodyStart = stripped.indexOf("{") + 1
  const bodyEnd = stripped.lastIndexOf("}")
  const executableCode = stripped.slice(bodyStart, bodyEnd)
  const parsed = parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as unknown

  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.")
  }

  return parsed as ProgramNode
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

// Drop a replacement character produced by truncating inside a UTF-8 sequence.
const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  const text = new TextDecoder("utf-8").decode(bytes.slice(0, Math.max(0, maxBytes)))
  return text.endsWith("\uFFFD") ? text.slice(0, -1) : text
}

// Warnings have a separate budget so result data cannot starve diagnostics.
const boundOutput = (result: Result, maxOutputBytes: number): Result => {
  let truncated = false

  let value: DataValue = null
  let valueBytes = 0
  if (result.ok) {
    const serialized = JSON.stringify(result.value) ?? "null"
    const bytes = utf8ByteLength(serialized)
    if (bytes > maxOutputBytes) {
      truncated = true
      value = `${utf8Truncate(serialized, maxOutputBytes)} [result truncated: ${bytes} bytes exceeds the ${maxOutputBytes}-byte output limit; return a smaller value]`
      valueBytes = maxOutputBytes
    } else {
      value = result.value
      valueBytes = bytes
    }
  }

  const warnings = result.ok ? (result.warnings ?? []) : []
  const keptWarnings: Array<Diagnostic> = []
  let warningBytes = 0
  for (const warning of warnings) {
    const bytes = utf8ByteLength(JSON.stringify(warning)) + 1
    if (warningBytes + bytes > maxOutputBytes) break
    warningBytes += bytes
    keptWarnings.push(warning)
  }
  if (keptWarnings.length < warnings.length) {
    truncated = true
    keptWarnings.push({
      kind: "Truncated",
      message: `${warnings.length - keptWarnings.length} additional warnings omitted by the output limit.`,
    })
  }

  const logs = result.logs ?? []
  const retentionMarker = result.truncated === true && logs.at(-1)?.includes("more console lines dropped after the")
    ? logs.at(-1)
    : undefined
  const retainedLogs = retentionMarker === undefined ? logs : logs.slice(0, -1)
  const kept: Array<string> = []
  const logBudget = Math.max(0, maxOutputBytes - valueBytes)
  let logBytes = 0
  for (const line of retainedLogs) {
    const lineBytes = utf8ByteLength(line) + 1
    if (logBytes + lineBytes > logBudget) break
    logBytes += lineBytes
    kept.push(line)
  }
  if (retentionMarker !== undefined) {
    truncated = true
    kept.push(retentionMarker)
  } else if (kept.length < logs.length) {
    truncated = true
    kept.push(`[logs truncated: showing ${kept.length} of ${logs.length} lines]`)
  }

  if (!truncated) return result
  const warningsPart = keptWarnings.length > 0 ? { warnings: keptWarnings } : {}
  const logsPart = kept.length > 0 ? { logs: kept } : {}
  return result.ok
    ? {
        ok: true,
        value,
        ...warningsPart,
        ...logsPart,
        truncated: true,
        toolCalls: result.toolCalls,
      }
    : { ok: false, error: result.error, ...logsPart, truncated: true, toolCalls: result.toolCalls }
}
