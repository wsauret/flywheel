import Anthropic from "@anthropic-ai/sdk";
import type { SDKAssistantMessageError, SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Cause, Effect, Exit } from "effect";
import type { AccessProviderAccessOutcome } from "../../../infra/llm/access-provider.js";
import { ContextLengthExceededError, extendedContextRefusal, LlmStreamError, ModelAccessRefusedError, QuotaExhaustedError, StreamIdleTimeoutError } from "../../agent-runtime/llm/errors.js";
import type { QuotaExhaustionObservation } from "../../agent-runtime/llm/provider-availability-types.js";
import { ProviderAuthenticationError } from "../../agent-runtime/llm/provider-failure.js";
import { eventUsageWindows, type UsageWindows } from "./account-usage.js";
import type { ReplayAcks } from "./in-place.js";
import { CLAUDE_AGENT_SDK_LOGIN_COMMAND } from "./names.js";
import { isUsageLimitText } from "./query-launcher.js";
import { wireFailure, type WireFailure } from "./service-requests.js";
import type { StderrSignal } from "./stderr-signals.js";

/** An assistant message that carries the CLI's error for the current request. */
export interface CliErrorReport {
  readonly error: SDKAssistantMessageError;
  /** The CLI's error text, such as "API Error: Stream idle timeout - no chunks received". */
  readonly text: string;
}

/** The `result` that ends one CLI turn. */
export interface CliTurnResult {
  readonly isError: boolean;
  /** The HTTP status of the failed request, when the CLI received one. */
  readonly status: number | null;
  readonly terminalReason: string | undefined;
  readonly text: string;
  /** The user message that started the turn, as the bridge named it. The answer to a replayed row names that row. */
  readonly userMessageUuid: string | undefined;
}

/** One SDK message, sorted into the input that the bridge's pump reads. */
export type SdkInput =
  /** A stream event of the main conversation, for the request that the bridge admitted. */
  | { readonly kind: "event"; readonly event: BetaRawMessageStreamEvent }
  /** The CLI's heartbeat while bytes arrive. Native drops pings too, so the stall watchdog never sees one (rule 8). */
  | { readonly kind: "ping" }
  /** The CLI starts a turn. `plugins` names each plugin that the CLI loaded. `perTurnEffort` states whether the CLI also
   *  sends the request's effort inside the conversation, at the newest message, for its model: undefined when the CLI
   *  does not state it. */
  | { readonly kind: "init"; readonly sessionId: string; readonly cliVersion: string; readonly plugins: readonly string[]; readonly perTurnEffort: boolean | undefined }
  /** The CLI stopped sending the effort inside the conversation, as after a refusal of it. */
  | { readonly kind: "per-turn-effort"; readonly active: boolean }
  | { readonly kind: "cli-error"; readonly report: CliErrorReport }
  /** The service refused the response, and no fallback model takes it. The stream still brings the refusal stop
   *  reason after the CLI's error report of it (CLI 2.1.295). */
  | { readonly kind: "refusal" }
  | { readonly kind: "turn-result"; readonly result: CliTurnResult }
  /** The CLI's usage report after a response. `windows` holds the account's plan windows when the report names them. */
  | { readonly kind: "rate-limit"; readonly info: RateLimitReport; readonly billing: ResponseBilling; readonly windows?: UsageWindows }
  /** Everything the bridge reads elsewhere or not at all: per-block assistant copies, user echoes, status. */
  | { readonly kind: "ignored" };

/** The fields of the CLI's rate-limit event that the bridge reads. */
type RateLimitReport = Pick<SDKRateLimitInfo, "status" | "rateLimitType" | "utilization" | "resetsAt" | "overageStatus" | "isUsingOverage" | "overageInUse">;

/**
 * What one rate-limit event states about the response before it. The CLI reads the service's usage headers when a
 * response ends and emits the event only when its reading changes, and always after the first response of its
 * process (CLI 2.1.295). `extra-usage`: the account served the response from Claude extra usage. The CLI sets
 * `isUsingOverage` when a spent window's overflow goes to extra usage, `overageInUse` copies the service's own
 * overage-in-use header, and an `overage` window is extra usage itself. `included`: the event names a usage window
 * and no extra usage. `refused`: the event names no window and states `rejected`, as for a 429 without the service's
 * usage headers (CLI 2.1.296). The service refused the request, so the response spent no usage. `unconfirmed`: the
 * event names no window, as for a response without the service's usage headers, so nothing shows which usage served it.
 */
