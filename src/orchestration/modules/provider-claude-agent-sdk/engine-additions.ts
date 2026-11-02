import { DebugLog } from "../../../infra/debug-log.js";
import type { BlockOrigins } from "../../agent-runtime/llm/conversions/anthropic-messages.js";
import type { TransportContextFrame } from "../../agent-runtime/llm/types.js";
import type { ProviderTransportAddition, ProviderTransportContext, ProviderTransportHiddenRequest } from "../../session/provider-request-audit-types.js";
import { isReminder, type BridgeRequest, type CliView } from "./cli-view.js";
import type { SdkInput } from "./sdk-events.js";
import { stopReasonOrder, type DebugLine, type SentRequest } from "./stderr-signals.js";

/** The name under which the audit shows what the engine added. It names the transport, never the product. */
const ENGINE_IDENTITY = "claude-engine";

/**
 * What one bridge's engine stated for the audit, and the record of each admitted request that it builds from that
 * (ARCH-CONTEXT-008). The bridge feeds it every SDK input and debug line of its queries as the bridge reads them, and each
 * request that the engine sent by itself (bridge rule 4). A request that the engine sent by itself reaches the audit on
 * the record of the next request that the bridge admits, because a record cannot belong to a request that Flywheel
 * never made.
 */
export interface EngineAudit {
  /** An SDK input of query `query`: its init and a later change state whether the engine sends the effort per turn. */
  sdkInput(query: number, input: SdkInput): void;
  /** A debug line of query `query`: the first model request block after an admission is the admitted request's own,
   *  and a later query's block replaces it, as when the bridge sends the request again on a new query. */
  debugLine(query: number, line: DebugLine): void;
  /** A request that the engine sent by itself while query `sessionId` was live, recorded once in the debug log too. A
   *  message_start states its status and input tokens; a retry line states neither. */
  hidden(request: HiddenRequest): void;
  /** The model requests that a stopped query's engine announced and Flywheel did not admit, by caller. */
  late(callers: readonly string[]): void;
  /** The events of a request that the bridge admits now, followed by the record of what the engine added to it before
   *  their end or their failure. The record carries every hidden request since the previous admission. */
  recorded<Event>(prepared: BridgeRequest, view: CliView, events: AsyncIterable<Event>): AsyncIterable<Event | TransportContextFrame>;
}

/** What the bridge knows of a request that the engine sent by itself while a query was live. */
interface HiddenRequest {
  readonly sessionId: string;
  readonly tag: string;
  readonly phase: string;
  readonly announcedBy: "message_start" | "retry-line";
  readonly endedWith: string | undefined;
  readonly inputTokens: number | undefined;
}

/** What the engine stated during one query, which a later query's statement replaces. */
interface QueryStatement<Value> {
  readonly query: number;
  readonly value: Value;
}

/** The audit of one bridge. `accountEmail` reads the login's account email, which the engine adds as a reminder. */
export function createEngineAudit(accountEmail: () => string | undefined): EngineAudit {
  const hidden: ProviderTransportHiddenRequest[] = [];
  /** The newest query's statement of the per-turn effort. */
  let effort: QueryStatement<boolean | undefined> = { query: 0, value: undefined };
  /** The request block of the admitted request, undefined for a block that the reader could not read. */
  let sent: QueryStatement<SentRequest | undefined> | undefined;
  const record = (prepared: BridgeRequest, view: CliView, carried: readonly ProviderTransportHiddenRequest[]): TransportContextFrame => ({ type: "transport_context", context: engineAdditions({
    prepared, view, loginEmail: accountEmail() !== undefined, perTurnEffort: effort.value, sent: sent?.value,
  }, carried) });
  async function* recorded<Event>(prepared: BridgeRequest, view: CliView, carried: readonly ProviderTransportHiddenRequest[], events: AsyncIterable<Event>): AsyncIterable<Event | TransportContextFrame> {
    try {
      yield* events;
    } catch (error) {
      yield record(prepared, view, carried);
      throw error;
    }
    yield record(prepared, view, carried);
  }
  return {
    sdkInput(query, input) {
      if (input.kind === "init" && query >= effort.query) effort = { query, value: input.perTurnEffort };
      if (input.kind === "per-turn-effort" && query === effort.query) effort = { query, value: input.active };
    },
    debugLine(query, line) {
      if (line.kind !== "request-sent" && line.kind !== "request-unread") return;
      if (line.kind === "request-sent" && line.request.path !== "/v1/messages") return;
      if (sent === undefined || query > sent.query) sent = { query, value: line.kind === "request-sent" ? line.request : undefined };
    },
    hidden({ sessionId, tag, phase, announcedBy, endedWith, inputTokens }) {
      DebugLog.record({ type: "provider.claude_sdk.request.hidden", payload: {
        sessionId, tag, phase, announcedBy, ...stopReasonOrder(endedWith), ...(inputTokens === undefined ? {} : { inputTokens }),
      } });
      // A message_start is the service's streamed answer, so it states the status and the input tokens.
      hidden.push(inputTokens === undefined ? { source: `${announcedBy}:${tag}` } : { source: announcedBy, status: 200, inputTokens });
    },
    late(callers) {
      for (const caller of callers) hidden.push({ source: `api-request-line:${caller}` });
    },
    recorded(prepared, view, events) {
      // The engine can log the request before the adapter starts to read it, so the admission forgets the last block.
      sent = undefined;
      return recorded(prepared, view, hidden.splice(0), events);
    },
  };
}

