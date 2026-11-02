import { Database } from "bun:sqlite"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { accountServeRecordPath, accountServeSocketPath, accountServeTokenPath, resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../src/infra/paths.js"
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js"
import { openReadonlyEventReader } from "../../../src/infra/sqlite-event-store.js"
import { createSocketRuntimeClient } from "../../../src/orchestration/app-service/socket-runtime-client.js"
import { acquireSessionSummaryIndex } from "../../../src/orchestration/session/session-summary-index.js"
import { encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import {
  LARGE_SESSION_SUMMARY_HISTORY,
  SESSION_SUMMARY_FIXTURE_FACT_TYPES,
  createSessionSummaryHistoryFixture,
  createStaleSessionSummaryIndex,
} from "../../fixtures/session-summary-history.js"
import { readDebugLogRecords } from "../lib/debug-log-reader.js"
import type { MetricValues } from "../lib/metrics.js"
import { percentile } from "../lib/metrics.js"
import type { ScenarioContext, ScenarioResult } from "./scenario-context.js"

const READY_TIMEOUT_MS = 60_000
const TARGET_SESSION = `session-${LARGE_SESSION_SUMMARY_HISTORY.sessions - 1}`
const SEARCHABLE_SESSION_COUNT = LARGE_SESSION_SUMMARY_HISTORY.sessions
/** The account attach token: 32 random bytes in unpadded base64url. */
const WHOLE_TOKEN = /^[A-Za-z0-9_-]{43}$/u

async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  const deadline = performance.now() + READY_TIMEOUT_MS
  while (performance.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function stopServe(child: Bun.Subprocess, userDataRoot: string): Promise<void> {
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL")
    await child.exited
  }
  await waitFor("serve identity removal", () => existsSync(accountServeRecordPath(userDataRoot, "installed")) ? undefined : true)
}

interface FixedTypeProbeResult {
  readonly unindexedPlans: number
}

interface WarmOpenResult {
  readonly elapsedMs: number
  readonly rows: number
}

function fixedTypeProbes(dbFile: string): FixedTypeProbeResult {
  const db = new Database(dbFile, { readonly: true })
  let indexedPlans = 0
  try {
    for (const type of SESSION_SUMMARY_FIXTURE_FACT_TYPES) {
      const plan = db.query<{ detail: string }, [string]>(
        "explain query plan select position from event indexed by event_type_idx where type = ? order by position desc limit 1",
      ).all(type)
      if (plan.some((row) => row.detail.includes("event_type_idx") && row.detail.includes("type=?"))) indexedPlans++
    }
  } finally {
    db.close()
  }
  return { unindexedPlans: SESSION_SUMMARY_FIXTURE_FACT_TYPES.length - indexedPlans }
}

async function productionFreshnessP95(projectRoot: string): Promise<number> {
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(projectRoot))
  const index = acquireSessionSummaryIndex(
    resolveSessionSummaryDbFile(projectRoot),
    asAsyncEventReadSurface(reader),
    { shared: false },
  )
  const durations: number[] = []
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const started = performance.now()
      const result = await index.readImmediate([TARGET_SESSION])
      durations.push(performance.now() - started)
      if (result.status !== "ready") throw new Error("production freshness read was not ready")
    }
  } finally {
    await index.dispose()
    reader.close()
  }
  return percentile(durations, 95)
}

/** Returns why the late adoption total is wrong, or undefined when it is
 *  right. A chat that the migration created to adopt a workflow counts only
 *  that workflow's subtree. The conversion retires the workflow session, so
 *  the subtree's total lives on its `workflow:<id>` aggregate. The adopter's
 *  total comes from the recompute that a new ancestry edge starts after the
 *  usage, and the aggregate's total comes from the incremental fold of the
 *  same requests, so the two must agree. */
