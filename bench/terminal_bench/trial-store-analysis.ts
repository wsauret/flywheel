import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs"
import type { EventStoreReadSurface, StoredFact } from "../../src/infra/event-store-types.js"
import { SESSION_RUNTIME_FACT_DEFINITIONS, TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS } from "../../src/infra/runtime-fact-types.js"
import { createSqliteEventReadSurface } from "../../src/infra/sqlite-event-read-surface.js"
import { usageEntriesFromFacts } from "../../src/orchestration/session/durable-usage.js"
import { loadProviderRequestAuditFromEvents } from "../../src/orchestration/session/provider-request-audit-projection.js"
import { reconstructProviderRequestPrompt } from "../../src/orchestration/session/provider-request-audit-reconstruction.js"
import { ProviderRequestOutcomeSchema, type ProviderRequestAuditEntry, type ProviderRequestOutcome } from "../../src/orchestration/session/provider-request-audit-types.js"
// Prompt reconstruction reads the installed module catalog to label the hidden
// entries that each module wrote, such as the Claude engine's reminders. As in
// a release, loading the module registry publishes the shipped catalog.
import "../../src/orchestration/modules.js"

/** The analysis of one Terminal-Bench trial store. Every trial runs this file
 *  inside its sandbox, `bun trial-store-analysis.ts <store>`, and records the
 *  one JSON line it prints in its agent logs in place of the store, because
 *  Harbor scrubs secrets only in text files. The agent package carries this
 *  file from the packaged commit, so it imports only `src/` and the runtime. */

interface JsonObject { readonly [key: string]: unknown }
export interface ToolSettlement { inputs: number; results: number; missing: number; orphan: number; duplicateInputs: number; duplicateResults: number; identityConflicts: number }
interface EventRow { type: string; version: number; actor: string; payload: string }

// The stored result versions: the inline ones and those that move text to content rows.
const TOOL_RESULT_VERSIONS = [...SESSION_RUNTIME_FACT_DEFINITIONS, ...TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS].filter((definition) => definition.type === "tool.result.recorded").map((definition) => definition.version).join(", ")

export function object(value: unknown): JsonObject | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined }
export function emptySettlement(): ToolSettlement { return { inputs: 0, results: 0, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 } }
export function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 }
function payload(row: EventRow): JsonObject { const value = object(JSON.parse(row.payload)); if (!value) throw new Error(`invalid ${row.type} payload`); return value }

/** Whether the evidence file admits nobody but this account.
 *
 *  POSIX states that in the file's mode and owning uid. Windows publishes
 *  neither - it reports no uid and a fixed mode whatever a write asked for - so
 *  the checks that still hold there are the regular-file and link-count ones the
 *  caller makes alongside this. */
function ownerOnlyEvidence(stats: Stats): boolean {
  if (process.platform === "win32") return true
  return stats.uid === process.getuid?.() && (stats.mode & 0o777) === 0o600
}

interface AuditedRequest { sessionId: string; entry: ProviderRequestAuditEntry; sessionEvents: readonly StoredFact[]; tools: ReadonlySet<string> }
interface RequestAudit { valid: boolean; requests: ReadonlyMap<string, AuditedRequest>; interactionProfiles: ReadonlySet<string | null> }

const PROVIDER_REQUEST_AUDIT_TYPES = ["prompt.assembled", "tool_surface.selected", "model.requested", "model.request.dispatched", "model.response_received"] as const

/** The provider-request audit of every session that holds audit facts, read
 *  through the product's own projection, so the analysis accepts the fact
 *  shapes and versions that the product reader accepts and no other. The store
 *  audit is invalid when the projection refuses a session (duplicate, orphan,
 *  or mixed-version facts) or when two sessions claim one request id. */
