import { DebugLog } from "../../../infra/debug-log.js";
import { ProviderRequestValidationError } from "../../agent-runtime/llm/errors.js";
import { CLAUDE_AGENT_SDK_LABEL } from "./names.js";

/** Sign-in messages emitted by CLI 2.1.296. Only these fixed kinds cross the diagnostics boundary.
 *  The keychain messages also occur in utils/secureStorage/macOsKeychainStorage.ts:58,83 of the vendored engine.
 *  The other messages come from the shipped engine's auth and Anthropic client chunks, not its analytics events. */
const SIGN_IN_LINES = [
  ["authentication-unresolved", /^\[ERROR\] API error \(attempt \d+\/\d+\): Could not resolve authentication method\./u],
  ["keychain-read-failed-stale", /^\[WARN\] \[keychain\] read failed; serving stale cache$/u],
  ["keychain-async-read-failed", /^\[WARN\] \[keychain\] readAsync failed; (?:serving stale cache|not caching a null)$/u],
  ["refresh-failed", /^\[ERROR\] OAuth refresh failed (?:\(expected\)|while lock compromised):/u],
  ["refresh-lock-compromised", /^\[ERROR\] OAuth refresh lock compromised:/u],
  ["refresh-lock-release-failed", /^\[(?:DEBUG|ERROR)\] OAuth refresh (?:new-lock |legacy-lock |lock )release failed:/u],
  ["oauth-callback-failed", /^\[ERROR\] SDK getOAuthToken callback failed:/u],
  ["existing-sign-in-check-failed", /^\[WARN\] Existing sign-in check failed:/u],
] as const;

type SignInKind = (typeof SIGN_IN_LINES)[number][0];

function signInKind(line: string): SignInKind | undefined {
  const level = line.indexOf(" [");
  if (level < 0) return undefined;
  const message = line.slice(level + 1);
  return SIGN_IN_LINES.find(([, pattern]) => pattern.test(message))?.[0];
}

/** The last 32 sign-in observations of an engine, with monotonic milliseconds from its launch.
 *  No raw message, token, or error detail is retained. Earlier observations count as omitted. */
export function signInTrace() {
  const startedAt = performance.now();
  const signals: { readonly kind: SignInKind; readonly sinceStartMs: number }[] = [];
  let omitted = 0;
  return {
    read(line: string): void {
      const kind = signInKind(line);
      if (kind === undefined) return;
      if (signals.length === 32) {
        signals.shift();
        omitted += 1;
      }
      signals.push({ kind, sinceStartMs: Math.round(performance.now() - startedAt) });
    },
    snapshot: () => ({ signals: [...signals], omitted }),
  };
}

/**
 * A CLI debug line that marks a request the CLI sent again by itself. The SDK stream shows none of these resends
 * (bridge rule 4). The signal holds no line text, so a diagnostic record built from it holds no content.
 */
export interface StderrSignal {
  /** The CLI's own tag, or `unrecognized` for a warn-level line that names a retry no tag here describes. */
  readonly tag: string;
  /** How an open request fails: `bad-request` where native Flywheel would have shown the HTTP 400 that the CLI
   *  answered, `transient` for a connection or server failure, and for an unrecognized line. */
  readonly failure: "bad-request" | "transient";
}

/** The silent retry paths of CLI 2.1.293 to 2.1.296. Each line is warn level. */
const RETRY_LINES: readonly { readonly tag: string; readonly pattern: RegExp; readonly failure: StderrSignal["failure"] }[] = [
  { tag: "server-fallback", pattern: /^\[server-fallback\] 400 attributed\b/u, failure: "bad-request" },
  { tag: "thinking-signature", pattern: /^\[thinking\] server rejected a thinking block\b/u, failure: "bad-request" },
  { tag: "thinking-type", pattern: /^\[thinking\] model rejected thinking\.type=/u, failure: "bad-request" },
  { tag: "dispatch", pattern: /^\[dispatch\] .*\bretrying once\b/u, failure: "transient" },
  { tag: "server-classifier", pattern: /^\[server-classifier\] .*\bretrying once\b/u, failure: "bad-request" },
  { tag: "reminders-clear-at", pattern: /^\[reminders\] .*\bclear_at\b.*\bretrying\b/u, failure: "bad-request" },
  { tag: "mid-conv-system", pattern: /^\[mid-conv-system\] .*\b(?:retrying|resending)\b/u, failure: "bad-request" },
  { tag: "per-turn-control", pattern: /^\[per-turn-control\] .*\bresending\b/u, failure: "bad-request" },
  { tag: "effort", pattern: /^\[effort\] .*\boutput_config\.effort\b.*\bretrying\b/u, failure: "bad-request" },
  { tag: "structured-outputs", pattern: /^\[structured-outputs\] .*\boutput_config\.format\b.*\bretrying\b/u, failure: "bad-request" },
  { tag: "thinking-token-count", pattern: /^\[thinking-token-count\] .*\bretrying\b/u, failure: "bad-request" },
  // The media strip after a 400 that names an image, or after a 400 that names none.
  { tag: "media-strip", pattern: /^Removed (?:unprocessable|base64) .*; retrying\.$/u, failure: "bad-request" },
  // The resend without the 1M context beta header after a 400 that names it or names an invalid beta (CLI 2.1.296).
  { tag: "betas", pattern: /^\[betas\] an HTTP 400 .*; resending once without it$/u, failure: "bad-request" },
];

