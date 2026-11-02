// Adapted from pi `packages/ai/src/api/openai-codex-responses.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import type { ResponseInput } from "openai/resources/responses/responses.js";
import { isAbortError } from "../../../../infra/abort.js";
import { formatThrownValue, headersToRecord, runtimeWebSocket } from "./deps.js";
import { resolveHttpProxyUrlForTarget } from "./proxy.js";
import { ChatGptAdapterProtocolError } from "./sse.js";
import { type RequestBody, WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE } from "./types.js";

interface UnknownRecord {
	[key: string]: unknown;
}

interface StringRecord {
	[key: string]: string;
}

export interface WebSocketEvent {
	readonly data?: string | ArrayBuffer | ArrayBufferView | Blob;
	readonly message?: string;
	readonly error?: Error | { readonly message?: string };
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;
}

export interface WebSocketOptions {
	readonly headers?: StringRecord;
	readonly proxy?: string;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 15 * 1000;
const WEBSOCKET_FAILURE_COOLDOWN_BASE_MS = 60 * 1000;
const WEBSOCKET_FAILURE_COOLDOWN_MAX_MS = 16 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: WebSocketEvent) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export interface CachedWebSocketConnection {
	socket: WebSocketLike;
	accountId?: string;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: { lastRequestBody: RequestBody; lastResponseId: string; lastResponseItems: ResponseInput };
}

interface WebSocketSession {
	leases: number;
	connection?: CachedWebSocketConnection;
	fallback?: { retryAt: number; consecutiveFailures: number };
}

const websocketSessions = new Map<string, WebSocketSession>();

function sessionFor(sessionId: string): WebSocketSession {
	let session = websocketSessions.get(sessionId);
	if (!session) {
		session = { leases: 0 };
		websocketSessions.set(sessionId, session);
	}
	return session;
}

function deleteUnusedSession(sessionId: string, session: WebSocketSession): void {
	if (session.leases === 0 && !session.connection && !session.fallback && websocketSessions.get(sessionId) === session) {
		websocketSessions.delete(sessionId);
	}
}

/** Retains transport state across runs sharing a provider session key.
 * The owning scope calls the release once, after its requests settle. */
export function retainWebSocketSession(sessionId: string): () => void {
	const session = sessionFor(sessionId);
	session.leases += 1;
	return () => {
		session.leases -= 1;
		if (session.leases !== 0) return;
		if (session.connection) closeSessionConnection(sessionId, session, session.connection);
		websocketSessions.delete(sessionId);
	};
}

export function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	const session = websocketSessions.get(sessionId);
	const entry = session?.fallback;
	if (!entry) return false;
	if (Date.now() < entry.retryAt) return true;
	recordWebSocketSuccess(sessionId);
	return false;
}

/** Routes the session to SSE with exponential backoff (1, 2, 4, ... minutes,
 *  capped at 16) so a flaky proxy doesn't retry-fail every turn; after each
 *  window the next request tries WebSocket again. */
export function recordWebSocketFailure(sessionId: string | undefined): void {
	if (!sessionId) return;
	const session = sessionFor(sessionId);
	const consecutiveFailures = (session.fallback?.consecutiveFailures ?? 0) + 1;
	const cooldown = Math.min(
		WEBSOCKET_FAILURE_COOLDOWN_BASE_MS * 2 ** (consecutiveFailures - 1),
		WEBSOCKET_FAILURE_COOLDOWN_MAX_MS,
	);
	session.fallback = { retryAt: Date.now() + cooldown, consecutiveFailures };
}

/** Clears the backoff after a successful WebSocket stream so a later
 *  isolated failure restarts at the base cooldown. */
export function recordWebSocketSuccess(sessionId: string | undefined): void {
	if (!sessionId) return;
	const session = websocketSessions.get(sessionId);
	if (!session) return;
	session.fallback = undefined;
	deleteUnusedSession(sessionId, session);
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: StringRecord },
) => WebSocketLike;