function readRequestAudit(db: Database, readSurface: EventStoreReadSurface): RequestAudit {
  const requests = new Map<string, AuditedRequest>(), interactionProfiles = new Set<string | null>()
  let valid = true
  const placeholders = PROVIDER_REQUEST_AUDIT_TYPES.map(() => "?").join(",")
  for (const { session_id: sessionId } of db.query<{ session_id: string }, string[]>(`select distinct session_id from event where type in (${placeholders}) order by session_id`).all(...PROVIDER_REQUEST_AUDIT_TYPES)) {
    const sessionEvents = readSurface.read({ aggregateId: `session:${sessionId}` })
    let entries: ProviderRequestAuditEntry[]
    try { entries = loadProviderRequestAuditFromEvents(sessionEvents) } catch { valid = false; continue }
    for (const entry of entries) {
      if (requests.has(entry.requestId)) { valid = false; continue }
      if (entry.request !== undefined) interactionProfiles.add(entry.request.interactionProfileId ?? null)
      // The projection resolves each request's tool surface, including a
      // surface the writer recorded once for an earlier request with the same
      // hash. Historical tools carry no executable identity and join nothing.
      // A tool's `name` is its wire form, which a route's tool presentation can
      // rename (the Claude engine's `mcp__runtime__` prefix); the adapter maps a
      // call back to the canonical name space before Flywheel records it, so a
      // tool input's provider tool name joins the tool's `executableId`.
      const tools = new Set((entry.toolSurface?.tools ?? []).flatMap((tool) => "executableId" in tool ? [tool.executableId] : []))
      requests.set(entry.requestId, { sessionId, entry, sessionEvents, tools })
    }
  }
  return { valid, requests, interactionProfiles }
}

/** Whether a request has the full audit chain: prepared, dispatched, a
 *  terminal response, and a prompt that refolds from durable facts to the
 *  recorded hash. A prompt the reconstruction reports as unavailable is
 *  degraded evidence and fails. */
async function completeRequest(request: AuditedRequest, readSurface: EventStoreReadSurface): Promise<boolean> {
  const { entry } = request
  if (entry.prompt === undefined || entry.request === undefined || entry.dispatchState !== "dispatched" || entry.completionState !== "terminal") return false
  try {
    const reconstruction = await reconstructProviderRequestPrompt({ entry, store: readSurface, sessionEvents: request.sessionEvents })
    return reconstruction.kind === "reconstructed" && reconstruction.verified
  } catch {
    return false
  }
}

/** The version of the trial store analysis. A trial records its
 *  analysis in its agent logs in place of its store, so a change to what the
 *  analysis states or means needs a new version, which the host refuses until
 *  its reader decodes it. */
const TRIAL_STORE_ANALYSIS_VERSION = 3 as const
/** The agent-log file of a trial that holds its store analysis. The shim
 *  writes it under this name. */
export const TRIAL_STORE_ANALYSIS_NAME = "flywheel-store-analysis.json"

/** What one trial store proves, apart from the run's expectation and without
 *  content: counts, booleans, registry tool names, interaction profile ids,
 *  the final request outcome, the estimated cost, and the identity of the
 *  analysed bytes. */
export interface TrialStoreAnalysis {
  version: typeof TRIAL_STORE_ANALYSIS_VERSION
  store: { sha256: string; size: number }
  toolSettlement: ToolSettlement
  /** The projection accepted every session, and every request that a tool input names, and a final request
   *  that the provider refused, has its full audit chain. */
  requestAuditComplete: boolean
  /** The interaction profile of every audited request, null for one that recorded none. */
  interactionProfiles: (string | null)[]
  /** The tool inputs that joined their audited tool surface, by executable tool name. */
  executableToolInputs: { [toolName: string]: number }
  /** The outcome of the last provider response of the trial, null when no request was answered. An
   *  outcome other than `ok` names why the trial's model work ended: a provider failure, the provider's
   *  refusal of the conversation content (`refused`), an abort, or a context or output limit. */
  finalRequestOutcome: TrialRequestOutcome | null
  /** The estimated cost of every priced usage entry in USD, null when no entry was priced. */
  estimatedCostUsd: number | null
}

/** A provider response outcome, with a stream error that the provider's content refusal ended told apart
 *  as `refused`: a refusal repeats for the same content, so it is a result of the trial, not a fault. */
type TrialRequestOutcome = ProviderRequestOutcome | "refused"
const isProviderRequestOutcome = Schema.is(ProviderRequestOutcomeSchema)
const isRequestOutcome = (value: unknown): value is TrialRequestOutcome => value === "refused" || isProviderRequestOutcome(value)