/** The sections that the engine sends after the first message whether or not Flywheel's reminders hold them. */
const ENGINE_SECTIONS = ["environment", "model", "date"] as const;

/**
 * The message and block of the prepared request that the engine sends at wire message `wireMessage`, block
 * `wireBlock`, or undefined when the wire message is one that the engine adds (`PreparedBlockLocation`). The engine
 * sends its own section message after the first message (above, and probe d1). `cliView` removes each Flywheel
 * reminder from its user message, and the engine sends the reminders of one user message after the first as one
 * message after it (observed live: one or two reminders in prepared message 2 moved the tool results of prepared
 * message 4 to wire message 6). Reminders follow the tool results of their message, so block positions do not move.
 */
export function engineBlockLocation(prepared: BlockOrigins, wireMessage: number, wireBlock: number): { readonly message: number; readonly block: number } | undefined {
  if (wireMessage === 0) return { message: 0, block: wireBlock };
  let wire = 2;
  for (const [message, held] of prepared.entries()) {
    if (message === 0) continue;
    if (wire === wireMessage) return { message, block: wireBlock };
    wire += held.some(isReminder) ? 2 : 1;
  }
  return undefined;
}

/** What the bridge knows of one admitted request when it ends: what Flywheel prepared, how the bridge started the
 *  engine for it, and what the engine stated about it. */
interface EngineRequest {
  /** The request that the shared adapter prepared, which the audit records. */
  readonly prepared: BridgeRequest;
  readonly view: CliView;
  /** Whether the login names an account email. The engine of a Claude login then adds it as a `session_context`
   *  reminder to the first user message. */
  readonly loginEmail: boolean;
  /** Whether the engine sends the effort inside the conversation too, as its init frame states it; undefined when the
   *  engine did not state it. */
  readonly perTurnEffort: boolean | undefined;
  /** The request block that the engine's Anthropic client logged for the request; undefined when the bridge read none. */
  readonly sent: SentRequest | undefined;
}

/**
 * Builds the audit's record of what the engine added to one request (ARCH-CONTEXT-008). The record names each addition and
 * holds no content. The bridge reads part of it from the engine's own statements: the request block of its debug
 * output (the body fields and the exact beta header) and its init frame (the per-turn effort). The rest is the pinned
 * engine's fixed behavior for a Claude login with a custom system prompt (CLI 2.1.296, verified on a fake host): a
 * billing block and an identity block before Flywheel's system text, and its own copy of each Flywheel reminder at the
 * message that holds it. The engine always sends an environment, model, and date section in a system message after
 * the first message, and writes its own section for each one that Flywheel's first message does not hold. It sets
 * the effort on that system message too. A message position names the prepared request's message that the engine
 * attaches the addition to. Whatever the engine adds but does not state is named in `notRecorded`. `hidden` holds the
 * requests that the engine sent by itself since the previous admission.
 */
function engineAdditions(request: EngineRequest, hidden: readonly ProviderTransportHiddenRequest[]): ProviderTransportContext {
  const { view, sent } = request;
  const opening = new Set(view.reminders.flatMap(({ message, reminder }) => (message === 0 ? [reminder.kind] : [])));
  const additions: ProviderTransportAddition[] = [
    { part: "system", kind: "billing", at: 0 },
    { part: "system", kind: "identity", at: 1 },
    ...(request.loginEmail ? [{ part: "message", kind: "reminder:session-context", at: 0 } as const] : []),
    ...view.reminders.map(({ message, reminder }) => ({ part: "message", kind: `reminder:${reminder.kind}`, at: message } as const)),
    ...ENGINE_SECTIONS.filter((kind) => !opening.has(kind)).map((kind) => ({ part: "message", kind, at: 0 } as const)),
    ...(view.identity.effort !== undefined && request.perTurnEffort === true ? [{ part: "message", kind: "output_config.effort", at: 0, value: view.identity.effort } as const] : []),
    ...(view.identity.promptCaching ? [{ part: "body", kind: "cache_control", value: "engine-placed" } as const] : []),
    ...sentAdditions(request.prepared, sent),
  ];
  const notRecorded = [
    // The request block shows the system blocks and messages only as `[Array ...]`, so the engine's marks go uncounted.
    ...(view.identity.promptCaching ? ["cache_control count"] : []),
    ...(view.identity.effort !== undefined && request.perTurnEffort === undefined ? ["output_config.effort per turn"] : []),
    ...(sent === undefined ? ["body fields", "anthropic-beta"] : sent.betas === undefined ? ["anthropic-beta"] : []),
  ];
  return { identity: ENGINE_IDENTITY, additions, hiddenRequests: [...hidden], notRecorded };
}

/** The body fields that the engine sent beyond the prepared request's, a model other than the prepared one, and the
 *  exact beta header, as its request block states them. */
function sentAdditions(prepared: BridgeRequest, sent: SentRequest | undefined): ProviderTransportAddition[] {
  if (sent === undefined) return [];
  const preparedFields = new Set(Object.entries(prepared).flatMap(([field, value]) => (value === undefined ? [] : [field])));
  return [
    ...sent.fields.filter((field) => !preparedFields.has(field)).map((field) => ({ part: "body", kind: field } as const)),
    ...(sent.model !== undefined && sent.model !== prepared.model ? [{ part: "body", kind: "model", value: sent.model } as const] : []),
    ...(sent.betas === undefined ? [] : [{ part: "header", kind: "anthropic-beta", value: sent.betas.join(",") } as const]),
  ];
}
