import { Redacted } from "effect";
import { errorMessage } from "../../../../infra/error-message.js";
import { CHATGPT_BACKEND_API_BASE } from "../../../../infra/auth/openai-auth-types.js";
import { JWT_CLAIM_PATH } from "./types.js";
import { providerRequestHeaders } from "../../../../infra/llm/provider-request-identity.js";

// pi's `buildRequestBody` (which used pi's `Context` + `convertResponsesMessages`)
// is dropped here; Flywheel agent runtime builds its own `ResponseCreateParamsStreaming` via
// `buildOpenAIParams` and passes it to the WebSocket transport directly. The
// header/URL builders + tool-call-providers set below are pi's logic kept verbatim.

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

/** Derived from the SSE path's `CHATGPT_BACKEND_API_BASE` so both transports always
 *  target the same ChatGPT backend. */
export function resolveChatGptAdapterWebSocketUrl(): string {
	const url = new URL(`${CHATGPT_BACKEND_API_BASE}/responses`);
	url.protocol = "wss:";
	return url.toString();
}

export function extractAccountId(token: Redacted.Redacted<string>): string {
	try {
		// The account id is a non-secret claim inside the JWT; unwrap inline to
		// parse it and never retain the plaintext token.
		const parts = Redacted.value(token).split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		// SAFETY: parts.length === 3 guarantees parts[1] (the JWT payload segment) is present.
		const payload = JSON.parse(atob(parts[1]!));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch (err) {
		// Surface the real JWT/base64 parse reason - a malformed token must be
		// diagnosable at this OpenAI/ChatGPT auth boundary, not collapsed to a generic message.
		throw new Error(`Failed to extract accountId from token: ${errorMessage(err)}`, { cause: err });
	}
}

export function createChatGptAdapterRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function buildWebSocketHeaders(
	accountId: string,
	token: Redacted.Redacted<string>,
	affinityHeaders: { readonly [name: string]: string },
): Promise<Headers> {
	// Provider-call adapter (WebSocket handshake): the token is unwrapped only
	// into the header.
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${Redacted.value(token)}`);
	headers.set("chatgpt-account-id", accountId);
	// Match the SSE path's originator (set in `openai-chatgpt.ts`) so the
	// ChatGPT backend sees the same source for both transports; server-side
	// trace correlation and per-originator quota apply consistently.
	headers.set("originator", "flywheel");
	headers.set("User-Agent", (await providerRequestHeaders())["User-Agent"] ?? "");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	for (const [name, value] of Object.entries(affinityHeaders)) headers.set(name, value);
	return headers;
}
