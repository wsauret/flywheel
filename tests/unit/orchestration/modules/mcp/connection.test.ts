import { describe, expect, it, spyOn } from "bun:test";
import { Redacted } from "effect";
import * as taskScheduling from "../../../../../src/infra/task-scheduling.js";
import { McpOutcomeUnknownError } from "../../../../../src/orchestration/modules/mcp/errors.js";
import { startLoopbackMcpServer } from "../../../../helpers/code-mode-loopback-mcp.js";
import {
  createMcpConnection,
  normalizeMcpCallResult,
  normalizeMcpTools,
} from "../../../../../src/orchestration/modules/mcp/connection.js";

describe("MCP connection normalization", () => {
  it("tolerates arbitrary outputSchema values", () => {
    expect(normalizeMcpTools("test", {
      tools: [{
        name: "lookup",
        description: "Looks up a value",
        inputSchema: { type: "object" },
        outputSchema: { $ref: "missing-reference" },
        annotations: { readOnlyHint: true },
      }],
    })).toEqual([{
      server: "test",
      name: "lookup",
      description: "Looks up a value",
      inputSchema: { type: "object" },
      outputSchema: { $ref: "missing-reference" },
      annotations: { readOnlyHint: true },
    }]);
  });

  it("rejects malformed tool definitions", () => {
    expect(() => normalizeMcpTools("test", { tools: [{ inputSchema: {} }] })).toThrow("Invalid MCP tool definition");
    expect(() => normalizeMcpTools("test", { tools: "wrong" })).toThrow("Invalid MCP tools/list response");
  });

  it("normalizes known and unknown call content once", () => {
    expect(normalizeMcpCallResult({
      isError: false,
      structuredContent: { count: 1 },
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "future", payload: true },
      ],
    })).toEqual({
      isError: false,
      structuredContent: { count: 1 },
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aW1hZ2U=", mediaType: "image/png" },
        { type: "text", text: "[unsupported MCP content: future]" },
      ],
    });
  });

  it("redacts exact resolved values from normalized tool output", () => {
    const secret = "opaque-value-with-no-token-shape";
    expect(normalizeMcpCallResult({
      content: [{ type: "text", text: `secret=${secret}; literal=visible` }],
      structuredContent: { [secret]: secret, nested: [secret, { literal: "visible" }] },
    }, [Redacted.make(secret)])).toEqual({
      isError: false,
      content: [{ type: "text", text: "secret=[REDACTED]; literal=visible" }],
      structuredContent: { "[REDACTED]": "[REDACTED]", nested: ["[REDACTED]", { literal: "visible" }] },
    });
  });
});

describe("MCP Streamable HTTP receive", () => {
  it("parses each JSON response body as one named turn of the shared task slice", async () => {
    const turns = spyOn(taskScheduling, "runInTaskTurn");
    const server = startLoopbackMcpServer({ largeResultBytes: 64 * 1024 });
    try {
      const ports = await server.connect();
      const result = await ports.call({ server: "loop", name: "large", arguments: {} });
      const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      expect(JSON.parse(text)).toHaveLength(server.largeItemCount);
      // initialize, tools/list, and tools/call each answer with one JSON body.
      expect(turns.mock.calls.map(([name]) => name)).toEqual(["mcp:receive", "mcp:receive", "mcp:receive"]);
    } finally {
      turns.mockRestore();
      await server.close();
    }
  });

  it("connects to a server that answers a notification with an empty JSON body", async () => {
    // The Python MCP SDK answers a notification with 202 and a JSON content
    // type but no body. The SDK client cancels that body and never parses it.
    const json = { "Content-Type": "application/json" };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message: { id?: number; method?: string } = await request.json();
        if (message.id === undefined) return new Response(null, { status: 202, headers: json });
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "empty-202", version: "1" } }
          : { tools: [] };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: json });
      },
    });
    try {
      const connection = await createMcpConnection({
        server: "empty-202",
        config: { url: `http://127.0.0.1:${server.port}/mcp`, headers: {}, enabled: true },
        executionCwd: process.cwd(),
        signal: new AbortController().signal,
        startupDeadline: Date.now() + 5_000,
      });
      try {
        expect(connection.tools()).toEqual([]);
      } finally {
        await connection.close();
      }
    } finally {
      await server.stop(true);
    }
  });
});

