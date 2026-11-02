import { reduceEvents } from "../../infra/event-projection.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { canonicalProviderStreamSummary, readProviderRequestAuditFact, type ProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import { hashSystemPrompt, hashToolSurface } from "./provider-request-audit-hash.js"
import {
  digestProviderRequestContextApplications,
  type ProviderRequestAuditEntry,
  providerRequestIdentityKey,
  providerRequestIdentityFromPayload,
  type ProviderRequestIdentity,
  type ProviderRequestAuditOmittedTool,
  type HistoricalProviderRequestAuditTool,
  type ProviderRequestAuditTool,
} from "./provider-request-audit-types.js"
import type { ModuleTransformerApplication } from "../module-hooks.js"

interface ResolvedToolSurface {
  tools: readonly (ProviderRequestAuditTool | HistoricalProviderRequestAuditTool)[]
  omittedTools: readonly ProviderRequestAuditOmittedTool[]
}

interface ContextApplicationEvidence {
  applications: ModuleTransformerApplication[]
  applicationCount: number
  sequenceDigest: string
  manifestEvent: StoredFact
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
}

// `type` (not `interface`) so the shape carries the implicit index signature
// `reduceEvents` requires of a projection state.
type ProviderRequestAuditState = {
  // O(1) upsert by requestId; `order` preserves first-seen ordering for stable
  // output. The fold never scans the array (no findIndex).
  byRequestId: Map<string, ProviderRequestAuditEntry>
  order: string[]
  historicalIdentityByRequestId: Map<string, string>
  // Last full tool surface seen per `${conversationId}:${toolSurfaceHash}`, so a
  // hash-only `tool_surface.selected` resolves back to the body that was stored
  // once for that hash within the conversation.
  toolSurfaceByHash: Map<string, ResolvedToolSurface>
  contextApplicationsByIdentity: Map<string, ContextApplicationEvidence>
  requestIdsByContextApplicationId: Map<string, Set<string>>
  promptEvents: Map<string, StoredFact>
  toolSurfaceEvents: Map<string, StoredFact>
  requestEvents: Map<string, StoredFact>
  dispatchEvents: Map<string, StoredFact>
  terminalEvents: Map<string, StoredFact>
  usageEvents: Map<string, StoredFact>
  systemPromptBodies: Set<string>
  strictRequestIds: Set<string>
  promptVersions: Map<string, number>
  toolSurfaceVersions: Map<string, number>
  requestVersions: Map<string, number>
}

type ProviderRequestStream = NonNullable<ProviderRequestAuditEntry["stream"]>

export const PROVIDER_REQUEST_AUDIT_FACT_TYPES = [
  "prompt.assembled",
  "tool_surface.selected",
  "model.requested",
  "model.request.dispatched",
  "context.application.recorded",
  "context.transformer.applied",
  "model.response_received",
  "model.usage.recorded",
  "model.stream.started",
  "model.stream.event_observed",
  "model.stream.completed",
  "model.stream.summary.recorded",
] as const

export function loadProviderRequestAuditFromEvents(
  events: readonly StoredFact[],
): ProviderRequestAuditEntry[] {
  const state = reduceEvents(events, {
    initialState,
    reduce: reduceProviderRequestAuditEvent,
    factTypes: PROVIDER_REQUEST_AUDIT_FACT_TYPES,
  })
  validateContextApplicationEvidence(state)
  validateStrictRequestEvidence(state)
  for (const [requestId, requestEvent] of state.requestEvents) validateVersionBundle(state, requestId, requestEvent)
  return state.order.map((requestId) => snapshotEntry(requireEntry(state, requestId)))
}

function snapshotEntry(entry: ProviderRequestAuditEntry): ProviderRequestAuditEntry {
  if (entry.contextApplications) {
    entry.contextApplications = entry.contextApplications.map((application) => ({ ...application }))
  }
  return entry
}

