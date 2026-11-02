/** Executor responsiveness under the work that once held its event loop:
 *  session activation over the giant transcript, an 8 MB Code Mode result,
 *  interruption of a running program, learning-review preparation over a
 *  20,000-load skill history, and forty 8 MB Code Mode jobs at once.
 *
 *  One isolated serve opens two projects. The fixture project holds the
 *  release fixture plus 20,000 skill loads. The tail project holds one chat,
 *  20,000 loads, the production snapshot of them, and 2,000 loads after it.
 *  The learning review runs on its own model, so its preparation replays the
 *  digest, as a routed review does.
 *
 *  Each phase runs beside a probe session whose provider stream sends one
 *  visible delta every 5 ms. The executor records the longest gap between two
 *  deltas it processed in the stream's summary fact; that gap is how long the
 *  executor's loop was away. The executor's own stall records, which start at
 *  50 ms, bound the loop lag over the same window. A phase closes only after
 *  its work is observed complete, a status query is answered, and one more
 *  sampler interval has passed, so a stall at the end of the work is inside.
 *
 *  Every measured value is checked for exactness too: the review request
 *  carries the exact load counts and transcript tail, and every Code Mode
 *  result carries the whole parsed array. */

import { Database } from "bun:sqlite"
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import type { ConversationMessage } from "../../../src/orchestration/agent-runtime/llm/types.js"
import type { FrontendActivity, FrontendOutputBlock, MutationResult, RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { startLoopbackMcpServer } from "../../helpers/code-mode-loopback-mcp.js"
import { appendSkillLoadHistory, GIANT_SESSION_ID, giantTranscript, SKILL_HISTORY_SESSION_ID, type SkillLoadCount } from "../fixtures/generate-store.js"
import { readDebugLogRecords } from "../lib/debug-log-reader.js"
import { registerProject, startIsolatedServe, waitFor, withTimeout, writeAccountConfig, type IsolatedServe, type RegisteredProject } from "../lib/isolated-serve.js"
import type { MetricValues } from "../lib/metrics.js"
import { processSample, settledSample } from "../lib/process-table.js"
import { CHAT_MODEL, isWholeLargeResult, reviewInstructionText, probeMessage, REVIEW_MODEL, startResponsivenessProvider, taskMessage, TITLE_MODEL, type FixtureTask, type ResponsivenessProvider } from "./executor-responsiveness-provider.js"
import type { ScenarioContext, ScenarioResult } from "./scenario-context.js"

const PREFIX = "executorResponsiveness"
/** One sampler interval, so the stall record of a block that ends with the
 *  phase's work is written inside the phase window. */
const FINAL_INTERVAL_MS = 100
/** A pause in the probe's own sends hides only an executor stall shorter
 *  than the pause, so a pause under the 50 ms gap ceiling hides no stall the
 *  ceiling judges. A longer one voids the probe. */
const PROBE_SOURCE_GAP_LIMIT_MS = 50
/** Long enough for a Worker to start the program before it is interrupted. */
const PROGRAM_RUNNING_MS = 200
const RSS_SAMPLE_INTERVAL_MS = 25
const STEP_TIMEOUT_MS = 120_000

/** Distinct counts, so the review's most-loaded-first list has one order. */
const PREFIX_LOADS: readonly SkillLoadCount[] = [
  { skillId: "planning", loads: 6000 }, { skillId: "debugging", loads: 4500 }, { skillId: "testing", loads: 3200 }, { skillId: "review", loads: 2400 },
  { skillId: "shipping", loads: 1800 }, { skillId: "design", loads: 1100 }, { skillId: "research", loads: 600 }, { skillId: "writing", loads: 400 },
]
const TAIL_LOADS: readonly SkillLoadCount[] = [
  { skillId: "planning", loads: 700 }, { skillId: "debugging", loads: 500 }, { skillId: "testing", loads: 350 }, { skillId: "review", loads: 200 },
  { skillId: "shipping", loads: 120 }, { skillId: "design", loads: 80 }, { skillId: "research", loads: 40 }, { skillId: "writing", loads: 10 },
]

/** The metrics this row must produce. A missing one fails the row by itself,
 *  because the budget pass judges only the metrics a run produced. */
export function executorResponsivenessRequiredMetrics(platform: NodeJS.Platform): readonly string[] {
  return [
    "maxLagMs", "codeResultMaxGapMs", "reviewMaxGapMs", "capacityMaxGapMs", "capacityIncrementalRssMiB",
    "computeInterruptMs", "pendingBridgeInterruptMs", "capacityBatchMs", "capacityCompleted",
    "activationColdMs", "activationWarmMs", "reviewPrepColdMs", "reviewPrepWarmMs", "reviewPrepSnapshotTailMs",
    "skillLoadsPrefix", "skillLoadsSnapshotTail",
    ...(platform === "darwin" ? ["capacityMacosBatchMs"] : []),
  ].map((metric) => `${PREFIX}.${metric}`)
}

type Phase = "activation" | "codeResult" | "interrupt" | "reviewCold" | "reviewWarm" | "reviewSnapshotTail" | "capacity"

interface PhaseEvidence {
  readonly phase: Phase
  readonly startedAt: number
  readonly endedAt: number
  readonly probeSessionId: string
  readonly maxGapMs: number
  readonly processedGaps: number
  readonly sourceDeltas: number
  readonly sourceMaxGapMs: number
  readonly maxLagMs: number
  readonly stalls: readonly number[]
}

interface ActivityChange {
  readonly sessionId: string
  /** Null once the session has no status: its runner ended. */
  readonly activity: FrontendActivity | null
  readonly at: number
}

/** One open project: its client, its executor, its store, and the status
 *  changes its client received. */
interface MeasuredProject {
  readonly root: string
  readonly client: RuntimeClient
  readonly executorPid: number
  readonly db: Database
  readonly activity: ActivityChange[]
  close(): Promise<void>
}

function requireOpened(result: MutationResult<{ type: "chat.open" }>, label: string): string {
  if (!result.ok || result.sessionId === undefined) throw new Error(`${label} did not open: ${"error" in result ? result.error : "no session id"}`)
  return result.sessionId
}

function requireOk(result: { readonly ok: boolean; readonly error?: string }, label: string): void {
  if (!result.ok) throw new Error(`${label} failed: ${result.error ?? "no reason"}`)
}

/** Executor pids the account recorded as ready, in the order they started. */
function readyExecutorPids(accountHome: string): number[] {
  return readDebugLogRecords(accountHome)
    .filter((record) => record.payload?.message === "executor generation ready")
    .map((record) => record.payload?.executorPid)
    .filter((pid): pid is number => typeof pid === "number")
}

async function openMeasuredProject(serve: IsolatedServe, project: RegisteredProject, accountHome: string, knownExecutors: readonly number[]): Promise<MeasuredProject> {
  const client = await serve.openProject(project)
  const activity: ActivityChange[] = []
  const unsubscribe = client.subscribe((event) => {
    if (event.type !== "patch" || event.patch.cursor.domain !== "status" || event.patch.cursor.scope !== "session") return
    const payload = event.patch.payload
    const at = performance.now()
    if (payload.kind === "status.updated") activity.push({ sessionId: event.patch.cursor.sessionId, activity: payload.status.activity, at })
    if (payload.kind === "status.removed") activity.push({ sessionId: event.patch.cursor.sessionId, activity: null, at })
  })
  const executorPid = await waitFor(`the executor of ${project.projectRoot}`, () => readyExecutorPids(accountHome).find((pid) => !knownExecutors.includes(pid)), 30_000, 250)
  const db = new Database(resolveEventStoreDbFile(project.projectRoot), { readonly: true })
  return {
    root: project.projectRoot,
    client,
    executorPid,
    db,
    activity,
    async close() {
      unsubscribe()
      await client.close().catch(() => {})
      db.close()
    },
  }
}

/** When the session's status first matched after `since`. */
function activityAfter(project: MeasuredProject, sessionId: string, since: number, matches: (activity: FrontendActivity | null) => boolean): Promise<number> {
  return waitFor(`status of ${sessionId}`, () => project.activity.find((change) => change.sessionId === sessionId && change.at > since && matches(change.activity))?.at, STEP_TIMEOUT_MS, 1)
}

function factCount(db: Database, sessionId: string, type: string, outcome?: string): number {
  const row = outcome === undefined
    ? db.query<{ count: number }, [string, string]>("select count(*) as count from event where aggregate_id = ? and type = ?").get(`session:${sessionId}`, type)
    : db.query<{ count: number }, [string, string, string]>("select count(*) as count from event where aggregate_id = ? and type = ? and json_extract(payload, '$.outcome') = ?").get(`session:${sessionId}`, type, outcome)
  return row?.count ?? 0
}

/** The probe stream's summary: the stream with the most visible deltas in the
 *  probe session, since a title request can record a summary of its own. */
function probeSummary(db: Database, sessionId: string): { readonly maxMs: number; readonly count: number } | undefined {
  const rows = db.query<{ payload: string }, [string]>("select payload from event where aggregate_id = ? and type = 'model.stream.summary.recorded'").all(`session:${sessionId}`)
  let best: { maxMs: number; count: number } | undefined
  for (const { payload } of rows) {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== "object" || parsed === null || !("interDelta" in parsed)) continue
    const { interDelta } = parsed
    if (typeof interDelta !== "object" || interDelta === null || !("maxMs" in interDelta) || !("count" in interDelta)) continue
    if (typeof interDelta.maxMs !== "number" || typeof interDelta.count !== "number") continue
    if (best === undefined || interDelta.count > best.count) best = { maxMs: interDelta.maxMs, count: interDelta.count }
  }
  return best
}