/** A warn-level line with any of these words can be a retry path that a later CLI added. */
const POSSIBLE_RETRY = /\b(?:retry|retrying|retried|resend|resending|rejected)\b/iu;

/**
 * Sorts one line of the CLI's `--debug-to-stderr` output. Only warn-level lines can mark a resend. A warn-level
 * line that the table does not know but that names a retry, a resend, or a rejection fails closed as
 * `unrecognized`: the tag list is valid for CLI 2.1.293 to 2.1.296 only, and a missed resend would reach the model unseen.
 */
export function classifyStderrLine(line: string): StderrSignal | undefined {
  const message = /\[WARN\] (.*)$/u.exec(line)?.[1];
  if (message === undefined) return undefined;
  const known = RETRY_LINES.find(({ pattern }) => pattern.test(message));
  if (known !== undefined) return { tag: known.tag, failure: known.failure };
  return POSSIBLE_RETRY.test(message) ? { tag: "unrecognized", failure: "transient" } : undefined;
}

/** An HTTP error response that the CLI received, as its error line states it. */
export interface ApiErrorLine {
  readonly status: number;
  /** The response body as text. It is content: it goes into the request's failure and never into a record. */
  readonly body: string;
  /** The body's `request_id`, which the service sets equal to the response's `request-id` header. The line names no
   *  log id, so this is the one key that joins the body to its request. */
  readonly requestId: string | undefined;
}

/**
 * The HTTP error that a line of the CLI's `--debug-to-stderr` output reports, or undefined for any other line. The
 * CLI writes `[ERROR] API error (attempt N/M): <status> <message>` for each HTTP error before any of its own recovery
 * paths runs, and the message of an Anthropic SDK error is `<status> <body>`. So the line gives every 400 with its
 * body, also a 400 that a recovery path resends without a warn line.
 */
export function apiErrorLine(line: string): ApiErrorLine | undefined {
  const reported = /\[ERROR\] API error \(attempt \d+\/\d+\): (\d{3}) (.*)$/u.exec(line);
  if (reported === null) return undefined;
  const [, status = "", message = ""] = reported;
  const body = message.startsWith(`${status} `) ? message.slice(status.length + 1) : message;
  return { status: Number(status), body, requestId: bodyRequestId(body) };
}

/**
 * Whether a line of the engine's `--debug-to-stderr` output reports that the service refused to count tokens for
 * `wireModelId` because it does not serve that model to the login. The engine writes `[ERROR] countTokens API call
 * failed: <status> <body>` when a count fails, and the refusal is a 404 whose `not_found_error` names the model
 * (engine 2.1.306: `{"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-5-2"}}`).
 */
export function countTokensRefusesModel(line: string, wireModelId: string): boolean {
  const body = /\[ERROR\] countTokens API call failed: 404 (\{.*\})$/u.exec(line)?.[1];
  if (body === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    const error = typeof parsed === "object" && parsed !== null && "error" in parsed ? parsed.error : undefined;
    return typeof error === "object" && error !== null && "type" in error && error.type === "not_found_error"
      && "message" in error && typeof error.message === "string" && error.message.includes(wireModelId);
  } catch {
    return false;
  }
}

