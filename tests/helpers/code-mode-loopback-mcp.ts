import { createMcpConnection, type McpConnection } from "../../src/orchestration/modules/mcp/connection.js";
import type { McpPorts } from "../../src/orchestration/modules/mcp/manager.js";

/** The tools the loopback server lists. `large` answers with one text part
 *  whose text is a JSON array of about `largeResultBytes` bytes. `pending`
 *  never answers: it waits until the client cancels the call. */
const LOOPBACK_MCP_TOOLS = [
  { name: "large", description: "Returns a large JSON array.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "pending", description: "Never answers until the call is aborted.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
] as const;

export interface LoopbackMcpServer {
  /** The Streamable HTTP endpoint, for a runtime configured to reach it as
   *  `[mcp.servers.<name>] url`. */
  readonly url: string;
  /** How many items the `large` result's JSON array holds. */
  readonly largeItemCount: number;
  /** Settles once the server has received `count` pending calls in total. */
  pendingReceived(count: number): Promise<void>;
  /** Settles once the client has abandoned `count` pending calls in total. */
  pendingAbandoned(count: number): Promise<void>;
  /** Opens a connection through production `createMcpConnection` and
   *  returns the ports a runner reaches the server through. */
  connect(): Promise<McpPorts>;
  /** Closes every connection this helper opened, then the server. */
  close(): Promise<void>;
}

interface RpcRequest {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: { readonly name?: string; readonly requestId?: number | string };
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A running count whose waiters settle once it reaches their target. */
function countdown() {
  let count = 0;
  const waiters: { readonly target: number; readonly resolve: () => void }[] = [];
  return {
    add(): void {
      count++;
      for (const waiter of waiters.filter(({ target }) => target <= count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    reached(target: number): Promise<void> {
      if (count >= target) return Promise.resolve();
      const waiting = Promise.withResolvers<void>();
      waiters.push({ target, resolve: waiting.resolve });
      return waiting.promise;
    },
  };
}

/** One JSON array of about `bytes` bytes, serialized once as the text of an
 *  MCP `tools/call` result so each call costs the server a write, not a
 *  serialization. Every item is distinct so no layer can share its strings. */
function largeResult(bytes: number): { readonly body: Uint8Array<ArrayBuffer>; readonly items: number } {
  const itemBytes = 1024;
  const items = Math.ceil(bytes / itemBytes);
  const payload = "x".repeat(itemBytes - 24);
  const document = JSON.stringify(Array.from({ length: items }, (_, index) => ({ index, payload })));
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ type: "text", text: document }] })), items };
}

/** Starts a Streamable HTTP MCP server on the loopback interface. It answers
 *  POST JSON-RPC with JSON bodies and refuses the optional SSE stream, which
 *  the SDK client accepts. It runs on the caller's thread, so a test that
 *  measures that thread pays only for socket writes of a prepared body. */
export function startLoopbackMcpServer(options: { readonly largeResultBytes?: number } = {}): LoopbackMcpServer {
  const large = largeResult(options.largeResultBytes ?? 8 * 1024 * 1024);
  const connections: McpConnection[] = [];
  const received = countdown();
  const abandoned = countdown();
  /** Each held `pending` call's release, by JSON-RPC request id. */
  const held = new Map<number | string, () => void>();
  const rpc = (id: RpcRequest["id"], result: unknown): Response => Response.json({ jsonrpc: "2.0", id, result });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body: unknown = await request.json();
      if (!isRpcRequest(body)) return new Response(null, { status: 400 });
      // Notifications carry no id. A cancellation names the request it abandons.
      if (body.id === undefined) {
        if (body.method === "notifications/cancelled" && body.params?.requestId !== undefined) held.get(body.params.requestId)?.();
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return rpc(body.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "code-mode-loopback", version: "1" } });
      }
      if (body.method === "tools/list") return rpc(body.id, { tools: LOOPBACK_MCP_TOOLS });
      if (body.method === "tools/call" && body.params?.name === "large") {
        const head = `{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"result":`;
        return new Response(new Blob([head, large.body, "}"]), { headers: { "Content-Type": "application/json" } });
      }
      if (body.method === "tools/call" && body.params?.name === "pending") {
        // The SDK client abandons a call with a cancellation notification and
        // keeps the HTTP request open, so either one releases the call.
        const id = body.id;
        const answer = Promise.withResolvers<Response>();
        const release = (): void => {
          if (!held.delete(id)) return;
          abandoned.add();
          answer.resolve(new Response(null, { status: 202 }));
        };
        held.set(id, release);
        request.signal.addEventListener("abort", release, { once: true });
        received.add();
        return await answer.promise;
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    },
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;

  return {
    url,
    largeItemCount: large.items,
    pendingReceived: received.reached,
    pendingAbandoned: abandoned.reached,
    async connect() {
      const connection = await createMcpConnection({
        server: "loop",
        config: { url, headers: {}, enabled: true },
        executionCwd: process.cwd(),
        signal: new AbortController().signal,
        startupDeadline: Date.now() + 10_000,
      });
      connections.push(connection);
      return {
        servers: () => ["loop"],
        tools: () => connection.tools(),
        call: ({ server: _server, ...request }) => connection.callTool(request),
      };
    },
    async close() {
      await Promise.all(connections.map((connection) => connection.close()));
      await server.stop(true);
    },
  };
}
