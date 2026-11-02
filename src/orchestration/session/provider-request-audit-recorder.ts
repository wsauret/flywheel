import { DebugLog } from "../../infra/debug-log.js"
import { parseProviderRequestAuditFact, PROVIDER_REQUEST_DIAGNOSTIC_TYPES, type ProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import { hashAgentPrompt, hashSystemPrompt, hashToolSurface } from "./provider-request-audit-hash.js"
import {
  digestProviderRequestContextApplications,
  type ProviderRequestAuditRequestInput,
  type ProviderRequestIdentity,
  type ProviderRequestAuditResponseInput,
  type ProviderRequestUsageInput,
  type ProviderStreamSummary,
  type ProviderStreamTelemetryCompletedInput,
  type ProviderStreamTelemetryEventInput,
  type ProviderStreamTelemetryStartedInput,
} from "./provider-request-audit-types.js"
import type { SessionFactWriter } from "./session-fact-writer.js"
import { durableOwnerId, type DurableOwner } from "../../infra/durable-owner.js"


/** Durable session audit sink plus optional live observation. Raw stream
 * telemetry also carries the session id into the bounded debug log. */
export interface ProviderRequestAuditContext {
  owner?: DurableOwner
  sessionId?: string
  writer?: Pick<SessionFactWriter, "record" | "recordBatch">
  observe?: (fact: ProviderRequestAuditFact) => void
}

// One transformer application can be active across contiguous provider
// failover attempts. Replacing this marker bounds retention to one identity.
export interface ConversationDedup {
  systemPromptHash?: string
  toolSurfaceHash?: string
  contextApplicationIdentity?: string
  contextApplicationDigest?: string
}

export interface ProviderRequestFacts {
  requestId: string
  facts: ProviderRequestAuditFact[]
  /** Dedup fields the caller commits after the facts are recorded. */
  dedupAdvance: ConversationDedup
}

type PresentedProviderRequestAuditTool = ProviderRequestAuditRequestInput["tools"][number] & {
  readonly kind: "function" | "custom"
  readonly inputFormatSha256: string
}

function hasPresentationAudit(tool: ProviderRequestAuditRequestInput["tools"][number]): tool is PresentedProviderRequestAuditTool {
  return tool.kind !== undefined && tool.inputFormatSha256 !== undefined
}

/** Builds the audit evidence facts for one provider request: the prompt, any
 *  first-seen tool surface or transformer manifest, and the model request.
 *  Pure construction so the live recorder and historical test fixtures share
 *  one shape. Throws when a context-application identity names a different
 *  transformer sequence than the dedup register recorded. */
export function buildProviderRequestFacts(
  input: ProviderRequestAuditRequestInput,
  dedup: ConversationDedup,
): ProviderRequestFacts {
  const requestId = input.requestId
  const systemPromptHash = hashSystemPrompt(input.systemPrompt)
  const toolSurfaceHash = hashToolSurface(input.tools, input.omittedTools)
  const promptSha256 = hashAgentPrompt({
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    tools: input.tools,
  })
  const contextApplicationSignature = input.contextApplication
    ? digestProviderRequestContextApplications(input.contextApplication.applications)
    : undefined
  const recordedContextApplication = input.contextApplication?.identity === dedup.contextApplicationIdentity
    ? dedup.contextApplicationDigest
    : undefined
  if (recordedContextApplication !== undefined && recordedContextApplication !== contextApplicationSignature) {
    throw new Error(`Context application identity ${input.contextApplication?.identity} names a different transformer sequence`)
  }

  const systemPromptChanged = dedup.systemPromptHash !== systemPromptHash
  const toolSurfaceChanged = dedup.toolSurfaceHash !== toolSurfaceHash
  const contextApplicationChanged = input.contextApplication !== undefined
    && recordedContextApplication === undefined

  const promptAssembled: ProviderRequestAuditFact = {
    type: "prompt.assembled",
    version: 5,
    actor: "flywheel",
    payload: {
      requestId,
      identity: input.identity,
      turn: input.turn,
      promptKind: input.promptKind,
      ...(input.requestPurpose ? { requestPurpose: input.requestPurpose } : {}),
      systemPromptHash,
      toolSurfaceHash,
      promptSha256,
      messageCount: input.messageCount,
      estimatedContextTokens: input.estimatedContextTokens,
      attemptStaticTokens: input.attemptStaticTokens,
      contextWindow: input.contextWindow,
      // Body only when the hash is new in this conversation.
      ...(systemPromptChanged ? { systemPrompt: input.systemPrompt } : {}),
      // Current facts derive the conversation id from `identity`; only the
      // leaf coordinate is stored alongside it.
      ...(input.treeLeafEntryId !== undefined && "conversationId" in input.identity
        ? { treeLeafEntryId: input.treeLeafEntryId }
        : {}),
      ...(input.parentToolUseId ? { parentToolUseId: input.parentToolUseId } : {}),
      ...(input.contextApplication ? { contextApplicationId: input.contextApplication.identity } : {}),
      ...(input.staleMasking ? { staleMasking: input.staleMasking } : {}),
      ...(input.toolHistoryProjection ? { toolHistoryProjection: input.toolHistoryProjection } : {}),
      ...(input.historyLowering ? { historyLowering: input.historyLowering } : {}),
      ...(input.requestContext ? { requestContext: input.requestContext } : {}),
    },
  }

  const facts: ProviderRequestAuditFact[] = [promptAssembled]
  if (toolSurfaceChanged) {
    const payload = {
      requestId,
      identity: input.identity,
      turn: input.turn,
      toolSurfaceHash,
      omittedTools: input.omittedTools.map((tool) => ({ ...tool })),
    }
    if (input.tools.every(hasPresentationAudit)) {
      facts.push({
        type: "tool_surface.selected",
        version: 5,
        actor: "flywheel",
        payload: { ...payload, tools: input.tools.map((tool) => ({ ...tool })) },
      })
    } else {
      facts.push({
        type: "tool_surface.selected",
        version: 4,
        actor: "flywheel",
        payload: { ...payload, tools: input.tools.map((tool) => ({ ...tool })) },
      })
    }
  }
  if (contextApplicationChanged && input.contextApplication) {
    const recordedSequenceDigest = digestProviderRequestContextApplications(input.contextApplication.applications)
    facts.push({
      type: "context.application.recorded",
      version: 2,
      actor: "flywheel",
      payload: {
        requestId,
        identity: input.identity,
        turn: input.turn,
        contextApplicationId: input.contextApplication.identity,
        applicationCount: input.contextApplication.applications.length,
        sequenceDigest: recordedSequenceDigest,
      },
    })
    for (const application of input.contextApplication.applications) {
      facts.push({
        type: "context.transformer.applied",
        version: 2,
        actor: "flywheel",
        payload: {
          requestId,
          identity: input.identity,
          turn: input.turn,
          contextApplicationId: input.contextApplication.identity,
          applicationId: application.applicationId,
          transformerId: application.transformerId,
          seam: application.seam,
          order: application.order,
          outcome: application.outcome,
          inputHash: application.inputHash,
          outputHash: application.outputHash,
        },
      })
    }
  }

  const modelRequestedPayload = {
    requestId,
    identity: input.identity,
    turn: input.turn,
    model: input.model,
    accessProvider: input.accessProvider,
    modelFamily: input.modelFamily,
    interactionProfileId: input.interactionProfileId,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
    ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
  };
  facts.push({
    type: "model.requested",
    version: 6,
    actor: "flywheel",
    payload: {
      ...modelRequestedPayload,
      ...(input.accessProviderCandidate === undefined ? {} : { accessProviderCandidate: input.accessProviderCandidate }),
      ...(input.catalogProvenance === undefined ? {} : { catalogProvenance: input.catalogProvenance }),
    },
  })

  const dedupAdvance: ConversationDedup = {
    ...(systemPromptChanged ? { systemPromptHash } : {}),
    ...(toolSurfaceChanged ? { toolSurfaceHash } : {}),
    ...(contextApplicationChanged && input.contextApplication && contextApplicationSignature !== undefined
      ? { contextApplicationIdentity: input.contextApplication.identity, contextApplicationDigest: contextApplicationSignature }
      : {}),
  }

  return { requestId, facts, dedupAdvance }
}

/** Records one provider request before external I/O. The dedup register advances
 * only after every fact is durable or observed. */
export async function recordProviderRequest(
  audit: ProviderRequestAuditContext,
  input: ProviderRequestAuditRequestInput,
  dedup: ConversationDedup,
): Promise<string> {
  const built = buildProviderRequestFacts(input, dedup)
  const facts = built.facts.map(parseProviderRequestAuditFact)
  if (audit.writer) {
    const stored = await audit.writer.recordBatch(facts)
    if (!stored) throw new Error("Provider request was not acknowledged by the session fact writer")
  }
  for (const fact of facts) audit.observe?.(fact)
  Object.assign(dedup, built.dedupAdvance)
  return built.requestId
}

/** Records that the provider adapter invoked its external I/O operation. */
export async function recordProviderRequestDispatched(
  audit: ProviderRequestAuditContext,
  input: { requestId: string; identity: ProviderRequestIdentity; turn: number },
): Promise<void> {
  await record(audit, {
    type: "model.request.dispatched",
    version: 2,
    actor: "provider",
    payload: input,
  })
}

export async function recordProviderResponse(
  audit: ProviderRequestAuditContext,
  input: ProviderRequestAuditResponseInput,
): Promise<void> {
  await record(audit, {
    type: "model.response_received",
    version: 3,
    actor: "provider",
    payload: {
      requestId: input.requestId,
      identity: input.identity,
      turn: input.turn,
      outcome: input.outcome,
      durationMs: input.durationMs,
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.transportContext ? { transportContext: input.transportContext } : {}),
    },
  })
}

