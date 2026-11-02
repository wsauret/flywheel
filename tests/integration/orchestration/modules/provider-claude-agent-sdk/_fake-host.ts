/**
 * A local Anthropic Messages host for the Claude engine qualification tier.
 *
 * It listens on 127.0.0.1 and serves `/v1/messages` from a script: each model request gets the reply that the
 * script's function returns for it. Every request is recorded with its path, its header names, the values of the
 * request-option headers that the qualification compares (`anthropic-beta`, `anthropic-version`), its session id, and
 * its body. No
 * credential header value is ever recorded.
 *
 * A trap proxy runs beside it. The engine receives it as its HTTP and HTTPS proxy, so a connection to any host other
 * than this one is refused and recorded, and nothing leaves the machine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One content block of a scripted answer. A tool name is Flywheel's own name; the host sends it under the `runtime`
 *  MCP prefix when the request declares it that way, unless `bare` makes it send the name as a model that drops the
 *  prefix does. */
export type FakeBlock =
  | { readonly text: string }
  | { readonly thinking: string }
  | { readonly tool: string; readonly input: unknown; readonly bare?: true };

/** The scripted reply to one model request. */
export interface FakeReply {
  readonly blocks: readonly FakeBlock[];
  /** Usage headers of the reply. A stream adds them to the included-usage default (`INCLUDED_USAGE`); an error reply
   *  sends only these. */
  readonly headers?: { readonly [name: string]: string };
  /** The reply streams its blocks and then nothing more until the client goes away: its last block gets no stop and
   *  the message no end, as a response that a person interrupts mid-stream. */
  readonly open?: true;
  /** The reply sends its headers and then no byte until the client goes away, as a response that stalls before its
   *  first event. `blocks` is not sent. */
  readonly silent?: true;
  /** The reply is this HTTP error status with an Anthropic error body instead of a stream. It carries no usage
   *  headers unless `headers` scripts them: the engine reads a 429 with unified usage headers as a spent login, not
   *  as a plain rate limit. */
  readonly status?: number;
  /** The error of an error reply's body, in place of the status's own type and a fixed message. */
  readonly error?: { readonly type: string; readonly message: string };
  /** The reply streams its blocks and then ends with this SSE `error` event, as a stream that the service ends with
   *  an error after its first event. */
  readonly streamError?: { readonly type: string; readonly message: string };
  /** The reply waits for this before it answers, so another request can go out and be answered meanwhile. */
  readonly after?: Promise<unknown>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headerNames: readonly string[];
  readonly betas: readonly string[];
  readonly anthropicVersion: string | undefined;
  /** The session id that the engine names in `x-claude-code-session-id`: a random id with no credential in it. */
  readonly sessionId: string | undefined;
  readonly body: { readonly [field: string]: unknown };
}

export interface FakeHost {
  /** The URL that the engine gets as `ANTHROPIC_BASE_URL`. */
  readonly url: string;
  /** The variables that send the engine to this host and every other connection to the trap. */
  readonly environment: { readonly [name: string]: string };
  /** Every model request, in order. */
  readonly requests: RecordedRequest[];
  /** Every connection that the trap refused, as `METHOD target`. */
  readonly trapped: string[];
  stop(): Promise<void>;
}

/** The betas that name the engine's subscription credential and its client. The native route sends no credential
 *  of that kind, so the opt-in table leaves them out (`ANTHROPIC_BETAS`). */
export const CREDENTIAL_BETAS: ReadonlySet<string> = new Set(["claude-code-20250219", "oauth-2025-04-20", "extended-cache-ttl-2025-04-11"]);

/** The usage headers of a response that the plan's included usage served. */
export const INCLUDED_USAGE: { readonly [name: string]: string } = (() => {
  const now = Math.floor(Date.now() / 1000);
  return {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-reset": String(now + 7_200),
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "0.1",
    "anthropic-ratelimit-unified-5h-reset": String(now + 7_200),
    "anthropic-ratelimit-unified-7d-utilization": "0.2",
    "anthropic-ratelimit-unified-7d-reset": String(now + 3 * 86_400),
  };
})();

/** The Anthropic error type of each scripted error status that the service answers with its own type. */
const ERROR_TYPES = new Map([[403, "permission_error"], [404, "not_found_error"], [429, "rate_limit_error"], [529, "overloaded_error"]]);