function initialState(): ProviderRequestAuditState {
  return {
    byRequestId: new Map(),
    order: [],
    historicalIdentityByRequestId: new Map(),
    toolSurfaceByHash: new Map(),
    contextApplicationsByIdentity: new Map(),
    requestIdsByContextApplicationId: new Map(),
    promptEvents: new Map(),
    toolSurfaceEvents: new Map(),
    requestEvents: new Map(),
    dispatchEvents: new Map(),
    terminalEvents: new Map(),
    usageEvents: new Map(),
    systemPromptBodies: new Set(),
    strictRequestIds: new Set(),
    promptVersions: new Map(),
    toolSurfaceVersions: new Map(),
    requestVersions: new Map(),
  }
}

function resolveProjectionIdentity(
  state: ProviderRequestAuditState,
  event: StoredFact,
  fact: ProviderRequestAuditFact,
): ProviderRequestIdentity {
  const payloadIdentity = providerRequestIdentityFromPayload(fact.payload)
  const existingEntry = state.byRequestId.get(fact.payload.requestId)
  const hasCurrentIdentity = "identity" in fact.payload
  if (!hasCurrentIdentity) {
    const historicalIdentity = state.historicalIdentityByRequestId.get(fact.payload.requestId)
    if (historicalIdentity && historicalIdentity !== fact.payload.conversationId) {
      throw auditViolation("schema-mismatch", event, `historical request identity does not match requestId ${fact.payload.requestId}`)
    }
    state.historicalIdentityByRequestId.set(fact.payload.requestId, fact.payload.conversationId)
  }
  const historicalCacheKey = !hasCurrentIdentity && fact.type === "model.requested"
    ? fact.payload.cacheKey
    : undefined
  const conversationId = payloadIdentity.conversationId ?? existingEntry?.identity.conversationId
  const identity: ProviderRequestIdentity = {
    providerSessionKey: historicalCacheKey ?? (hasCurrentIdentity
      ? payloadIdentity.providerSessionKey
      : existingEntry?.identity.providerSessionKey ?? payloadIdentity.providerSessionKey),
    ...(conversationId ? { conversationId } : {}),
  }
  if (historicalCacheKey && existingEntry) existingEntry.identity = identity
  return identity
}