type ResponseBilling = "included" | "extra-usage" | "refused" | "unconfirmed";

function responseBilling(info: RateLimitReport): ResponseBilling {
  if (info.isUsingOverage === true || info.overageInUse === true || info.rateLimitType === "overage") return "extra-usage";
  if (info.rateLimitType !== undefined) return "included";
  return info.status === "rejected" ? "refused" : "unconfirmed";
}

/** Sorts one SDK message. Messages from a CLI subagent cannot occur, because the CLI declares no tools of its
 *  own, and they are ignored. */
export function classifySdkMessage(message: SDKMessage): SdkInput {
  switch (message.type) {
    case "stream_event": {
      if (message.parent_tool_use_id !== null) return { kind: "ignored" };
      // The CLI's heartbeat is outside the SDK's declared event union.
      return String(message.event.type) === "ping" ? { kind: "ping" } : { kind: "event", event: message.event };
    }
    case "assistant": {
      if (message.parent_tool_use_id !== null || message.error === undefined) return { kind: "ignored" };
      const text = message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      return { kind: "cli-error", report: { error: message.error, text } };
    }
    case "result":
      return {
        kind: "turn-result",
        result: message.subtype === "success"
          ? { isError: message.is_error, status: message.api_error_status ?? null, terminalReason: message.terminal_reason, text: message.result, userMessageUuid: message.user_message_uuid }
          : { isError: true, status: null, terminalReason: message.terminal_reason, text: message.errors.join("\n"), userMessageUuid: message.user_message_uuid },
      };
    case "system":
      if (message.subtype === "init") {
        return { kind: "init", sessionId: message.session_id, cliVersion: message.claude_code_version, plugins: message.plugins.map(({ name }) => name), perTurnEffort: perTurnEffortActive(message) };
      }
      // The SDK's declared subtypes omit the CLI's refusal notice and its per-turn effort change (CLI 2.1.296).
      if (String(message.subtype) === "per_turn_effort_changed") return { kind: "per-turn-effort", active: perTurnEffortActive(message) ?? false };
      return String(message.subtype) === "model_refusal_no_fallback" ? { kind: "refusal" } : { kind: "ignored" };
    case "rate_limit_event": {
      const { status, rateLimitType, utilization, resetsAt, overageStatus, isUsingOverage, overageInUse } = message.rate_limit_info;
      const info = { status, rateLimitType, utilization, resetsAt, overageStatus, isUsingOverage, overageInUse };
      const windows = eventUsageWindows(message.rate_limit_info);
      return { kind: "rate-limit", info, billing: responseBilling(info), ...(windows === undefined ? {} : { windows }) };
    }
    default:
      return { kind: "ignored" };
  }
}

/** The CLI's internal `per_turn_effort_active` field, which the SDK's declared types omit (CLI 2.1.296). */
function perTurnEffortActive(message: SDKMessage): boolean | undefined {
  const active = "per_turn_effort_active" in message ? message.per_turn_effort_active : undefined;
  return typeof active === "boolean" ? active : undefined;
}

/** The windows that spend one model's allowance only. The account key carries no model, so a reset of one of these
 *  windows never bounds the whole account: the mark falls back to the safe recheck, and the account's other models
 *  stay in service. */
const MODEL_WINDOWS: ReadonlySet<SDKRateLimitInfo["rateLimitType"]> = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);

/** When the account's whole allowance resets, in epoch ms, from one rate-limit event: the reset of a rejected window
 *  that covers every model on the account, else undefined. */
export function accountLimitResetAtMs(info: Pick<SDKRateLimitInfo, "status" | "rateLimitType" | "resetsAt">): number | undefined {
  if (info.status !== "rejected" || info.resetsAt === undefined || MODEL_WINDOWS.has(info.rateLimitType)) return undefined;
  return info.resetsAt * 1000;
}

