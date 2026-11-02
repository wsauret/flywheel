import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../src/infra/paths.js"
import type { ReleaseMemoryEvidence } from "../../../src/infra/startup-trace.js"
import { readDescendantUsage, readStoredSessionSummary } from "../../../src/orchestration/session/session-summary-index-sql.js"
import { budgetSummaryFromState } from "../../../src/orchestration/session/budget-summary.js"
import { initialBudgetProjectionState } from "../../../src/orchestration/session/budget-projection.js"
import { inspectUpgradeFixture, WORKFLOW_UPGRADE_WORKLOAD } from "../fixtures/workflow-agent-previous-shape.js"
import type { MetricValues } from "../lib/metrics.js"
import type { WorkflowAgentMigrationMetrics } from "../types.js"
import type { ScenarioContext, ScenarioResult } from "./scenario-context.js"
import { runStartupScenario } from "./startup.js"

/** Reads durable conversion evidence, including no-op fingerprints. No projection can repair these observations. */
export function readUpgradeState(dbFile: string) {
  const db = new Database(dbFile, { readonly: true })
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n
  try {
    // TUI opens create unrelated empty chats. Fingerprint the fixture owners and their converted members only.
    const owners = "session_id like 'upgrade-%' or session_id in (select session_id from event where type='session.created' and json_valid(payload) and json_extract(payload,'$.workflowMembership.workflowId') like 'upgrade-%')"
    const facts = db.query(`select id, aggregate_id, session_id, type, version, payload from event where ${owners} order by position`).all()
    const inFlight = db.query(`select session_id, kind, key, payload from in_flight where ${owners} order by session_id, kind, key`).all()
    return {
      convertedWorkflows: count("select count(*) as n from event where type='session.representation.retired' and json_extract(payload,'$.migrationId')='workflow-agent-session-ownership'"),
      convertedGenerations: count("select count(*) as n from event where type='session.created' and json_extract(payload,'$.kind')='workflow-agent' and json_extract(payload,'$.workflowMembership.kind')!='historical-follow-up'"),
      followUps: count("select count(*) as n from event where type='session.created' and json_extract(payload,'$.workflowMembership.kind')='historical-follow-up'"),
      residualGapCount: count("select coalesce(sum(json_array_length(json_extract(payload,'$.recovery'))),0) as n from event where type='session.representation.retired'"),
      providerRequests: count("select count(*) as n from event where type='model.request.dispatched'"),
      fingerprint: createHash("sha256").update(JSON.stringify({ facts, inFlight })).digest("hex"),
      conversationAppends: db.query<{ type: string; origin: string; count: number }, []>(
        "select e.type, coalesce(json_extract(j.value,'$.message.origin'),'none') as origin, count(*) as count from event e, json_each(e.payload,'$.entries') j where e.type='chat.entries.appended' and e.session_id like 'upgrade-%' group by e.type, origin order by e.type, origin",
      ).all(),
      admittedDeletions: db.query("select session_id, kind, key, payload from in_flight where kind='session.subagent_recursive_deletion' order by session_id").all(),
      deletedSessions: db.query<{ sessionId: string }, []>("select session_id as sessionId from event where type='session.deleted' order by session_id").all().map(row => row.sessionId),
      nestedParents: db.query("select session_id, json_extract(payload,'$.launchedFrom.parentSessionId') as parent from event where type='session.created' and json_extract(payload,'$.kind')='subagent' order by session_id").all(),
    }
  } finally { db.close() }
}

/** D requires a no-op second open. The old binary's recovery churn is evidence only. */
export function secondOpenFailures(first: ReturnType<typeof readUpgradeState>, reopened: ReturnType<typeof readUpgradeState>, role: ScenarioContext["measurementRole"]): string[] {
  return role === "candidate" && reopened.fingerprint !== first.fingerprint
    ? ["second open changed durable facts, accounting, retained input, or notices"]
    : []
}

const STATE_OWNER_ROLES = ["project-state", "workspace-preparation"]
const SUMMARY_ROLE = "session-summary"

/** Peak heap belongs to the state owner, including synchronous phase observations, not the executor or the harness. */
export function upgradeMemoryMetrics(evidence: readonly ReleaseMemoryEvidence[], runId: string) {
  const owners = evidence.filter(record => record.runId === runId && STATE_OWNER_ROLES.includes(record.role))
  if (owners.length !== 1 || owners[0]!.samples.length === 0) throw new Error("upgrade requires one measured state-owner")
  const samples = owners[0]!.samples
  if (samples.some(sample => !Number.isFinite(sample.heapUsed) || !Number.isFinite(sample.rss))) throw new Error("state-owner memory is not finite")
  const begin = samples.find(sample => sample.phase === "conversion.begin")
  const end = samples.findLast(sample => sample.phase === "conversion.end")
  return {
    peakHeapMiB: Math.max(...samples.map(sample => sample.heapUsed)) / 1024 ** 2,
    peakRssMiB: Math.max(...samples.map(sample => sample.rss)) / 1024 ** 2,
    ...(begin && end ? { conversionMs: end.timestampMs - begin.timestampMs } : {}),
  }
}

