import { FUNCTION_TOOL_PRESENTATION, type ToolDef } from "../../agent-runtime/llm/types.js"

/** The parameter that agy adds, required, to the schema root of every tool that it reads from an MCP server, and
 *  strips from each call before the call reaches the server (agy 1.5.14). A parameter of the same name that the
 *  server declares is replaced by agy's own and never reaches the server. */
export const ENGINE_TOOL_SUMMARY = "toolSummary"

/** A Flywheel tool declares a parameter that agy owns (`ENGINE_TOOL_SUMMARY`), so its calls could never carry it. */
export class ToolSummaryCollisionError extends Error {
  constructor(readonly toolName: string) {
    super(`The tool ${toolName} declares the parameter ${ENGINE_TOOL_SUMMARY}, which the Google Antigravity engine reserves for itself`)
    this.name = "ToolSummaryCollisionError"
  }
}

/** One tool as Flywheel's MCP server lists it to agy. */
export interface McpToolDeclaration {
  readonly name: string
  readonly description: string
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown }
}

/**
 * The MCP declarations of `tools`, each with the description and the raw JSON Schema that the function presentation
 * of a native Google request sends. agy changes each declaration before the model reads it, and these changes are the
 * route's transport additions, never Flywheel's: it puts `This is a tool from the runtime MCP server.\n` before the
 * description, sorts the schema keys, adds `additionalProperties: false` to every object that does not state it, and
 * adds the required `toolSummary`. Throws `ToolSummaryCollisionError` for the first tool whose schema root declares
 * `toolSummary`.
 */
export function projectTools(tools: readonly ToolDef[]): readonly McpToolDeclaration[] {
  return tools.map((tool) => {
    const { description, inputFormat } = FUNCTION_TOOL_PRESENTATION.present(tool)
    const schema: { readonly [key: string]: unknown } = inputFormat
    const properties = schema["properties"]
    if (typeof properties === "object" && properties !== null && Object.hasOwn(properties, ENGINE_TOOL_SUMMARY)) throw new ToolSummaryCollisionError(tool.name)
    // Every Flywheel tool input schema has one object root: `materializeToolInputSchema` refuses any other.
    return { name: tool.name, description, inputSchema: { ...schema, type: "object" } }
  })
}