/**
 * Reads one query's SDK messages until the stream ends and hands each one, sorted, to `onInput`. The turn result that
 * answers a replayed row settles its wait in `acks` and never reaches `onInput`. When the stream ends, fails, or the
 * reading fiber is interrupted, every open wait fails. The effect never fails: it succeeds with the stream's failure,
 * or with undefined when the stream ended.
 */
export function readSdkMessages(messages: AsyncIterable<SDKMessage>, acks: Pick<ReplayAcks, "settle" | "end">, onInput: (input: SdkInput) => void): Effect.Effect<unknown> {
  return Effect.gen(function* () {
    const iterator = messages[Symbol.asyncIterator]();
    while (true) {
      // The stream's own failure, such as the SDK's report that the CLI exited, names the cause; Effect's wrapper does not.
      const next = yield* Effect.tryPromise({ try: () => iterator.next(), catch: (error) => error });
      if (next.done === true) return;
      const input = readSdkMessage(next.value, acks);
      if (input !== undefined) onInput(input);
    }
  }).pipe(Effect.exit, Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)), Effect.ensuring(Effect.sync(() => { acks.end(); })));
}

/** One SDK message, sorted for the query's owner, or undefined for the turn result that answers a replayed row: that
 *  result settles its wait in `acks` and never reaches the owner. */
export function readSdkMessage(message: SDKMessage, acks: Pick<ReplayAcks, "settle">): SdkInput | undefined {
  const input = classifySdkMessage(message);
  return input.kind === "turn-result" && acks.settle(input.result.userMessageUuid) ? undefined : input;
}

/**
 * The error map. A request that the CLI ended with an error rejects the adapter's pending read with the error that
 * native Flywheel would raise, so the adapter's own classification, retry, and outage marks apply unchanged. The
 * bridge passes the assistant error and the turn result that follows it; either can be missing. A turn result that
 * is not an error states nothing about the failure: after a cut the step gate refuses the CLI's resume, and the CLI
 * then ends its turn as a success that holds the partial text. The stream decides that class, a transient cut.
 * `wire` is the service's own answer to the request when the CLI's debug output logged it and the bridge kept it for
 * the turn's end: then the failure is the native error of that answer, except where the CLI's text reports the
 * account's spent allowance or a refusal of one model, which the CLI reads from the service's usage headers.
 * A spent allowance is recorded at this boundary, as the ChatGPT adapter records its own at its transport: only
 * that class calls `markQuotaExhausted`, with the reset that the CLI's rejected rate-limit event named, and the
 * error carries the observation, so the walk records nothing a second time.
 */
export function cliFailure(report: CliErrorReport | undefined, turnResult: CliTurnResult | undefined, markQuotaExhausted: QuotaMark, resetsAtMs: number | undefined, wire?: WireFailure): Error {
  const result = turnResult?.isError === true ? turnResult : undefined;
  const text = report?.text || result?.text || "The Claude CLI ended the request without a stop reason";
  const status = result?.status ?? null;
  if (/Stream idle timeout/u.test(text)) return new StreamIdleTimeoutError(text, "idle");
  if (isUsageLimitText(text)) return quotaFailure(text, () => markQuotaExhausted(resetsAtMs));
  // The CLI states both refusals of one model only in its error kind and text: a 404 is `model_not_found`, and a
  // long-context refusal is a 429 `rate_limit` (its own `long_context_credits_required` does not reach the SDK).
  if (report?.error === "model_not_found") return new ModelAccessRefusedError(text, { kind: "model" });
  const refusal = extendedContextRefusal(text);
  if (refusal) return refusal;
  if (wire !== undefined) return wireFailure(wire);
  if (report?.error === "authentication_failed") return loginRefusal(text);
  // The CLI blocks locally near its model window and sends no request.
  if (result?.terminalReason === "blocking_limit" || result?.terminalReason === "prompt_too_long" || /prompt is too long/iu.test(text)) {
    return new ContextLengthExceededError(text);
  }
  // The CLI refuses an image above its own limit and sends no request. The service refuses such an image with a 400
  // (not verified live), so the request fails in the class that native Flywheel gets.
  if (result?.terminalReason === "image_error") return badRequest(text);
  if (status !== null) return Anthropic.APIError.generate(status, { type: "error", error: { type: errorType(report?.error), message: text } }, text, new Headers());
  return transportTimeout(text) ?? new LlmStreamError(text, "transient");
}