function reduceProviderRequestAuditEvent(
  state: ProviderRequestAuditState,
  event: StoredFact,
): ProviderRequestAuditState {
  const fact = readProviderRequestAuditFact(event)
  const identity = resolveProjectionIdentity(state, event, fact)
  const identityKey = providerRequestIdentityKey(identity)

  switch (fact.type) {
    case "prompt.assembled": {
      rejectDuplicate(state.promptEvents, fact.payload.requestId, event)
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      if ((fact.version === 2 || fact.version === 3) && fact.payload.treePointer && identity.conversationId
        && fact.payload.treePointer.conversationId !== identity.conversationId) {
        throw auditViolation("schema-mismatch", event, `tree pointer conversation does not match requestId ${fact.payload.requestId}`)
      }
      if ((fact.version === 3 || fact.version === 4 || fact.version === 5) && fact.payload.systemPrompt !== undefined && hashSystemPrompt(fact.payload.systemPrompt) !== fact.payload.systemPromptHash) {
        throw auditViolation("schema-mismatch", event, `system prompt body does not match hash ${fact.payload.systemPromptHash}`)
      }
      if ((fact.version === 4 || fact.version === 5) && fact.payload.treeLeafEntryId !== undefined && !identity.conversationId) {
        throw auditViolation("schema-mismatch", event, `tree leaf has no durable conversation owner for requestId ${fact.payload.requestId}`)
      }
      state.promptEvents.set(fact.payload.requestId, event)
      state.promptVersions.set(fact.payload.requestId, fact.version)
      if (fact.payload.systemPrompt !== undefined) state.systemPromptBodies.add(`${identityKey}:${fact.payload.systemPromptHash}`)
      const conversationId = identity.conversationId
      const treePointer = fact.version === 4 || fact.version === 5
        ? (conversationId && fact.payload.treeLeafEntryId !== undefined
            ? { conversationId, leafEntryId: fact.payload.treeLeafEntryId }
            : undefined)
        : fact.payload.treePointer
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        entry.prompt = {
          promptKind: fact.payload.promptKind,
          ...(fact.version === 5 && fact.payload.requestPurpose ? { requestPurpose: fact.payload.requestPurpose } : {}),
          messageCount: fact.payload.messageCount,
          estimatedContextTokens: fact.payload.estimatedContextTokens,
          ...(fact.version === 3 || fact.version === 4 || fact.version === 5 ? { attemptStaticTokens: fact.payload.attemptStaticTokens } : {}),
          contextWindow: fact.payload.contextWindow,
          promptSha256: fact.payload.promptSha256,
          systemPromptHash: fact.payload.systemPromptHash,
          toolSurfaceHash: fact.payload.toolSurfaceHash,
          ...(treePointer ? { treePointer } : {}),
          ...(fact.payload.parentToolUseId ? { parentToolUseId: fact.payload.parentToolUseId } : {}),
          ...(fact.payload.staleMasking ? { staleMasking: fact.payload.staleMasking } : {}),
          ...(fact.version === 5 && fact.payload.toolHistoryProjection ? { toolHistoryProjection: fact.payload.toolHistoryProjection } : {}),
          ...(fact.version === 5 && fact.payload.historyLowering ? { historyLowering: fact.payload.historyLowering } : {}),
          ...((fact.version === 3 || fact.version === 4 || fact.version === 5) && fact.payload.requestContext ? { requestContext: fact.payload.requestContext } : {}),
          ...(fact.payload.contextApplicationId ? { contextApplicationId: fact.payload.contextApplicationId } : {}),
        }
        applyToolSurface(state, entry, identityKey, fact.payload.toolSurfaceHash)
        if (fact.payload.contextApplicationId) {
          const owners = state.requestIdsByContextApplicationId.get(fact.payload.contextApplicationId) ?? new Set<string>()
          owners.add(fact.payload.requestId)
          state.requestIdsByContextApplicationId.set(fact.payload.contextApplicationId, owners)
          entry.contextApplications = state.contextApplicationsByIdentity.get(fact.payload.contextApplicationId)?.applications
        }
      })
    }
    case "tool_surface.selected": {
      requireProducer(state, event, fact.payload.requestId, identity, fact.payload.turn, "prompt.assembled")
      rejectDuplicate(state.toolSurfaceEvents, fact.payload.requestId, event)
      if ((fact.version === 3 || fact.version === 4 || fact.version === 5) && hashToolSurface(fact.payload.tools, fact.payload.omittedTools) !== fact.payload.toolSurfaceHash) {
        throw auditViolation("schema-mismatch", event, `tool surface body does not match hash ${fact.payload.toolSurfaceHash}`)
      }
      state.toolSurfaceEvents.set(fact.payload.requestId, event)
      state.toolSurfaceVersions.set(fact.payload.requestId, fact.version)
      const key = `${identityKey}:${fact.payload.toolSurfaceHash}`
      state.toolSurfaceByHash.set(key, {
        tools: Object.freeze(fact.payload.tools.map((tool) => Object.freeze({ ...tool }))),
        omittedTools: Object.freeze(fact.payload.omittedTools.map((tool) => Object.freeze({ ...tool }))),
      })
      const prompt = requireEntry(state, fact.payload.requestId).prompt
      if (prompt?.toolSurfaceHash !== fact.payload.toolSurfaceHash) {
        throw auditViolation("schema-mismatch", event, `tool surface hash does not match prompt for requestId ${fact.payload.requestId}`)
      }
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        applyToolSurface(state, entry, identityKey, fact.payload.toolSurfaceHash)
      })
    }
    case "context.application.recorded": {
      if (state.contextApplicationsByIdentity.has(fact.payload.contextApplicationId)) {
        throw contextEvidenceViolation("duplicate-event", event, `duplicate manifest for contextApplicationId ${fact.payload.contextApplicationId}`)
      }
      const owner = state.byRequestId.get(fact.payload.requestId)
      if (owner?.prompt?.contextApplicationId !== fact.payload.contextApplicationId) {
        throw contextEvidenceViolation("orphan-event", event, `manifest has no matching prompt for contextApplicationId ${fact.payload.contextApplicationId}`)
      }
      const evidence: ContextApplicationEvidence = {
        applications: [],
        applicationCount: fact.payload.applicationCount,
        sequenceDigest: fact.payload.sequenceDigest,
        manifestEvent: event,
        requestId: fact.payload.requestId,
        identity,
        turn: fact.payload.turn,
      }
      state.contextApplicationsByIdentity.set(fact.payload.contextApplicationId, evidence)
      for (const requestId of state.requestIdsByContextApplicationId.get(fact.payload.contextApplicationId) ?? []) {
        requireEntry(state, requestId).contextApplications = evidence.applications
      }
      return state
    }
    case "context.transformer.applied": {
      const evidence = state.contextApplicationsByIdentity.get(fact.payload.contextApplicationId)
      if (!evidence) {
        throw contextEvidenceViolation("missing-producer-event", event, `manifest has not been observed for contextApplicationId ${fact.payload.contextApplicationId}`)
      }
      if (evidence.requestId !== fact.payload.requestId
        || providerRequestIdentityKey(evidence.identity) !== identityKey
        || evidence.turn !== fact.payload.turn) {
        throw contextEvidenceViolation("schema-mismatch", event, `transformer application does not match manifest owner for contextApplicationId ${fact.payload.contextApplicationId}`)
      }
      evidence.applications.push({
        applicationId: fact.payload.applicationId,
        transformerId: fact.payload.transformerId,
        seam: fact.payload.seam,
        order: fact.payload.order,
        outcome: fact.payload.outcome,
        inputHash: fact.payload.inputHash,
        outputHash: fact.payload.outputHash,
      })
      state.contextApplicationsByIdentity.set(fact.payload.contextApplicationId, evidence)
      for (const requestId of state.requestIdsByContextApplicationId.get(fact.payload.contextApplicationId) ?? []) {
        requireEntry(state, requestId).contextApplications = evidence.applications
      }
      return state
    }
    case "model.requested":
      requireProducer(state, event, fact.payload.requestId, identity, fact.payload.turn, "prompt.assembled")
      rejectDuplicate(state.requestEvents, fact.payload.requestId, event)
      state.requestEvents.set(fact.payload.requestId, event)
      state.requestVersions.set(fact.payload.requestId, fact.version)
      if (fact.version !== 1 && fact.version !== 2) state.strictRequestIds.add(fact.payload.requestId)
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        entry.preparedAt = event.timestamp
        entry.dispatchState = "prepared"
        entry.auditVersion = fact.version
        entry.request = {
          model: fact.payload.model,
          accessProvider: fact.payload.accessProvider,
          modelFamily: fact.payload.modelFamily,
          ...(fact.version !== 1 ? { interactionProfileId: fact.payload.interactionProfileId } : {}),
          ...(fact.version === 4 || fact.version === 5 || fact.version === 6 ? { accessProviderCandidate: fact.payload.accessProviderCandidate } : {}),
          ...((fact.version === 4 || fact.version === 5 || fact.version === 6) && fact.payload.catalogProvenance !== undefined ? { catalogProvenance: fact.payload.catalogProvenance } : {}),
          reasoningEffort: fact.payload.reasoningEffort,
          cacheRetention: fact.payload.cacheRetention,
          cacheKey: fact.payload.cacheKey,
          providerOptions: fact.payload.providerOptions,
        }
      })
    case "model.request.dispatched":
      requireProducer(state, event, fact.payload.requestId, identity, fact.payload.turn, "model.requested")
      rejectDuplicate(state.dispatchEvents, fact.payload.requestId, event)
      if (state.terminalEvents.has(fact.payload.requestId)) {
        throw auditViolation("orphan-event", event, `dispatch follows terminal evidence for requestId ${fact.payload.requestId}`)
      }
      state.dispatchEvents.set(fact.payload.requestId, event)
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        entry.dispatchedAt = event.timestamp
        entry.requestedAt = event.timestamp
        entry.dispatchState = "dispatched"
        entry.completionState = "unknown"
      })
    case "model.response_received":
      requireProducer(state, event, fact.payload.requestId, identity, fact.payload.turn, "model.requested")
      rejectDuplicate(state.terminalEvents, fact.payload.requestId, event)
      state.terminalEvents.set(fact.payload.requestId, event)
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        entry.respondedAt = event.timestamp
        entry.completionState = "terminal"
        entry.response = {
          outcome: fact.payload.outcome,
          durationMs: fact.payload.durationMs,
          stopReason: fact.payload.stopReason,
          responseId: fact.payload.responseId,
          error: fact.payload.error ? { ...fact.payload.error } : undefined,
          ...(fact.version === 3 && fact.payload.transportContext ? { transportContext: fact.payload.transportContext } : {}),
        }
      })
    case "model.usage.recorded": {
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      const usageEvent = state.usageEvents.get(fact.payload.requestId)
      if (usageEvent?.id === event.id) return state
      if (usageEvent) throw auditViolation("duplicate-event", event, `conflicting model.usage.recorded for requestId ${fact.payload.requestId}`)
      state.usageEvents.set(fact.payload.requestId, event)
      return upsertRequest(state, fact.payload.requestId, identity, fact.payload.turn, (entry) => {
        entry.usage = {
          recordedAt: event.timestamp,
          ...(fact.version === 3 || fact.version === 4 || fact.version === 5 ? { attemptId: fact.payload.attemptId } : {}),
          ...workflowAttemptOf(fact.payload),
          ...(fact.payload.parentToolUseId ? { parentToolUseId: fact.payload.parentToolUseId } : {}),
          // Remove the pre-v5 reading after 2027-04-30: every earlier fact held the provider's final report.
          coverage: fact.version === 5 ? fact.payload.coverage : "complete",
          inputTokens: fact.payload.inputTokens,
          outputTokens: fact.payload.outputTokens,
          cacheReadInputTokens: fact.payload.cacheReadInputTokens,
          cacheCreationInputTokens: fact.payload.cacheCreationInputTokens,
          reasoningTokens: fact.payload.reasoningTokens,
          promptTokens: fact.payload.promptTokens,
          ...(fact.version === 1 || fact.version === 2 ? { deltaCostUsd: fact.payload.deltaCostUsd } : {}),
        }
      })
    }
    case "model.stream.started":
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      return updateStream(state, fact.payload.requestId, event, (stream) => {
        stream.startedAt = event.timestamp
      })
    case "model.stream.event_observed":
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      return updateStream(state, fact.payload.requestId, event, (stream) => {
        stream.events.push({
          sequence: fact.payload.sequence,
          timestamp: event.timestamp,
          source: fact.payload.source,
          kind: fact.payload.kind,
          elapsedMs: fact.payload.elapsedMs,
          sincePreviousMs: fact.payload.sincePreviousMs,
          metadata: { ...fact.payload.metadata },
        })
      })
    case "model.stream.completed":
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      return updateStream(state, fact.payload.requestId, event, (stream) => {
        stream.completedAt = event.timestamp
        stream.durationMs = fact.payload.durationMs
        stream.eventCount = fact.payload.eventCount
        stream.outcome = fact.payload.outcome
        stream.lastEventKind = fact.payload.lastEventKind
      })
    case "model.stream.summary.recorded":
      validateIdentity(state, event, fact.payload.requestId, identity, fact.payload.turn)
      return updateStream(state, fact.payload.requestId, event, (stream) => {
        stream.summary = canonicalProviderStreamSummary(fact, identity)
        stream.startedAt ??= fact.payload.startedAt
        stream.completedAt ??= fact.payload.completedAt
        stream.durationMs ??= fact.payload.durationMs
        stream.eventCount ??= fact.payload.rawEventCount
        stream.outcome ??= fact.payload.outcome
        stream.lastEventKind ??= fact.payload.lastEventKind
      })
  }
}

