import { Schema } from "effect"
import { PersistenceWriteRefused } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { AccessProviderIdSchema } from "../../infra/llm/access-provider.js"
import { contentDeclinedCopy, type ProviderErrorCopy, type ProviderRecovery } from "../../infra/llm/provider-error-copy.js"
import { RefusedPartKindSchema } from "../../infra/llm/content-repair.js"
import { AllCandidatesExhaustedError, ContentFilteredError, ContentRefusedError, ContextLengthExceededError, LlmStreamError, OutputLengthExceededError, QuotaCoordinationError, StreamIdleTimeoutError } from "./llm/errors.js"
import { classifyProviderFailure, ProviderAttemptFailure, providerRecovery, type ProviderFailure } from "./llm/provider-failure.js"
import { DegenerateRepetitionError } from "./llm/reasoning-repetition.js"
import { ThinkingStallError } from "./llm/thinking-stall.js"
import type { AgentFailureReason } from "./types.js"

export class ContextOverflow extends Schema.TaggedError<ContextOverflow>()("ContextOverflow", {}) {}
export class OutputOverflow extends Schema.TaggedError<OutputOverflow>()("OutputOverflow", {}) {}
/** A provider request failed. `copy`, when present, is the presentation the
 *  failing attempt settled from facts the message does not carry, such as
 *  which provider refused its credential. `recovery` states whether a later
 *  run can send again or the failure needs a person. */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", { message: Schema.String }) {
  readonly copy?: ProviderErrorCopy
  readonly recovery: ProviderRecovery

  constructor(input: { message: string; copy?: ProviderErrorCopy; recovery: ProviderRecovery }) {
    super({ message: input.message })
    this.copy = input.copy
    this.recovery = input.recovery
  }
}
/** No configured provider offers the model, so no provider was called. Apart
 *  from ApiError so that a caller can tell a wrong model id from a provider
 *  failure. */
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()("ModelUnavailable", { message: Schema.String, missing: Schema.Literals(["provider", "offering", "access"]) }) {}
export class TransientDisconnect extends Schema.TaggedError<TransientDisconnect>()("TransientDisconnect", { message: Schema.String }) {}
const StallAttributionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("provider"), provider: AccessProviderIdSchema }),
  Schema.Struct({ kind: Schema.Literal("unattributed") }),
]);

export class StreamStalled extends Schema.TaggedError<StreamStalled>()("StreamStalled", {
  message: Schema.String,
  attribution: StallAttributionSchema,
}) {}
export class ApiOverloaded extends Schema.TaggedError<ApiOverloaded>()("ApiOverloaded", { message: Schema.String }) {}
/** The provider refused the request because of conversation content. `message` is the provider failure text
 *  the person reads, `reason` the provider's own words, `part` the canonical tool result part it names, and
 *  `policy` the provider's code when it refused the content under its usage policy. */
export class ContentRefused extends Schema.TaggedError<ContentRefused>()("ContentRefused", {
  message: Schema.String,
  reason: Schema.String,
  part: Schema.optionalKey(Schema.Struct({ toolUseId: Schema.String, partIndex: Schema.Int, kind: RefusedPartKindSchema })),
  policy: Schema.optionalKey(Schema.String),
}) {}
/** The provider's content filter stopped the response after the request was accepted. */
class ContentFiltered extends Schema.TaggedError<ContentFiltered>()("ContentFiltered", { message: Schema.String }) {}
export class AgentAborted extends Schema.TaggedError<AgentAborted>()("AgentAborted", {}) {}
export class ProviderAuditSettlementError extends Schema.TaggedError<ProviderAuditSettlementError>()("ProviderAuditSettlementError", { message: Schema.String }) {}
// The agent broke its handoff contract: every correction the bounded loop
// allowed was rejected (see agent-loop-handoff.ts). It is a plain Error outside
// AgentRuntimeError because the model request did not fail, so it must never
// map to a provider failure. The run rejects with it, and the owner of the
// handoff contract reports it in its own terms.
export class HandoffCorrectionExhausted extends Error {
  readonly _tag = "HandoffCorrectionExhausted" as const

  constructor(input: { readonly message: string }) {
    super(input.message)
    this.name = "HandoffCorrectionExhausted"
  }
}

// Single authority for union membership: the type and the guard both derive from it.
const AGENT_RUNTIME_ERRORS = [
  ContextOverflow,
  OutputOverflow,
  ApiError,
  ModelUnavailable,
  AllCandidatesExhaustedError,
  TransientDisconnect,
  StreamStalled,
  ApiOverloaded,
  ContentRefused,
  ContentFiltered,
  AgentAborted,
  ProviderAuditSettlementError,
  ThinkingStallError,
  DegenerateRepetitionError,
  QuotaCoordinationError,
] as const