export async function recordProviderUsage(
  audit: ProviderRequestAuditContext,
  input: ProviderRequestUsageInput,
): Promise<void> {
  await record(audit, {
    type: "model.usage.recorded",
    version: 4,
    actor: "provider",
    payload: {
      requestId: input.requestId,
      identity: input.identity,
      turn: input.turn,
      attemptId: input.requestId,
      ...(input.workflowAttemptId ? { workflowAttemptId: input.workflowAttemptId } : {}),
      ...(input.parentToolUseId ? { parentToolUseId: input.parentToolUseId } : {}),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      reasoningTokens: input.reasoningTokens,
      promptTokens: input.promptTokens,
    },
  })
}

export function recordProviderStreamStarted(
  audit: ProviderRequestAuditContext,
  input: ProviderStreamTelemetryStartedInput,
): void {
  recordStreamDiagnostic(audit, "model.stream.started", {
    requestId: input.requestId,
    identity: input.identity,
    turn: input.turn,
  })
}

export function recordProviderStreamEvent(
  audit: ProviderRequestAuditContext,
  input: ProviderStreamTelemetryEventInput,
): void {
  recordStreamDiagnostic(audit, "model.stream.event_observed", {
    requestId: input.requestId,
    identity: input.identity,
    turn: input.turn,
    sequence: input.sequence,
    source: input.source,
    kind: input.kind,
    elapsedMs: input.elapsedMs,
    sincePreviousMs: input.sincePreviousMs,
    metadata: { ...input.metadata },
  })
}

