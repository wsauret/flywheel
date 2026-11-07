import { lstat, readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isAgentTimeout } from "./disclosure-ledger.js"
import { decodeTrialStoreAnalysis, emptySettlement, nonempty, object, TRIAL_STORE_ANALYSIS_NAME, type ToolSettlement, type TrialStoreAnalysis } from "./trial-store-analysis.js"

export type JsonMap = Record<string, unknown>
type FailureClass = "missing_trial" | "agent_timeout" | "unreadable_store" | "adapter_invalid" | "verifier_invalid" | "request_audit_invalid" | "tool_settlement_invalid" | "command_expectation_failed" | "provider_failure" | "genuine_command_failure" | "genuine_model_failure"
export interface AnalyzerTrialRow { id: string; task: string; expected: boolean; discovered: boolean; storeValid: boolean; adapterSettled: boolean; verifierValid: boolean; requestAuditValid: boolean; toolSettlement: ToolSettlement; commandExpected: boolean; commandObserved: boolean; reward: number | null; failure: FailureClass | null }
export interface ToolOutcomeAnalysis { version: 2; denominator: number; rows: AnalyzerTrialRow[]; infrastructureValid: boolean; comparisonAvailable: boolean }
interface ExpectedRow { task: string; attempt: number }
interface CommandExpectation { version: 1; executableToolNames: Set<string>; minimumCardinality: number; interactionProfile: string }

// Version 2 reads the provider-request audit through the product projection
// instead of pinned fact versions, so a version 1 summary is not comparable.
export const TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION = 2 as const
export const TOOL_OUTCOME_ANALYZER_RESULT_VERSION = 2 as const

