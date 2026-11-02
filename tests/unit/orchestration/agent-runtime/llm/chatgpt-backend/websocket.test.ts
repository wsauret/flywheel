import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseInput, ResponseOutputMessage } from "openai/resources/responses/responses.js";
import type { RequestBody } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/types.js";
import { getCachedWebSocketInputDelta, streamChatGptAdapterWebSocket } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket.js";
import { retainWebSocketSession, type CachedWebSocketConnection, type WebSocketEvent, type WebSocketOptions } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket-session.js";
import { ChatGptAdapterTransportError } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/types.js";
import { createStaleToolResultMasker } from "../../../../../../src/orchestration/agent-runtime/compaction/stale-tool-result-masker.js";
import { buildOpenAIResponseInput } from "../../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import type { ConversationMessage } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import { Log } from "../../../../../../src/infra/log.js";
import * as windowsAcl from "../../../../../../src/infra/windows-private-directory-acl.js";

interface UnknownRecord {
  [key: string]: unknown;
}

type Continuation = NonNullable<CachedWebSocketConnection["continuation"]>;

const userMessage = (text: string): ResponseInput[number] =>
  ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

const assistantMessage = (id: string, text: string): ResponseInput[number] =>
  ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

const baseRequestBody = (input: ResponseInput): RequestBody => ({ model: "gpt-5.4", input });

function makeContinuation(lastInput: ResponseInput, lastResponseItems: ResponseInput): Continuation {
  return {
    lastRequestBody: baseRequestBody(lastInput),
    lastResponseId: "resp-1",
    lastResponseItems,
  };
}

