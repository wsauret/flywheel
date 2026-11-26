import { transformSync } from "amaro"
import { Cause, Effect, Exit, Schema } from "effect"
import { formatLocation, Host, HostFailure, Runtime, type Diagnostic } from "psychoscript/effect"
import { isRecord } from "../../../../infra/guards/record.js"
import type { CodeModeToolDescriptor } from "../descriptors.js"
import type { CodeModeResult } from "../result-format.js"
import { prepareToolCatalog, SearchInput } from "./tool-catalog.js"

// The Flywheel layer over psychoscript: the `tools` namespace and the
// `searchCatalog` global, the per-run tool-call budget, the failure kinds a
// script sees, TypeScript input, and console retention. The interpreter owns
// the language, its values, and console formatting.

/** The console lines that a run keeps, with the drop marker last once a line was dropped. */
interface RetainedConsole {
  readonly logs?: ReadonlyArray<string>
  readonly truncated?: true
}

/** The retained console of one run, as the stream sees it after each line. */
export interface ConsoleLogView {
  /** Lines kept so far, not counting the drop marker. */
  readonly retainedLineCount: number
  readonly snapshot: () => RetainedConsole
}

export interface ScriptRuntimeOptions {
  readonly descriptors: readonly CodeModeToolDescriptor[]
  /** Runs one admitted call. A `HostFailure` reaches the script with its
   *  own kind and message; any other failure or defect reaches it as a
   *  ToolFailure with no detail, so no host text leaks into the program. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: the argument that model-written Code Mode code passes to a tool, which the nested tool dispatch decodes
  readonly call: (name: string, input: unknown) => Effect.Effect<unknown, unknown>
  readonly maxToolCalls: number
  /** UTF-8 bytes of whole console lines kept for the result, one byte per line included. */
  readonly maxLogBytes: number
  /** Sees every console line as the program writes it, also a dropped one, after the view counts it. */
  readonly onLog?: (line: string, view: ConsoleLogView) => void
}

/** Runs programs over one prepared tool surface. Each run starts from fresh
 *  globals, budgets, and console, so no run sees another's state. */
export interface ScriptRuntime {
  /** Runs one TypeScript or JavaScript program body to its result. A program
   *  failure is a result; only an interruption fails the Effect. */
  readonly execute: (source: string) => Effect.Effect<CodeModeResult>
}

/** The diagnostic for a name that resolves to no tool. It names no other
 *  tool, so a mistyped path never lists the catalog into the program. */
export const unknownTool = (name: string): HostFailure =>
  Host.fail("UnknownTool", `Unknown tool '${name}'.`, ["The tool may have been removed or renamed. Use searchCatalog to find available tools."])

/** A tool call that the host refused, with the message the script sees. */
export const toolFailure = (message: string): HostFailure => Host.fail("ToolFailure", message)

class RetainedLogs {
  readonly #maxBytes: number
  readonly #lines: string[] = []
  #retainedBytes = 0
  #droppedLines = 0
  readonly view: ConsoleLogView

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes
    const lines = this.#lines
    this.view = Object.freeze({
      get retainedLineCount() { return lines.length },
      snapshot: () => this.snapshot(),
    })
  }

  append(line: string): void {
    if (this.#droppedLines > 0) {
      this.#droppedLines += 1
      return
    }
    // One byte per line bounds empty lines. The first overflow closes the prefix.
    const bytes = Buffer.byteLength(line, "utf8") + 1
    if (this.#retainedBytes + bytes > this.#maxBytes) {
      this.#droppedLines += 1
      return
    }
    this.#retainedBytes += bytes
    this.#lines.push(line)
  }

  snapshot(): RetainedConsole {
    if (this.#droppedLines > 0) {
      return {
        logs: [...this.#lines, `[${this.#droppedLines} more console lines dropped after the ${this.#maxBytes}-byte retention budget]`],
        truncated: true,
      }
    }
    return this.#lines.length > 0 ? { logs: [...this.#lines] } : {}
  }
}

// The interpreter parses JavaScript. amaro strips TypeScript in place, so
// every position stays where the model wrote it; the async function lets swc
// accept the top-level `return` and `await` of a program body.
const TYPESCRIPT_WRAPPER = "async function __codemode__() {\n"

function stripTypes(source: string): { readonly ok: true; readonly code: string } | { readonly ok: false; readonly error: Diagnostic } {
  try {
    const stripped = transformSync(`${TYPESCRIPT_WRAPPER}${source}\n}`, { mode: "strip-only" }).code
    return { ok: true, code: stripped.slice(TYPESCRIPT_WRAPPER.length, stripped.lastIndexOf("}")) }
  } catch (cause) {
    const details = isRecord(cause) ? cause : {}
    const message = typeof details.message === "string" ? details.message : "Unknown syntax error"
    // swc counts the wrapper's line and can point past the body at its closing brace.
    const wrappedLine = typeof details.startLine === "number" ? details.startLine : 2
    const column = typeof details.startColumn === "number" ? details.startColumn : 0
    const location = { line: Math.min(Math.max(1, wrappedLine - 1), source.split("\n").length), column: column + 1 }
    return { ok: false, error: { kind: "ParseError", message: `Failed to parse TypeScript: ${message}${formatLocation(location)}`, location } }
  }
}

interface TrieNode {
  readonly children: Map<string, TrieNode>
  callable: boolean
}

function toolTrie(descriptors: readonly CodeModeToolDescriptor[]): TrieNode {
  const root: TrieNode = { children: new Map(), callable: false }
  for (const { path } of descriptors) {
    let node = root
    for (const segment of path) {
      const child = node.children.get(segment) ?? { children: new Map(), callable: false }
      node.children.set(segment, child)
      node = child
    }
    node.callable = true
  }
  return root
}

// A bracket segment may hold dots: `tools["github.search"]` names the same tool as `tools.github.search`.
const canonical = (path: ReadonlyArray<string>): string[] => path.flatMap((segment) => segment.split("."))

const lookup = (root: TrieNode, segments: ReadonlyArray<string>): TrieNode | undefined =>
  segments.reduce<TrieNode | undefined>((node, segment) => node?.children.get(segment), root)

/** Tool input leaves as JSON would: an undefined field drops, and a
 *  non-finite number or a hole becomes null, so a conditional
 *  `{ limit: cond ? 5 : undefined }` passes an optional schema field. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- boundary: the argument that model-written Code Mode code passes to a tool, which the nested tool dispatch decodes
function jsonData(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- boundary: JSON serialization removes undefined fields and writes non-finite numbers as null, which structuredClone keeps
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const hostFailure = (cause: Cause.Cause<unknown>): HostFailure => {
  const error = Cause.squash(cause)
  return error instanceof HostFailure ? error : toolFailure("Tool execution failed")
}

// The interpreter copies a call's arguments to the host before the call
// runs, and a value that cannot cross fails as a TypeError there, as in
// "TypeError: Argument 1 to tools.a[\"b-c\"] contains a function, which cannot be passed to the host.".
const SEGMENT = String.raw`\.[A-Za-z_$][\w$]*|\["(?:[^"\\]|\\.)*"\]`
const CROSSING_FAILURE = new RegExp(String.raw`^TypeError: Argument \d+ to (searchCatalog|tools(?:${SEGMENT})+) (?:contains|exceeds) (.*?)(?:, which cannot be passed to the host)?\.(?: \(line|$)`)

/** The script-facing diagnostic for a call argument that is not data: the
 *  kind InvalidDataValue, with the await guidance for a pending tool call. */
function invalidDataValue(error: Diagnostic): Diagnostic {
  const match = error.kind === "ExecutionFailure" ? CROSSING_FAILURE.exec(error.message) : null
  if (match === null) return error
  // SAFETY: both groups of CROSSING_FAILURE are required, so a match holds them.
  const [label, described] = [match[1]!, match[2]!]
  const segments = [...label.slice("tools".length).matchAll(new RegExp(SEGMENT, "g"))]
    .map(([segment]) => segment.startsWith(".") ? segment.slice(1) : String(JSON.parse(segment.slice(1, -1))))
  const name = label === "searchCatalog" ? label : canonical(segments).join(".")
  const message = described === "an un-awaited Promise"
    ? `Arguments for tool '${name}' contains an un-awaited Promise; await tool calls (e.g. \`const result = await tools.ns.tool(...)\`) before using their results.`
    : `Arguments for tool '${name}' must contain data only.`
  return { kind: "InvalidDataValue", message: `${message}${error.location === undefined ? "" : formatLocation(error.location)}`, ...(error.location === undefined ? {} : { location: error.location }) }
}