async function json(path: string): Promise<JsonMap | undefined> { try { return object(JSON.parse(await readFile(path, "utf8"))) } catch { return undefined } }
function reward(result: JsonMap | undefined): number | null { const value = object(object(result?.verifier_result)?.rewards)?.reward; return typeof value === "number" && Number.isFinite(value) ? value : null }
async function absent(path: string): Promise<boolean> { return lstat(path).then(() => false, (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT") }

/** A trial's store evidence judged against the run's expectation. */
function judged(analysis: TrialStoreAnalysis, expectation: CommandExpectation): { requestAuditValid: boolean; commandObserved: boolean } {
  let executable = 0
  for (const name of expectation.executableToolNames) executable += analysis.executableToolInputs[name] ?? 0
  return { requestAuditValid: analysis.requestAuditComplete && analysis.interactionProfiles.every((profile) => profile === expectation.interactionProfile), commandObserved: executable >= expectation.minimumCardinality }
}

function settled(value: ToolSettlement): boolean { return value.missing === 0 && value.orphan === 0 && value.duplicateInputs === 0 && value.duplicateResults === 0 && value.identityConflicts === 0 }
function failure(row: Omit<AnalyzerTrialRow, "failure">, result: JsonMap | undefined, timeoutWithoutSummary: boolean): FailureClass | null { if (!row.discovered) return "missing_trial"; if (timeoutWithoutSummary) return "agent_timeout"; if (!row.storeValid) return "unreadable_store"; if (!row.adapterSettled) return "adapter_invalid"; if (!row.verifierValid) return "verifier_invalid"; if (!row.requestAuditValid) return "request_audit_invalid"; if (!settled(row.toolSettlement)) return "tool_settlement_invalid"; if (row.commandExpected && !row.commandObserved) return "command_expectation_failed"; const exception = object(result?.exception_info)?.exception_type; if (nonempty(exception)) return "provider_failure"; if (row.reward === 0 && row.commandObserved) return "genuine_command_failure"; if (row.reward === 0) return "genuine_model_failure"; return null }
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
    // A trial's logs hold the analysis of its store, never the store.
    if (discovered && summary) try { const analysis = decodeTrialStoreAnalysis(JSON.parse(await readFile(join(discovered.directory, "agent", TRIAL_STORE_ANALYSIS_NAME), "utf8"))); if (summary.evidence_sha256 !== analysis.store.sha256 || summary.evidence_size !== analysis.store.size) throw new Error("evidence digest mismatch"); ({ requestAuditValid, commandObserved } = judged(analysis, contract.expectation)); storeValid = true; toolSettlement = analysis.toolSettlement } catch {}
    const score = reward(discovered?.result), base = { id: typeof id === "string" ? id : `${expected.task}#${expected.attempt}`, task: expected.task, expected: true, discovered: discovered !== undefined, storeValid, adapterSettled: summary?.adapter_settlement === "normal" && summary?.evidence_exported === true && summary?.project_root === summary?.execution_cwd && summary?.profile_sha256 === manifest.profile_sha256 && typeof summary?.source_archive_sha256 === "string" && summary.source_archive_sha256 === manifest.source_archive_sha256, verifierValid: score !== null, requestAuditValid, toolSettlement, commandExpected: true, commandObserved, reward: score }
    // A malformed summary is not an absent one: only a missing file is the agent timeout shape.
    const timeoutWithoutSummary = discovered !== undefined && isAgentTimeout(discovered.result) && await absent(join(discovered.directory, "agent", "flywheel-run-summary.json"))
    rows.push({ ...base, failure: failure(base, discovered?.result, timeoutWithoutSummary) })
    if (expected.attempt === expectedCountByTask.get(expected.task)) { for (const extra of taskRows.slice(expected.attempt)) rows.push({ id: String(extra.result?.trial_name ?? extra.directory), task: expected.task, expected: false, discovered: true, storeValid: false, adapterSettled: false, verifierValid: false, requestAuditValid: false, toolSettlement: emptySettlement(), commandExpected: true, commandObserved: false, reward: reward(extra.result), failure: "adapter_invalid" }); found.delete(expected.task) }
  }
  for (const [task, extras] of found) for (const extra of extras) rows.push({ id: String(extra.result?.trial_name ?? extra.directory), task, expected: false, discovered: true, storeValid: false, adapterSettled: false, verifierValid: false, requestAuditValid: false, toolSettlement: emptySettlement(), commandExpected: true, commandObserved: false, reward: reward(extra.result), failure: "adapter_invalid" })
  const ids = new Map<string, number>(); for (const row of rows) ids.set(row.id, (ids.get(row.id) ?? 0) + 1); for (const row of rows) if ((ids.get(row.id) ?? 0) > 1) row.failure = "adapter_invalid"
  const infrastructureFailures = new Set<FailureClass>(["missing_trial", "unreadable_store", "adapter_invalid", "verifier_invalid", "request_audit_invalid", "tool_settlement_invalid", "command_expectation_failed"]), infrastructureValid = rows.length === contract.rows.length && rows.every((row) => row.expected && (row.failure === null || !infrastructureFailures.has(row.failure)))
  return { version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, denominator: contract.rows.length, rows, infrastructureValid, comparisonAvailable: infrastructureValid }
}

/** `bun analyze-tool-outcomes.ts <trials-directory> [run-manifest]` analyzes a
 *  run and exits 1 unless its infrastructure is valid. */
async function main(): Promise<number> {
  const root = process.argv[2], manifestPath = process.argv[3] ?? (root ? join(root, "run_manifest.json") : undefined); if (!root || !manifestPath) throw new Error("Usage: bun analyze-tool-outcomes.ts <trials-directory> [run-manifest]")
  const manifest = await json(manifestPath); if (!manifest) throw new Error(`missing or malformed run manifest: ${manifestPath}`)
  const analysis = await analyzeToolOutcomes(root, manifest)
  console.log(JSON.stringify(analysis, undefined, 2))
  return analysis.infrastructureValid ? 0 : 1
}
if (import.meta.main) main().then((code) => { process.exitCode = code }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })