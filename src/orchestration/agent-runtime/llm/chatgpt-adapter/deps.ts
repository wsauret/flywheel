interface StringRecord {
	[key: string]: string;
}

export function headersToRecord(headers: Headers): StringRecord {
	const result: StringRecord = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

/** The runtime's `WebSocket` global, read as `unknown` because availability and
 *  shape differ across runtimes (Bun native vs. polyfilled vs. absent). Callers
 *  narrow with `typeof === "function"` before constructing. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: Runtime globals require caller-side availability and shape narrowing.
export function runtimeWebSocket(): unknown {
	// SAFETY: external runtime-global boundary; `WebSocket` is optional on globalThis (absent in some runtimes) and its constructor shape is runtime-specific, so it is surfaced as unknown for callers to narrow.
	// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: runtime globals can omit or replace the WebSocket constructor
	return (globalThis as { WebSocket?: unknown }).WebSocket;
}