/** Reads the state-owner and summary records of one open; each sampler names its file `<role>-<pid>.json`.
 * Both write when their startup work ends. The executor writes its record at shutdown, and the harness kills it after a
 * two-second grace, so that file can be empty. The upgrade does not measure the executor, so it is never read. */
export function readUpgradeMemoryEvidence(directory: string): ReleaseMemoryEvidence[] {
  return readdirSync(directory)
    .filter(file => [...STATE_OWNER_ROLES, SUMMARY_ROLE].includes(file.replace(/-\d+\.json$/u, "")))
    .map(file => JSON.parse(readFileSync(join(directory, file), "utf8")))
}

function summaryRebuildMs(evidence: readonly ReleaseMemoryEvidence[]): number {
  const intervals = evidence.filter(record => record.role === SUMMARY_ROLE).flatMap(record => {
    const begin = record.samples.find(sample => sample.phase === "summary.begin")
    const end = record.samples.findLast(sample => sample.phase === "summary.end")
    return begin && end ? [end.timestampMs - begin.timestampMs] : []
  })
  if (intervals.length === 0) throw new Error("first open has no summary-rebuild interval")
  return Math.max(...intervals)
}

/** A failed open retains frame evidence but never supplies a readiness duration. */
export function upgradeReadiness(result: ScenarioResult, label: string) {
  const failures = result.failures.map(failure => `${label}: ${failure}`)
  const ready = result.metrics["startup.large.readyMs"]
  const list = result.metrics["startup.large.sessionListMs"]
  if (ready === undefined || list === undefined) failures.push(`${label}: upgrade readiness requires chat input mode ready and a hydrated catalog`)
  return {
    firstFrameMs: result.metrics["startup.large.firstFrameMs"],
    readyMs: failures.length > 0 || ready === undefined || list === undefined ? undefined : Math.max(ready, list),
    failures,
  }
}

async function open(context: ScenarioContext, suffix: string) {
  const evidenceDir = join(context.evidenceDir, suffix)
  const directory = join(evidenceDir, "memory")
  mkdirSync(directory, { recursive: true })
  const runId = `${context.sessionName}-${suffix}`
  const result = await runStartupScenario({
    ...context, evidenceDir, sessionName: runId,
    environment: { ...context.environment, FLYWHEEL_RELEASE_MEMORY_DIRECTORY: directory, FLYWHEEL_RELEASE_MEMORY_RUN: runId },
  }, "startup.large", 10 * 60_000)
  return { ...upgradeReadiness(result, suffix), evidence: readUpgradeMemoryEvidence(directory), runId }
}

/** Collects first-open evidence without substituting a duration for failed readiness. */
export function firstOpenEvidence(first: Awaited<ReturnType<typeof open>>, state: ReturnType<typeof readUpgradeState>): ScenarioResult {
  const failures = [...first.failures]
  const values: Partial<WorkflowAgentMigrationMetrics> = {
    firstFrameMs: first.firstFrameMs, firstOpenReadyMs: first.readyMs, convertedWorkflows: state.convertedWorkflows,
    convertedGenerations: state.convertedGenerations, residualGapCount: state.residualGapCount,
  }
  try { Object.assign(values, upgradeMemoryMetrics(first.evidence, first.runId)) }
  catch (error) { failures.push(String(error)) }
  try { Object.assign(values, { summaryRebuildMs: summaryRebuildMs(first.evidence) }) }
  catch (error) { failures.push(String(error)) }
  const metrics: MetricValues = {}
  for (const [key, value] of Object.entries(values)) if (value !== undefined) metrics[`workflowAgentMigration.${key}`] = value
  return { metrics, failures }
}