/** The executor's stall records in the window, by its own pid. */
function executorStalls(project: MeasuredProject, startedAt: number, endedAt: number): number[] {
  return readDebugLogRecords(project.root)
    .filter((record) => record.writer?.pid === String(project.executorPid) && record.payload?.service === "event-loop-lag"
      && record.payload.message === "event loop stall observed" && record.ts >= startedAt && record.ts <= endedAt)
    .map((record) => record.payload?.lagMs)
    .filter((lagMs): lagMs is number => typeof lagMs === "number")
}

/** The texts a routed review replays verbatim. A tool result is not one of
 *  them: the replay masks a stale tool result to a one-line stub. */
function replayedTexts(message: ConversationMessage): string[] {
  if (message.kind !== "user" && message.kind !== "assistant") return []
  if (typeof message.content === "string") return [message.content]
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
}

/** Exactness of one review request: the load counts it carries equal the
 *  history's, and every expected transcript text is in it verbatim. Returns
 *  the loads it carries. */
function checkReview(label: string, body: string, expected: ReadonlyMap<string, number>, texts: readonly string[], failures: string[]): number {
  const counted = new Map([...reviewInstructionText(body).matchAll(/^- ([^:\n]+): (\d+) loads?$/gm)].map((match) => [match[1] ?? "", Number(match[2])]))
  const want = JSON.stringify([...expected].sort(([a], [b]) => a.localeCompare(b)))
  const got = JSON.stringify([...counted].sort(([a], [b]) => a.localeCompare(b)))
  if (want !== got) failures.push(`${label}: the review carried load counts ${got}, expected ${want}`)
  const missing = texts.filter((text) => !body.includes(text))
  if (missing.length > 0) failures.push(`${label}: the review request lacked ${missing.length} of ${texts.length} expected transcript texts`)
  return [...counted.values()].reduce((sum, loads) => sum + loads, 0)
}