class ScriptedWebSocket {
	static scripts: Array<Array<UnknownRecord>> = [];
	static sent: Array<UnknownRecord> = [];
	static nextFrames: Array<UnknownRecord> | undefined;
	readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
	readonly script = ScriptedWebSocket.scripts.shift() ?? [];
	readyState = 1;
	constructor(_url: string, _options?: WebSocketOptions) { queueMicrotask(() => this.emit("open", {})); }
	addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
	close(): void { this.readyState = 3; }
	send(data: string): void {
		ScriptedWebSocket.sent.push(JSON.parse(data));
		const frames = ScriptedWebSocket.nextFrames ?? this.script;
		ScriptedWebSocket.nextFrames = undefined;
		setTimeout(() => { for (const frame of frames) this.emit("message", { data: JSON.stringify(frame) }); }, 0);
	}
	emit(type: string, event: WebSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe("WebSocket request failures", () => {
	it("dumps the continuation-adjusted sent body only with explicit opt-in", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		const previousOptIn = process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
		const projectRoot = mkdtempSync(join(tmpdir(), "chatgpt-websocket-dump-"));
		const apply = spyOn(windowsAcl, "applyWindowsPrivateDirectoryAcl").mockImplementation(() => {});
		const verify = spyOn(windowsAcl, "windowsDirectoryIsOwnerOnly").mockReturnValue(true);
		globalObject.WebSocket = ScriptedWebSocket;
		ScriptedWebSocket.scripts = [[{ type: "response.completed", response: { id: "resp-1", status: "completed", output: [] } }]];
		ScriptedWebSocket.sent = [];
		process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = "1";
		try {
			const options = { projectRoot, sessionId: "rejected-continuation-test" };
			const prior = userMessage("prompt-marker");
			const first = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody([prior]), new Headers(), options);
			const answer = assistantMessage("msg-1", "answer-marker");
			first.commitContinuation([answer], "resp-1");
			for await (const _event of first.events) { /* drain */ }
			const directory = join(projectRoot, ".flywheel", "log", "chatgpt-adapter-failures");
			expect(existsSync(directory)).toBe(false);
			ScriptedWebSocket.nextFrames = [{ type: "error", error: { code: "unsupported_parameter", message: "unsupported" } }];
			const result = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody([prior, answer, userMessage("next-marker")]), new Headers(), options);
			await expect(async () => {
				for await (const _event of result.events) { /* drain */ }
			}).toThrow("unsupported");
			expect(ScriptedWebSocket.sent[1]).toMatchObject({ previous_response_id: "resp-1", input: [userMessage("next-marker")] });
			const [name, extra] = readdirSync(directory);
			if (!name) throw new Error("missing dump");
			expect(extra).toBeUndefined();
			const file = join(directory, name);
			if (process.platform === "win32") {
				expect(apply).toHaveBeenCalledWith(directory);
				expect(verify).toHaveBeenCalledWith(directory);
			} else expect(statSync(file).mode & 0o777).toBe(0o600);
			const dump = JSON.parse(readFileSync(file, "utf8"));
			expect(dump.request).toEqual(ScriptedWebSocket.sent.at(-1));
			expect(dump.response.error.code).toBe("unsupported_parameter");
		} finally {
			apply.mockRestore();
			verify.mockRestore();
			ScriptedWebSocket.nextFrames = undefined;
			globalObject.WebSocket = originalWebSocket;
			if (previousOptIn === undefined) delete process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
			else process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = previousOptIn;
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
	it("logs only field types when full request dumps are disabled", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		const previousOptIn = process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
		const projectRoot = mkdtempSync(join(tmpdir(), "chatgpt-websocket-private-"));
		const warning = spyOn(Log.create({ service: "llm-openai-chatgpt" }), "warn").mockImplementation(() => {});
		globalObject.WebSocket = ScriptedWebSocket;
		ScriptedWebSocket.scripts = [[{ type: "error", error: { code: "unsupported_parameter", message: "rejected" } }]];
		delete process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
		try {
			const result = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody([userMessage("private-prompt-marker")]), new Headers(), { projectRoot });
			await expect(async () => {
				for await (const _event of result.events) { /* drain */ }
			}).toThrow("rejected");
			expect(existsSync(join(projectRoot, ".flywheel", "log", "chatgpt-adapter-failures"))).toBe(false);
			const diagnostic = warning.mock.calls.find(([message]) => message === "ChatGPT backend request rejected");
			expect(diagnostic?.[1]).toMatchObject({ transport: "websocket", requestFields: { input: { count: 1, items: [{ content: { count: 1, items: [{ type: "string", text: "string" }] } }] } } });
			expect(JSON.stringify(diagnostic)).not.toContain("private-prompt-marker");
		} finally {
			warning.mockRestore();
			globalObject.WebSocket = originalWebSocket;
			if (previousOptIn === undefined) delete process.env.FLYWHEEL_DUMP_FAILED_REQUESTS;
			else process.env.FLYWHEEL_DUMP_FAILED_REQUESTS = previousOptIn;
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
	it("does not retry previous-response loss after dispatch", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = ScriptedWebSocket;
		ScriptedWebSocket.scripts = [
			[{ type: "error", error: { code: "previous_response_not_found", message: "gone" } }],
		];
		ScriptedWebSocket.sent = [];
		try {
			const body = baseRequestBody([userMessage("hello")]);
			const result = await streamChatGptAdapterWebSocket("wss://example.test", body, new Headers(), { sessionId: "retry-session" });
			const failure = await (async () => {
				try {
					for await (const _event of result.events) { /* drain */ }
				} catch (error) {
					return error;
				}
			})();
			expect(failure).toBeInstanceOf(ChatGptAdapterTransportError);
			expect(failure).toMatchObject({ phase: "read" });
			expect(ScriptedWebSocket.sent).toHaveLength(1);
		} finally {
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("does not retry or spend budget after a refusal delta", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = ScriptedWebSocket;
		ScriptedWebSocket.scripts = [[
			{ type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "I cannot help." },
			{ type: "error", error: { code: "previous_response_not_found", message: "gone" } },
		]];
		ScriptedWebSocket.sent = [];
		try {
			const result = await streamChatGptAdapterWebSocket(
				"wss://example.test",
				baseRequestBody([userMessage("hello")]),
				new Headers(),
				{ sessionId: "refusal-session" },
			);
			await expect(async () => {
				for await (const _event of result.events) { /* drain */ }
			}).toThrow("gone");
			expect(ScriptedWebSocket.sent).toHaveLength(1);
		} finally {
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("does not retry or spend budget after a rendered refusal terminal frame", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = ScriptedWebSocket;
		ScriptedWebSocket.scripts = [[
			{ type: "response.output_item.done", item: { type: "message", content: [{ type: "refusal", refusal: "I cannot help." }] } },
			{ type: "error", error: { code: "websocket_connection_limit_reached", message: "limited" } },
		]];
		ScriptedWebSocket.sent = [];
		try {
			const result = await streamChatGptAdapterWebSocket(
				"wss://example.test",
				baseRequestBody([userMessage("hello")]),
				new Headers(),
				{ sessionId: "terminal-refusal-session" },
			);
			await expect(async () => {
				for await (const _event of result.events) { /* drain */ }
			}).toThrow("limited");
			expect(ScriptedWebSocket.sent).toHaveLength(1);
		} finally {
			globalObject.WebSocket = originalWebSocket;
		}
	});
});

describe("getCachedWebSocketInputDelta", () => {
  it.each(["write", "edit"])("rejects same-id %s arguments rewritten by stale masking", (name) => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "change the source file" },
      {
        kind: "assistant", api: "openai-responses", provider: "openai", accessProvider: "chatgpt", model: "gpt-5.5", timestamp: 1, stopReason: "tool_use",
        content: [{ type: "tool_use", id: "call_1", providerCallId: "call_1", providerItemId: "fc_1", name, input: { path: "src/sample.ts", ...(name === "write" ? { content: "x".repeat(1000) } : { old_string: "x".repeat(1000), new_string: "y".repeat(1000) }) } }],
      },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "Done" }] },
      { kind: "user", content: "continue" },
    ];
    const convert = (messages: ConversationMessage[]) => {
      const input = buildOpenAIResponseInput({ messages, accessProvider: "chatgpt", model: "gpt-5.5", supportsImages: false, tools: [] });
      if (typeof input === "string" || !input) throw new Error("Expected Responses input items");
      return input;
    };
    const original = convert(history);
    const masked = createStaleToolResultMasker().mask(history, 0.3);
    if (!masked) throw new Error("Expected stale mutation arguments to be masked");
    const current = convert(masked.messages);
    const oldCall = original[1];
    const newCall = current[1];
    if (oldCall?.type !== "function_call" || newCall?.type !== "function_call") throw new Error("Expected function calls");
    expect(newCall.id).toBe(oldCall.id);
    expect(newCall.arguments).not.toBe(oldCall.arguments);
    for (const continuation of [
      makeContinuation(original.slice(0, 1), [oldCall]),
      makeContinuation(original.slice(0, 2), []),
    ]) {
      expect(getCachedWebSocketInputDelta(baseRequestBody(current), continuation)).toBeUndefined();
    }
  });

  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: '{"content":"old"}' } as const;
  const custom = { type: "custom_tool_call", id: "ct_1", call_id: "call_2", name: "apply_patch", input: "old patch" } as const;
  const reasoning = { type: "reasoning", id: "r_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "encrypted" } satisfies ResponseInput[number];
  const driftCases: Array<[string, ResponseInput[number], ResponseInput[number]]> = [
    ["function arguments", call, { ...call, arguments: '{"content":"new"}' }],
    ["function name", call, { ...call, name: "edit" }],
    ["function call id", call, { ...call, call_id: "other" }],
    ["custom input", custom, { ...custom, input: "new patch" }],
    ["custom name", custom, { ...custom, name: "other" }],
    ["custom call id", custom, { ...custom, call_id: "other" }],
    ["reasoning summary", reasoning, { ...reasoning, summary: [{ type: "summary_text", text: "changed" }] } satisfies typeof reasoning],
    ["reasoning ciphertext", reasoning, { ...reasoning, encrypted_content: "changed" }],
    ["assistant text", assistantMessage("a1", "old"), assistantMessage("a1", "new")],
    ["function result", { type: "function_call_output", id: "o1", call_id: "call_1", output: "old" }, { type: "function_call_output", id: "o1", call_id: "call_1", output: "new" }],
    ["custom result", { type: "custom_tool_call_output", id: "o1", call_id: "call_2", output: "old" }, { type: "custom_tool_call_output", id: "o1", call_id: "call_2", output: "new" }],
  ];
  it.each(driftCases)("rejects same-id %s drift in either prefix segment", (_name, original, changed) => {
    for (const continuation of [makeContinuation([original], []), makeContinuation([], [original])]) {
      expect(getCachedWebSocketInputDelta(baseRequestBody([changed, userMessage("next")]), continuation)).toBeUndefined();
    }
  });

  it("matches a response reasoning item to its replay, which omits output-only fields", () => {
    const raw = { ...reasoning, status: "completed", content: [] } satisfies ResponseInput[number];
    const replay = { encrypted_content: raw.encrypted_content, summary: raw.summary, id: raw.id, type: raw.type };
    const next = userMessage("next");
    expect(getCachedWebSocketInputDelta(baseRequestBody([replay, next]), makeContinuation([], [raw]))).toEqual([next]);
  });

  it("normalizes server-only tool status and argument serialization before comparison", () => {
    const response: ResponseInput = [{ ...call, status: "completed", arguments: '{ "content": "old" }' }, custom];
    const next = userMessage("next");
    expect(getCachedWebSocketInputDelta(baseRequestBody([call, custom, next]), makeContinuation([], response))).toEqual([next]);
  });

  it("normalizes server text metadata and refusal parts to the converter's text and phase", () => {
    const response = {
      type: "message", id: "a1", role: "assistant", status: "completed", phase: "final_answer",
      content: [
        { type: "output_text", text: "answer", annotations: [{ type: "url_citation", start_index: 0, end_index: 6, title: "source", url: "https://example.test" }], logprobs: [] },
        { type: "refusal", refusal: " refused" },
      ],
    } satisfies ResponseInput[number] & { phase: string };
    const replay = {
      type: "message", id: "a1", role: "assistant", status: "completed", phase: "final_answer",
      content: [{ type: "output_text", text: "answer refused", annotations: [] }],
    } satisfies ResponseInput[number] & { phase: string };
    const next = userMessage("next");
    const continuation = makeContinuation([], [response]);
    expect(getCachedWebSocketInputDelta(baseRequestBody([replay, next]), continuation)).toEqual([next]);
    const changedPhase = { ...replay, phase: "commentary" as const };
    expect(getCachedWebSocketInputDelta(baseRequestBody([changedPhase, next]), continuation)).toBeUndefined();
  });

  it.each([null, "commentary", "final_answer"] satisfies Array<ResponseOutputMessage["phase"]>)("reuses provider phase %s through the actual replay converter", (phase) => {
    const response = {
      type: "message", id: "a1", role: "assistant", status: "completed", phase,
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    } satisfies ResponseOutputMessage;
    const replay = buildOpenAIResponseInput({
      messages: [{
        kind: "assistant", api: "openai-responses", provider: "openai", accessProvider: "chatgpt", model: "gpt-5.5", timestamp: 1, stopReason: "end_turn",
        content: [{ type: "text", text: "answer", signature: JSON.stringify({ v: 1, id: response.id, ...(phase ? { phase } : {}) }) }],
      }],
      accessProvider: "chatgpt", model: "gpt-5.5", supportsImages: false, tools: [],
    });
    if (typeof replay === "string" || !replay) throw new Error("Expected Responses input items");
    const continuation = makeContinuation([], [response]);
    expect(getCachedWebSocketInputDelta(baseRequestBody(replay), continuation)).toEqual([]);
    const next = userMessage("next");
    expect(getCachedWebSocketInputDelta(baseRequestBody([...replay, next]), continuation)).toEqual([next]);
  });

  it("reuses the cached delta when the prior input + response items are an exact prefix", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    const followUp = userMessage("how are you?");
    const body = baseRequestBody([...priorInput, ...responseItems, followUp]);

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toEqual([followUp]);
  });