/** Measures fresh old bytes twice through the installed TUI. M16 owns budget enforcement and repetition. */
export async function runWorkflowAgentUpgradeScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const metrics: MetricValues = {}
  const failures: string[] = []
  const frozen = process.env.FLYWHEEL_RELEASE_UPGRADE_FIXTURE
  if (!frozen) return { metrics, failures: ["workflow-agent-upgrade requires its frozen pre-D fixture"] }
  const manifest = JSON.parse(readFileSync(join(frozen, "fixture.json"), "utf8"))
  if (JSON.stringify(manifest.workload) !== JSON.stringify(WORKFLOW_UPGRADE_WORKLOAD)) throw new Error("upgrade requires the full declared nonzero workload")
  writeFileSync(join(context.evidenceDir, "fixture.json"), JSON.stringify(manifest, null, 2))
  const dbFile = resolveEventStoreDbFile(context.workDir)
  try {
    copyFileSync(join(frozen, "previous.sqlite"), dbFile)
    cpSync(join(frozen, "sessions"), join(context.workDir, ".flywheel", "sessions"), { recursive: true })
    const before = inspectUpgradeFixture(dbFile)
    const untouched = readUpgradeState(dbFile)
    if (JSON.stringify(before) !== JSON.stringify(manifest.counts)) throw new Error("untouched previous-shape fixture counters differ")
    const first = await open(context, "first")
    const state = readUpgradeState(dbFile)
    const collected = firstOpenEvidence(first, state)
    Object.assign(metrics, collected.metrics)
    failures.push(...collected.failures)
    writeFileSync(join(context.evidenceDir, "first-open.json"), JSON.stringify({ metrics, failures }, null, 2))
    if (state.providerRequests !== 0) throw new Error("upgrade dispatched provider work")
    if (context.measurementRole === "candidate" && (state.convertedWorkflows !== manifest.expected.workflows || state.convertedGenerations !== manifest.expected.generations || state.followUps !== manifest.expected.followUps)) throw new Error("first open did not convert every expected survivor")
    const summary = new Database(resolveSessionSummaryDbFile(context.workDir), { readonly: true })
    try {
      const parent = readStoredSessionSummary(summary, "upgrade-parent")
      const total = budgetSummaryFromState(parent?.budget ?? initialBudgetProjectionState(), readDescendantUsage(summary, "upgrade-parent"))
      const workflows = Array.from({ length: manifest.workload.workflows }, (_, index) => {
        const owner = context.measurementRole === "candidate" ? `workflow:upgrade-${index}` : `upgrade-${index}`
        const local = readStoredSessionSummary(summary, owner)
        if (!local || local.budget.totalInputTokens !== 20 || local.budget.totalOutputTokens !== 8 || Math.round(local.budget.totalCost * 1e6) !== 150_000) throw new Error(`workflow-local residual summary differs for ${owner}`)
        return { owner, budget: local.budget }
      })
      if (context.measurementRole === "candidate" && (total.totalTokens !== manifest.workload.workflows * 28
        || total.outputTokens !== manifest.workload.workflows * 8 || Math.round(total.totalCost * 1e6) !== manifest.workload.workflows * 150_000)) throw new Error("candidate launching-chat ancestry differs from exact residual totals")
      writeFileSync(join(context.evidenceDir, "summary.json"), JSON.stringify({
        workflows, parentBudget: total, expectedParentBudget: { totalCost: manifest.workload.workflows * 0.15, totalTokens: manifest.workload.workflows * 28 },
        ...(context.measurementRole === "baseline" ? { parentAncestryGap: { scope: "pre-existing correctness evidence, not a paired performance metric", observed: total } } : {}),
      }, null, 2))
    } finally { summary.close() }
    const second = await open(context, "second")
    failures.push(...second.failures)
    const reopened = readUpgradeState(dbFile)
    if (second.readyMs !== undefined) metrics["workflowAgentMigration.secondOpenReadyMs"] = second.readyMs
    metrics["workflowAgentMigration.secondOpenConvertedWorkflows"] = reopened.convertedWorkflows - state.convertedWorkflows
    failures.push(...secondOpenFailures(state, reopened, context.measurementRole))
    writeFileSync(join(context.evidenceDir, "conversion.json"), JSON.stringify({
      before, untouched, state, reopened,
      secondOpenReadiness: "reported only, not a paired budget; baseline recovery churn can skew this interval",
      oneSided: context.measurementRole === "baseline" ? ["conversionMs", "ownership conversion", "recovery conversation appends"] : [],
    }, null, 2))

    // The deletion fixture is a separate copy: it must never replace either measured first-open input.
    const deletionWork = join(context.workDir, "deletion")
    mkdirSync(join(deletionWork, ".flywheel"), { recursive: true })
    copyFileSync(join(frozen, "deletion.sqlite"), resolveEventStoreDbFile(deletionWork))
    cpSync(join(frozen, "sessions"), join(deletionWork, ".flywheel", "sessions"), { recursive: true })
    const deletionBefore = readUpgradeState(resolveEventStoreDbFile(deletionWork))
    const deletion = await open({ ...context, workDir: deletionWork }, "deletion")
    failures.push(...deletion.failures)
    const deletionAfter = readUpgradeState(resolveEventStoreDbFile(deletionWork))
    if (context.measurementRole === "candidate" && (deletionAfter.convertedWorkflows !== manifest.expected.deletionWorkflows || deletionAfter.convertedGenerations !== manifest.expected.deletionGenerations)) throw new Error("admitted deletion did not preserve declared conversion survivors")
    if (JSON.stringify(deletionAfter.deletedSessions) !== JSON.stringify(["upgrade-0"]) || deletionAfter.admittedDeletions.length !== 0) throw new Error("startup did not complete exactly the admitted deletion targets")
    if (JSON.stringify(deletionBefore.nestedParents) !== JSON.stringify(deletionAfter.nestedParents)) throw new Error("admitted root-only deletion changed retained nested topology")
    writeFileSync(join(context.evidenceDir, "deletion.json"), JSON.stringify({ before: deletionBefore, after: deletionAfter }, null, 2))
  } catch (error) { failures.push(`workflow-agent-upgrade: ${String(error)}`) }
  return { metrics, failures }
}