function bodyRequestId(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const id = typeof parsed === "object" && parsed !== null && "request_id" in parsed ? parsed.request_id : undefined;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** A request that a line of the CLI's `--debug-to-stderr` output announces. */
export interface AnnouncedRequest {
  /** Whether the request goes to `/v1/messages`, the model endpoint. */
  readonly model: boolean;
  /** The CLI caller that the line names: a short identifier of the CLI's own code path, `none` for a line without
   *  one, and `unknown` for a value that is not a short identifier, so a diagnostic record never holds line text. */
  readonly source: string;
}

/**
 * The request that a line of the CLI's `--debug-to-stderr` output announces, or undefined for any other line. CLI
 * 2.1.293 writes `[API REQUEST] <path> source=<caller>` at debug level before it dispatches each API request,
 * including the requests it decides by itself, so the model lines are the bridge's count of what the CLI sent. The
 * line names no request id, so it attributes no answer (`service-requests.ts` does).
 */
export function announcedRequest(line: string): AnnouncedRequest | undefined {
  const announced = /\[DEBUG\] \[API REQUEST\] (\/\S*)(?: (.*))?$/u.exec(line);
  if (announced === null) return undefined;
  const source = /(?:^| )source=(\S+)/u.exec(announced[2] ?? "")?.[1];
  const caller = source === undefined ? "none" : /^[\w.:-]{1,64}$/u.test(source) ? source : "unknown";
  return { model: announced[1] === "/v1/messages", source: caller };
}


/** The SSE error event that ended a stream, as the line that the CLI writes for it states it, or undefined for any
 *  other line. With its non-streaming fallback off, the CLI writes `[ERROR] Error streaming (non-streaming fallback
 *  disabled): <event>` and ends the turn. The event is content: it goes into the request's failure and never into a
 *  record. */
function streamErrorLine(line: string): string | undefined {
  return /\[ERROR\] Error streaming(?: \([^)]*\))?: (\{.*\})$/u.exec(line)?.[1];
}

/** One HTTP response that the CLI's internal Anthropic client logged at `ANTHROPIC_LOG=debug`. */
interface LoggedResponse {
  readonly status: number;
  /** Only the headers in `KEPT_HEADERS`. */
  readonly headers: Headers;
}

/** The response headers that the native Anthropic classification reads (`classifyAnthropicError` and
 *  `classifyProviderFailure`): the request id, the retry delays, and the retry advice. The unified limit status tells
 *  the bridge that a 429 is the account's spent allowance, which the CLI reports itself. Every other header stays out. */
const KEPT_HEADERS: ReadonlySet<string> = new Set(["request-id", "retry-after", "retry-after-ms", "x-should-retry", "anthropic-ratelimit-unified-status"]);

/** One request that the CLI's internal Anthropic client logged at `ANTHROPIC_LOG=debug`, as its `sending request` block
 *  states it. The block shows the messages, the system blocks, and the tools as `[Array ...]` and the authorization as
 *  `***`, so the reader keeps no content and no secret: only the request's path, its model, the names of the body
 *  fields that it sends, and its exact `anthropic-beta` header. */
export interface SentRequest {
  /** The path without its query, such as `/v1/messages`. */
  readonly path: string;
  readonly model: string | undefined;
  /** The body fields with a value, in the order of the body. A field whose value is `undefined` is not sent. */
  readonly fields: readonly string[];
  /** The `anthropic-beta` header, or undefined when the request sends none. */
  readonly betas: readonly string[] | undefined;
}

/** The first line of the block that the internal client writes for each response: `response start` for a stream that
 *  began, `response error` for an HTTP error (CLI 2.1.296). */
const RESPONSE_BLOCK = /^\[Anthropic SDK DEBUG\] \[(log_\w+)\] response (?:start|error)\b.*\{$/u;
/** The first line of the block that the internal client writes before it sends each request (CLI 2.1.296). */
const REQUEST_BLOCK = /^\[Anthropic SDK DEBUG\] \[(log_\w+)\] sending request \{$/u;
/** The line that the internal client writes when a response arrives, before its response block (CLI 2.1.306). The
 *  request id is missing when the response names none. */
const STATUS_LINE = /^\[Anthropic SDK INFO\] \[(log_\w+)(?:, request-id: "([^"]*)")?\] \w+ \S+ (?:succeeded|failed) with status (\d{3})\b/u;
const STATUS_FIELD = /^ {2}status: (\d{3}),$/u;
const HEADER_FIELD = /^ {4}(?:"([^"]+)"|([A-Za-z][\w-]*)): "((?:[^"\\]|\\.)*)",$/u;
const PATH_FIELD = /^ {4}path: "([^"?]*)(?:\?[^"]*)?",$/u;
const BODY_FIELD = /^ {6}([A-Za-z_]\w*): (.*),$/u;
const BETA_HEADER = /^ {4}"anthropic-beta": "([^"]*)",$/u;
/** The header with which the engine names the hosted agent that sends a request (CLI 2.1.306). A request of the
 *  engine's main loop sends none. */
const AGENT_HEADER = /^ {4}"x-claude-code-agent-id": "([^"]*)",$/u;
/** A response block holds about 20 lines and a request block about 50. A longer one is not the format that this reader
 *  knows. */
