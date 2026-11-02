import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { EventStoreReadSurface, StoredFact } from "../../src/infra/event-store-types.js"
import { createSqliteEventReadSurface } from "../../src/infra/sqlite-event-read-surface.js"
import { loadProviderRequestAuditFromEvents } from "../../src/orchestration/session/provider-request-audit-projection.js"
import { reconstructProviderRequestPrompt } from "../../src/orchestration/session/provider-request-audit-reconstruction.js"
import type { ProviderRequestAuditEntry } from "../../src/orchestration/session/provider-request-audit-types.js"

export type JsonMap = Record<string, unknown>
type FailureClass = "missing_trial" | "unreadable_store" | "adapter_invalid" | "verifier_invalid" | "request_audit_invalid" | "tool_settlement_invalid" | "command_expectation_failed" | "provider_failure" | "genuine_command_failure" | "genuine_model_failure"
interface ToolSettlement { inputs: number; results: number; missing: number; orphan: number; duplicateInputs: number; duplicateResults: number; identityConflicts: number }
export interface AnalyzerTrialRow { id: string; task: string; expected: boolean; discovered: boolean; storeValid: boolean; adapterSettled: boolean; verifierValid: boolean; requestAuditValid: boolean; toolSettlement: ToolSettlement; commandExpected: boolean; commandObserved: boolean; reward: number | null; failure: FailureClass | null }
export interface ToolOutcomeAnalysis { version: 2; denominator: number; rows: AnalyzerTrialRow[]; infrastructureValid: boolean; comparisonAvailable: boolean }
interface EventRow { type: string; version: number; actor: string; payload: string }
interface ExpectedRow { task: string; attempt: number }
interface CommandExpectation { version: 1; executableToolNames: Set<string>; minimumCardinality: number; interactionProfile: string }

// Version 2 reads the provider-request audit through the product projection
// instead of pinned fact versions, so a version 1 summary is not comparable.
export const TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION = 2 as const
export const TOOL_OUTCOME_ANALYZER_RESULT_VERSION = 2 as const

function object(value: unknown): JsonMap | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined }
async function json(path: string): Promise<JsonMap | undefined> { try { return object(JSON.parse(await readFile(path, "utf8"))) } catch { return undefined } }
function reward(result: JsonMap | undefined): number | null { const value = object(object(result?.verifier_result)?.rewards)?.reward; return typeof value === "number" && Number.isFinite(value) ? value : null }
function emptySettlement(): ToolSettlement { return { inputs: 0, results: 0, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 } }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 }
function payload(row: EventRow): JsonMap { const value = object(JSON.parse(row.payload)); if (!value) throw new Error(`invalid ${row.type} payload`); return value }

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

interface AuditedRequest { sessionId: string; entry: ProviderRequestAuditEntry; sessionEvents: readonly StoredFact[]; tools: ReadonlyMap<string, string> }
interface RequestAudit { valid: boolean; requests: ReadonlyMap<string, AuditedRequest> }

const PROVIDER_REQUEST_AUDIT_TYPES = ["prompt.assembled", "tool_surface.selected", "model.requested", "model.request.dispatched", "model.response_received"] as const

/** The provider-request audit of every session that holds audit facts, read
 *  through the product's own projection, so the analyzer accepts the fact
 *  shapes and versions that the product reader accepts and no other. The store
 *  audit is invalid when the projection refuses a session (duplicate, orphan,
 *  or mixed-version facts), when two sessions claim one request id, or when a
 *  request ran under an interaction profile other than the expected one. */
