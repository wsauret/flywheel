import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CliTool } from "./cli-view.js";
import { TOOL_MCP_SERVER } from "./names.js";
import { HANDLER_RESULT_LIMIT, type DeliverableResult } from "./request-plan.js";

/** The `_meta` key in which the CLI names the tool_use that a call answers. */
const TOOL_USE_ID_KEY = "claudecode/toolUseId";

/** The result of a call that the bridge cannot answer. The CLI never sends it to the model: the bridge reaches
 *  it only after it interrupted the query, or for a call that names no tool use. */
const UNANSWERED: CallToolResult = { isError: true, content: [{ type: "text", text: "The host did not return a result for this call." }] };

/**
 * The `runtime` MCP server of one query. Its handlers execute nothing: Flywheel's dispatcher runs every tool and
 * the bridge hands the settled results to the gate.
 */
export interface ToolGate {
  /** The server instance that the SDK hosts in process for the query. */
  readonly server: McpServer;
  /** Answers the calls of these tool uses with Flywheel's results. A call that already waits resolves now, and a
   *  call that enters later resolves when it enters. */
  deliver(results: readonly DeliverableResult[]): void;
  /** Settles every call that still waits and refuses later calls. The bridge calls it only after the query
   *  stopped, so no settled call reaches the model. */
  close(): void;
}

/**
 * Builds the gate for one query's declared tools (bridge rule 2). The server lists each tool with its raw JSON
 * Schema and `_meta["anthropic/maxResultSizeChars"]`, so the CLI keeps a result up to that size intact and sends
 * no token-count request for it. It advertises only the tools capability.
 *
 * Each tool also carries `_meta["anthropic/alwaysLoad"]`. When the CLI's tool search is on, it defers every MCP tool
 * behind a search stub, and the model then sees only the tool names. Native Flywheel declares every planned tool in
 * full, so the key keeps each tool in the request with its definition. The key is per tool, because the server-level
 * `alwaysLoad` option also makes the CLI wait for the server before its first turn. The CLI sends no field for the
 * key, so the request bytes do not change while tool search is off.
 *
 * The CLI calls a handler when the tool_use block ends, before the request ends, and calls a tool that is not
 * read-only only after the previous call returned. A call therefore parks by its tool_use id, and a result can
 * arrive before or after its call enters.
 */
export function createToolGate(tools: readonly CliTool[]): ToolGate {
  const server = new McpServer({ name: TOOL_MCP_SERVER, version: "1.0.0" });
  // Registered on the inner server: a `tools` capability in the McpServer options installs its own tool handlers,
  // which also declare `listChanged`, and the gate never changes its tool list.
  server.server.registerCapabilities({ tools: {} });
  const ready = new Map<string, CallToolResult>();
  const waiting = new Map<string, (result: CallToolResult) => void>();
  let closed = false;

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      // Every Flywheel tool input schema has an object root (`materializeToolInputSchema` refuses any other), and
      // the bridge passes it unchanged so the CLI sends its bytes as received.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the MCP list result types the schema as an object with `type: "object"`
      inputSchema: inputSchema as { type: "object" }, // SAFETY: an object root, as the comment above states.
      _meta: { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": HANDLER_RESULT_LIMIT },
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const toolUseId = request.params._meta?.[TOOL_USE_ID_KEY];
    if (typeof toolUseId !== "string" || closed) return UNANSWERED;
    const result = ready.get(toolUseId);
    if (result !== undefined) {
      ready.delete(toolUseId);
      return result;
    }
    return new Promise<CallToolResult>((resolve) => {
      waiting.set(toolUseId, resolve);
      // The CLI cancels its calls when the query is interrupted.
      extra.signal.addEventListener("abort", () => {
        if (waiting.get(toolUseId) !== resolve) return;
        waiting.delete(toolUseId);
        resolve(UNANSWERED);
      }, { once: true });
    });
  });

  return {
    server,
    deliver(results) {
      for (const { toolUseId, content, isError } of results) {
        const result: CallToolResult = { content: content.map(({ text }) => ({ type: "text", text })), ...(isError ? { isError } : {}) };
        const resolve = waiting.get(toolUseId);
        if (resolve === undefined) {
          ready.set(toolUseId, result);
          continue;
        }
        waiting.delete(toolUseId);
        resolve(result);
      }
    },
    close() {
      closed = true;
      ready.clear();
      for (const resolve of waiting.values()) resolve(UNANSWERED);
      waiting.clear();
    },
  };
}
