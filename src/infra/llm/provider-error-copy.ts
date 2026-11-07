/**
 * The single home for humanizing model-provider `api_error` messages.
 *
 * `classifyApiError` is total: every provider error message maps to structured
 * copy - a short title, a standalone problem statement, chat-surface guidance
 * naming the exit, an optional provider detail, and an optional command
 * action. Classification order matters - auth before billing before
 * throttling - because providers reuse status codes across categories (429 is
 * both "slow down" and "out of quota"). Unrecognized messages fall back to a
 * generic title with the detail extracted from the raw payload (nested JSON
 * error messages, HTML titles). A display bounds that detail with
 * `boundProviderDetail`; durable records keep it whole. Raw payloads
 * remain available in the event store and logs.
 *
 * Two composition registers share the copy: `providerErrorProse` is the terse
 * neutral form for surfaces that embed the failure in a larger sentence
 * ("Subagent 'x' failed: <prose>") and deliberately omits `guidance`, which
 * instructs the chat user ("send a message to retry") and would be wrong
 * advice inside an agent-facing notification.
 *
 * Lives in `infra/llm` next to `auth-error.ts`, whose detector is shared with
 * the tool-error laundering paths in `infra/output`.
 */

import { isRecord } from "../record.js";
import type { PresentationChannel, PresentationIdOn } from "../error-presentation.js";
import { AUTH_ERROR_TITLE, authErrorCopy, type ProviderIdentity } from "./auth-error.js";
import { redactSecrets } from "../redact-secrets.js";

interface ProviderErrorAction {
  label: string;
  command: string;
}

export interface ProviderErrorCopy {
  /** The registered presentation family this failure belongs to. The one
   *  channel it renders on derives from the registry in
   *  `infra/error-presentation.ts`; publishers route on that and never
   *  hand-pick a surface. Terminal copy is never in-flight progress, so the
   *  status channel is excluded by construction. */
  presentation: PresentationIdOn<Exclude<PresentationChannel, "status">>;
  /** Short Title Case headline: "Out of credits", "Rate limited". */
  title: string;
  /** Standalone problem statement. No instructions; safe in any register. */
  message: string;
  /** The chat user's next step ("Add credits ... then send a message to
   *  retry."). Chat surfaces only; embedded registers omit it. */
  guidance?: string;
  /** Raw provider detail, extracted and whole. A display bounds it with `boundProviderDetail`. */
  detail?: string;
  /** The one command affordance for this failure class. */
  action?: ProviderErrorAction;
}

const BANKED_RESET_HINT = "This account has a banked reset that you can apply in Usage (/usage).";
const SWITCH_MODELS_ACTION: ProviderErrorAction = { label: "Switch models", command: "/model" };
const MANAGE_AUTH_ACTION: ProviderErrorAction = { label: "Manage credentials", command: "/auth" };

export type ProviderUnavailableCause = "quota" | "rate_limit" | "server_error" | "overload" | "connection" | "stall" | "unavailable" | "route_unavailable" | "ineligible" | "model_access" | "extended_context";

/** Causes that only a person clears: what an account grants, and a route whose program is missing or unusable on
 *  this machine. Waiting does not change them, so they carry no reset bound. */
const PERSON_CAUSES: ReadonlySet<ProviderUnavailableCause> = new Set(["route_unavailable", "ineligible", "model_access", "extended_context"]);

/** Whether waiting can clear `cause`, so that it has a time at which a request can check it again. */
export function waitingClears(cause: ProviderUnavailableCause): boolean {
  return !PERSON_CAUSES.has(cause);
}

const UNAVAILABLE_COPY = { presentation: "provider.unavailable", title: "Provider unavailable", message: "No configured provider can serve this model right now." } as const;