function readRequestAudit(db: Database, readSurface: EventStoreReadSurface, expectation: CommandExpectation): RequestAudit {
  const requests = new Map<string, AuditedRequest>()
  let valid = true
  const placeholders = PROVIDER_REQUEST_AUDIT_TYPES.map(() => "?").join(",")
  for (const { session_id: sessionId } of db.query<{ session_id: string }, string[]>(`select distinct session_id from event where type in (${placeholders}) order by session_id`).all(...PROVIDER_REQUEST_AUDIT_TYPES)) {
    const sessionEvents = readSurface.read({ aggregateId: `session:${sessionId}` })
    let entries: ProviderRequestAuditEntry[]
    try { entries = loadProviderRequestAuditFromEvents(sessionEvents) } catch { valid = false; continue }
    for (const entry of entries) {
      if (requests.has(entry.requestId)) { valid = false; continue }
      if (entry.request !== undefined && entry.request.interactionProfileId !== expectation.interactionProfile) valid = false
      // The projection resolves each request's tool surface, including a
      // surface the writer recorded once for an earlier request with the same
      // hash. Historical tools carry no executable identity and join nothing.
      const tools = new Map((entry.toolSurface?.tools ?? []).flatMap((tool) => "executableId" in tool ? [[tool.name, tool.executableId] as const] : []))
      requests.set(entry.requestId, { sessionId, entry, sessionEvents, tools })
    }
  }
  return { valid, requests }
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

async function analyzeStore(path: string, expectation: CommandExpectation): Promise<{ settlement: ToolSettlement; requestAuditValid: boolean; commandObserved: boolean; identity: { sha256: string; size: number } }> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  const before = fstatSync(descriptor)
  if (!before.isFile() || before.nlink !== 1 || !ownerOnlyEvidence(before)) { closeSync(descriptor); throw new Error("unsafe evidence file") }
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), chunks: Buffer[] = []
  let size = 0, count = 0
  while ((count = readSync(descriptor, buffer, 0, buffer.length, size)) > 0) { digest.update(buffer.subarray(0, count)); chunks.push(Buffer.from(buffer.subarray(0, count))); size += count }
  const identity = { sha256: digest.digest("hex"), size }
  // The database is opened from the exact bytes the digest covers, so the
  // analysis is bound to the stated evidence identity and immutable by
  // construction. A file: URI with immutable=1 is not portable: Bun's bundled
  // Linux SQLite is compiled without URI filenames and refuses the open.
  const db = Database.deserialize(Buffer.concat(chunks), true)
  try {
    const readSurface = createSqliteEventReadSurface(db)
    const audit = readRequestAudit(db, readSurface, expectation)
    const inputCounts = new Map<string, number>(), resultCounts = new Map<string, number>(), inputRequests = new Map<string, string>()
    const providerAliases = new Map<string, string>(), settlement = emptySettlement()
    let executableCount = 0
    for (const row of db.query<EventRow & { session_id: string }, []>("select type, version, actor, payload, session_id from event where type = 'tool.input.completed' and version = 2 and actor = 'agent'").iterate()) {
      const value = payload(row)
      if (![value.toolUseId, value.providerCallId, value.providerToolName, value.toolName, value.modelRequestId].every(nonempty)) { settlement.identityConflicts += 1; continue }
      const id = String(value.toolUseId), requestId = String(value.modelRequestId), request = audit.requests.get(requestId)
      const joined = request?.sessionId === row.session_id && request.tools.get(String(value.providerToolName)) === value.toolName
      if (!joined) settlement.identityConflicts += 1
      settlement.inputs += 1; inputCounts.set(id, (inputCounts.get(id) ?? 0) + 1); inputRequests.set(id, requestId)
      const alias = `${requestId}:${String(value.providerCallId)}`, prior = providerAliases.get(alias)
      if (prior !== undefined && prior !== id) settlement.identityConflicts += 1
      providerAliases.set(alias, id)
      if (joined && expectation.executableToolNames.has(String(value.toolName))) executableCount += 1
    }
    // Version 2 is the same result with large text moved to content rows; the
    // identity and outcome fields are unchanged.
    for (const row of db.query<EventRow, []>("select type, version, actor, payload from event where type = 'tool.result.recorded' and version in (1, 2) and actor = 'flywheel'").iterate()) {
      const value = payload(row)
      if (!nonempty(value.toolUseId) || !nonempty(value.outcome)) { settlement.identityConflicts += 1; continue }
      const id = value.toolUseId
      settlement.results += 1; resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1)
      if (value.modelRequestId !== undefined && inputRequests.get(id) !== value.modelRequestId) settlement.identityConflicts += 1
    }
    for (const [id, inputCount] of inputCounts) { if (inputCount > 1) settlement.duplicateInputs += inputCount - 1; if (!resultCounts.has(id)) settlement.missing += 1 }
    for (const [id, resultCount] of resultCounts) { if (resultCount > 1) settlement.duplicateResults += resultCount - 1; if (!inputCounts.has(id)) settlement.orphan += 1 }
    let requestsComplete = audit.valid && inputRequests.size > 0
    for (const requestId of new Set(inputRequests.values())) {
      if (!requestsComplete) break
      const request = audit.requests.get(requestId)
      requestsComplete = request !== undefined && await completeRequest(request, readSurface)
    }
    const after = fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("evidence identity changed")
    return { settlement, requestAuditValid: requestsComplete, commandObserved: executableCount >= expectation.minimumCardinality, identity }
  } finally { db.close(); closeSync(descriptor) }
}
function settled(value: ToolSettlement): boolean { return value.missing === 0 && value.orphan === 0 && value.duplicateInputs === 0 && value.duplicateResults === 0 && value.identityConflicts === 0 }
function failure(row: Omit<AnalyzerTrialRow, "failure">, result: JsonMap | undefined): FailureClass | null { if (!row.discovered) return "missing_trial"; if (!row.storeValid) return "unreadable_store"; if (!row.adapterSettled) return "adapter_invalid"; if (!row.verifierValid) return "verifier_invalid"; if (!row.requestAuditValid) return "request_audit_invalid"; if (!settled(row.toolSettlement)) return "tool_settlement_invalid"; if (row.commandExpected && !row.commandObserved) return "command_expectation_failed"; const exception = object(result?.exception_info)?.exception_type; if (nonempty(exception)) return "provider_failure"; if (row.reward === 0 && row.commandObserved) return "genuine_command_failure"; if (row.reward === 0) return "genuine_model_failure"; return null }
async function discoveredTrials(root: string): Promise<Map<string, { directory: string; result?: JsonMap }[]>> { const byTask = new Map<string, { directory: string; result?: JsonMap }[]>(); for (const entry of await readdir(root, { withFileTypes: true })) { if (!entry.isDirectory() || entry.isSymbolicLink()) continue; const directory = join(root, entry.name), result = await json(join(directory, "result.json")), task = result?.task_name, key = typeof task === "string" ? task : "__unknown__", rows = byTask.get(key) ?? []; rows.push({ directory, result }); byTask.set(key, rows) } for (const rows of byTask.values()) rows.sort((a, b) => a.directory.localeCompare(b.directory)); return byTask }
function parseManifest(manifest: JsonMap): { rows: ExpectedRow[]; expectation: CommandExpectation } { const tasks = manifest.requested_tasks, attempts = manifest.attempts, denominator = manifest.expected_trials, rows = manifest.expected_rows, command = object(manifest.command_expectation); if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every(nonempty) || new Set(tasks).size !== tasks.length || !Number.isInteger(attempts) || Number(attempts) <= 0 || !Number.isInteger(denominator) || Number(denominator) <= 0 || denominator !== tasks.length * Number(attempts)) throw new Error("run manifest has an invalid expected trial denominator"); const expected = tasks.flatMap((task) => Array.from({ length: Number(attempts) }, (_, index) => ({ task, attempt: index + 1 }))); if (!Array.isArray(rows) || JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error("run manifest is missing exact expected rows"); const names = command?.executable_tool_names, profile = manifest.expected_interaction_profile; if (command?.version !== 1 || !Array.isArray(names) || names.length === 0 || !names.every(nonempty) || new Set(names).size !== names.length || !Number.isInteger(command.minimum_cardinality) || Number(command.minimum_cardinality) <= 0 || !nonempty(profile)) throw new Error("run manifest has an invalid command expectation"); return { rows: expected, expectation: { version: 1, executableToolNames: new Set(names), minimumCardinality: Number(command.minimum_cardinality), interactionProfile: profile } } }