/** A stream that ran this long is past a long answer's usual length, and a
 *  person who waited that long asks why. */
const SLOW_PROVIDER_STREAM_MS = 120_000

/** The one diagnostic record of a provider request. It reaches the default
 *  level only when the stream failed, stalled, or ran slow; an interrupted
 *  stream is the person's decision, not a failure. */
export function recordProviderStreamCompleted(
  audit: ProviderRequestAuditContext,
  input: ProviderStreamTelemetryCompletedInput,
): void {
  const failed = input.outcome !== "ok" && input.outcome !== "aborted"
  recordStreamDiagnostic(audit, "model.stream.completed", {
    requestId: input.requestId,
    turn: input.turn,
    durationMs: input.durationMs,
    eventCount: input.eventCount,
    outcome: input.outcome,
    ...(input.lastEventKind ? { lastEventKind: input.lastEventKind } : {}),
    ...(input.stallCount > 0 ? { stallCount: input.stallCount } : {}),
  }, failed || input.stallCount > 0 || input.durationMs >= SLOW_PROVIDER_STREAM_MS)
}

/** The fields every raw stream record carries: the request it belongs to. */
interface StreamDiagnosticPayload {
  readonly requestId: string
  readonly turn: number
  readonly [field: string]: unknown
}

/** Raw stream telemetry is diagnostic only: it goes to the debug log as
 *  built, and never through the durable audit union or its observers. */
function recordStreamDiagnostic(
  audit: ProviderRequestAuditContext,
  type: typeof PROVIDER_REQUEST_DIAGNOSTIC_TYPES[number],
  payload: StreamDiagnosticPayload,
  notable = false,
): void {
  DebugLog.record({
    ...(audit.owner ? { sessionId: durableOwnerId(audit.owner) } : audit.sessionId ? { sessionId: audit.sessionId } : {}),
    type,
    actor: "provider",
    payload,
    ...(notable ? { notable } : {}),
  })
}

export async function recordProviderStreamSummary(
  audit: ProviderRequestAuditContext,
  input: ProviderStreamSummary,
): Promise<void> {
  await record(audit, {
    type: "model.stream.summary.recorded",
    version: 3,
    actor: "flywheel",
    payload: input,
  })
}

async function record(audit: ProviderRequestAuditContext, fact: ProviderRequestAuditFact): Promise<void> {
  // The schema gate is the writer's: a fact bound for the store is decoded
  // before it is appended.
  const parsed = parseProviderRequestAuditFact(fact)
  if (audit.writer) {
    const stored = await audit.writer.record(parsed)
    if (!stored) throw new Error(`${parsed.type} was not acknowledged by the session fact writer`)
  }
  audit.observe?.(parsed)
}
