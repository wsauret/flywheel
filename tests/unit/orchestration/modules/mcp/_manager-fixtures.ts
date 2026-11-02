import type { McpConnection } from "../../../../../src/orchestration/modules/mcp/connection.js";
import { accountAuthDir } from "../../../../../src/infra/paths.js";
import { testDirectories } from "../../../../helpers/directories.js";

// The account credential directory the composition root publishes. It resolves
// under the isolated test account home, so no case reads real credentials.
export const AUTH_DIR = accountAuthDir(testDirectories(process.cwd()).userDataRoot);

export function fakeConnection(): McpConnection & { disconnect(): void; toolsChanged(): void; closed(): boolean } {
  let onClose = (): void => {};
  let onToolsChanged: Parameters<McpConnection["onToolsChanged"]>[0] = () => {};
  let closed = false;
  return {
    instructions: undefined,
    tools: () => [],
    callTool: async () => ({ content: [], isError: false }),
    onClose(callback) { onClose = callback; },
    onToolsChanged(callback) { onToolsChanged = callback; },
    async close() { closed = true; },
    disconnect() { onClose(); },
    toolsChanged() { onToolsChanged({ tag: "success", tools: [] }); },
    closed: () => closed,
  };
}

/** Reports how one promise settled without waiting on it forever, so a waiter
 *  that must stay pending is asserted instead of hanging the case. */
export async function settlement(promise: Promise<unknown>, waitMs: number): Promise<string> {
  return await Promise.race([
    promise.then(() => "resolved", (error: Error) => error.message),
    Bun.sleep(waitMs).then(() => "pending"),
  ]);
}