let _cachedWebSocketCtor: WebSocketConstructor | null | undefined;
let _cachedWebSocketBaseCtor: unknown;

async function getWebSocketConstructor(): Promise<WebSocketConstructor | null> {
	const baseCtor = runtimeWebSocket();
	if (_cachedWebSocketCtor !== undefined && baseCtor === _cachedWebSocketBaseCtor) return _cachedWebSocketCtor;
	_cachedWebSocketBaseCtor = baseCtor;
	if (typeof baseCtor !== "function") return (_cachedWebSocketCtor = null);
	if (typeof process !== "undefined" && process.versions?.bun) {
		// SAFETY: runtime boundary; the native constructor supports Bun's proxy option in addition to headers.
		// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Bun extends the runtime WebSocket constructor with proxy options
		_cachedWebSocketCtor = class extends (baseCtor as { new (url: string, opts?: WebSocketOptions): WebSocketLike }) {
			constructor(url: string, options?: WebSocketOptions) {
				const baseOptions = isRecord(options) ? { ...options } : {};
				const target = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
				const proxy = resolveHttpProxyUrlForTarget(target);
				super(url, { ...baseOptions, ...(proxy ? { proxy: proxy.toString() } : {}) });
			}
		// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the derived constructor implements the local WebSocket constructor contract
		} as WebSocketConstructor;
		return _cachedWebSocketCtor;
	}
	// SAFETY: runtime-global boundary; the constructor was narrowed to a function and matches the local wire interface.
	// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the runtime WebSocket constructor is verified only by runtime availability
	return (_cachedWebSocketCtor = baseCtor as WebSocketConstructor);
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const rs = isRecord(socket) ? socket.readyState : undefined;
	return typeof rs !== "number" || rs === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try { socket.close(code, reason); } catch {
		// Closing is best-effort; a dead socket is already unusable.
	}
}

function signalAbortError(signal: AbortSignal): Error {
	return isAbortError(signal.reason) ? signal.reason : new DOMException("Request was aborted", "AbortError");
}

function closeSessionConnection(sessionId: string, session: WebSocketSession, entry: CachedWebSocketConnection, reason = "done"): void {
	if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
	closeWebSocketSilently(entry.socket, 1000, reason);
	if (session.connection === entry) session.connection = undefined;
	deleteUnusedSession(sessionId, session);
}

function scheduleSessionWebSocketExpiry(sessionId: string, session: WebSocketSession, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeSessionConnection(sessionId, session, entry, "idle_timeout");
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function acquireSessionConnection(sessionId: string, session: WebSocketSession, entry: CachedWebSocketConnection) {
	entry.busy = true;
	return {
		socket: entry.socket, entry,
		release: ({ keep }: { keep?: boolean } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeSessionConnection(sessionId, session, entry);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, session, entry);
		},
	};
}

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor();
	if (!WebSocketCtor) throw new Error("WebSocket transport is not available in this runtime");

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let socket: WebSocketLike;
		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, reason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (reason) closeWebSocketSilently(socket, 1000, reason);
			reject(error);
		};
		const onOpen: WebSocketListener = () => { if (settled) return; settled = true; cleanup(); resolve(socket); };
		const onError: WebSocketListener = (event) => { fail(extractWebSocketError(event)); };
		const onClose: WebSocketListener = (event) => { fail(extractWebSocketCloseError(event)); };
		const onAbort = () => { if (signal) fail(signalAbortError(signal), "aborted"); };
		const timeout = setTimeout(() => {
			fail(new Error(`WebSocket connect timeout after ${WEBSOCKET_CONNECT_TIMEOUT_MS}ms`), "connect_timeout");
		}, WEBSOCKET_CONNECT_TIMEOUT_MS);
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
		if (signal?.aborted) onAbort();
	});
}