/** Analyzes the exact trial set declared by a run manifest without executing a child process. */
export async function analyzeToolOutcomes(root: string, manifest: JsonMap): Promise<ToolOutcomeAnalysis> {
  const contract = parseManifest(manifest), found = await discoveredTrials(resolve(root)), rows: AnalyzerTrialRow[] = []
  const expectedCountByTask = new Map<string, number>()
  for (const row of contract.rows) expectedCountByTask.set(row.task, (expectedCountByTask.get(row.task) ?? 0) + 1)
  for (const expected of contract.rows) {
    const taskRows = found.get(expected.task) ?? [], discovered = taskRows[expected.attempt - 1], id = discovered?.result?.trial_name, summary = discovered ? await json(join(discovered.directory, "agent", "flywheel-run-summary.json")) : undefined
    let storeValid = false, requestAuditValid = false, commandObserved = false, toolSettlement = emptySettlement()
    if (discovered && summary) try { const path = join(discovered.directory, "agent", "state", ".flywheel", "flywheel.sqlite"), analysis = await analyzeStore(path, contract.expectation); if (summary.evidence_sha256 !== analysis.identity.sha256 || summary.evidence_size !== analysis.identity.size) throw new Error("evidence digest mismatch"); storeValid = true; requestAuditValid = analysis.requestAuditValid; commandObserved = analysis.commandObserved; toolSettlement = analysis.settlement } catch {}
    const score = reward(discovered?.result), base = { id: typeof id === "string" ? id : `${expected.task}#${expected.attempt}`, task: expected.task, expected: true, discovered: discovered !== undefined, storeValid, adapterSettled: summary?.adapter_settlement === "normal" && summary?.evidence_exported === true && summary?.project_root === summary?.execution_cwd && summary?.profile_sha256 === manifest.profile_sha256 && typeof summary?.source_archive_sha256 === "string" && summary.source_archive_sha256 === manifest.source_archive_sha256, verifierValid: score !== null, requestAuditValid, toolSettlement, commandExpected: true, commandObserved, reward: score }
    rows.push({ ...base, failure: failure(base, discovered?.result) })
    if (expected.attempt === expectedCountByTask.get(expected.task)) { for (const extra of taskRows.slice(expected.attempt)) rows.push({ id: String(extra.result?.trial_name ?? extra.directory), task: expected.task, expected: false, discovered: true, storeValid: false, adapterSettled: false, verifierValid: false, requestAuditValid: false, toolSettlement: emptySettlement(), commandExpected: true, commandObserved: false, reward: reward(extra.result), failure: "adapter_invalid" }); found.delete(expected.task) }
  }
  for (const [task, extras] of found) for (const extra of extras) rows.push({ id: String(extra.result?.trial_name ?? extra.directory), task, expected: false, discovered: true, storeValid: false, adapterSettled: false, verifierValid: false, requestAuditValid: false, toolSettlement: emptySettlement(), commandExpected: true, commandObserved: false, reward: reward(extra.result), failure: "adapter_invalid" })
  const ids = new Map<string, number>(); for (const row of rows) ids.set(row.id, (ids.get(row.id) ?? 0) + 1); for (const row of rows) if ((ids.get(row.id) ?? 0) > 1) row.failure = "adapter_invalid"
  const infrastructureFailures = new Set<FailureClass>(["missing_trial", "unreadable_store", "adapter_invalid", "verifier_invalid", "request_audit_invalid", "tool_settlement_invalid", "command_expectation_failed"]), infrastructureValid = rows.length === contract.rows.length && rows.every((row) => row.expected && (row.failure === null || !infrastructureFailures.has(row.failure)))
  return { version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, denominator: contract.rows.length, rows, infrastructureValid, comparisonAvailable: infrastructureValid }
}

async function main(): Promise<number> {
  const root = process.argv[2], manifestPath = process.argv[3] ?? (root ? join(root, "run_manifest.json") : undefined); if (!root || !manifestPath) throw new Error("Usage: bun analyze-tool-outcomes.ts <trials-directory> [run-manifest]")
  const manifest = await json(manifestPath); if (!manifest) throw new Error(`missing or malformed run manifest: ${manifestPath}`)
  const analysis = await analyzeToolOutcomes(root, manifest)
  console.log(JSON.stringify(analysis, undefined, 2))
  return analysis.infrastructureValid ? 0 : 1
}
if (import.meta.main) main().then((code) => { process.exitCode = code }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })