import { describe, expect, it, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { Redacted } from "effect";
import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";
import { tryChatGptAdapterTransport } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/transport.js";
import { isWebSocketSseFallbackActive, retainWebSocketSession, type WebSocketEvent, type WebSocketOptions } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket-session.js";
import { createChatGPTTokenAccessor } from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import * as websocket from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket.js";

class ConnectingWebSocket {
  readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  constructor(_url: string, _options?: WebSocketOptions) { void _url; void _options; }
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  send(_data: string): void {}
  close(): void {}
}

/** Opens at once and answers each request with a completed response, or closes mid-stream when told to fail. */
class AnsweringWebSocket {
  static instances: AnsweringWebSocket[] = [];
  readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  readonly sent: Array<{ [key: string]: unknown }> = [];
  readonly headers: { [name: string]: string };
  failNext = false;
  readyState = 1;
  constructor(_url: string, options?: WebSocketOptions) {
    this.headers = options?.headers ?? {};
    AnsweringWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
    const id = `resp-${this.sent.length}`;
    // A macrotask, as on a real wire: the stream subscribes after the transport returns.
    setTimeout(() => {
      if (this.failNext) { this.readyState = 3; this.emit("close", { code: 1011, reason: "upstream", wasClean: false }); return; }
      this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } }) });
    }, 0);
  }
  close(): void { this.readyState = 3; }
  emit(type: string, event: WebSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

function testTokenAccessor() {
  return createChatGPTTokenAccessor({
    seed: {
      accessToken: Redacted.make("test-token"), refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000, accountId: "test-account",
    },
    persistence: "memory-only",
  });
}

describe("ChatGPT backend WebSocket transport", () => {
  it("sends the cache group as handshake affinity only when caching, and pools only cached requests by identity", async () => {
    const stream = spyOn(websocket, "streamChatGptAdapterWebSocket").mockResolvedValue({
      events: (async function* () {})(), commitContinuation: () => {},
    });
    try {
      const tokenAccessor = testTokenAccessor();
      for (const cacheRetention of ["none", "5m"] as const) {
        await tryChatGptAdapterTransport({
          tokenAccessor, providerSessionKey: "compaction-session", promptCacheKey: "tree-root", cacheRetention,
          params: { model: "gpt-5.4", input: [], stream: true },
        });
      }
      expect(stream).toHaveBeenCalledTimes(2);
      const [uncached, cached] = stream.mock.calls;
      expect(uncached?.[2].get("session-id")).toBe("compaction-session");
      expect(uncached?.[2].get("session_id")).toBe("compaction-session");
      expect(cached?.[2].get("session-id")).toBe("tree-root");
      expect(cached?.[2].get("session_id")).toBe("tree-root");
      for (const call of stream.mock.calls) expect(call[2].get("x-client-request-id")).toBe("compaction-session");
      expect(uncached?.[3]?.sessionId).toBeUndefined();
      expect(cached?.[3]?.sessionId).toBe("compaction-session");
    } finally {
      stream.mockRestore();
    }
  });

  it("keeps a separate socket, continuation, and SSE fallback for each conversation of one cache group", async () => {
    const globalObject: { WebSocket?: unknown } = globalThis;
    const originalWebSocket = globalObject.WebSocket;
    globalObject.WebSocket = AnsweringWebSocket;
    AnsweringWebSocket.instances = [];
    const releases = ["sibling-a", "sibling-b"].map((key) => retainWebSocketSession(key));
    const tokenAccessor = testTokenAccessor();
    const request = async (providerSessionKey: string, input: ResponseInput) => {
      const result = await tryChatGptAdapterTransport({
        tokenAccessor, providerSessionKey, promptCacheKey: "tree-root", cacheRetention: "5m",
        params: { model: "gpt-5.4", input, stream: true },
      });
      if (!result) return null;
      let responseId: string | undefined;
      for await (const event of result.events) if (event.type === "response.completed") responseId = event.response.id;
      result.commitContinuation([], responseId);
      return responseId;
    };
    const turn = (text: string): ResponseInput[number] => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    try {
      await request("sibling-a", [turn("a1")]);
      await request("sibling-b", [turn("b1")]);
      const [socketA, socketB] = AnsweringWebSocket.instances;
      expect(AnsweringWebSocket.instances).toHaveLength(2);
      assert.ok(socketA && socketB);
      expect(socketA.headers["session-id"]).toBe("tree-root");
      expect(socketB.headers["session-id"]).toBe("tree-root");
      expect(socketA.headers["x-client-request-id"]).toBe("sibling-a");
      expect(socketB.headers["x-client-request-id"]).toBe("sibling-b");

      await request("sibling-a", [turn("a1"), turn("a2")]);
      expect(AnsweringWebSocket.instances).toHaveLength(2);
      expect(socketA.sent[1]).toMatchObject({ previous_response_id: "resp-1", input: [turn("a2")] });

      socketB.failNext = true;
      await expect(request("sibling-b", [turn("b1"), turn("b2")])).rejects.toThrow();
      expect(isWebSocketSseFallbackActive("sibling-b")).toBe(true);
      expect(isWebSocketSseFallbackActive("sibling-a")).toBe(false);
      await request("sibling-a", [turn("a1"), turn("a2"), turn("a3")]);
      expect(socketA.sent[2]).toMatchObject({ previous_response_id: "resp-2", input: [turn("a3")] });
    } finally {
      for (const release of releases) release();
      globalObject.WebSocket = originalWebSocket;
    }
  });

  it("silently falls back to SSE when WebSocket is unavailable", async () => {
    const globalObject: { WebSocket?: unknown } = globalThis;
    const originalWebSocket = globalObject.WebSocket;
    globalObject.WebSocket = undefined;
    let dispatched = false;
    try {
      const result = await tryChatGptAdapterTransport({
        tokenAccessor: createChatGPTTokenAccessor({
          seed: {
            accessToken: Redacted.make("test-token"),
            refreshToken: Redacted.make("test-refresh"),
            expiresAtMs: Date.now() + 3_600_000,
          },
          persistence: "memory-only",
        }),
        providerSessionKey: "conversation-1",
        params: { model: "gpt-5.4", input: [], stream: true } satisfies ResponseCreateParamsStreaming,
        onDispatch: () => { dispatched = true; },
      });

      expect(result).toBeNull();
      expect(dispatched).toBe(false);
    } finally {
      globalObject.WebSocket = originalWebSocket;
    }
  });

  it("propagates cancellation without degrading the WebSocket transport", async () => {
    const globalObject: { WebSocket?: unknown } = globalThis;
    const originalWebSocket = globalObject.WebSocket;
    globalObject.WebSocket = ConnectingWebSocket;
    const controller = new AbortController();
    controller.abort();
    const sessionId = "cancelled-handshake";
    try {
      const result = tryChatGptAdapterTransport({
        tokenAccessor: createChatGPTTokenAccessor({
          seed: {
            accessToken: Redacted.make("test-token"),
            refreshToken: Redacted.make("test-refresh"),
            expiresAtMs: Date.now() + 3_600_000,
            accountId: "test-account",
          },
          persistence: "memory-only",
        }),
        providerSessionKey: sessionId,
        signal: controller.signal,
        params: { model: "gpt-5.4", input: [], stream: true } satisfies ResponseCreateParamsStreaming,
      });

      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(isWebSocketSseFallbackActive(sessionId)).toBe(false);
    } finally {
      globalObject.WebSocket = originalWebSocket;
    }
  });

  it("selects SSE when external token setup fails", async () => {
    const accessor = createChatGPTTokenAccessor({
      seed: {
        accessToken: Redacted.make("test-token"),
        refreshToken: Redacted.make("test-refresh"),
        expiresAtMs: 1,
      },
      persistence: "access-only",
    });

    const result = await tryChatGptAdapterTransport({
      tokenAccessor: accessor,
      params: { model: "gpt-5.4", input: [], stream: true } satisfies ResponseCreateParamsStreaming,
    });

    expect(result).toBeNull();
  });
});