export type AgentRuntimeError = InstanceType<(typeof AGENT_RUNTIME_ERRORS)[number]>

export function isAgentRuntimeError<Failure>(err: Failure): err is Failure & AgentRuntimeError {
  return AGENT_RUNTIME_ERRORS.some((member) => err instanceof member)
}

/** Maps an error that crossed a provider request onto the typed runtime
 *  channel. A request's catch also sees what the caller's own turn work threw,
 *  and a HandoffCorrectionExhausted from that work is not a request failure:
 *  it is rethrown unchanged, so it never reads as a provider error and never
 *  advances failover.
 *
 *  `failure` is the normalized classification of the attempt that raised
 *  `err`, when the caller has one. It decides the recovery of an ApiError,
 *  because a classification of the raw outer error can miss the typed failure
 *  that normalization found in its cause chain. */
export function fromStreamError(err: unknown, failure: ProviderFailure = err instanceof ProviderAttemptFailure ? err.failure : classifyProviderFailure(err)): AgentRuntimeError {
  if (err instanceof PersistenceWriteRefused) throw err
  if (err instanceof HandoffCorrectionExhausted) throw err
  // Our own tagged runtime errors resurface through provider catch blocks.
  if (isAgentRuntimeError(err)) return err
  if (err instanceof ContextLengthExceededError) return new ContextOverflow()
  if (err instanceof OutputLengthExceededError) return new OutputOverflow()
  if (err instanceof ContentFilteredError) return new ContentFiltered({ message: err.message })
  if (err instanceof ContentRefusedError) return new ContentRefused({ message: errorMessage(err.cause), reason: err.reason, ...(err.part === undefined ? {} : { part: err.part }), ...(err.policy === undefined ? {} : { policy: err.policy }) })
  if (err instanceof StreamIdleTimeoutError && err.phase === "idle") return new StreamStalled({ message: err.message, attribution: { kind: "unattributed" } })
  if (err instanceof LlmStreamError) {
    return err.kind === "overload"
      ? new ApiOverloaded({ message: err.message })
      : new TransientDisconnect({ message: err.message })
  }
  return new ApiError({ message: errorMessage(err), recovery: providerRecovery(failure) })
}

export function toFailureReason(error: AgentRuntimeError): AgentFailureReason {
  switch (error._tag) {
    case "ContextOverflow": return { kind: "context_overflow" }
    case "OutputOverflow": return { kind: "output_overflow" }
    case "ApiError": return { kind: "api_error", message: error.message, ...(error.copy === undefined ? {} : { copy: error.copy }), recovery: error.recovery }
    case "ModelUnavailable": return { kind: "model_unavailable", message: error.message, missing: error.missing }
    case "AllCandidatesExhausted": return {
      kind: "api_error",
      message: error.message,
      ...(error.copy === undefined ? {} : { copy: error.copy }),
      recovery: error.recovery,
      candidatesExhausted: true,
      ...(error.noPreferenceServes ? { noPreferenceServes: true } : {}),
    }
    case "TransientDisconnect": return { kind: "transient_disconnect", message: error.message }
    case "StreamStalled": return { kind: "stream_stalled", message: error.message, attribution: error.attribution }
    case "ApiOverloaded": return { kind: "api_overloaded", message: error.message }
    // A refusal that the repair inside the run could not clear meets the same
    // content on every later run.
    case "ContentRefused": return { kind: "api_error", message: error.message, ...(error.policy === undefined ? {} : { copy: contentDeclinedCopy(error.reason) }), recovery: { kind: "none" }, contentRefused: true }
    // The assistant boundary settles a content filter as a response, so only a
    // caller outside it meets this; a later run can be served.
    case "ContentFiltered": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    case "AgentAborted": return { kind: "aborted" }
    case "ProviderAuditSettlementError": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    case "ThinkingStall": return { kind: "stream_stalled", message: error.message, attribution: { kind: "unattributed" } }
    // The walk resamples a repeating response and accepts its last attempt, so only a turn that settled during a
    // resampled attempt, such as one that took new input, ends on it; a later run samples again.
    case "DegenerateRepetition": return { kind: "api_error", message: error.message, recovery: { kind: "retry" } }
    // No failure kind states quota coordination, so the account that could not
    // be coordinated has to survive in the message the user reads.
    case "QuotaCoordination": return { kind: "api_error", message: `${error.provider}: ${error.message}`, recovery: { kind: "retry" } }
  }
}