function applyToolSurface(
  state: ProviderRequestAuditState,
  entry: ProviderRequestAuditEntry,
  identityKey: string,
  toolSurfaceHash: string,
): void {
  const resolved = state.toolSurfaceByHash.get(`${identityKey}:${toolSurfaceHash}`)
  if (!resolved) return
  entry.toolSurface = resolved
}

function upsertRequest(
  state: ProviderRequestAuditState,
  requestId: string,
  identity: ProviderRequestIdentity,
  turn: number,
  mutate: (entry: ProviderRequestAuditEntry) => void,
): ProviderRequestAuditState {
  const entry = ensureEntry(state, requestId, identity, turn)
  mutate(entry)
  return state
}

function ensureEntry(
  state: ProviderRequestAuditState,
  requestId: string,
  identity: ProviderRequestIdentity,
  turn: number,
): ProviderRequestAuditEntry {
  const existing = state.byRequestId.get(requestId)
  if (existing) return existing
  const created: ProviderRequestAuditEntry = { requestId, identity, turn }
  state.byRequestId.set(requestId, created)
  state.order.push(requestId)
  return created
}

function updateStream(
  state: ProviderRequestAuditState,
  requestId: string,
  event: StoredFact,
  mutate: (stream: ProviderRequestStream) => void,
): ProviderRequestAuditState {
  const entry = state.byRequestId.get(requestId)
  if (!entry) {
    throw new InvariantViolation({
      kind: "missing-producer-event",
      eventType: event.type,
      eventPosition: event.position,
      aggregateId: event.aggregateId,
      detail: `prompt.assembled has not been observed for requestId ${requestId}`,
    })
  }
  entry.stream ??= { events: [] }
  mutate(entry.stream)
  return state
}