const MAX_BLOCK_LINES = 64;

/** What one line of the CLI's `--debug-to-stderr` output tells the bridge, by the readers above. Every line that the
 *  internal client writes names the client's own id of the request (`logId`), which no other request of the engine
 *  holds while it is open. */
export type DebugLine =
  | { readonly kind: "request-line"; readonly request: AnnouncedRequest }
  /** `agent` is the hosted agent that sent the request, undefined for the engine's main loop. */
  | { readonly kind: "request-sent"; readonly logId: string; readonly agent: string | undefined; readonly request: SentRequest }
  /** A request block that ended without a path that the reader could read. */
  | { readonly kind: "request-unread"; readonly logId: string }
  | { readonly kind: "status-line"; readonly logId: string; readonly status: number; readonly requestId: string | undefined }
  | { readonly kind: "api-error"; readonly response: ApiErrorLine }
  | { readonly kind: "stream-error"; readonly body: string }
  | { readonly kind: "response"; readonly logId: string; readonly response: LoggedResponse }
  /** A response block that ended without a status that the reader could read. */
  | { readonly kind: "response-unread"; readonly logId: string }
  | { readonly kind: "stderr"; readonly signal: StderrSignal };

/** The block that the reader holds open: a response, or a request with the section of it that the reader is in. */
type OpenBlock =
  | { readonly kind: "response"; readonly logId: string; status: number | undefined; readonly headers: Headers; lines: number }
  | {
    readonly kind: "request"; readonly logId: string; path: string | undefined; model: string | undefined; agent: string | undefined; readonly fields: string[]; betas: string[] | undefined;
    inBody: boolean; lines: number;
  };

/**
 * Reads the debug output of one CLI, line by line, and hands `onLine` what each line tells the bridge. A request or a
 * response block spans several lines, so the reader keeps the open block. The format is the internal client's debug
 * format, not a public contract: the reader fails closed, and a block that it cannot read, that a line outside it
 * interrupts, or that grows past `MAX_BLOCK_LINES` ends as `request-unread` or `response-unread`.
 */
export function debugLineReader(onLine: (line: DebugLine) => void): (line: string) => void {
  let block: OpenBlock | undefined;
  return (line) => {
    if (block !== undefined) {
      if (line === "}") {
        onLine(closedBlock(block));
        block = undefined;
        return;
      }
      if (/^\s/u.test(line) && block.lines < MAX_BLOCK_LINES) {
        block.lines += 1;
        return block.kind === "response" ? readResponseField(block, line) : readRequestField(block, line);
      }
      onLine({ kind: block.kind === "response" ? "response-unread" : "request-unread", logId: block.logId });
      block = undefined;
    }
    const response = RESPONSE_BLOCK.exec(line)?.[1];
    if (response !== undefined) {
      block = { kind: "response", logId: response, status: undefined, headers: new Headers(), lines: 0 };
      return;
    }
    const request = REQUEST_BLOCK.exec(line)?.[1];
    if (request !== undefined) {
      block = { kind: "request", logId: request, path: undefined, model: undefined, agent: undefined, fields: [], betas: undefined, inBody: false, lines: 0 };
      return;
    }
    const sorted = debugLine(line);
    if (sorted !== undefined) onLine(sorted);
  };
}

function closedBlock(block: OpenBlock): DebugLine {
  const { logId } = block;
  if (block.kind === "response") return block.status === undefined ? { kind: "response-unread", logId } : { kind: "response", logId, response: { status: block.status, headers: block.headers } };
  return block.path === undefined ? { kind: "request-unread", logId }
    : { kind: "request-sent", logId, agent: block.agent, request: { path: block.path, model: block.model, fields: block.fields, betas: block.betas } };
}