export function makeScriptRuntime(options: ScriptRuntimeOptions): ScriptRuntime {
  const { maxToolCalls, maxLogBytes } = options
  const root = toolTrie(options.descriptors)
  const catalog = prepareToolCatalog(options.descriptors)

  const globals = () => {
    let calls = 0
    // Every call, `searchCatalog` included, takes one argument and one unit of the budget.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: the argument that model-written Code Mode code passes to a call
    const admit = <I>(name: string, args: ReadonlyArray<unknown>, decode: (data: unknown) => I, run: (input: I) => Effect.Effect<unknown, unknown>) => Effect.suspend(() => {
      if (args.length !== 1) return Effect.fail(Host.fail("InvalidToolInput", `Tool '${name}' expects exactly one input object.`))
      let input: I
      try {
        input = decode(jsonData(args[0]))
      } catch (cause) {
        return Effect.fail(Host.fail("InvalidToolInput", `Invalid input for tool '${name}': ${String(cause)}`))
      }
      if (calls >= maxToolCalls) return Effect.fail(Host.fail("ToolCallLimitExceeded", `Execution exceeded its tool-call limit of ${maxToolCalls}.`))
      calls += 1
      return run(input)
    })
    // A tool call starts where the program makes it, so its nested row lands
    // between the console lines before and after it. The interpreter starts an
    // `async` host function only when the program next yields, so a call is a
    // synchronous one that returns a promise. Its run fiber ends on the
    // call's signal, which the interpreter aborts when the run stops. The
    // nested tool dispatch decodes a tool's input, so it crosses as data.
    const call = (name: string) => Host.fn((args, { signal }) =>
      Effect.runPromiseExit(admit(name, args, (data) => data, (input) => options.call(name, input)), { signal })
        .then((exit) => Exit.isSuccess(exit) ? exit.value : Promise.reject(hostFailure(exit.cause))))
    const notCallable = (name: string) => Host.fn(() => Promise.reject(Host.fail("UnknownTool", `Tool '${name}' is not callable.`)))
    return {
      tools: Host.namespace({
        keys: (path) => {
          const segments = canonical(path)
          const node = lookup(root, segments)
          if (node === undefined) throw Host.fail("UnknownTool", `Unknown tool namespace '${segments.join(".")}'.`)
          return [...node.children.keys()]
        },
        // A name the catalog does not hold still goes to the host, which may
        // hold a tool that arrived after the catalog, and answers UnknownTool otherwise.
        resolve: (path) => {
          const name = canonical(path).join(".")
          const node = lookup(root, canonical(path))
          // A rejected promise, not a thrown failure, so `.catch` on the call recovers.
          if (node !== undefined && !node.callable) return notCallable(name)
          return call(name)
        },
      }),
      // Synchronous, so a script may use its result without `await`, as the catalog prompt's signature states.
      searchCatalog: Host.fn((args) => admit("searchCatalog", args, Schema.decodeUnknownSync(SearchInput), (request) => Effect.sync(() => catalog.search(request)))),
    }
  }

  return {
    execute: (source) => Effect.suspend(() => {
      const stripped = stripTypes(source)
      if (!stripped.ok) return Effect.succeed<CodeModeResult>({ ok: false, error: stripped.error })
      const logs = new RetainedLogs(maxLogBytes)
      const runtime = Runtime.make({
        globals,
        onLog: (line) => {
          logs.append(line)
          options.onLog?.(line, logs.view)
        },
      })
      // The patched console holds no line, so the engine result carries no logs; the retention view supplies them.
      return runtime.execute(stripped.code).pipe(Effect.map((result): CodeModeResult => result.ok
        ? { ok: true, value: result.value, ...(result.warnings === undefined ? {} : { warnings: result.warnings }), ...logs.snapshot() }
        : { ok: false, error: invalidDataValue(result.error), ...logs.snapshot() }))
    }),
  }
}