function trialRequestOutcome(response: JsonObject | undefined): TrialRequestOutcome {
  const outcome = response?.outcome
  if (!isProviderRequestOutcome(outcome)) throw new Error("invalid model.response_received outcome")
  return outcome === "stream_error" && object(response?.error)?.tag === "ContentRefused" ? "refused" : outcome
}

/** Analyzes one trial store, the private settled copy that a driver exported.
 *  The file must be a regular, single-link, owner-only file; it is read once,
 *  and the analysis is bound to the digest of exactly those bytes. Throws when
 *  the file is unsafe, unreadable, or changes while it is read. */
export async function analyzeTrialStore(path: string): Promise<TrialStoreAnalysis> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  const before = fstatSync(descriptor)
  if (!before.isFile() || before.nlink !== 1 || !ownerOnlyEvidence(before)) { closeSync(descriptor); throw new Error("unsafe evidence file") }
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), chunks: Buffer[] = []
  let size = 0, count = 0
  while ((count = readSync(descriptor, buffer, 0, buffer.length, size)) > 0) { digest.update(buffer.subarray(0, count)); chunks.push(Buffer.from(buffer.subarray(0, count))); size += count }
  const store = { sha256: digest.digest("hex"), size }
  // The database is opened from the exact bytes the digest covers, so the
  // analysis is bound to the stated evidence identity and immutable by
  // construction. A file: URI with immutable=1 is not portable: Bun's bundled
  // Linux SQLite is compiled without URI filenames and refuses the open.
  const db = Database.deserialize(Buffer.concat(chunks), true)
  try {
    const readSurface = createSqliteEventReadSurface(db)
    const audit = readRequestAudit(db, readSurface)
    const inputCounts = new Map<string, number>(), resultCounts = new Map<string, number>(), inputRequests = new Map<string, string>()
    const providerAliases = new Map<string, string>(), toolSettlement = emptySettlement(), executableToolInputs: { [toolName: string]: number } = {}
    for (const row of db.query<EventRow & { session_id: string }, []>("select type, version, actor, payload, session_id from event where type = 'tool.input.completed' and version = 2 and actor = 'agent'").iterate()) {
      const value = payload(row)
      if (![value.toolUseId, value.providerCallId, value.providerToolName, value.toolName, value.modelRequestId].every(nonempty)) { toolSettlement.identityConflicts += 1; continue }
      const id = String(value.toolUseId), requestId = String(value.modelRequestId), request = audit.requests.get(requestId), toolName = String(value.toolName)
      // A repaired call's provider tool name is the name the model wrote, which no tool of the surface has.
      const joined = request?.sessionId === row.session_id && value.providerToolName === toolName && request.tools.has(toolName)
      if (!joined) toolSettlement.identityConflicts += 1
      toolSettlement.inputs += 1; inputCounts.set(id, (inputCounts.get(id) ?? 0) + 1); inputRequests.set(id, requestId)
      const alias = `${requestId}:${String(value.providerCallId)}`, prior = providerAliases.get(alias)
      if (prior !== undefined && prior !== id) toolSettlement.identityConflicts += 1
      providerAliases.set(alias, id)
      if (joined) executableToolInputs[toolName] = (executableToolInputs[toolName] ?? 0) + 1
    }
    // Every registered version keeps the same identity and outcome fields; later
    // versions only move text to content rows or add mutation evidence.
    for (const row of db.query<EventRow, []>(`select type, version, actor, payload from event where type = 'tool.result.recorded' and version in (${TOOL_RESULT_VERSIONS}) and actor = 'flywheel'`).iterate()) {
      const value = payload(row)
      if (!nonempty(value.toolUseId) || !nonempty(value.outcome)) { toolSettlement.identityConflicts += 1; continue }
      const id = value.toolUseId
      toolSettlement.results += 1; resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1)
      if (value.modelRequestId !== undefined && inputRequests.get(id) !== value.modelRequestId) toolSettlement.identityConflicts += 1
    }
    for (const [id, inputCount] of inputCounts) { if (inputCount > 1) toolSettlement.duplicateInputs += inputCount - 1; if (!resultCounts.has(id)) toolSettlement.missing += 1 }
    for (const [id, resultCount] of resultCounts) { if (resultCount > 1) toolSettlement.duplicateResults += resultCount - 1; if (!inputCounts.has(id)) toolSettlement.orphan += 1 }
    const finalRow = db.query<{ payload: string }, []>("select payload from event where type = 'model.response_received' and actor = 'provider' order by position desc limit 1").get()
    const finalResponse = finalRow === null ? undefined : object(JSON.parse(finalRow.payload))
    const finalRequestOutcome = finalRow === null ? null : trialRequestOutcome(finalResponse)
    // A refusal can end the trial before any tool call, so the refused request
    // needs its audit chain as well; it is then the only audited request.
    const auditedRequests = new Set(inputRequests.values())
    if (finalRequestOutcome === "refused") auditedRequests.add(String(finalResponse?.requestId))
    let requestAuditComplete = audit.valid && auditedRequests.size > 0
    for (const requestId of auditedRequests) {
      if (!requestAuditComplete) break
      const request = audit.requests.get(requestId)
      requestAuditComplete = request !== undefined && await completeRequest(request, readSurface)
    }
    const after = fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("evidence identity changed")
    const interactionProfiles = [...audit.interactionProfiles].sort((a, b) => String(a).localeCompare(String(b)))
    const prices = usageEntriesFromFacts(readSurface.read({ types: ["model.usage.measured"] })).flatMap((entry) => entry.coverage !== "unmeasured" && entry.price.kind === "priced" ? [entry.price.estimatedUsd] : [])
    const estimatedCostUsd = prices.length === 0 ? null : Number(prices.reduce((total, price) => total + price, 0).toFixed(6))
    return { version: TRIAL_STORE_ANALYSIS_VERSION, store, toolSettlement, requestAuditComplete, interactionProfiles, executableToolInputs, finalRequestOutcome, estimatedCostUsd }
  } finally { db.close(); closeSync(descriptor) }
}

