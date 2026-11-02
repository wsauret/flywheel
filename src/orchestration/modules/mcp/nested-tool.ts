import { boundedStringCodeModeOutput, type RuntimeTool } from "../../agent-runtime/tools/types.js";
import type { McpToolHit } from "./connection.js";
import { McpOutcomeUnknownError } from "./errors.js";
import type { McpPorts } from "./manager.js";

/** Build one code-only tool from the live server catalog. It forwards
 *  progress through the nested dispatch output channel, and a refusal the
 *  manager states, a lapsed token or a failed server, is the tool's error. A
 *  call that ended without the server's answer says that its effect may have
 *  completed (ARCH-TOOLS-050). */
export function createMcpNestedTool(mcp: McpPorts, hit: McpToolHit): RuntimeTool {
  const name = `${hit.server}.${hit.name}`;
  return {
    name,
    action: "shell_exec",
    description: hit.description ?? `Call ${hit.name} on the ${hit.server} MCP server.`,
    inputSchema: isRuntimeToolInput(hit.inputSchema) ? hit.inputSchema : { type: hit.inputSchema },
    codeMode: "exclusive",
    codeModeOutput: boundedStringCodeModeOutput,
    // Remote effects belong to the server, which owns its own consistency;
    // read-only annotations do not change local admission.
    isConcurrencySafe: true,
    async execute(arguments_, context) {
      try {
        const result = await mcp.call({
          server: hit.server,
          name: hit.name,
          arguments: arguments_,
          signal: context.signal,
          onProgress: ({ progress, total, message }) => {
            const amount = total === undefined ? String(progress) : `${progress}/${total}`;
            context.onExecutionOutput?.(`${amount}${message ? ` ${message}` : ""}`);
          },
        });
        return { content: result.content, outcome: result.isError ? "error" : "ok" };
      } catch (error) {
        if (error instanceof McpOutcomeUnknownError) {
          return {
            content: `MCP call ${name} ended without the server's answer (${error.reason}). The server may have completed it; check its state before you call it again.`,
            outcome: "error",
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { content: `MCP call failed: ${message}`, outcome: "error" };
      }
    },
  };
}

function isRuntimeToolInput<Value>(value: Value): value is Value & { readonly [field: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