export async function acquireWebSocket(
	url: string, headers: Headers, sessionId: string | undefined, accountId?: string, signal?: AbortSignal,
): Promise<{ socket: WebSocketLike; entry?: CachedWebSocketConnection; release: (options?: { keep?: boolean }) => void }> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal);
		return { socket, release: () => { closeWebSocketSilently(socket); } };
	}

	const session = websocketSessions.get(sessionId);
	const cached = session?.connection;
	if (session && cached) {
		if (cached.accountId !== accountId) {
			closeSessionConnection(sessionId, session, cached, "account_changed");
		} else {
			if (cached.idleTimer) { clearTimeout(cached.idleTimer); cached.idleTimer = undefined; }
			if (!cached.busy && isWebSocketSessionExpired(cached)) {
				closeSessionConnection(sessionId, session, cached, "connection_age_limit");
			} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
				return acquireSessionConnection(sessionId, session, cached);
			}
			if (cached.busy) {
				const socket = await connectWebSocket(url, headers, signal);
				return { socket, release: () => { closeWebSocketSilently(socket); } };
			}
			if (session.connection === cached && !isWebSocketReusable(cached.socket)) closeSessionConnection(sessionId, session, cached);
		}
	}

	const socket = await connectWebSocket(url, headers, signal);
	const currentSession = sessionFor(sessionId);
	// Another cold acquisition can publish while this connection opens.
	if (currentSession.connection) return { socket, release: () => { closeWebSocketSilently(socket); } };
	const entry: CachedWebSocketConnection = { socket, accountId, busy: true, createdAt: Date.now() };
	currentSession.connection = entry;
	return acquireSessionConnection(sessionId, currentSession, entry);
}

function extractWebSocketError(event: WebSocketEvent): Error {
	if (isRecord(event)) {
		const message = event.message;
		if (typeof message === "string" && message.length > 0) return new Error(message);
		const nestedError = event.error;
		if (nestedError instanceof Error && nestedError.message.length > 0) return nestedError;
		if (isRecord(nestedError)) {
			const nestedMessage = nestedError.message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) return new Error(nestedMessage);
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: WebSocketEvent): Error {
	if (isRecord(event)) {
		const code = event.code;
		const reason = event.reason;
		const wasClean = event.wasClean;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) reasonText = " message too big";
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

function parseFrame(text: string): UnknownRecord {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new SyntaxError("ChatGPT backend WebSocket frame is not a JSON object");
	return parsed;
}

async function decodeWebSocketData(data: WebSocketEvent["data"]): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	if (isRecord(data) && typeof data.arrayBuffer === "function") {
		// SAFETY: external WebSocket message boundary; Blob-like frames expose arrayBuffer(), verified callable above; the no-arg () => Promise<ArrayBuffer> shape is the Blob/Response contract we decode.
		// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a callable Blob-like external frame exposes the standard arrayBuffer contract
		const arrayBuffer = await (data.arrayBuffer as () => Promise<ArrayBuffer>)();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

export async function* parseWebSocket(socket: WebSocketLike, signal?: AbortSignal): AsyncGenerator<UnknownRecord> {
	const queue: UnknownRecord[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => { if (!pending) return; const resolve = pending; pending = null; resolve(); };
	const waitForFrame = () => new Promise<void>((resolve) => { pending = resolve; });
	const throwFailure = (error: Error): never => { throw error; };

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				text = await decodeWebSocketData(event.data);
				if (!text) return;
				const parsed = parseFrame(text);
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true; done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new ChatGptAdapterProtocolError(`Invalid ChatGPT backend WebSocket JSON: ${formatThrownValue(cause)}`, { cause, payload: text });
				done = true; wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => { failed = extractWebSocketError(event); done = true; wake(); };
	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) { done = true; wake(); return; }
		if (!failed) failed = extractWebSocketCloseError(event);
		done = true; wake();
	};
	const onAbort = () => { if (signal) failed = signalAbortError(signal); done = true; wake(); };

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) throw signalAbortError(signal);
			if (queue.length > 0) {
				// SAFETY: queue.length > 0 checked on the line above, so shift() returns a frame (never undefined).
				yield queue.shift()!;
				continue;
			}
			if (done) break;
				await waitForFrame();
			}
			if (failed) throwFailure(failed);
		if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}