function requireEntry(state: ProviderRequestAuditState, requestId: string): ProviderRequestAuditEntry {
  const entry = state.byRequestId.get(requestId)
  if (!entry) throw new Error(`provider-request-audit projection lost requestId ${requestId}`)
  return entry
}

function validateContextApplicationEvidence(state: ProviderRequestAuditState): void {
  for (const entry of state.byRequestId.values()) {
    const identity = entry.prompt?.contextApplicationId
    if (!identity) continue
    const evidence = state.contextApplicationsByIdentity.get(identity)
    if (!evidence) {
      throw new InvariantViolation({
        kind: "missing-producer-event",
        eventType: "context.application.recorded",
        eventPosition: 0,
        aggregateId: providerRequestIdentityKey(entry.identity),
        detail: `missing manifest for contextApplicationId ${identity}`,
      })
    }
    const digest = digestProviderRequestContextApplications(evidence.applications)
    if (evidence.applicationCount !== evidence.applications.length || evidence.sequenceDigest !== digest) {
      throw contextEvidenceViolation("schema-mismatch", evidence.manifestEvent, `inconsistent transformer sequence for contextApplicationId ${identity}`)
    }
  }
}

function validateStrictRequestEvidence(state: ProviderRequestAuditState): void {
  for (const requestId of state.strictRequestIds) {
    const entry = requireEntry(state, requestId)
    const prompt = entry.prompt
    const requestEvent = state.requestEvents.get(requestId)
    if (!prompt || !requestEvent) throw new Error(`strict provider request ${requestId} lost preparation evidence`)
    if (!state.systemPromptBodies.has(`${providerRequestIdentityKey(entry.identity)}:${prompt.systemPromptHash}`)) {
      throw auditViolation("missing-producer-event", requestEvent, `no stored system prompt body for requestId ${requestId}`)
    }
    if (!entry.toolSurface) {
      throw auditViolation("missing-producer-event", requestEvent, `no stored tool surface body for requestId ${requestId}`)
    }
  }
}