const EXHAUSTED_COPY = {
  quota: { presentation: "provider.out_of_credits", title: "Out of credits", message: "The eligible provider accounts for this model are out of quota or credits." },
  rate_limit: { presentation: "provider.rate_limited", title: "Rate limited", message: "The model providers throttled this request. This is not exhausted quota or credits." },
  server_error: { presentation: "provider.server_error", title: "Provider server error", message: "The model providers reported temporary server errors." },
  overload: { presentation: "provider.overloaded", title: "Provider overloaded", message: "The model providers reported overload." },
  connection: { presentation: "provider.connection_lost", title: "Connection lost", message: "The connections to the model providers failed. This does not establish a provider outage." },
  stall: { presentation: "provider.connection_lost", title: "Model response stalled", message: "The models stopped sending progress while composing their responses." },
  unavailable: UNAVAILABLE_COPY,
  route_unavailable: UNAVAILABLE_COPY,
  ineligible: { presentation: "provider.unavailable", title: "No eligible provider", message: "None of the configured providers was eligible for this request." },
  model_access: { presentation: "provider.unavailable", title: "Model not available", message: "The provider accounts for this model do not grant it." },
  extended_context: { presentation: "provider.unavailable", title: "Extended context not available", message: "The provider accounts for this model do not grant its extended context window. Flywheel uses the standard window for the next request." },
} as const satisfies { [Cause in ProviderUnavailableCause]: ProviderErrorCopy };

/** What a later request can do after no candidate served one: run once
 *  `atMs` passes, when every candidate that waiting can help states when it
 *  can serve again; run again with no known time; or nothing, when only
 *  causes that a person clears refused it. */
export type ProviderRecovery =
  | { readonly kind: "at"; readonly atMs: number }
  | { readonly kind: "retry" }
  | { readonly kind: "none" };

/** The recovery of a request that every candidate refused. The earliest
 *  bound is the moment at which a request can recheck a candidate, which is
 *  the bound the copy states. An extended context refusal is retryable,
 *  because the next request uses the standard window. */
export function exhaustedProvidersRecovery(candidates: readonly { readonly cause: ProviderUnavailableCause; readonly resetsAtMs: number | undefined }[]): ProviderRecovery {
  const retryable = candidates.filter((candidate) => waitingClears(candidate.cause));
  const bounds = retryable.flatMap((candidate) => candidate.resetsAtMs === undefined ? [] : [candidate.resetsAtMs]);
  if (bounds.length > 0 && bounds.length === retryable.length) return { kind: "at", atMs: Math.min(...bounds) };
  if (retryable.length > 0 || candidates.some((candidate) => candidate.cause === "extended_context")) return { kind: "retry" };
  return { kind: "none" };
}

/** Renders request-local evidence after routing ends. Causes and hold bounds
 * come from routing owners, never from parsing the aggregate's prose.
 * Admission skips retain their detail without becoming dispatched failures.
 * `bankedReset` marks a candidate whose account holds a banked reset. Only a
 * quota refusal names it, in that candidate's own line, which every register
 * renders, and the line never predicts whether the reset lets the request run. */
export function exhaustedProvidersCopy(candidates: readonly {
  readonly provider: string;
  readonly cause: ProviderUnavailableCause;
  readonly detail: string;
  readonly resetsAtMs: number | undefined;
  readonly bankedReset?: boolean;
}[]): ProviderErrorCopy {
  const causes = new Set(candidates.map((candidate) => candidate.cause).filter((cause) => cause !== "ineligible"));
  const [firstCause] = causes;
  const cause = causes.size > 1 ? undefined : firstCause ?? "ineligible";
  const base: ProviderErrorCopy = cause === undefined
    ? { presentation: "provider.unavailable", title: "Providers unavailable", message: "The configured providers cannot serve this model for different reasons." }
    : EXHAUSTED_COPY[cause];
  const bounds = candidates.flatMap((candidate) => candidate.resetsAtMs === undefined ? [] : [candidate.resetsAtMs]);
  const bound = bounds.length === 0 ? undefined : new Date(Math.min(...bounds)).toLocaleString();
  const recovery = exhaustedProvidersRecovery(candidates);
  const waitBound = recovery.kind === "at" ? new Date(recovery.atMs).toLocaleString() : undefined;
  const skipped = cause !== "ineligible" && candidates.some((candidate) => candidate.cause === "ineligible")
    ? " Other candidates could not be used for this request."
    : "";
  return {
    ...base,
    message: `${base.message}${skipped}${waitBound !== undefined
      ? ` A request after ${waitBound} can recheck provider availability.`
      : bound === undefined ? "" : ` Some candidates have a reset or recheck bound at ${bound}.`}`,
    guidance: exhaustedGuidance(cause, waitBound !== undefined),
    detail: [...new Set(candidates.map((candidate) =>
      `${redactSecrets(candidate.provider)}: ${EXHAUSTED_COPY[candidate.cause].title}. ${candidate.cause === "quota" && candidate.bankedReset === true ? `${BANKED_RESET_HINT} ` : ""}${extractProviderErrorDetail(redactSecrets(candidate.detail))}`
    ))].join(" "),
    action: SWITCH_MODELS_ACTION,
  };
}

/** The chat user's next step after no candidate served the request for `cause`, or for different causes. */
function exhaustedGuidance(cause: ProviderUnavailableCause | undefined, waitBound: boolean): string {
  if (cause === "model_access") return "Switch models with /model, or add an account that grants this model with /auth.";
  if (cause === "extended_context") return "Send a message to continue in the standard context window, or switch models with /model.";
  if (waitBound) return "Wait until then and send a message to retry, or switch models with /model.";
  if (cause === "ineligible") return "Review the candidate reasons or switch models with /model, then send a message to retry.";
  return "Send a message to retry now, or switch models with /model.";
}

// The provider chain's all-candidates-exhausted terminal error. Recognized
// ahead of the generic billing patterns so the notice can say when capacity
// returns: the chain threads the earliest known reset into the message as an
// ISO instant, and this renderer localizes it.
const ALL_PROVIDERS_EXHAUSTED_RE = /no access provider can run/i;
const CAPACITY_RETURNS_AT_RE = /capacity returns at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/i;
const PROVIDER_OUTAGE_RE = /\bunreachable\b|rechecked after an outage/i;

// Account-level exhaustion: credits, quota, spend/usage limits. Checked before
// rate limiting because providers deliver these as 429s too, and the remedy is
// the opposite (pay or switch, not wait). Everything the chain's
// classifyQuotaError reads as terminal must match here, or a terminal
// exhaustion renders with wait-and-retry copy; the coherence test in
// quota-vocabulary-coherence.test.ts holds the two vocabularies together.
const BILLING_RE =
  /credit balance|insufficient[_ ](?:quota|credits|funds)|exceeded your current quota|quota.?exceeded|billing|payment required|\b402\b|spend limit|usage.?limit|out of budget|premium request/i;

const RATE_LIMIT_RE = /\b429\b|rate[_ -]?limit|too many requests/i;

const CONTENT_POLICY_RE = /content[_ ]filter|content filtering|usage policy|content policy/i;

// Transient upstream failures: gateway 5xx (500/502/503/504) and Cloudflare-family
// edge errors (510-529, 530), which typically arrive with no usable body. 501
// (not implemented) is deliberately excluded - it is not transient.
const UPSTREAM_STATUS_RE = /\b(500|50[234]|5[12]\d|530)\b/;

const MAX_DETAIL_LENGTH = 400;

/** Copy for one failed provider request. A caller that knows the request's
 *  provider refused its credential passes that provider as `authProvider`,
 *  and the copy names it; every other caller classifies from the message. */
