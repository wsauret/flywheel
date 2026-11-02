import { afterEach, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Exit, Scope } from "effect";
import { acquireWebSocket, isWebSocketSseFallbackActive, parseWebSocket, recordWebSocketFailure, recordWebSocketSuccess, retainWebSocketSession, type WebSocketEvent, type WebSocketOptions } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/websocket-session.js";

const originalNow = Date.now;

function scopedSession(sessionId: string): () => void {
	const scope = Scope.makeUnsafe("sequential");
	Effect.runSync(Scope.addFinalizer(scope, Effect.sync(retainWebSocketSession(sessionId))));
	return () => Effect.runSync(Scope.close(scope, Exit.void));
}

function advanceMinutes(minutes: number): void {
	Date.now = () => originalNow() + minutes * 60 * 1000;
}

afterEach(() => {
	Date.now = originalNow;
	OpeningWebSocket.instances = [];
});

class OpeningWebSocket {
	static instances: OpeningWebSocket[] = [];
	readonly listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
	readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
	readyState = 1;
	constructor(_url: string, _options?: WebSocketOptions) {
		OpeningWebSocket.instances.push(this);
		queueMicrotask(() => this.emit("open", {}));
	}
	addEventListener(type: string, listener: (event: WebSocketEvent) => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: (event: WebSocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
	send(_data: string): void {}
	close(code?: number, reason?: string): void { this.closeCalls.push([code, reason]); this.readyState = 3; }
	emit(type: string, event: WebSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe("WebSocket session lifetime", () => {
	it("keeps shared active sessions until their last owner releases without affecting other keys", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = OpeningWebSocket;
		const releaseParent = scopedSession("shared-session");
		const releaseReview = scopedSession("shared-session");
		const releaseOther = scopedSession("independent-session");
		try {
			const parent = await acquireWebSocket("wss://example.test", new Headers(), "shared-session");
			const review = await acquireWebSocket("wss://example.test", new Headers(), "shared-session");
			const other = await acquireWebSocket("wss://example.test", new Headers(), "independent-session");
			expect(review.entry).toBeUndefined();
			review.release({ keep: true });
			releaseReview();
			expect(OpeningWebSocket.instances[0]?.closeCalls).toEqual([]);
			expect(OpeningWebSocket.instances[1]?.closeCalls).toHaveLength(1);
			parent.release({ keep: true });
			other.release({ keep: true });
			const reused = await acquireWebSocket("wss://example.test", new Headers(), "shared-session");
			expect(reused.socket).toBe(parent.socket);
			reused.release({ keep: true });
			recordWebSocketFailure("shared-session");
			recordWebSocketFailure("independent-session");
			releaseParent();
			expect(OpeningWebSocket.instances[0]?.closeCalls).toHaveLength(1);
			expect(parent.entry?.idleTimer).toBeUndefined();
			expect(isWebSocketSseFallbackActive("shared-session")).toBe(false);
			expect(OpeningWebSocket.instances[2]?.closeCalls).toEqual([]);
			expect(isWebSocketSseFallbackActive("independent-session")).toBe(true);
			releaseOther();
			expect(OpeningWebSocket.instances[2]?.closeCalls).toHaveLength(1);
			expect(other.entry?.idleTimer).toBeUndefined();
			expect(isWebSocketSseFallbackActive("independent-session")).toBe(false);
		} finally {
			releaseParent();
			releaseReview();
			releaseOther();
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("retains only one connection when cold requests open concurrently", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = OpeningWebSocket;
		OpeningWebSocket.instances = [];
		const acquired: Awaited<ReturnType<typeof acquireWebSocket>>[] = [];
		try {
			acquired.push(...await Promise.all([
				acquireWebSocket("wss://example.test", new Headers(), "cold-session"),
				acquireWebSocket("wss://example.test", new Headers(), "cold-session"),
			]));
			for (const connection of acquired) connection.release({ keep: true });
			expect(acquired.filter((connection) => connection.entry)).toHaveLength(1);
			expect(OpeningWebSocket.instances.filter((socket) => socket.readyState === 1)).toHaveLength(1);
			const retained = acquired.find((connection) => connection.entry);
			assert.ok(retained, "expected one retained connection");
			const next = await acquireWebSocket("wss://example.test", new Headers(), "cold-session");
			expect(next.socket).toBe(retained.socket);
			next.release();
		} finally {
			for (const connection of acquired) connection.release();
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("replaces an idle cached socket after 55 minutes", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = OpeningWebSocket;
		const releaseOwner = scopedSession("aged-session");
		try {
			const first = await acquireWebSocket("wss://example.test", new Headers(), "aged-session", "account-a");
			first.release({ keep: true });
			advanceMinutes(56);
			const second = await acquireWebSocket("wss://example.test", new Headers(), "aged-session", "account-a");
			expect(second.socket).not.toBe(first.socket);
			expect(OpeningWebSocket.instances[0]?.closeCalls).toContainEqual([1000, "connection_age_limit"]);
			second.release({ keep: true });
			releaseOwner();
			expect(OpeningWebSocket.instances[1]?.closeCalls).toHaveLength(1);
			expect(second.entry?.idleTimer).toBeUndefined();
		} finally {
			releaseOwner();
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("replaces a cached socket when the ChatGPT account changes", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = OpeningWebSocket;
		OpeningWebSocket.instances = [];
		try {
			const first = await acquireWebSocket("wss://example.test", new Headers(), "account-session", "account-a");
			first.release({ keep: true });
			const second = await acquireWebSocket("wss://example.test", new Headers(), "account-session", "account-b");
			expect(second.socket).not.toBe(first.socket);
			expect(OpeningWebSocket.instances[0]?.closeCalls).toContainEqual([1000, "account_changed"]);
			second.release();
		} finally {
			globalObject.WebSocket = originalWebSocket;
		}
	});
});

describe("WebSocket cancellation", () => {
	it("preserves AbortError while connecting", async () => {
		const globalObject: { WebSocket?: unknown } = globalThis;
		const originalWebSocket = globalObject.WebSocket;
		globalObject.WebSocket = OpeningWebSocket;
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(acquireWebSocket("wss://example.test", new Headers(), undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			globalObject.WebSocket = originalWebSocket;
		}
	});

	it("preserves AbortError while streaming", async () => {
		const socket = new OpeningWebSocket("wss://example.test");
		const controller = new AbortController();
		const next = parseWebSocket(socket, controller.signal).next();
		controller.abort();

		await expect(next).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("WebSocket SSE fallback cooldown", () => {
	it("activates after a failure and stays scoped to the failing session", () => {
		expect(isWebSocketSseFallbackActive("cooldown-session")).toBe(false);
		recordWebSocketFailure("cooldown-session");
		expect(isWebSocketSseFallbackActive("cooldown-session")).toBe(true);
		expect(isWebSocketSseFallbackActive("other-session")).toBe(false);
	});

	it("expires after 1 minute for a single failure", () => {
		recordWebSocketFailure("expiry-session");
		advanceMinutes(1.5);
		expect(isWebSocketSseFallbackActive("expiry-session")).toBe(false);
	});

	it("doubles the cooldown on consecutive failures", () => {
		recordWebSocketFailure("backoff-session");
		recordWebSocketFailure("backoff-session");
		advanceMinutes(1.5);
		expect(isWebSocketSseFallbackActive("backoff-session")).toBe(true);
		advanceMinutes(2.5);
		expect(isWebSocketSseFallbackActive("backoff-session")).toBe(false);
	});

	it("resets the backoff after a successful stream", () => {
		recordWebSocketFailure("reset-session");
		recordWebSocketFailure("reset-session");
		recordWebSocketSuccess("reset-session");
		expect(isWebSocketSseFallbackActive("reset-session")).toBe(false);
		recordWebSocketFailure("reset-session");
		advanceMinutes(1.5);
		expect(isWebSocketSseFallbackActive("reset-session")).toBe(false);
	});

	it("ignores undefined session ids", () => {
		recordWebSocketFailure(undefined);
		expect(isWebSocketSseFallbackActive(undefined)).toBe(false);
	});
});