type ToolsCallAnswer = (id: number, released: Promise<void>) => Response | Promise<Response>;

/** A Streamable HTTP stub that answers startup itself and each tools/call
 *  with `answer`. An answer that holds waits on `released`, which `release()`
 *  and disposal settle, so the server can always stop. */
async function stubServer(answer: ToolsCallAnswer) {
  const json = { "Content-Type": "application/json" };
  const received = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message: { id?: number; method?: string } = await request.json();
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "tools/call") {
        received.resolve();
        return answer(message.id, released.promise);
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } }
        : { tools: [{ name: "effect", inputSchema: { type: "object" } }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: json });
    },
  });
  const connection = await createMcpConnection({
    server: "stub",
    config: { url: `http://127.0.0.1:${server.port}/mcp`, headers: {}, enabled: true },
    executionCwd: process.cwd(),
    signal: new AbortController().signal,
    startupDeadline: Date.now() + 5_000,
  });
  return {
    connection,
    received: received.promise,
    release: released.resolve,
    async [Symbol.asyncDispose]() {
      released.resolve();
      await connection.close();
      await server.stop(true);
    },
  };
}

type JsonRpcOutcome =
  | { readonly result: { readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> } }
  | { readonly error: { readonly code: number; readonly message: string } };

const answered = (id: number, body: JsonRpcOutcome): Response => new Response(
  JSON.stringify({ jsonrpc: "2.0", id, ...body }),
  { headers: { "Content-Type": "application/json" } },
);

describe("MCP tool call duration and outcome", () => {
  it("leaves the duration of a call to the caller, past the SDK's default request timer", async () => {
    await using stub = await stubServer(async (id, released) => {
      await released;
      return answered(id, { result: { content: [{ type: "text", text: "committed" }] } });
    });
    // Fake timers stall Bun's loopback fetch, so the call's own timers run a
    // thousand times faster instead: 61 ms of real time stands for 61 s.
    const realTimeout = globalThis.setTimeout;
    const compressed = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(realTimeout, {
      apply: (target, _receiver, [callback, delay, ...rest]: Parameters<typeof setTimeout>) => target(callback, (delay ?? 0) / 1000, ...rest),
    }));
    const call = (() => {
      try {
        return stub.connection.callTool({ name: "effect" });
      } finally {
        compressed.mockRestore();
      }
    })();
    let settled = false;
    void call.then(() => { settled = true; }, () => { settled = true; });
    await stub.received;
    await Bun.sleep(61);
    expect(settled).toBe(false);
    stub.release();
    expect((await call).content).toEqual([{ type: "text", text: "committed" }]);
  });

  it("reports an aborted call as an unknown outcome", async () => {
    await using stub = await stubServer(async (id, released) => {
      await released;
      return answered(id, { result: { content: [] } });
    });
    const controller = new AbortController();
    const call = stub.connection.callTool({ name: "effect", signal: controller.signal });
    await stub.received;
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(McpOutcomeUnknownError);
  });

  it("tells an answer or a refusal from a call that ended without an answer", async () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly answer: ToolsCallAnswer; readonly unknown: boolean }> = [
      { name: "JSON-RPC error answer", answer: (id) => answered(id, { error: { code: -32602, message: "bad arguments" } }), unknown: false },
      { name: "HTTP 400", answer: () => new Response("refused", { status: 400 }), unknown: false },
      { name: "HTTP 502", answer: () => new Response("bad gateway", { status: 502 }), unknown: true },
      { name: "unparsable body", answer: () => new Response("{not json", { headers: { "Content-Type": "application/json" } }), unknown: true },
    ];
    for (const { name, answer, unknown } of cases) {
      await using stub = await stubServer(answer);
      const error = await stub.connection.callTool({ name: "effect" }).then(() => undefined, (cause: unknown) => cause);
      expect(error, name).toBeInstanceOf(Error);
      expect(error instanceof McpOutcomeUnknownError, name).toBe(unknown);
    }
  });
});