export function classifyApiError(message: string, authProvider?: ProviderIdentity): ProviderErrorCopy {
  const auth = authErrorCopy(message, authProvider);
  if (auth) {
    return {
      presentation: "provider.auth_failed",
      title: AUTH_ERROR_TITLE[auth.kind],
      message: auth.problem,
      guidance: auth.guidance,
      ...(auth.kind === "credential" ? { action: MANAGE_AUTH_ACTION } : {}),
    };
  }
  if (ALL_PROVIDERS_EXHAUSTED_RE.test(message)) {
    const resetsAtIso = message.match(CAPACITY_RETURNS_AT_RE)?.[1];
    const returns = resetsAtIso === undefined ? undefined : new Date(resetsAtIso).toLocaleString();
    const detail = chainReasonsDetail(message);
    // The chain marks outage-skipped candidates "unreachable" (and in-flight
    // rechecks "rechecked after an outage"): the provider is down, not the
    // account spent, so the notice must not claim credits are the problem or
    // that waiting cannot help.
    if (PROVIDER_OUTAGE_RE.test(message)) {
      return {
        presentation: "provider.unavailable",
        title: "Provider unavailable",
        message: returns === undefined
          ? "This model's provider is unreachable, and no other configured provider can serve it."
          : `This model's provider is unreachable, and no other configured provider can serve it. A request after ${returns} can recheck provider availability.`,
        guidance: returns === undefined
          ? "Send a message to retry now, or switch models with /model."
          : "Wait until then and send a message to retry, or switch models with /model.",
        ...(detail === undefined ? {} : { detail }),
        action: SWITCH_MODELS_ACTION,
      };
    }
    return {
      presentation: "provider.out_of_credits",
      title: "Out of credits",
      message: returns === undefined
        ? "Every configured provider for this model is out of quota or credits; waiting alone will not fix this."
        : `Every configured provider for this model is out of quota or credits. Capacity returns at ${returns}.`,
      guidance: returns === undefined
        ? "Add credits or switch models with /model, then send a message to retry."
        : "Wait for the quota to reset or switch models with /model, then send a message to retry.",
      ...(detail === undefined ? {} : { detail }),
      action: SWITCH_MODELS_ACTION,
    };
  }
  if (BILLING_RE.test(message)) {
    return {
      presentation: "provider.out_of_credits",
      title: "Out of credits",
      message: "The provider account is out of credits or has hit a usage limit; waiting alone will not fix this.",
      guidance: "Add credits or switch models with /model, then send a message to retry.",
      detail: extractProviderErrorDetail(message),
      action: SWITCH_MODELS_ACTION,
    };
  }
  if (RATE_LIMIT_RE.test(message)) {
    return {
      presentation: "provider.rate_limited",
      title: "Rate limited",
      message: "The model provider is rate-limiting requests (temporary throttling, not your quota or credits).",
      guidance: "Send a message to retry, or switch models with /model if it keeps happening.",
      action: SWITCH_MODELS_ACTION,
    };
  }
  if (CONTENT_POLICY_RE.test(message)) return contentDeclinedCopy();
  const upstreamCode = message.match(UPSTREAM_STATUS_RE)?.[0];
  if (upstreamCode !== undefined) {
    return {
      presentation: "provider.server_error",
      title: "Provider server error",
      message: `The model provider hit a temporary server error (${upstreamCode}); nothing is wrong with your request.`,
      guidance: "Send a message to retry. If it keeps happening, the provider is likely degraded.",
    };
  }
  return {
    presentation: "provider.request_failed",
    title: "Model request failed",
    message: "The provider rejected the request.",
    guidance: "Send a message to retry.",
    detail: extractProviderErrorDetail(message),
  };
}

/** Copy for a request that the provider declined under its content policy, with the provider's own words as
 *  `detail` when the caller has them. */
export function contentDeclinedCopy(detail?: string): ProviderErrorCopy {
  return {
    presentation: "provider.content_declined",
    title: "Request declined",
    message: "The provider declined this request under its content policy.",
    guidance: "Rephrase the message or try a different model.",
    ...(detail === undefined ? {} : { detail }),
    action: SWITCH_MODELS_ACTION,
  };
}

/** Terse neutral prose for embedded registers: the title plus the most
 *  specific fact available (raw provider detail when extracted, the problem
 *  statement otherwise). Never includes `guidance`. */
export function providerErrorProse(copy: ProviderErrorCopy): string {
  return `${copy.title}: ${copy.detail ?? copy.message}`;
}

/** The per-provider reasons inside the chain's aggregate message, for the
 *  notice's detail line. The framing sentence and the machine-readable
 *  "Capacity returns at" channel are re-rendered by the structured copy
 *  above, so repeating them as detail would show the same fact three times
 *  (transcript line, notice message, notice detail). */
function chainReasonsDetail(message: string): string | undefined {
  const reasons = message
    .replace(/^no access provider can run "[^"]*" right now\.\s*/i, "")
    .replace(/\s*capacity returns at [^ ]+\.?\s*$/i, "")
    .trim();
  return reasons.length === 0 ? undefined : reasons;
}

/**
 * Pulls the human-relevant detail out of a raw provider error string: the
 * innermost `message` of an embedded JSON error payload, the `<title>` of an
 * HTML error page, or the raw text itself, whole. External
 * boundary normalization: provider bodies are allowed to be messy.
 */
export function extractProviderErrorDetail(raw: string): string {
  const trimmed = raw.trim();
  const payload = parseJsonPayload(trimmed);
  if (payload !== undefined) {
    const message = innermostErrorMessage(payload);
    if (message !== undefined) return message;
  }
  const htmlTitle = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  if (htmlTitle) return htmlTitle;
  return trimmed;
}

function parseJsonPayload(text: string): { readonly [key: string]: unknown } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const payload = JSON.parse(text.slice(start, end + 1));
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function innermostErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const nested = innermostErrorMessage(payload.error);
  if (nested !== undefined) return nested;
  return typeof payload.message === "string" && payload.message.length > 0 ? payload.message : undefined;
}

/** Bounds provider detail where a person reads it, such as a notice or a
 *  transcript row. Durable records keep the whole detail. */
export function boundProviderDetail(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}...` : text;
}
