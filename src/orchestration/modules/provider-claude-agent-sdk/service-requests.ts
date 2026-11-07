import Anthropic from "@anthropic-ai/sdk";
import { DebugLog } from "../../../infra/debug-log.js";
import type { DebugLine } from "./stderr-signals.js";

/**
 * The service's own answer to a failed request, as the CLI's debug output states it: an HTTP error response with its
 * status and body, or the SSE error event that ended a stream, which has no status. `headers` are the response's
 * headers that the debug output kept (`LoggedResponse`), empty when it logged none. The body is content: it goes into
 * the request's failure and never into a record.
 */
export interface WireFailure {
  readonly status: number | undefined;
  readonly body: string;
  readonly headers: Headers;
}

/** The error that the native Anthropic client raises for the same answer: the HTTP status error that it builds from
 *  the response, or the error of an SSE `error` event that its stream reader throws. The shared adapter then
 *  classifies it once with `classifyAnthropicError`, as on the native route, with the same message, request id, and
 *  retry delay. */
export function wireFailure({ status, body, headers }: WireFailure): Error {
  const parsed = parsedBody(body);
  if (status !== undefined) return Anthropic.APIError.generate(status, parsed, parsed === undefined ? body : undefined, headers);
  return new Anthropic.APIError(undefined, parsed ?? body, undefined, headers, eventErrorType(parsed));
}

export function wireKind(wire: WireFailure): "http" | "stream" {
  return wire.status === undefined ? "stream" : "http";
}

/** One model or API request that an engine sent, as its debug output names it. */
interface ServiceRequest {
  /** The engine's internal client's id of the request (`[log_<id>]`). */
  readonly logId: string;
  /** The hosted agent that sent the request (`x-claude-code-agent-id`), or undefined for the engine's main loop: the
   *  chat query, or a host's dispatcher. */
  readonly agent: string | undefined;
  /** Whether the request goes to `/v1/messages`, the model endpoint. */
  readonly model: boolean;
}

/** What one debug line decided about the engine's requests. */
type ServiceRequestEvent =
  | { readonly kind: "opened"; readonly request: ServiceRequest }
  /** The service answered the request with a success, with its status; a model response then streams. */
  | { readonly kind: "succeeded"; readonly request: ServiceRequest; readonly status: number }
  /** The request's record is complete with the service's failure. */
  | { readonly kind: "failed"; readonly request: ServiceRequest; readonly wire: WireFailure }
  /** An error body that no record can take: the debug format is not the one that this reader knows. */
  | { readonly kind: "unjoinable" };

type RecordState =
  | { readonly kind: "sent" }
  /** A model response that streams. The record waits for the end of its stream, which the debug output does not
   *  state. Its owner retires it (`forget`, `retire`); a sender that has no such owner, the chat query, retires it
   *  when it sends its next model request, which it does only after the stream ended. */
  | { readonly kind: "streaming" }
  | { readonly kind: "awaiting-body" };

interface OpenRecord extends ServiceRequest {
  state: RecordState;
  status: number | undefined;
  requestId: string | undefined;
  headers: Headers;
  /** A response block for the record came that the reader could not read. */
  unread: boolean;
  /** A later model request of the same sender went out, such as the engine's non-streaming resend after a 404. The
   *  record then joins a body only by its request id, and it retires at the sender's next model request after that,
   *  so a sender keeps at most two records that no answer completed. */
  superseded: boolean;
}

type RequestLine = Extract<DebugLine, { kind: "request-sent" | "status-line" | "response" | "response-unread" | "api-error" | "stream-error" }>;

/**
 * The service requests of one engine, keyed by the internal client's log id (bridge rule 4; ARCH-CONTEXT-008). A
 * `sending request` block opens a record, attributed to the hosted agent that its `x-claude-code-agent-id` header
 * names, or to the engine's main loop when it names none. The record collects the status line (status and request id,
 * partial evidence that never closes it), the `response` or `response error` block (status, request id, and the
 * headers that classification reads, such as `Retry-After`), and, for an HTTP error, the service's body. A response
 * block that the reader cannot read leaves the record incomplete. The body line names no log id: it joins the record
 * whose request id equals the body's `request_id`, which the service sets equal to its `request-id` header, and
 * otherwise only the one record of the engine that awaits a body and that no later request of its sender passed. A
 * record states its failure once, when it is complete, and only then retires its log id. No answer is ever attributed
 * by the order in which requests were announced.
 */
export interface ServiceRequests {
  read(line: RequestLine): ServiceRequestEvent | undefined;
  /** The failure of record `logId` without the body that it awaits: the engine writes none for some answers that it
   *  throws on, such as a 400 `dlp_request_denied` (CLI 2.1.306). The failure holds the response's status, request id,
   *  and headers; the record retires. Undefined when the record does not await a body. */
  withoutBody(logId: string): WireFailure | undefined;
  /** Retires record `logId` when the debug output states no answer to it: no status line and no response block came.
   *  True when it retired. The engine writes no status for a request that a transport failure ended before the
   *  response headers, such as a connection that dropped, so such a record is complete evidence of that failure and
   *  not drift of the debug format. A response block that the reader could not read is an answer, so it stays. */
  unanswered(logId: string): boolean;
  /** Retires every record of sender `agent`, whatever evidence it still awaits: its owner reads none of them again. */
  retire(agent: string): void;
  /** Retires record `logId`, whatever evidence it still awaits: its owner reads it no more. */
  forget(logId: string): void;
}

