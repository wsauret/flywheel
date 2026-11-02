import { Effect, Schema } from "effect"
import * as Tool from "../../../infra/code-mode/tool.js"
import type { JsonSchema, Tool as CodeModeTool } from "../../../infra/code-mode/tool.js"
import { toolError, type ToolError } from "../../../infra/code-mode/tool-error.js"
import type { Tools } from "../../../infra/code-mode/tools.js"
import type { BoundedStringCodeModeOutput, RuntimeTool } from "../../agent-runtime/tools/types.js"

/** What a script sees from every bridged call. */
export const CodeToolResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "error", "interrupted"]),
  content: Schema.Unknown.annotate({
    description: "Parsed data when the tool's text output is a JSON object or array; otherwise the raw string.",
  }),
})
export type CodeToolResult = typeof CodeToolResult.Type

/** Plain data that names one callable tool. It crosses to the guest and
 *  grants nothing: the host resolves every call against its own map. */
export interface CodeModeToolDescriptor {
  readonly name: string
  readonly path: readonly string[]
  readonly description: string
  readonly inputSchema: JsonSchema
}

interface CodeModeOmission {
  readonly path: string
  readonly reason: string
}

/** A tool a script can call: one whose result has a script transport. */
type CallableCodeModeTool = RuntimeTool & { readonly codeModeOutput: BoundedStringCodeModeOutput }

/** One request's script surface: the descriptors the guest builds its
 *  `tools` from, the exact map the host dispatches against, and why each
 *  other script-eligible tool is absent. */
export interface CodeModeToolSet {
  readonly descriptors: readonly CodeModeToolDescriptor[]
  readonly callable: ReadonlyMap<string, CallableCodeModeTool>
  readonly omissions: readonly CodeModeOmission[]
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (!("type" in value) || value.type === undefined) return true
  return typeof value.type === "string" || (Array.isArray(value.type) && value.type.every((item) => typeof item === "string"))
}

const UNSAFE_SEGMENTS = new Set(["", "__proto__", "constructor", "prototype"])

type Candidate =
  | { readonly kind: "omitted"; readonly omission: CodeModeOmission }
  | { readonly kind: "described"; readonly descriptor: CodeModeToolDescriptor; readonly tool: CallableCodeModeTool }

function hasScriptTransport(tool: RuntimeTool): tool is CallableCodeModeTool {
  return tool.codeModeOutput !== undefined
}

function candidate(name: string, tool: RuntimeTool): Candidate | undefined {
  if (tool.codeMode === undefined) return undefined
  const path = `tools.${name}`
  if (!hasScriptTransport(tool)) return { kind: "omitted", omission: { path, reason: "incomplete code-mode transport contract" } }
  if (!isJsonSchema(tool.inputSchema)) return { kind: "omitted", omission: { path, reason: "unsupported input schema" } }
  const segments = name.split(".")
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) return { kind: "omitted", omission: { path, reason: "unsupported executable path" } }
  return {
    kind: "described",
    descriptor: { name, path: segments, description: tool.description, inputSchema: tool.inputSchema },
    tool,
  }
}

/** Describes the script surface of one request-pinned eligible map without
 *  making a second exposure decision. A tool whose path continues past
 *  another tool's path is omitted, whatever order the map holds them in, so
 *  the shorter tool stays callable and the omission is always reported. */
export function describeCodeModeTools(eligible: ReadonlyMap<string, RuntimeTool>): CodeModeToolSet {
  const candidates = [...eligible].flatMap(([name, tool]) => candidate(name, tool) ?? [])
  const toolPaths = new Set(candidates.flatMap((entry) => entry.kind === "described" ? [entry.descriptor.name] : []))
  const descriptors: CodeModeToolDescriptor[] = []
  const callable = new Map<string, CallableCodeModeTool>()
  const omissions: CodeModeOmission[] = []
  for (const entry of candidates) {
    if (entry.kind === "omitted") {
      omissions.push(entry.omission)
      continue
    }
    const { path, name } = entry.descriptor
    const depth = path.findIndex((_, index) => index > 0 && toolPaths.has(path.slice(0, index).join(".")))
    if (depth > 0) {
      omissions.push({ path: `tools.${name}`, reason: `namespace '${path[depth - 1]}' collides with a root tool` })
      continue
    }
    descriptors.push(entry.descriptor)
    callable.set(name, entry.tool)
  }
  return { descriptors, callable, omissions }
}

type ToolGroup = { [segment: string]: CodeModeTool | ToolGroup }

/** Builds the Code Mode `tools` trie from descriptors whose paths
 *  `describeCodeModeTools` already proved free of prefix collisions. */
export function toolTrie(descriptors: readonly CodeModeToolDescriptor[], execute: (descriptor: CodeModeToolDescriptor, input: unknown) => Effect.Effect<CodeToolResult, ToolError>): Tools {
  const root: ToolGroup = {}
  for (const descriptor of descriptors) {
    let group = root
    for (const segment of descriptor.path.slice(0, -1)) {
      const child = group[segment] ?? {}
      if (Tool.isTool(child)) throw new Error(`Code Mode descriptor '${descriptor.name}' continues past a tool`)
      group[segment] = child
      group = child
    }
    const leaf = descriptor.path.at(-1)
    if (leaf === undefined || group[leaf] !== undefined) throw new Error(`Code Mode descriptor '${descriptor.name}' collides with another path`)
    group[leaf] = Tool.make({
      description: descriptor.description,
      input: descriptor.inputSchema,
      output: CodeToolResult,
      execute: (input) => execute(descriptor, input),
    })
  }
  return root
}

/** The catalog renders signatures only, so its trie never runs a call. */
export const catalogOnlyCall = (): Effect.Effect<never, ToolError> => Effect.fail(toolError("A Code Mode catalog trie cannot execute tools"))
