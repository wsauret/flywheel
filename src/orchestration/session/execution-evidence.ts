import { asAsyncEventReadSurface } from "../../infra/event-store-types.js";
import type { ExecutionEvidence } from "../../protocol/execution-evidence.js";
import { resolveEventStoreDbFile } from "../../infra/paths.js";
import { openReadonlyEventReader } from "../../infra/sqlite-event-store.js";
import { usageEntriesFromFacts } from "./durable-usage.js";
import { loadProviderRequestAuditFromEvents, PROVIDER_REQUEST_AUDIT_FACT_TYPES } from "./provider-request-audit-projection.js";
import type { ProviderRequestAuditEntry } from "./provider-request-audit-types.js";
import { createSessionMetadataProjection } from "./session-metadata-projection.js";

type SessionEvidence = ExecutionEvidence["sessions"][number];
type RequestEvidence = SessionEvidence["requests"][number];
type MetadataGap = ExecutionEvidence["metadataGaps"][number];

/** Reads the requested session and current durable descendants without write
 * authority or runtime admission. Missing stores, unavailable root metadata,
 * and invalid request or canonical usage facts throw. No audit content is returned. */
export async function readExecutionEvidence(projectRoot: string, rootSessionId: string): Promise<ExecutionEvidence> {
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(projectRoot));
  try {
    const catalog = await createSessionMetadataProjection(asAsyncEventReadSurface(reader)).replay();
    if (catalog.errors[rootSessionId]) throw new Error(`Session ${rootSessionId} has corrupt metadata`);
    if (catalog.deleted[rootSessionId]) throw new Error(`Session ${rootSessionId} is deleted`);
    if (!catalog.sessions[rootSessionId]) throw new Error(`Session ${rootSessionId} has no durable metadata`);

    const metadataGaps: MetadataGap[] = Object.keys(catalog.errors).map((sessionId) => ({ sessionId, kind: "corrupt", scope: "workspace" }));
    const children = new Map<string, string[]>();
    for (const [sessionId, session] of Object.entries(catalog.sessions)) {
      const parent = session.launchedFrom?.parentSessionId;
      if (parent === undefined) continue;
      const ids = children.get(parent) ?? [];
      ids.push(sessionId);
      children.set(parent, ids);
    }
    const sessionIds = new Set([rootSessionId]);
    const sessions: SessionEvidence[] = [];
    for (const sessionId of sessionIds) {
      // SAFETY: the root is validated above; children come only from catalog.sessions entries.
      const session = catalog.sessions[sessionId]!;
      for (const childId of children.get(sessionId) ?? []) sessionIds.add(childId);
      for (const childId of session.childSessionIds ?? []) {
        if (!catalog.sessions[childId] && !catalog.deleted[childId] && !catalog.errors[childId]) {
          metadataGaps.push({ sessionId: childId, kind: "missing", scope: "descendant" });
        }
      }
      try {
        const events = reader.read({ sessionId, types: [...PROVIDER_REQUEST_AUDIT_FACT_TYPES, "model.usage.measured"] });
        const usageEntries = usageEntriesFromFacts(events);
        const measured = new Set(usageEntries.flatMap((entry) => entry.coverage === "unmeasured" ? [] : [entry.attemptId]));
        const requests = loadProviderRequestAuditFromEvents(events).map((entry) => requestEvidence(entry, measured));
        sessions.push({
          sessionId,
          kind: session.kind,
          ...(session.launchedFrom ? { parentSessionId: session.launchedFrom.parentSessionId } : {}),
          requests,
          usageEntries,
        });
      } catch {
        // Audit decoder errors can contain prompt bodies. This command exposes
        // only the owning session id, not those diagnostic details.
        throw new Error(`Cannot decode execution evidence for session ${sessionId}`);
      }
    }
    return {
      version: 2,
      projectRoot,
      rootSessionId,
      descendantDiscovery: metadataGaps.length === 0 ? "current-metadata" : "incomplete",
      metadataGaps,
      sessions,
      accounting: {
        usage: sessions.some((session) => session.usageEntries.some((entry) => entry.coverage !== "unmeasured")) ? "available" : "unavailable",
        price: "estimate",
        providerInvoicedCost: "unavailable",
      },
    };
  } finally {
    reader.close();
  }
}

function requestEvidence(entry: ProviderRequestAuditEntry, measured: ReadonlySet<string>): RequestEvidence {
  // Current attempts use their UUID as requestId before usage exists. Historical
  // audits establish an attemptId only through model.usage.recorded v3.
  const attemptId = entry.usage?.attemptId ?? (entry.auditVersion === 5 || entry.auditVersion === 6 ? entry.requestId : undefined);
  const candidate = entry.request?.accessProviderCandidate;
  return {
    requestId: entry.requestId,
    identity: { providerSessionKey: entry.identity.providerSessionKey, ...(entry.identity.conversationId ? { conversationId: entry.identity.conversationId } : {}) },
    turn: entry.turn,
    attemptId,
    workflowAttemptId: entry.usage?.workflowAttemptId,
    preparedAt: entry.preparedAt,
    dispatchedAt: entry.dispatchedAt,
    respondedAt: entry.respondedAt,
    durationMs: entry.response?.durationMs,
    dispatchState: entry.dispatchState ?? "unknown",
    completionState: entry.completionState ?? "unknown",
    purpose: entry.prompt?.requestPurpose === "compaction" ? "compaction" : "normal",
    model: entry.request?.model,
    accessProvider: entry.request?.accessProvider,
    accessProviderCandidate: candidate === undefined ? undefined : candidate.kind === "subscription"
      ? { kind: "subscription", providerId: candidate.providerId, instanceId: candidate.instanceId, spendMode: candidate.spendMode }
      : { kind: "singleton", providerId: candidate.providerId, spendMode: candidate.spendMode },
    reasoningEffort: entry.request?.reasoningEffort,
    outcome: entry.response?.outcome,
    errorTag: entry.response?.error?.tag,
    measurement: attemptId !== undefined && measured.has(attemptId) ? "available" : "unavailable",
  };
}