/** What an activated giant session must show exactly: the transcript's
 *  closing text and its last 4 KB tool result. */
interface GiantTail {
  readonly closing: string
  readonly toolUseId: string
  readonly toolText: string
}

function giantTail(messages: readonly ConversationMessage[]): GiantTail {
  const closing = messages.at(-1)
  const tool = messages.findLast((message) => message.kind === "toolResult")
  if (closing?.kind !== "system" || tool?.kind !== "toolResult") throw new Error("the giant transcript has no closing text or no tool result")
  return { closing: closing.content, toolUseId: tool.toolUseId, toolText: tool.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") }
}

/** Exactness of one activation, as a client that opens the session reads it:
 *  the transcript tail ends with the closing text, and the tool result body
 *  equals the fixture's text. A runner over a truncated or degraded
 *  conversation fails here. */
async function checkActivation(label: string, project: MeasuredProject, sessionId: string, expected: GiantTail, failures: string[]): Promise<void> {
  const window = await project.client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 16, maxBytes: 256 * 1024 } } })
  const last: FrontendOutputBlock | undefined = window.range.kind === "ok" ? window.range.blocks.at(-1) : undefined
  if (last?.kind !== "system" || last.message !== expected.closing) failures.push(`${label}: the transcript tail ended with ${JSON.stringify(last ?? window.range.kind).slice(0, 200)}, expected ${JSON.stringify(expected.closing)}`)
  const body = await project.client.query({ type: "outputBlockBody", sessionId, request: { blockId: `tool:${expected.toolUseId}` } })
  if (body.content !== expected.toolText) failures.push(`${label}: tool result ${expected.toolUseId} carried ${body.content?.length ?? 0} characters that differ from the fixture's ${expected.toolText.length}`)
}

