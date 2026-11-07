// Adapted from opencode `packages/core/src/codemode/tool.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import { Schema } from "effect"
import type { RuntimeTool, ToolResult } from "../../agent-runtime/tools/types.js"
import type { CatalogRender } from "./catalog.js"
import type { CodeModeToolSet } from "./descriptors.js"
import type { CodeModeService } from "./service.js"

const RETURN_RULE = "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result."
const LARGE_RETURN_RULE = "A large return value does not fail: the runtime truncates it for the model and saves the full result to a breadcrumb file. Treat that as a missed projection; re-run the script with a tighter projection instead of post-processing the breadcrumb."

/** The description while the capture contributes tools that scripts call through `tools`. */
const NESTED_TOOLS_DESCRIPTION = [
  "Run JavaScript in a confined Code Mode runtime to orchestrate tool calls and compose their results.",
  "Imports, direct filesystem access, and timers are unavailable. Do not use `fetch`; all external access goes through `tools`.",
  "Within `{ source }`, only tools listed in the Code Mode catalog or returned by `searchCatalog` are callable. Call first-class tools directly, never through code.",
  "`searchCatalog` is a global function, never a member of `tools`. Call `searchCatalog(input)`, not `tools.searchCatalog(input)`.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "For discovery, run one script that makes all independent `searchCatalog` calls concurrently with `Promise.all`. Then run one separate real-work script with the discovered exact tool paths and signatures.",
  RETURN_RULE,
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.all`.",
  "Tool results are `{ outcome, content }`. `content` arrives parsed when the tool's text output is a JSON object or array; otherwise it is a string.",
  "Post-process results in the same script, the way shell commands pipe into filters: never return a raw result. Map it to only the fields the task needs and return that projection.",
  "Discover an unknown shape inside the script, not in your context: probe with a small limit, log `Object.keys(...)` or one sample item with `console.log`, then project defensively with optional chaining.",
  LARGE_RETURN_RULE,
] as const

/** The description while no module contributes such tools: a script computes, and calls nothing. */
const SCRIPT_ONLY_DESCRIPTION = [
  "Run JavaScript in a confined Code Mode runtime to compute and compose results.",
  "Imports, direct filesystem access, timers, and `fetch` are unavailable.",
  RETURN_RULE,
  LARGE_RETURN_RULE,
] as const

const CodeInput = Schema.Struct({ source: Schema.String })

export interface CodeToolOptions {
  /** The catalog of the request's code-only tools; absent while the capture contributes none. */
  readonly catalog: CatalogRender | undefined
  readonly tools: CodeModeToolSet
  readonly service: CodeModeService
  readonly bash: boolean
}

/** The `code` tool of one request: a script transport over that request's
 *  exact callable map, executed by the process's Code Mode service. */
export function createCodeTool(options: CodeToolOptions): RuntimeTool {
  const description = options.catalog ? NESTED_TOOLS_DESCRIPTION : SCRIPT_ONLY_DESCRIPTION
  return {
    name: "code",
    action: "shell_exec",
    description: description.join("\n"),
    promptGuidelines: [
      ...description,
      options.bash
        ? "Heavy computation and gigabyte-scale data belong in Bash; exceeding the heap growth budget terminates the program. Program intermediates never enter model context."
        : "Exceeding the heap growth budget terminates the program. Program intermediates never enter model context.",
      ...(options.catalog ? [options.catalog.text] : []),
    ],
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
      additionalProperties: false,
    },
    gateAdmission: "none",
    isConcurrencySafe: true,
    // The Code Mode host deadline bounds the program, and each nested call
    // keeps the dispatcher watchdog; a second timer on the program would end
    // it while nested progress shows it busy (ARCH-TOOLS-006, ARCH-TOOLS-042).
    unboundedDuration: true,
    async execute(input, context): Promise<ToolResult> {
      const { source } = Schema.decodeUnknownSync(CodeInput)(input)
      const parentToolUseId = context.toolUseId
      const createBatch = context.createNestedToolDispatchBatch
      if (parentToolUseId === undefined || createBatch === undefined) {
        return { outcome: "error", content: "Code runtime is unavailable because this call has no nested dispatch owner." }
      }
      return await options.service.run({ source, tools: options.tools, parentToolUseId, createBatch }, context)
    },
  }
}