  it("returns an empty delta when the new input exactly equals the baseline (no appended items)", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    const body = baseRequestBody([...priorInput, ...responseItems]);

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toEqual([]);
  });

  it("continues after a custom call and result without replaying them", () => {
    const priorInput: ResponseInput = [userMessage("edit")];
    const responseItems: ResponseInput = [{ type: "custom_tool_call", id: "ct_1", call_id: "call_1", name: "apply_patch", input: "patch" }];
    const continuation = makeContinuation(priorInput, responseItems);
    const result: ResponseInput[number] = { type: "custom_tool_call_output", call_id: "call_1", output: "Done" };
    const followUp = userMessage("continue");
    const body = baseRequestBody([...priorInput, ...responseItems, result, followUp]);

    expect(getCachedWebSocketInputDelta(body, continuation)).toEqual([result, followUp]);
  });

  it("busts reuse when an earlier item changed (content drift)", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    // Same lengths and same id/type per slot, but the first item's text differs.
    const body = baseRequestBody([userMessage("HELLO"), ...responseItems, userMessage("next")]);

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toBeUndefined();
  });

  it("busts reuse when an earlier item's identity changed (type mismatch)", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    // Replace the assistant message slot with a different id.
    const body = baseRequestBody([...priorInput, assistantMessage("a2", "hi there"), userMessage("next")]);

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toBeUndefined();
  });

  it("returns undefined when the new input is shorter than the baseline", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    const body = baseRequestBody([userMessage("hello")]);

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toBeUndefined();
  });

  it("returns undefined when a non-input request field diverges", () => {
    const priorInput: ResponseInput = [userMessage("hello")];
    const responseItems: ResponseInput = [assistantMessage("a1", "hi there")];
    const continuation = makeContinuation(priorInput, responseItems);

    const body: RequestBody = {
      ...baseRequestBody([...priorInput, ...responseItems, userMessage("next")]),
      temperature: 0.7,
    };

    const delta = getCachedWebSocketInputDelta(body, continuation);
    expect(delta).toBeUndefined();
  });
});