function loadTotals(...parts: readonly (readonly SkillLoadCount[])[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const { skillId, loads } of parts.flat()) totals.set(skillId, (totals.get(skillId) ?? 0) + loads)
  return totals
}

interface RssSample {
  readonly at: number
  readonly rssMb: number
}

/** Samples the tree's RSS about every 25 ms until stopped. */
function sampleRss(pid: number) {
  const samples: RssSample[] = []
  let running = true
  // `stop` ends the loop from outside it.
  const sampling = () => running
  const loop = (async () => {
    while (sampling()) {
      const at = performance.now()
      samples.push({ at, rssMb: (await processSample(pid)).rssMb })
      await Bun.sleep(Math.max(0, RSS_SAMPLE_INTERVAL_MS - (performance.now() - at)))
    }
  })()
  return {
    async stop(): Promise<readonly RssSample[]> {
      running = false
      await loop
      return samples
    },
  }
}

/** Measures the candidate only: every metric is an absolute ceiling or evidence. */
export async function runExecutorResponsivenessScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const failures: string[] = []
  const metrics: MetricValues = {}
  const metric = (name: string, value: number) => { metrics[`${PREFIX}.${name}`] = value }
  const { timeline } = context
  const accountHome = context.workDir
  const userDataRoot = join(accountHome, ".flywheel")
  const tailRoot = join(accountHome, "projects", "tail")
  mkdirSync(join(tailRoot, ".git"), { recursive: true })
  await timeline.time("skill-history", async () => {
    await appendSkillLoadHistory(accountHome, accountHome, { prefix: PREFIX_LOADS })
    await appendSkillLoadHistory(tailRoot, accountHome, { prefix: PREFIX_LOADS, unseenTail: TAIL_LOADS })
  })

  const mcp = startLoopbackMcpServer()
  const provider = startResponsivenessProvider()
  await writeAccountConfig(userDataRoot, {
    baseUrl: provider.baseUrl,
    models: [CHAT_MODEL, REVIEW_MODEL, TITLE_MODEL],
    roleModels: { "learning-review": REVIEW_MODEL, "title-generation": TITLE_MODEL },
    // The digest of the giant transcript is about 150,000 tokens. A real
    // review model holds it; the custom-provider default of 128,000 would
    // compact the review into a different request.
    contextLimit: 1_000_000,
  }, ["[mcp.servers.loop]", `url = ${JSON.stringify(mcp.url)}`, ""])
  const fixtureProject = await registerProject(userDataRoot, accountHome, "fixture")
  const tailProject = await registerProject(userDataRoot, tailRoot, "tail")

  const phases: PhaseEvidence[] = []
  const opened: MeasuredProject[] = []
  let serve: IsolatedServe | undefined
  let reviews = 0
  let codeResults = 0

  /** Runs `work` beside a fresh probe session and records the window. */
  async function phase<T>(project: MeasuredProject, name: Phase, work: () => Promise<T>): Promise<T> {
    const probeSessionId = requireOpened(await project.client.dispatch({ type: "chat.open", initialMessage: probeMessage(name) }), `${name} probe`)
    await withTimeout(`${name} probe stream`, provider.probeFlowing(name), STEP_TIMEOUT_MS)
    const startedAt = Date.now()
    const value = await timeline.time(name, work)
    await project.client.query({ type: "statusSnapshot", sessionIds: [] })
    await Bun.sleep(FINAL_INTERVAL_MS)
    const endedAt = Date.now()
    const source = provider.endProbe(name)
    const summary = await waitFor(`${name} probe stream summary`, () => probeSummary(project.db, probeSessionId))
    const stalls = executorStalls(project, startedAt, endedAt)
    const evidence: PhaseEvidence = {
      phase: name, startedAt, endedAt, probeSessionId,
      maxGapMs: summary.maxMs, processedGaps: summary.count, sourceDeltas: source.sent, sourceMaxGapMs: source.maxSourceGapMs,
      maxLagMs: stalls.length === 0 ? 0 : Math.max(...stalls), stalls,
    }
    phases.push(evidence)
    metric(`${name}MaxGapMs`, evidence.maxGapMs)
    metric(`${name}MaxLagMs`, evidence.maxLagMs)
    if (evidence.sourceMaxGapMs > PROBE_SOURCE_GAP_LIMIT_MS) failures.push(`${name}: the probe source itself paused ${evidence.sourceMaxGapMs.toFixed(1)}ms, so its gap is void`)
    if (evidence.processedGaps < 1) failures.push(`${name}: the executor processed no probe delta gap`)
    return value
  }

  /** Time until the executor attached the session's runner. The control
   *  answers an activation before the executor attaches (ARCH-RUNTIME-006), so the
   *  runner's first idle status is the end. */
  async function activate(project: MeasuredProject, sessionId: string, label: string): Promise<number> {
    const startedAt = performance.now()
    requireOk(await project.client.dispatch({ type: "session.activate", sessionId }), label)
    return await activityAfter(project, sessionId, startedAt, (activity) => activity === "idle") - startedAt
  }

  async function interruptMs(project: MeasuredProject, task: FixtureTask, running: (sessionId: string) => Promise<void>): Promise<number> {
    const sessionId = requireOpened(await project.client.dispatch({ type: "chat.open", initialMessage: taskMessage(task) }), task)
    await withTimeout(`${task} program start`, running(sessionId), STEP_TIMEOUT_MS)
    const dispatchedAt = performance.now()
    requireOk(await project.client.dispatch({ type: "chat.interrupt", sessionId }), `${task} interrupt`)
    const [idleAt, resultAt] = await Promise.all([
      activityAfter(project, sessionId, dispatchedAt, (activity) => activity === "idle"),
      waitFor(`${task} interrupted result`, () => factCount(project.db, sessionId, "tool.result.recorded", "interrupted") > 0 ? performance.now() : undefined, STEP_TIMEOUT_MS, 2),
    ])
    return Math.max(idleAt, resultAt) - dispatchedAt
  }

  async function reviewPrepMs(project: MeasuredProject, sessionId: string, label: string, expected: ReadonlyMap<string, number>, texts: readonly string[]): Promise<{ readonly prepMs: number; readonly loads: number }> {
    const index = reviews++
    const completedBefore = factCount(project.db, sessionId, "skill.review.completed")
    const catalog = await project.client.query({ type: "commandCatalog" })
    const dispatchedAt = performance.now()
    const outcome = await project.client.dispatch({ type: "command.invoke", id: "learn", revision: catalog.revision, sessionId })
    if (outcome.kind !== "none") throw new Error(`${label}: /learn answered ${JSON.stringify(outcome)}`)
    const request = await withTimeout(`${label} review request`, provider.review(index), STEP_TIMEOUT_MS)
    await waitFor(`${label} review completion`, () => factCount(project.db, sessionId, "skill.review.completed") > completedBefore ? true : undefined, STEP_TIMEOUT_MS)
    writeFileSync(join(context.evidenceDir, `${label}-request.json`), request.body)
    return { prepMs: request.receivedAt - dispatchedAt, loads: checkReview(label, request.body, expected, texts, failures) }
  }

  try {
    serve = await startIsolatedServe(context, { accountHome, projectRoot: accountHome })
    const fixture = await openMeasuredProject(serve, fixtureProject, accountHome, [])
    opened.push(fixture)
    const giant = giantTranscript()
    const giantTexts = giant.slice(-13).flatMap(replayedTexts)
    const tailOfGiant = giantTail(giant)

    // A client that opens a session reads its tail, so the exactness reads
    // stay inside the phase as part of the activation's work.
    await phase(fixture, "activation", async () => {
      metric("activationColdMs", await activate(fixture, GIANT_SESSION_ID, "cold activation"))
      await checkActivation("cold activation", fixture, GIANT_SESSION_ID, tailOfGiant, failures)
      const releasedAt = performance.now()
      requireOk(await fixture.client.dispatch({ type: "session.release", sessionId: GIANT_SESSION_ID }), "release")
      await activityAfter(fixture, GIANT_SESSION_ID, releasedAt, (activity) => activity === null || activity === "absent")
      metric("activationWarmMs", await activate(fixture, GIANT_SESSION_ID, "warm activation"))
      await checkActivation("warm activation", fixture, GIANT_SESSION_ID, tailOfGiant, failures)
    })

    await phase(fixture, "codeResult", async () => {
      requireOpened(await fixture.client.dispatch({ type: "chat.open", initialMessage: taskMessage("code-result") }), "code result")
      const result = await withTimeout("code result", provider.codeResult(codeResults++), STEP_TIMEOUT_MS)
      if (!isWholeLargeResult(result, mcp.largeItemCount)) failures.push(`codeResult: the program returned ${result.slice(0, 200)}`)
    })

    await phase(fixture, "interrupt", async () => {
      metric("computeInterruptMs", await interruptMs(fixture, "compute-interrupt", async (sessionId) => {
        await waitFor("compute program call", () => factCount(fixture.db, sessionId, "tool.input.completed") > 0 ? true : undefined, STEP_TIMEOUT_MS, 5)
        await Bun.sleep(PROGRAM_RUNNING_MS)
      }))
      metric("pendingBridgeInterruptMs", await interruptMs(fixture, "pending-interrupt", () => mcp.pendingReceived(1)))
      await withTimeout("pending MCP call abandonment", mcp.pendingAbandoned(1), 10_000)
    })

    const prefixTotals = loadTotals(PREFIX_LOADS)
    const cold = await phase(fixture, "reviewCold", () => reviewPrepMs(fixture, GIANT_SESSION_ID, "reviewCold", prefixTotals, giantTexts))
    metric("reviewPrepColdMs", cold.prepMs)
    metric("skillLoadsPrefix", cold.loads)
    const warm = await phase(fixture, "reviewWarm", () => reviewPrepMs(fixture, GIANT_SESSION_ID, "reviewWarm", prefixTotals, giantTexts))
    metric("reviewPrepWarmMs", warm.prepMs)

    const tail = await openMeasuredProject(serve, tailProject, accountHome, [fixture.executorPid])
    opened.push(tail)
    // /learn reviews a session that has a runner, as one open in a client does.
    metric("activationSkillHistoryMs", await activate(tail, SKILL_HISTORY_SESSION_ID, "skill history activation"))
    const tailReview = await phase(tail, "reviewSnapshotTail", () => reviewPrepMs(tail, SKILL_HISTORY_SESSION_ID, "reviewSnapshotTail", loadTotals(PREFIX_LOADS, TAIL_LOADS), ["The skills are loaded."]))
    metric("reviewPrepSnapshotTailMs", tailReview.prepMs)
    metric("skillLoadsSnapshotTail", tailReview.loads)
    metric("reviewMaxGapMs", Math.max(...phases.filter((entry) => entry.phase.startsWith("review")).map((entry) => entry.maxGapMs)))

    const before = await processSample(fixture.executorPid)
    const sampler = sampleRss(fixture.executorPid)
    let samples: readonly RssSample[] = []
    let batches: Awaited<ReturnType<ResponsivenessProvider["capacity"]>>
    try {
      batches = await phase(fixture, "capacity", async () => {
        requireOpened(await fixture.client.dispatch({ type: "chat.open", initialMessage: taskMessage("capacity") }), "capacity")
        return await withTimeout("capacity batches", provider.capacity(), STEP_TIMEOUT_MS)
      })
    } finally {
      samples = await sampler.stop()
    }
    const settled = await timeline.time("capacity-settle", () => settledSample(fixture.executorPid))
    let incremental = 0
    let peak = before.rssMb
    let batchMs = 0
    let completed = 0
    for (const [index, batch] of batches.entries()) {
      const receivedAt = batch.receivedAt ?? Number.NaN
      const start = samples.findLast((sample) => sample.at <= batch.sentAt)?.rssMb ?? before.rssMb
      const during = samples.filter((sample) => sample.at >= batch.sentAt && sample.at <= receivedAt).map((sample) => sample.rssMb)
      if (during.length === 0) failures.push(`capacity batch ${index}: no RSS sample fell inside the batch`)
      const batchPeak = Math.max(start, ...during)
      peak = Math.max(peak, batchPeak)
      incremental = Math.max(incremental, batchPeak - start)
      batchMs = Math.max(batchMs, receivedAt - batch.sentAt)
      completed += batch.results.filter((result) => isWholeLargeResult(result, mcp.largeItemCount)).length
    }
    const jobs = provider.capacityBatches * provider.capacityCallsPerBatch
    if (completed !== jobs) failures.push(`capacity: ${completed} of ${jobs} jobs returned the whole result`)
    metric("capacityBatchMs", batchMs)
    if (process.platform === "darwin") metric("capacityMacosBatchMs", batchMs)
    metric("capacityIncrementalRssMiB", incremental)
    metric("capacityPeakRssMiB", peak)
    metric("capacityBaselineRssMiB", before.rssMb)
    metric("capacitySettledRssMiB", settled.rssMb)
    metric("capacitySettledGrowthMiB", settled.rssMb - before.rssMb)
    metric("capacityCompleted", completed)
    metric("maxLagMs", Math.max(...phases.map((entry) => entry.maxLagMs)))
    metric("probeSourceMaxGapMs", Math.max(...phases.map((entry) => entry.sourceMaxGapMs)))
    metric("unexpectedProviderRequests", provider.unexpectedRequests())
    writeFileSync(join(context.evidenceDir, "responsiveness.json"), JSON.stringify({ fixtureExecutorPid: fixture.executorPid, tailExecutorPid: tail.executorPid, phases, batches: batches.map(({ sentAt, receivedAt }) => ({ sentAt, receivedAt })), before, settled }, null, 2))
  } catch (error) {
    failures.push(`executor responsiveness: ${String(error)}`)
  } finally {
    provider.stop()
    for (const project of opened) await project.close()
    for (const [name, root] of [["fixture", accountHome], ["tail", tailRoot]] as const) {
      if (existsSync(join(root, ".flywheel", "log"))) cpSync(join(root, ".flywheel", "log"), join(context.evidenceDir, `${name}-log`), { recursive: true })
    }
    try {
      await serve?.stop()
    } catch (error) {
      failures.push(`executor responsiveness cleanup: ${String(error)}`)
    }
    await mcp.close()
  }
  return { metrics, failures }
}
