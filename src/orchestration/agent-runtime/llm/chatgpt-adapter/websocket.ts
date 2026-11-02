// Adapted from pi `packages/ai/src/api/openai-codex-responses.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import { isDeepStrictEqual } from "node:util";
import { dumpFailedChatGptRequest, logRejectedChatGptRequest } from "../openai-chatgpt.js";
import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { isAbortError } from "../../../../infra/abort.js";
import { parseToolArguments } from "../json-parse.js";
import { sanitizeSurrogates } from "../sanitize-unicode.js";
import { ChatGptAdapterApiError, mapChatGptAdapterEvents } from "./sse.js";
import { ChatGptAdapterTransportError, type ChatGptAdapterResponsesOptions, type RequestBody } from "./types.js";
import {
	acquireWebSocket,
	parseWebSocket,
	recordWebSocketFailure,
	recordWebSocketSuccess,
	type CachedWebSocketConnection,
} from "./websocket-session.js";

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

type ResponseItem = ResponseInput[number];

function itemId(item: ResponseItem): string | undefined {
	const id = "id" in item ? item.id : undefined;
	return typeof id === "string" ? id : undefined;
}

function itemType(item: ResponseItem) {
	return "type" in item ? item.type : undefined;
}

/** Compare the content replayed by conversions/openai-responses, not response-only
 * metadata. A field the converter never replays must not count: a response item
 * that carries it would never match its replay, and every later request would
 * resend the whole conversation. */
function comparableInput(item: ResponseItem) {
	if (item.type === "reasoning") {
		return { type: item.type, id: item.id, summary: item.summary, encrypted_content: item.encrypted_content };
	}
	if (item.type === "function_call") {
		return { type: item.type, id: item.id, call_id: item.call_id, name: item.name, arguments: parseToolArguments(item.arguments).input };
	}
	if (item.type === "custom_tool_call") {
		return { type: item.type, id: item.id, call_id: item.call_id, name: item.name, input: sanitizeSurrogates(item.input) };
	}
	if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)
		&& item.content.every((part) => part.type === "output_text" || part.type === "refusal")) {
		// openai.ts joins terminal text/refusal parts into the converter's single
		// output_text part and carries the message phase through its text signature.
		const phase = "phase" in item ? item.phase : undefined;
		const text = item.content.map((part) => part.type === "output_text" ? part.text : part.refusal).join("");
		return { type: item.type, id: itemId(item), role: item.role, text: sanitizeSurrogates(text), phase: phase ?? undefined };
	}
	return item;
}

/** IDs preserve identity across stale masking, not content. Stop at the first
 * changed slot rather than serializing the complete growing prefix. */
function isPrefixOf(prefix: readonly ResponseItem[], items: readonly ResponseItem[]): boolean {
	if (prefix.length > items.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		// SAFETY: loop bound is prefix.length and prefix.length <= items.length.
		const a = prefix[i]!;
		// SAFETY: same bound; i < prefix.length <= items.length.
		const b = items[i]!;
		if (itemType(a) !== itemType(b)) return false;
		if (itemId(a) !== itemId(b)) return false;
		if (!isDeepStrictEqual(comparableInput(a), comparableInput(b))) return false;
	}
	return true;
}

function getCachedWebSocketInputDelta(body: RequestBody, continuation: NonNullable<CachedWebSocketConnection["continuation"]>): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) return undefined;
	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (!isPrefixOf(baseline, currentInput)) return undefined;
	return currentInput.slice(baseline.length);
}

export { getCachedWebSocketInputDelta };

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) return body;
	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) { entry.continuation = undefined; return body; }
	return { ...body, previous_response_id: continuation.lastResponseId, input: delta };
}

function transportError(phase: "setup" | "call" | "read", cause: unknown): Error {
	if (isAbortError(cause)) throw cause;
	if (cause instanceof ChatGptAdapterTransportError) return cause;
	return new ChatGptAdapterTransportError(phase, cause);
}

interface ChatGptAdapterWebSocketStreamResult {
	events: AsyncGenerator<ResponseStreamEvent>;
	commitContinuation: (items: ResponseInput | undefined, responseId: string | undefined) => void;
}

export async function streamChatGptAdapterWebSocket(
	url: string,
	body: RequestBody,
	headers: Headers,
	options?: ChatGptAdapterResponsesOptions,
): Promise<ChatGptAdapterWebSocketStreamResult> {
	let acquisition: Awaited<ReturnType<typeof acquireWebSocket>>;
	try {
		acquisition = await acquireWebSocket(url, headers, options?.sessionId, options?.accountId, options?.signal);
	} catch (cause) {
		throw transportError("setup", cause);
	}
	const finalEntry = acquisition.entry;
	const continuationBody = finalEntry ? buildCachedWebSocketRequestBody(finalEntry, body) : body;
	let committed = false;

	try {
		acquisition.socket.send(JSON.stringify({ type: "response.create", ...continuationBody }));
	} catch (cause) {
		acquisition.release({ keep: false });
		throw transportError("call", cause);
	}

	async function* yieldEvents(): AsyncGenerator<ResponseStreamEvent> {
		let keepConnection = true;
		try {
			for await (const event of mapChatGptAdapterEvents(parseWebSocket(acquisition.socket, options?.signal))) yield event;
			recordWebSocketSuccess(options?.sessionId);
		} catch (cause) {
			if (cause instanceof ChatGptAdapterApiError) {
				logRejectedChatGptRequest({ type: "response.create", ...continuationBody }, "websocket");
				dumpFailedChatGptRequest(options?.projectRoot, "websocket", { type: "response.create", ...continuationBody }, cause.payload);
			}
			if (finalEntry) finalEntry.continuation = undefined;
			keepConnection = false;
			if (!options?.signal?.aborted) recordWebSocketFailure(options?.sessionId);
			throw transportError("read", cause);
		} finally {
			if (options?.signal?.aborted) keepConnection = false;
			acquisition.release({ keep: keepConnection });
		}
	}

	function commitContinuation(items: ResponseInput | undefined, responseId: string | undefined): void {
		if (committed || !finalEntry || !items || !responseId) return;
		committed = true;
		const filtered = items.filter((item) => itemType(item) !== "function_call_output");
		finalEntry.continuation = { lastRequestBody: body, lastResponseId: responseId, lastResponseItems: filtered };
	}

	return { events: yieldEvents(), commitContinuation };
}