export function serviceRequests(sessionId: string): ServiceRequests {
  const records = new Map<string, OpenRecord>();
  /** The open records of each sender, so a new request of a sender reads only that sender's records. */
  const bySender = new Map<string | undefined, Set<OpenRecord>>();
  let unreadRecorded = false;

  const remove = (record: OpenRecord) => {
    records.delete(record.logId);
    const own = bySender.get(record.agent);
    own?.delete(record);
    if (own?.size === 0) bySender.delete(record.agent);
  };

  const close = (record: OpenRecord, wire: WireFailure): ServiceRequestEvent => {
    remove(record);
    return { kind: "failed", request: { logId: record.logId, agent: record.agent, model: record.model }, wire };
  };

  /** The response's status is known: a failure awaits its body, a model response streams, and any other success is
   *  complete. */
  const answered = (record: OpenRecord): ServiceRequestEvent | undefined => {
    const { status } = record;
    if (status === undefined) return undefined;
    if (status >= 400) {
      record.state = { kind: "awaiting-body" };
      return undefined;
    }
    if (record.model) record.state = { kind: "streaming" };
    else remove(record);
    return { kind: "succeeded", request: { logId: record.logId, agent: record.agent, model: record.model }, status };
  };

  const inState = (kind: RecordState["kind"]) => [...records.values()].filter((record) => record.state.kind === kind);

  return {
    read(line) {
      switch (line.kind) {
        case "request-sent": {
          const model = line.request.path === "/v1/messages";
          const own = bySender.get(line.agent) ?? new Set<OpenRecord>();
          if (model) {
            for (const prior of own) {
              if (!prior.model) continue;
              if (prior.state.kind === "streaming" || prior.superseded) remove(prior);
              else prior.superseded = true;
            }
          }
          const request = { logId: line.logId, agent: line.agent, model };
          const record: OpenRecord = { ...request, state: { kind: "sent" }, status: undefined, requestId: undefined, headers: new Headers(), unread: false, superseded: false };
          records.set(line.logId, record);
          own.add(record);
          bySender.set(line.agent, own);
          return { kind: "opened", request };
        }
        case "status-line": {
          const record = records.get(line.logId);
          if (record === undefined || record.state.kind !== "sent") return undefined;
          record.status ??= line.status;
          record.requestId ??= line.requestId;
          return undefined;
        }
        case "response": {
          const record = records.get(line.logId);
          if (record === undefined || record.state.kind !== "sent") return undefined;
          record.status = line.response.status;
          record.headers = line.response.headers;
          record.requestId = line.response.headers.get("request-id") ?? record.requestId;
          return answered(record);
        }
        case "response-unread": {
          // The status line is partial evidence: without the block's headers, such as `Retry-After`, the record stays
          // incomplete, and its consumer treats it as output that it cannot read.
          const record = records.get(line.logId);
          if (record !== undefined) record.unread = true;
          if (!unreadRecorded) DebugLog.record({ type: "provider.claude_sdk.response_log.unread", payload: { sessionId } });
          unreadRecorded = true;
          return undefined;
        }
        case "api-error": {
          const { requestId, body } = line.response;
          const awaiting = inState("awaiting-body");
          const current = awaiting.filter((candidate) => !candidate.superseded);
          const only = current.length === 1 ? current[0] : undefined;
          const record = (requestId === undefined ? undefined : awaiting.find((candidate) => candidate.requestId === requestId))
            ?? (requestId === undefined || only?.requestId === undefined ? only : undefined);
          if (record === undefined) return { kind: "unjoinable" };
          return close(record, { status: record.status, body, headers: record.headers });
        }
        case "stream-error": {
          const streaming = inState("streaming");
          const record = streaming.length === 1 ? streaming[0] : undefined;
          if (record === undefined) {
            DebugLog.record({ type: "provider.claude_sdk.api_error.unattributed", payload: { sessionId, signal: "stream-error", streaming: streaming.length } });
            return undefined;
          }
          return close(record, { status: undefined, body: line.body, headers: record.headers });
        }
      }
    },
    withoutBody(logId) {
      const record = records.get(logId);
      if (record?.state.kind !== "awaiting-body") return undefined;
      remove(record);
      return { status: record.status, body: "", headers: record.headers };
    },
    unanswered(logId) {
      const record = records.get(logId);
      if (record?.state.kind !== "sent" || record.status !== undefined || record.unread) return false;
      remove(record);
      return true;
    },
    retire(agent) {
      for (const record of bySender.get(agent) ?? []) remove(record);
    },
    forget(logId) {
      const record = records.get(logId);
      if (record !== undefined) remove(record);
    },
  };
}

/**
 * The service's answers that the CLI does not end the request at: after a 401 or a 403 the CLI renews its login and
 * can send the request again, and after a 429 whose unified limit status is `rejected` it reports
 * the account's spent allowance with its reset, which the error map reads from its text. Every other answer ends the
 * request at once: the CLI resends a 400 at once through one of its recovery paths, and the stop records the resend as
 * hidden.
 */
export function decidedAtTurnEnd(wire: WireFailure): boolean {
  return wire.status === 401 || wire.status === 403 || (wire.status === 429 && wire.headers.get("anthropic-ratelimit-unified-status") === "rejected");
}

/** The JSON body of an error response, or undefined for text that is not JSON, as the native client reads it. */
function parsedBody(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The `error.type` of an SSE error event, which the Anthropic client's stream reader gives its error. */
function eventErrorType(body: unknown): Anthropic.ErrorType | undefined {
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
  return typeof type === "string" && isErrorType(type) ? type : undefined;
}

const ERROR_TYPES: ReadonlySet<string> = new Set<Anthropic.ErrorType>([
  "invalid_request_error", "authentication_error", "billing_error", "permission_error", "not_found_error", "rate_limit_error", "timeout_error", "api_error", "overloaded_error",
]);

function isErrorType(type: string): type is Anthropic.ErrorType {
  return ERROR_TYPES.has(type);
}