function validateVersionBundle(state: ProviderRequestAuditState, requestId: string, requestEvent: StoredFact): void {
  const promptVersion = state.promptVersions.get(requestId)
  const requestVersion = state.requestVersions.get(requestId)
  const toolVersion = state.toolSurfaceVersions.get(requestId)
  const strictHistorical = promptVersion === 3 || requestVersion === 3 || requestVersion === 4 || toolVersion === 3
  if (strictHistorical && (promptVersion !== 3 || (requestVersion !== 3 && requestVersion !== 4) || (toolVersion !== undefined && toolVersion !== 3))) {
    throw auditViolation("schema-mismatch", requestEvent, `mixed provider request fact versions for requestId ${requestId}`)
  }
  const current = promptVersion === 4 || promptVersion === 5 || requestVersion === 5 || requestVersion === 6 || toolVersion === 4 || toolVersion === 5
  if (current && ((promptVersion !== 4 && promptVersion !== 5) || (requestVersion !== 5 && requestVersion !== 6) || (toolVersion !== undefined && toolVersion !== 4 && toolVersion !== 5))) {
    throw auditViolation("schema-mismatch", requestEvent, `mixed provider request fact versions for requestId ${requestId}`)
  }
}

function requireProducer(
  state: ProviderRequestAuditState,
  event: StoredFact,
  requestId: string,
  identity: ProviderRequestIdentity,
  turn: number,
  producer: "prompt.assembled" | "model.requested",
): void {
  const entry = state.byRequestId.get(requestId)
  const present = producer === "prompt.assembled" ? state.promptEvents.has(requestId) : state.requestEvents.has(requestId)
  if (!entry || !present) throw auditViolation("missing-producer-event", event, `${producer} has not been observed for requestId ${requestId}`)
  validateIdentity(state, event, requestId, identity, turn)
}