function count(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 }
function invalidAnalysis(): never { throw new Error("invalid trial store analysis") }

/** Decodes the store analysis that a trial recorded, and refuses any
 *  other version or shape. */
export function decodeTrialStoreAnalysis(value: unknown): TrialStoreAnalysis {
  const row = object(value), store = object(row?.store), settlement = object(row?.toolSettlement), inputs = object(row?.executableToolInputs), profiles = row?.interactionProfiles
  if (row?.version !== TRIAL_STORE_ANALYSIS_VERSION || !store || !nonempty(store.sha256) || !count(store.size) || !settlement || !inputs || !Array.isArray(profiles) || typeof row.requestAuditComplete !== "boolean") return invalidAnalysis()
  const cost = row.estimatedCostUsd, outcome = row.finalRequestOutcome
  const estimatedCostUsd = cost === null ? null : typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : invalidAnalysis()
  const finalRequestOutcome = outcome === null ? null : isRequestOutcome(outcome) ? outcome : invalidAnalysis()
  const field = (name: keyof ToolSettlement): number => { const item = settlement[name]; return count(item) ? item : invalidAnalysis() }
  return {
    version: TRIAL_STORE_ANALYSIS_VERSION,
    store: { sha256: store.sha256, size: store.size },
    toolSettlement: { inputs: field("inputs"), results: field("results"), missing: field("missing"), orphan: field("orphan"), duplicateInputs: field("duplicateInputs"), duplicateResults: field("duplicateResults"), identityConflicts: field("identityConflicts") },
    requestAuditComplete: row.requestAuditComplete,
    interactionProfiles: profiles.map((profile: unknown) => profile === null ? null : nonempty(profile) ? profile : invalidAnalysis()),
    executableToolInputs: Object.fromEntries(Object.entries(inputs).map(([name, item]) => [name, count(item) ? item : invalidAnalysis()])),
    finalRequestOutcome,
    estimatedCostUsd,
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) { console.error("Usage: bun trial-store-analysis.ts <store>"); process.exit(2) }
  analyzeTrialStore(path).then((analysis) => { console.log(JSON.stringify(analysis)) }, (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