describe("WebSocket continuation requests", () => {
  it("sends full changed input, then resumes unchanged delta continuation", async () => {
    const globalObject: { WebSocket?: unknown } = globalThis;
    const originalWebSocket = globalObject.WebSocket;
    globalObject.WebSocket = ScriptedWebSocket;
    ScriptedWebSocket.scripts = [[{ type: "response.completed", response: { id: "resp-1", status: "completed", output: [] } }]];
    ScriptedWebSocket.sent = [];
    // The runner scope that owns a provider session retains it for its requests, and its release closes the cached socket.
    const release = retainWebSocketSession("content-drift-continuation");
    try {
      const options = { sessionId: "content-drift-continuation" };
      const prior = [userMessage("write")];
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: '{"content":"original"}' } as const;
      const first = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody(prior), new Headers(), options);
      first.commitContinuation([{ ...call, status: "completed" }], "resp-1");
      for await (const _event of first.events) { /* drain */ }
      const fullInput: ResponseInput = [...prior, { ...call, arguments: '{"content":"masked"}' }, { type: "function_call_output", call_id: "call_1", output: "Done" }];
      const second = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody(fullInput), new Headers(), options);
      expect(ScriptedWebSocket.sent[1]).toEqual({ type: "response.create", ...baseRequestBody(fullInput) });
      const answer = assistantMessage("a1", "done");
      second.commitContinuation([answer], "resp-2");
      for await (const _event of second.events) { /* drain */ }
      const next = userMessage("next");
      const third = await streamChatGptAdapterWebSocket("wss://example.test", baseRequestBody([...fullInput, answer, next]), new Headers(), options);
      expect(ScriptedWebSocket.sent[2]).toEqual({ type: "response.create", model: "gpt-5.4", previous_response_id: "resp-2", input: [next] });
      for await (const _event of third.events) { /* drain */ }
    } finally {
      release();
      globalObject.WebSocket = originalWebSocket;
    }
  });
});