function isRecord(value: unknown): value is { readonly [field: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tool names that a request declares. */
export function declaredTools(body: RecordedRequest["body"]): readonly string[] {
  const tools = body["tools"];
  return Array.isArray(tools) ? tools.flatMap((tool) => isRecord(tool) && typeof tool["name"] === "string" ? [tool["name"]] : []) : [];
}

/** Starts the host and its trap. `reply` gets each model request and its index from 0; a side request, such as one
 *  without tools, can be told apart by its body. */
export function startFakeHost(reply: (request: RecordedRequest, index: number) => FakeReply): FakeHost {
  const requests: RecordedRequest[] = [];
  const trapped: string[] = [];
  const encoder = new TextEncoder();
  const event = (data: { readonly type: string; readonly [field: string]: unknown }) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 60,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
      if (url.pathname !== "/v1/messages") return Response.json({ type: "error", error: { type: "not_found_error", message: "not served" } }, { status: 404 });
      const parsed: unknown = await request.json();
      const body = isRecord(parsed) ? parsed : {};
      const recorded: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        headerNames: [...request.headers.keys()].sort(),
        betas: (request.headers.get("anthropic-beta") ?? "").split(",").map((beta) => beta.trim()).filter((beta) => beta.length > 0),
        anthropicVersion: request.headers.get("anthropic-version") ?? undefined,
        sessionId: request.headers.get("x-claude-code-session-id") ?? undefined,
        body,
      };
      const index = requests.length;
      requests.push(recorded);
      const answer = reply(recorded, index);
      await answer.after;
      // The service names the request id in an error body too, equal to its `request-id` header.
      const requestId = `req_fake_${index}`;
      if (answer.status !== undefined) {
        const error = answer.error ?? { type: ERROR_TYPES.get(answer.status) ?? "api_error", message: "fake error" };
        return Response.json({ type: "error", error, request_id: requestId }, { status: answer.status, headers: { "request-id": requestId, ...answer.headers } });
      }
      if (answer.silent === true) return new Response(new ReadableStream({ start: () => {} }), { headers: { "content-type": "text/event-stream", "request-id": requestId, ...INCLUDED_USAGE } });
      const tools = declaredTools(body);
      const usage = { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(event({ type: "message_start", message: { id: `msg_fake_${index}`, type: "message", role: "assistant", model: body["model"], content: [], stop_reason: null, stop_sequence: null, usage } }));
          for (const [position, block] of answer.blocks.entries()) {
            if ("tool" in block) {
              const name = block.bare !== true && tools.includes(`mcp__runtime__${block.tool}`) ? `mcp__runtime__${block.tool}` : block.tool;
              controller.enqueue(event({ type: "content_block_start", index: position, content_block: { type: "tool_use", id: `toolu_fake_${index}_${position}`, name, input: {} } }));
              controller.enqueue(event({ type: "content_block_delta", index: position, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }));
            } else if ("thinking" in block) {
              controller.enqueue(event({ type: "content_block_start", index: position, content_block: { type: "thinking", thinking: "", signature: "" } }));
              controller.enqueue(event({ type: "content_block_delta", index: position, delta: { type: "thinking_delta", thinking: block.thinking } }));
              controller.enqueue(event({ type: "content_block_delta", index: position, delta: { type: "signature_delta", signature: `fake-signature-${index}-${position}` } }));
            } else {
              controller.enqueue(event({ type: "content_block_start", index: position, content_block: { type: "text", text: "" } }));
              controller.enqueue(event({ type: "content_block_delta", index: position, delta: { type: "text_delta", text: block.text } }));
            }
            if (answer.open === true && position === answer.blocks.length - 1) return;
            controller.enqueue(event({ type: "content_block_stop", index: position }));
          }
          if (answer.streamError !== undefined) {
            controller.enqueue(event({ type: "error", error: answer.streamError }));
            controller.close();
            return;
          }
          const stopReason = answer.blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn";
          controller.enqueue(event({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }));
          controller.enqueue(event({ type: "message_stop" }));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": requestId, ...INCLUDED_USAGE, ...answer.headers } });
    },
  });
  const trap = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, served) => {
      // A request that names the trap's own address may have come through the proxy setting or straight to the
      // port from another process that holds a stale loopback URL. Both stay recorded; the mark tells them apart
      // from a proxied request to another host when a case fails.
      const target = request.headers.get("host") ?? request.url;
      trapped.push(`${request.method} ${target}${target === `127.0.0.1:${served.port}` ? " (the trap's own address)" : ""}`);
      return new Response("refused by the qualification trap", { status: 403 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const proxy = `http://127.0.0.1:${trap.port}`;
  return {
    url, requests, trapped,
    environment: { ANTHROPIC_BASE_URL: url, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stop: async () => { await Promise.all([server.stop(true), trap.stop(true)]); },
  };
}

/** The account of the fake login. Its token text is a placeholder that no service accepts. */
export const FAKE_ACCOUNT = {
  accountUuid: "00000000-0000-4000-8000-0000000000a7",
  emailAddress: "qualification@example.invalid",
  organizationUuid: "00000000-0000-4000-8000-0000000000b7",
  billingType: "stripe_subscription",
  hasExtraUsageEnabled: false,
} as const;

/** Writes a Claude Max login into `configDir` in the engine's plaintext store, as the engine keeps it where no
 *  keychain serves it. The engine then treats it as a subscription login and sends what it sends for one. */
export function writeFakeClaudeLogin(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: FAKE_ACCOUNT, cachedExtraUsageDisabledReason: "org_level_disabled" }));
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "sk-ant-oat01-qualification-placeholder", refreshToken: "sk-ant-ort01-qualification-placeholder",
    expiresAt: Date.now() + 30 * 86_400_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x",
  } }), { mode: 0o600 });
}