async function adoptedTotalMismatch(projectRoot: string): Promise<string | undefined> {
  const events = new Database(resolveEventStoreDbFile(projectRoot), { readonly: true })
  let adoption: { workflow: string; adopter: string } | null
  try {
    adoption = events.query<{ workflow: string; adopter: string }, []>(`
      select session_id as workflow, json_extract(payload, '$.parentSessionId') as adopter from event
      where type = 'session.ownership.adopted' and json_extract(payload, '$.parentSessionId') not like 'session-%'
      order by position limit 1`).get()
  } finally {
    events.close()
  }
  if (!adoption) return "the migration created no adopting chat"
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(projectRoot))
  const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(projectRoot), asAsyncEventReadSurface(reader), { shared: false })
  try {
    const aggregate = `workflow:${adoption.workflow}`
    const result = await index.readImmediate([adoption.adopter, aggregate])
    if (result.status !== "ready") return "adoption totals were not ready after the rebuild"
    const adopter = result.summaries.get(adoption.adopter)?.budget
    const workflow = result.summaries.get(aggregate)?.budget
    if (!adopter || !workflow || workflow.totalCost <= 0
      || adopter.totalCost !== workflow.totalCost || adopter.totalTokens !== workflow.totalTokens) {
      return `adopting chat totals ${JSON.stringify(adopter)} differ from workflow ${adoption.workflow} totals ${JSON.stringify(workflow)}`
    }
    return undefined
  } finally {
    await index.dispose()
    reader.close()
  }
}

function warmOpenRows(projectRoot: string): WarmOpenResult {
  const started = performance.now()
  const db = new Database(resolveSessionSummaryDbFile(projectRoot), { readonly: true })
  try {
    const rows = db.query<{ session_id: string }, []>("select session_id from session_summary_local order by session_id").all()
    return { elapsedMs: performance.now() - started, rows: rows.length }
  } finally {
    db.close()
  }
}

function observedNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`summary page diagnostic has no finite ${field}`)
  return value
}

