import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { CHATGPT_BACKEND_RESPONSE_STATUSES, type ChatGptAdapterResponseStatus } from "./types.js";

interface AdapterEvent {
	[key: string]: unknown;
}

export class ChatGptAdapterApiError extends Error {
	readonly code?: string;
	readonly payload?: AdapterEvent;

	constructor(message: string, options?: { code?: string; payload?: AdapterEvent }) {
		super(message);
		this.name = "ChatGptAdapterApiError";
		this.code = options?.code;
		this.payload = options?.payload;
	}
}

export class ChatGptAdapterProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "ChatGptAdapterProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isResponseStreamEvent(event: AdapterEvent): event is AdapterEvent & ResponseStreamEvent {
	return typeof event.type === "string";
}

export async function* mapChatGptAdapterEvents(
	events: AsyncIterable<AdapterEvent>,
	onProviderError: (error: ChatGptAdapterApiError) => never = (error) => { throw error; },
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractBackendErrorFields(event);
			onProviderError(new ChatGptAdapterApiError(`ChatGPT backend error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			}));
		}

		if (type === "response.failed") {
			const error = recordField(recordField(event.response)?.error);
			const code = (stringField(error?.code) || stringField(error?.type)) || undefined;
			const message = stringField(error?.message);
			onProviderError(new ChatGptAdapterApiError(message || "ChatGPT backend response failed", { code, payload: event }));
		}

		// Normalize legacy done/incomplete frames to the SDK's response.completed; downstream branches on response.status, not the frame name.
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = recordField(event.response);
			const normalizedResponse = response
				? { ...response, status: normalizeChatGptAdapterStatus(response.status) }
				: response;
			// SAFETY: external ChatGPT backend SSE wire frame; the response.create/done envelope is structurally a ResponseStreamEvent and the status field is normalized above to the SDK's enum.
			// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: external ChatGPT SSE completion frames are normalized before entering the SDK event consumer
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		if (!isResponseStreamEvent(event)) continue;
		yield event;
	}
}

/** Real backend error frames nest the payload under `error` with the quota
 *  discriminator on `error.type` (`usage_limit_reached` carries no `code` at
 *  all) and structured codes on `error.code`; only legacy frames put fields at
 *  the top level. Verified against the Codex CLI fixtures
 *  (`client_websockets.rs:1472-1480,:1642-1648`); pi
 *  `openai-codex-responses.ts:708-719` reads the nested fallbacks the same way. */
function extractBackendErrorFields(event: AdapterEvent) {
	const nested = recordField(event.error);
	const code = stringField(event.code) || stringField(nested?.code) || stringField(nested?.type);
	const message = stringField(event.message) || stringField(nested?.message);
	return { code: code || undefined, message: message || undefined };
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function recordField(value: unknown): AdapterEvent | undefined {
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is AdapterEvent {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatGptAdapterResponseStatus(status: string): status is ChatGptAdapterResponseStatus {
	return CHATGPT_BACKEND_RESPONSE_STATUSES.has(status);
}

function normalizeChatGptAdapterStatus(status: unknown): ChatGptAdapterResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return isChatGptAdapterResponseStatus(status) ? status : undefined;
}