function readResponseField(block: Extract<OpenBlock, { kind: "response" }>, line: string): void {
  const status = STATUS_FIELD.exec(line)?.[1];
  if (status !== undefined) {
    block.status = Number(status);
    return;
  }
  const header = HEADER_FIELD.exec(line);
  const name = (header?.[1] ?? header?.[2])?.toLowerCase();
  if (header === null || name === undefined || !KEPT_HEADERS.has(name)) return;
  block.headers.set(name, unquoted(header[3] ?? ""));
}

/** Reads the path, the body's field names and its model, and the beta header. Every other line, such as the
 *  authorization header, is skipped unread. */
function readRequestField(block: Extract<OpenBlock, { kind: "request" }>, line: string): void {
  if (line === "    body: {") {
    block.inBody = true;
    return;
  }
  if (block.inBody) {
    if (line === "    },") {
      block.inBody = false;
      return;
    }
    const field = BODY_FIELD.exec(line);
    if (field === null || field[2] === "undefined") return;
    const [, name = "", value = ""] = field;
    block.fields.push(name);
    if (name === "model" && value.startsWith('"')) block.model = unquoted(value.slice(1, -1));
    return;
  }
  const path = PATH_FIELD.exec(line)?.[1];
  if (path !== undefined) {
    block.path = path;
    return;
  }
  const betas = BETA_HEADER.exec(line)?.[1];
  if (betas !== undefined) {
    block.betas = betas.split(",").filter((beta) => beta.length > 0);
    return;
  }
  const agent = AGENT_HEADER.exec(line)?.[1];
  if (agent !== undefined) block.agent = agent;
}