function validateIdentity(state: ProviderRequestAuditState, event: StoredFact, requestId: string, identity: ProviderRequestIdentity, turn: number): void {
  const entry = state.byRequestId.get(requestId)
  if (entry && (entry.identity.providerSessionKey !== identity.providerSessionKey
    || entry.identity.conversationId !== identity.conversationId
    || entry.turn !== turn)) {
    throw auditViolation("schema-mismatch", event, `request identity or turn does not match requestId ${requestId}`)
  }
}


function rejectDuplicate(events: Map<string, StoredFact>, requestId: string, event: StoredFact): void {
  if (events.has(requestId)) throw auditViolation("duplicate-event", event, `duplicate ${event.type} for requestId ${requestId}`)
}

function auditViolation(
  kind: "duplicate-event" | "missing-producer-event" | "orphan-event" | "schema-mismatch",
  event: StoredFact,
  detail: string,
): InvariantViolation {
  return new InvariantViolation({ kind, eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId, detail })
}

function contextEvidenceViolation(kind: "duplicate-event" | "missing-producer-event" | "orphan-event" | "schema-mismatch", event: StoredFact, detail: string): InvariantViolation {
  return new InvariantViolation({ kind, eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId, detail })
}

/** The workflow attempt of a usage fact: `workflowAttemptId` from version
 *  4, `stepId` before it. Remove the `stepId` reader after 2027-04-30. */
function workflowAttemptOf(payload: { readonly workflowAttemptId?: string } | { readonly stepId?: string }): { readonly workflowAttemptId?: string } {
  const workflowAttemptId = "workflowAttemptId" in payload ? payload.workflowAttemptId : "stepId" in payload ? payload.stepId : undefined
  return workflowAttemptId ? { workflowAttemptId } : {}
}