/** An access probe charges no account's quota row, so a spent allowance fails its classification instead. */
const probeQuotaMark: QuotaMark = () => {
  throw new Error("an access probe marks no quota");
};

/**
 * What one access probe's messages (`probeCliModel`) show about the model: a turn that ended without an error
 * completed; a refusal of the model itself, by the error map of every request (`cliFailure`), refused; anything else,
 * such as a login failure, a spent allowance, a rate limit, or a cut, is inconclusive. On a subscription login, a
 * probe that the account served from extra usage is inconclusive too, because a check never uses overage
 * (PI-MODEL-065). A `metered` login's reports state extra usage for every request (engine 2.1.296 on an
 * `enterprise_usage_based` seat), because that is its ordinary billing, so they decide nothing.
 */
export function probeOutcome(messages: readonly SDKMessage[], metered: boolean): AccessProviderAccessOutcome {
  let report: CliErrorReport | undefined;
  let result: CliTurnResult | undefined;
  for (const message of messages) {
    const input = classifySdkMessage(message);
    if (input.kind === "cli-error") report = input.report;
    else if (input.kind === "turn-result") result = input.result;
    else if (!metered && input.kind === "rate-limit" && input.billing === "extra-usage") return "inconclusive";
  }
  if (report === undefined && result !== undefined && !result.isError) return "completed";
  const failure = cliFailure(report, result, probeQuotaMark, undefined);
  return failure instanceof ModelAccessRefusedError && failure.refusal.kind === "model" ? "refused" : "inconclusive";
}

/**
 * The engine's own end of a request that got a response without an event, which carries no status, rebuilt as the
 * error that native's client raises for the same response (fake host, CLI 2.1.296 beside the native adapter). After
 * headers with no bytes both end with the Anthropic client's connection timeout ("Request timed out"), and after
 * bytes with no event both end with the runtime's fetch timeout ("The operation timed out."). The engine ends at
 * 360 s, native at 300 s. The shared classifier then gives both routes the same failure.
 */
function transportTimeout(text: string): Error | undefined {
  if (/Request timed out/u.test(text)) return new Anthropic.APIConnectionTimeoutError();
  return /The operation timed out/u.test(text) ? new DOMException("The operation timed out.", "TimeoutError") : undefined;
}

/** The CLI's refusal of its login without a response of the service, such as "Not logged in · Please run /login".
 *  Its advice names the CLI's own command, so Flywheel's login command replaces it. */
function loginRefusal(text: string): ProviderAuthenticationError {
  const reason = text.replace(/\s*·\s*Please run \/login\.?$/u, "").replace(/\.?$/u, ".");
  return new ProviderAuthenticationError(`${reason} Run: ${CLAUDE_AGENT_SDK_LOGIN_COMMAND}`);
}

/** Marks the account's allowance spent until `resetsAtMs`, or until the safe recheck when the CLI reported no reset
 *  (`ProviderAvailability.markQuotaExhausted` for the bridge's candidate). It throws `QuotaCoordinationError` when
 *  the account's row does not take the mark. */
export type QuotaMark = (resetsAtMs: number | undefined) => QuotaExhaustionObservation;

/** The quota error that carries the account's mark. A mark that the account's row does not take fails the request
 *  with that coordination error instead, as on native. */
export function quotaFailure(text: string, mark: () => QuotaExhaustionObservation): Error {
  try {
    return new QuotaExhaustedError(text, { quotaObservation: mark() });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The failure of an open request whose resend the CLI announced on stderr. The signal holds no CLI text. */
export function cliResendFailure(signal: StderrSignal): Error {
  const message = `The Claude CLI resent the request after a failure it did not report (${signal.tag})`;
  return signal.failure === "bad-request" ? badRequest(message) : new LlmStreamError(message, "transient");
}

function badRequest(message: string): Error {
  return Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message } }, message, new Headers());
}

function errorType(error: SDKAssistantMessageError | undefined): string {
  switch (error) {
    case "rate_limit": return "rate_limit_error";
    case "overloaded": return "overloaded_error";
    case "invalid_request": return "invalid_request_error";
    case "authentication_failed": return "authentication_error";
    case "server_error": return "api_error";
    default: return "error";
  }
}
