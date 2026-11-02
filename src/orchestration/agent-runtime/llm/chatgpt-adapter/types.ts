// Adapted from pi `packages/ai/src/api/openai-codex-responses.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import type {
	Tool as OpenAITool,
	ResponseInput,
} from "openai/resources/responses/responses.js";

export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
export const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

export const CHATGPT_BACKEND_RESPONSE_STATUSES: ReadonlySet<string> = new Set<ChatGptAdapterResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

export interface ChatGptAdapterResponsesOptions {
	sessionId?: string;
	accountId?: string;
	signal?: AbortSignal;
	projectRoot?: string;
}

export type ChatGptAdapterTransportPhase = "setup" | "call" | "read";

/** Identifies which external WebSocket boundary failed without converting local credential corruption into transport fallback. */
export class ChatGptAdapterTransportError extends Error {
	readonly phase: ChatGptAdapterTransportPhase;

	constructor(phase: ChatGptAdapterTransportPhase, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`ChatGPT backend WebSocket ${phase} failed: ${detail}`, { cause });
		this.name = "ChatGptAdapterTransportError";
		this.phase = phase;
	}
}

export type ChatGptAdapterResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: string | null;
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}