/** A header value as the debug format quotes it: a JSON string body. */
function unquoted(value: string): string {
  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** Sorts one line that is not part of a response block, or returns undefined for a line that tells the bridge nothing. */
function debugLine(line: string): DebugLine | undefined {
  const request = announcedRequest(line);
  if (request !== undefined) return { kind: "request-line", request };
  const status = STATUS_LINE.exec(line);
  if (status !== null) return { kind: "status-line", logId: status[1] ?? "", status: Number(status[3]), requestId: status[2] };
  const response = apiErrorLine(line);
  if (response !== undefined) return { kind: "api-error", response };
  const body = streamErrorLine(line);
  if (body !== undefined) return { kind: "stream-error", body };
  const signal = classifyStderrLine(line);
  return signal === undefined ? undefined : { kind: "stderr", signal };
}

/** One `[API REQUEST]` line of a model request of a query's CLI, as the bridge's actor read it. */
export interface RequestLine {
  /** The CLI caller that the line names, as `announcedRequest` returns it. */
  readonly source: string;
  /** The bridge phase when the actor read the line, or `stopped` after the query stopped. */
  readonly arrivedIn: string;
  /** The stop reason of the last admitted request, when the actor read it before the line. */
  readonly endedWith: string | undefined;
}

/** What the bridge keeps of a stopped query to account for its CLI's late model requests. */
export interface StoppedQuery {
  readonly id: number;
  readonly sessionId: string;
  /** The model requests that the CLI announced, before and after the stop. */
  readonly lines: RequestLine[];
  /** The requests that Flywheel admitted or that the bridge recorded as hidden. */
  accounted: number;
  /** The stop reason of the last admitted request, when the actor read it before the stop. */
  readonly endedWith: string | undefined;
}

/**
 * Bridge rule 4 after a stop. The step gate refuses every step that the CLI starts by itself, but a resend inside one
 * step does not pass the gate, and the CLI can send one before the interrupt reaches it. The stream then shows nothing
 * of that request, but the CLI's debug output announces it, so the bridge records each announced request that
 * Flywheel did not admit. Each record states the line's caller, the phase in which the actor read it, and whether the
 * actor had read the last admitted request's stop reason before it: stderr and the SDK stream are separate pipes, so
 * a line that the CLI wrote after a stop reason can arrive before it. Returns the caller of each request that it recorded.
 */
export function recordLateRequests(stopped: StoppedQuery): readonly string[] {
  const recorded: string[] = [];
  for (; stopped.accounted < stopped.lines.length; stopped.accounted += 1) {
    const line = stopped.lines[stopped.accounted];
    if (line === undefined) break;
    DebugLog.record({ type: "provider.claude_sdk.request.hidden", payload: {
      sessionId: stopped.sessionId, tag: "api-request", phase: "stopped", announcedBy: "api-request-line", source: line.source, arrivedIn: line.arrivedIn,
      ...stopReasonOrder(line.endedWith),
    } });
    recorded.push(line.source);
  }
  return recorded;
}

/** The announced request lines of one query, counted by the caller that each line names. */
export function countBySource(lines: readonly RequestLine[]) {
  const counts = new Map<string, number>();
  for (const { source } of lines) counts.set(source, (counts.get(source) ?? 0) + 1);
  return Object.fromEntries(counts);
}

/** Where an announcement falls relative to the last admitted request's stop reason, for a hidden-request record. */
export function stopReasonOrder(endedWith: string | undefined) {
  return endedWith === undefined ? { afterStopReason: false } : { afterStopReason: true, lastStopReason: endedWith };
}

/** What a silence check reads of one query: its CLI version, once the CLI stated it, the model requests that the
 *  bridge admitted, and the model requests that the debug output announced. */
interface QueryAnnouncements {
  readonly sessionId: string;
  readonly cliVersion: string | undefined;
  readonly admitted: number;
  readonly requestLines: readonly RequestLine[];
}

/** The CLI versions whose debug output went silent, as one process learned them. */
export interface SilentVersions {
  /**
   * Returns the query's CLI version when that version's debug output is silent. A query that admitted model requests
   * while its output announced none of them proves its version silent: the version joins the set, which records it
   * once (`provider.claude_sdk.debug_output.silent`). The CLI announces each request before it sends it, so a check at
   * a query's stop, or before a later request of the query, finds the announcement of every admitted request.
   */
  check(query: QueryAnnouncements): string | undefined;
  /** Marks `cliVersion` silent because an engine's service-request records do not account for a request, as `rule`
   *  names (`service-requests.ts`). The set records the version once, by whichever check found it first. */
  drifted(sessionId: string, cliVersion: string, rule: EngineDrift): void;
  /** Whether a check found `cliVersion` silent, so that it serves nothing more. */
  has(cliVersion: string): boolean;
}

/** How an engine's debug output failed to account for a request: a hosted request block without its agent header, a
 *  hosted agent's failed step that no complete record answers, or an error body that joins no record. */
export type EngineDrift = "agent-header-missing" | "record-incomplete" | "body-unjoined";

/** Builds the set. The provider client keeps one for the process, so no bridge or host serves a request on a version
 *  that another found silent; a test gives each case its own. */
export function silentVersions(known = new Set<string>()): SilentVersions {
  return {
    check({ sessionId, cliVersion, admitted, requestLines }) {
      if (cliVersion === undefined || known.has(cliVersion)) return cliVersion;
      if (admitted === 0 || requestLines.length > 0) return undefined;
      known.add(cliVersion);
      DebugLog.record({ type: "provider.claude_sdk.debug_output.silent", payload: { sessionId, cliVersion, requests: admitted } });
      return cliVersion;
    },
    drifted(sessionId, cliVersion, rule) {
      if (known.has(cliVersion)) return;
      known.add(cliVersion);
      DebugLog.record({ type: "provider.claude_sdk.debug_output.silent", payload: { sessionId, cliVersion, rule } });
    },
    has: (cliVersion) => known.has(cliVersion),
  };
}

/**
 * The failure of a request on a CLI version whose debug output Flywheel cannot read: a chat query admitted model
 * requests while the output announced none of them, or a hosted agent's request left no record that names its agent
 * and its answer (`service-requests.ts`). The readers above match undocumented lines, so a CLI update that changes its
 * logger removes their signals: a resend that the CLI sends by itself after an HTTP 400 would then reach the person as
 * a normal answer, and a failure could reach the wrong agent. The engine ships with Flywheel, so its version stays the
 * same until the next Flywheel release, and the request fails as a validation error, which no retry or failover
 * repeats.
 */
export function silentDebugOutputFailure(cliVersion: string): ProviderRequestValidationError {
  return new ProviderRequestValidationError(CLAUDE_AGENT_SDK_LABEL, `The Claude engine ${cliVersion} wrote debug output that does not account for the model requests that Flywheel sent through it. `
    + "Flywheel finds the requests that the engine sends by itself, and the service's answer to each request, only through the engine's debug output, so it serves no request on this engine. "
    + "Update Flywheel, or use another provider until a release fixes it.");
}