/** Candidate-only installed scenario for passive summary reads and real derived-index rebuild work. */
export async function runSessionSummaryScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const metrics: MetricValues = {}
  const failures: string[] = []
  const userDataRoot = join(context.workDir, ".flywheel")
  const stderrPath = join(context.evidenceDir, "serve.stderr.log")
  const stdoutPath = join(context.evidenceDir, "serve.stdout.log")
  let child: Bun.Subprocess | undefined
  let client: ReturnType<typeof createSocketRuntimeClient> | undefined
  try {
    const dimensions = createSessionSummaryHistoryFixture(context.workDir)
    if (dimensions.relevantFacts !== 530_000 || dimensions.semanticUsageIds !== 59_000 || dimensions.sessions !== 633) {
      throw new Error(`fixture dimensions ${JSON.stringify(dimensions)} do not equal 530000 facts, 59000 semantic ids, 633 sessions`)
    }
    writeFileSync(join(context.evidenceDir, "fixture-dimensions.json"), `${JSON.stringify(dimensions, null, 2)}\n`)
    child = Bun.spawn([context.binaryPath, "serve"], {
      cwd: context.workDir,
      env: {
        ...process.env,
        ...context.environment,
        HOME: context.workDir,
        FLYWHEEL_PROJECT_ROOT: context.workDir,
        FLYWHEEL_DISABLE_AUTOUPDATE: "1",
        FLYWHEEL_LOG_LEVEL: "DEBUG",
        // The runtime client holds the project throughout measurement; release starts cleanup's short idle grace.
        FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS: "1",
      },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
      windowsHide: true,
    })
    // The current service publishes only a whole token, but a build that
    // predates that publication can show the file before its token is in it,
    // so the wait ends at a whole token, never at the file.
    const credential = await waitFor("installed serve token", () => {
      if (child?.exitCode !== null) throw new Error(`serve exited with code ${child?.exitCode}: ${readFileSync(stderrPath, "utf8")}`)
      const tokenPath = accountServeTokenPath(userDataRoot, "installed")
      const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : ""
      return WHOLE_TOKEN.test(token) ? token : undefined
    })
    const attachStarted = performance.now()
    client = createSocketRuntimeClient({
      socketPath: accountServeSocketPath(userDataRoot, "installed"),
      ensureRuntime: async () => {},
      connectionPreface: () => new TextEncoder().encode(encodeAccountAttach({ projectRoot: context.workDir, credential, intent: "runtime" })),
    })
    const runtimeClient = client

    createStaleSessionSummaryIndex(context.workDir)
    let connected = false
    const rebuildStarted = performance.now()
    runtimeClient.subscribe(() => {})
    runtimeClient.onLane(() => { connected = true })
    await waitFor("runtime connection", () => connected ? true : undefined)
    await runtimeClient.query({ type: "statusSnapshot", sessionIds: [] })
    metrics["sessionSummary.migrationReadyMs"] = performance.now() - attachStarted
    const migratedDb = new Database(resolveEventStoreDbFile(context.workDir), { readonly: true })
    let rebuildTarget: number
    try {
      const adopted = migratedDb.query<{ count: number }, []>("select count(*) as count from event where type = 'session.ownership.adopted'").get()
      if (adopted?.count !== LARGE_SESSION_SUMMARY_HISTORY.workflows) throw new Error(`migration adopted ${adopted?.count} workflows, expected ${LARGE_SESSION_SUMMARY_HISTORY.workflows}`)
      const tail = migratedDb.query<{ position: number }, []>("select max(position) as position from event").get()
      if (!tail) throw new Error("migration left no event watermark")
      rebuildTarget = tail.position
    } finally {
      migratedDb.close()
    }
    // The subscription is the first cold trigger. The elapsed measurement
    // includes lazy worker construction; page CPU budgets measure replay alone.
    await runtimeClient.query({ type: "transcriptSearch", request: { query: "worker warmup", page: 1 } })
    await runtimeClient.query({ type: "sessionDetail", sessionId: TARGET_SESSION })
    await waitFor("active session summary replay", () => {
      const records = readDebugLogRecords(context.workDir).filter((record) => record.type === "session.summary.page")
      const through = records.at(-1)?.payload?.throughPosition
      return typeof through === "number" && through > 0 && through < LARGE_SESSION_SUMMARY_HISTORY.relevantFacts ? true : undefined
    })
    const coldDetails = await Promise.all(Array.from({ length: 5 }, async () => {
      const started = performance.now()
      const detail = await runtimeClient.query({ type: "sessionDetail", sessionId: TARGET_SESSION })
      return { detail, elapsedMs: performance.now() - started }
    }))
    if (coldDetails.some(({ detail }) => !detail.view)) throw new Error("cold session detail omitted the requested session")
    const coldDetailDurations = coldDetails.map(({ elapsedMs }) => elapsedMs)
    writeFileSync(join(context.evidenceDir, "cold-detail-durations.json"), JSON.stringify(coldDetailDurations))
    metrics["sessionSummary.detailColdRebuildP95Ms"] = percentile(coldDetailDurations, 95)
    metrics["sessionSummary.detailColdRebuildMaxMs"] = Math.max(...coldDetailDurations)

    const coldSearches = await Promise.all(Array.from({ length: 5 }, async () => {
      const started = performance.now()
      const result = await runtimeClient.query({ type: "transcriptSearch", request: { query: "searchable marker", page: 1 } })
      return { result, elapsedMs: performance.now() - started }
    }))
    const wrongColdSearch = coldSearches.find(({ result }) => result.total !== SEARCHABLE_SESSION_COUNT)
    if (wrongColdSearch) throw new Error(`cold transcript search returned ${wrongColdSearch.result.total} rows`)
    const coldSearchDurations = coldSearches.map(({ elapsedMs }) => elapsedMs)
    metrics["sessionSummary.searchColdRebuildP95Ms"] = percentile(coldSearchDurations, 95)
    metrics["sessionSummary.searchColdRebuildMaxMs"] = Math.max(...coldSearchDurations)
    const replayPositionAfterColdReads = readDebugLogRecords(context.workDir)
      .filter((record) => record.type === "session.summary.page")
      .at(-1)?.payload?.throughPosition
    if (typeof replayPositionAfterColdReads !== "number"
      || replayPositionAfterColdReads <= 0
      || replayPositionAfterColdReads >= LARGE_SESSION_SUMMARY_HISTORY.relevantFacts) {
      throw new Error("cold passive reads did not run while summary replay remained active")
    }

    await waitFor("session summary rebuild", () => {
      const records = readDebugLogRecords(context.workDir).filter((record) => record.type === "session.summary.page")
      const through = records.at(-1)?.payload?.throughPosition
      return typeof through === "number" && through >= rebuildTarget ? true : undefined
    })
    metrics["sessionSummary.totalRebuildMs"] = performance.now() - rebuildStarted
    const adoptionMismatch = await adoptedTotalMismatch(context.workDir)
    if (adoptionMismatch) throw new Error(adoptionMismatch)

    const warmDetailDurations: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      const detail = await runtimeClient.query({ type: "sessionDetail", sessionId: TARGET_SESSION })
      warmDetailDurations.push(performance.now() - started)
      if (!detail.view || detail.view.budget?.totalsLoading !== false) throw new Error("warm session detail did not expose ready totals")
    }
    metrics["sessionSummary.detailWarmP95Ms"] = percentile(warmDetailDurations, 95)

    const warmSearchDurations: number[] = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      const result = await runtimeClient.query({ type: "transcriptSearch", request: { query: "searchable marker", page: 1 } })
      warmSearchDurations.push(performance.now() - started)
      if (result.total !== SEARCHABLE_SESSION_COUNT) throw new Error(`warm transcript search returned ${result.total} rows`)
    }
    metrics["sessionSummary.searchWarmP95Ms"] = percentile(warmSearchDurations, 95)

    // Both child kinds remain in the summary index, but only chats enter navigation.
    const snapshot = await runtimeClient.query({ type: "snapshot" })
    if (snapshot.rows.length !== LARGE_SESSION_SUMMARY_HISTORY.listedSessions) throw new Error(`warm snapshot returned ${snapshot.rows.length} rows; the catalog lists ${LARGE_SESSION_SUMMARY_HISTORY.listedSessions}: the fixture's chats and ${LARGE_SESSION_SUMMARY_HISTORY.adoptingChats} adopting chats`)
    const warmRows = warmOpenRows(context.workDir)
    metrics["sessionSummary.warmOpen633RowsMs"] = warmRows.elapsedMs
    if (warmRows.rows !== LARGE_SESSION_SUMMARY_HISTORY.sessions) throw new Error(`warm summary open returned ${warmRows.rows} rows`)

    const probes = fixedTypeProbes(resolveEventStoreDbFile(context.workDir))
    metrics["sessionSummary.productionFreshnessP95Ms"] = await productionFreshnessP95(context.workDir)
    metrics["sessionSummary.unindexedTypePlans"] = probes.unindexedPlans
  } catch (error) {
    failures.push(`session summary: ${String(error)}`)
  } finally {
    if (client) await client.close()
    if (child) {
      try {
        await stopServe(child, userDataRoot)
      } catch (error) {
        failures.push(`session summary cleanup: ${String(error)}`)
      }
    }
  }

  const pageRecords = readDebugLogRecords(context.workDir).filter((record) => record.type === "session.summary.page")
  writeFileSync(join(context.evidenceDir, "summary-pages.json"), JSON.stringify(pageRecords))
  try {
    const pageDurations = pageRecords.map((record) => observedNumber(record.payload?.transactionMs, "transactionMs"))
    const pageCpuTimes = pageRecords.map((record) => observedNumber(record.payload?.taskCpuMs, "taskCpuMs"))
    const throughPosition = Math.max(...pageRecords.map((record) => observedNumber(record.payload?.throughPosition, "throughPosition")))
    if (throughPosition < LARGE_SESSION_SUMMARY_HISTORY.relevantFacts) throw new Error(`page diagnostics reached only ${throughPosition} for 530000 relevant facts`)
    metrics["sessionSummary.pageTransactionP95Ms"] = percentile(pageDurations, 95)
    // The bound on the worst page is a bound on the page's own work, so it
    // reads the thread CPU time of the page, not its wall time. The executor
    // replays at background priority, and the wall time of one page includes
    // each interval that the OS gives the core to other work. On a loaded
    // machine that interval alone reached 270 ms, and the same pages used at
    // most 40 ms of CPU. The wall-clock view stays in the p95 above, where a
    // percentile absorbs a rare stall and still shows a wait on every page.
    metrics["sessionSummary.maxTaskCpuMs"] = Math.max(...pageCpuTimes)
  } catch (error) {
    failures.push(`session summary instrumentation: ${String(error)}`)
  }

  return { metrics, failures }
}
