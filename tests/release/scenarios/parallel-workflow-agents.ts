import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { releaseMeasurementNow, type ReleaseMemoryEvidence } from "../../../src/infra/startup-trace.js"
import type { AttachedRuntimeClient } from "../../../src/protocol/app-service-types.js"
import { followOutput } from "../lib/follow-output.js"
import { readDebugLogRecords } from "../lib/debug-log-reader.js"
import { registerProject, startIsolatedServe, waitFor, writeAccountConfig, type IsolatedServe } from "../lib/isolated-serve.js"
import { percentile, type MetricValues } from "../lib/metrics.js"
import { processSample } from "../lib/process-table.js"
import { runRevisionDriver } from "../lib/revision-driver.js"
import { startRetainedHeapSampler } from "../lib/retained-heap.js"
import { selectExecutorPlateau, selectRetainedHeap, type ScenarioContext, type ScenarioResult } from "./scenario-context.js"
import { startWorkflowLoadProvider, WORKFLOW_LOAD_COMPETITOR, WORKFLOW_LOAD_KEYS, WORKFLOW_LOAD_LAUNCH, WORKFLOW_LOAD_MODEL } from "./workflow-load-provider.js"

interface Member { readonly id: string; readonly attemptId: string; readonly key: string; readonly startedAt: number }
interface WorkflowLoadRun { readonly id: string; readonly acceptedAt: number }
interface Observation { readonly domain: string; readonly bytes: number; readonly sessionId?: string; readonly edgeKeys: readonly string[] }

/** Revision drivers use their own shipped client and read surfaces. No old protocol enters the candidate runtime. */
export interface WorkflowLoadPort {
  readonly statusSurface: string
  openChat(message: string): Promise<string>
  enable(): Promise<void>
  observe(listener: (event: Observation) => void): () => void
  run(db: Database, parent: string): WorkflowLoadRun | undefined
  watch(workflowId: string): Promise<void>
  members(workflowId: string): Promise<readonly Member[]>
  status(workflowId: string, members: readonly Member[]): Promise<number>
  show(workflowId: string, member: Member, previous?: Member): Promise<number>
  output(workflowId: string, member: Member): Promise<number>
  state(workflowId: string): Promise<string | undefined>
  catalogTokens(): Promise<number | undefined>
  assertOwnership(db: Database, workflowId: string, parent: string): void
  close(): Promise<void>
}

export type WorkflowLoadDriver = (context: ScenarioContext, options: {
  readonly accountHome: string; readonly projectRoot: string; readonly project: { id: string; projectRoot: string }
}) => Promise<{ readonly serve: IsolatedServe; readonly port: WorkflowLoadPort }>

function requireOk(result: { readonly ok: boolean; readonly error?: string }): void {
  if (!result.ok) throw new Error(result.error ?? "workflow load mutation refused")
}

function candidatePort(client: AttachedRuntimeClient): WorkflowLoadPort {
  // A person sees the chats they open and the one member they show, so only
  // those sessions' live output is watched.
  const shown = new Map<string, () => void>()
  return {
    statusSurface: "ordinary member StatusView.activeForegroundBashToolCallIds",
    async openChat(initialMessage) {
      const result = await client.dispatch({ type: "chat.open", initialMessage })
      if (!result.ok || !result.sessionId) throw new Error("workflow load chat did not open")
      shown.set(result.sessionId, followOutput(client, [result.sessionId]))
      return result.sessionId
    },
    async enable() {
      const snapshot = await client.query({ type: "moduleSnapshot" })
      requireOk(await client.dispatch({ type: "settings.set_workflow_mode", expected: snapshot.capabilities.workflowsMode, mode: "on" }))
    },
    observe(listener) {
      return client.subscribe((event) => {
        if (event.type !== "patch") return
        const { cursor, payload } = event.patch
        const edgeKeys = payload.kind === "status.updated"
          ? payload.status.activeForegroundBashToolCallIds.flatMap((id) => id.startsWith("edge-") ? [id.slice(5)] : []) : []
        listener({ domain: cursor.domain, bytes: Buffer.byteLength(JSON.stringify(event.patch)), edgeKeys, ...(cursor.scope === "session" ? { sessionId: cursor.sessionId } : {}) })
      })
    },
    run(db, parent) {
      const row = db.query<{ id: string; createdAt: string }, [string]>("select substr(aggregate_id, 10) as id, json_extract(payload, '$.settings.createdAt') as createdAt from event where type = 'workflow.run.registered' and json_extract(payload, '$.launchedFrom.parentSessionId') = ? limit 1").get(parent)
      return row ? { id: row.id, acceptedAt: Date.parse(row.createdAt) } : undefined
    },
    async watch(workflowId) { await client.query({ type: "workflowLiveSnapshot", workflowId }) },
    async members(workflowId) {
      const { view } = await client.query({ type: "workflowViewSnapshot", workflowId })
      if (view?.attemptsStatus !== "loaded") throw new Error("active workflow view was unavailable")
      return view.attempts.flatMap((attempt) => {
        const node = view.tree.nodes.find((row) => row.kind === "agent" && row.currentAttemptId === attempt.id)
        return attempt.sessionId && attempt.startedAt !== undefined && node?.kind === "agent" && node.item
          ? [{ id: attempt.sessionId, attemptId: attempt.id, key: node.item.text, startedAt: attempt.startedAt }] : []
      })
    },
    async status(_workflowId, members) {
      const result = await client.query({ type: "statusSnapshot", sessionIds: members.map((member) => member.id) })
      if (result.views.length !== 50 || result.views.some(({ view }) => view === null
        || !Number.isFinite(view.startedAt)
        || !Array.isArray(view.activeBackgroundCommands) || !Array.isArray(view.replyWaits)
        || !Number.isFinite(view.activeSubagentCount) || typeof view.waitingOnBackgroundWork !== "boolean"
        || typeof view.activity !== "string" || typeof view.connectionState !== "string")) {
        throw new Error("fifty ordinary member full-status views were not complete")
      }
      return Buffer.byteLength(JSON.stringify(result))
    },
    async show(_workflowId, member, previous) {
      if (previous) {
        requireOk(await client.dispatch({ type: "session.release", sessionId: previous.id }))
        requireOk(await client.dispatch({ type: "session_detail.release", sessionId: previous.id }))
        shown.get(previous.id)?.()
        shown.delete(previous.id)
      }
      shown.get(member.id)?.()
      shown.set(member.id, followOutput(client, [member.id]))
      requireOk(await client.dispatch({ type: "session.activate", sessionId: member.id }))
      const detail = await client.query({ type: "sessionDetail", sessionId: member.id })
      if (detail.view?.kind !== "workflow-agent") throw new Error("viewer did not open an ordinary workflow-agent session")
      return Buffer.byteLength(JSON.stringify(detail))
    },
    output: async (_workflowId, member) => Buffer.byteLength(JSON.stringify(await client.query({ type: "outputWindow", sessionId: member.id, request: { range: { anchor: { kind: "tail" }, maxBlocks: 200, maxBytes: 256 * 1024 } } }))),
    state: async (workflowId) => (await client.query({ type: "workflowDetail", workflowId })).view?.workflowState,
    async catalogTokens() {
      const { rows } = await client.query({ type: "snapshot" })
      return rows.some((row) => row.totalsLoading) ? undefined : rows.reduce((total, row) => total + (row.totalTokens ?? 0), 0)
    },
    assertOwnership(db, workflowId, parent) {
      const rows = db.query<{ id: string; conversationId: string; parent: string; workflow: string }, [string]>("select session_id as id, json_extract(payload, '$.conversationId') as conversationId, json_extract(payload, '$.launchedFrom.parentSessionId') as parent, json_extract(payload, '$.workflowMembership.workflowId') as workflow from event where type = 'session.created' and json_extract(payload, '$.kind') = 'workflow-agent' and json_extract(payload, '$.workflowMembership.workflowId') = ?").all(workflowId)
      if (rows.length !== 50 || new Set(rows.map((row) => row.id)).size !== 50 || new Set(rows.map((row) => row.conversationId)).size !== 50 || rows.some((row) => row.parent !== parent)) throw new Error("fifty distinct conversations with immutable direct-chat memberships were not published")
      const old = db.query<{ n: number }, []>("select count(*) as n from event where type = 'session.created' and json_extract(payload, '$.kind') = 'workflow'").get()!.n
      if (old !== 0) throw new Error("active workload published a workflow session")
      const links = db.query<{ n: number }, [string]>("select count(*) as n from event where type = 'session.child.linked' and session_id = ?").get(parent)!.n
      if (links !== 50) throw new Error("launching chat did not own fifty direct child links")
    },
    close: () => client.close(),
  }
}

const candidateDriver: WorkflowLoadDriver = async (context, options) => {
  const serve = await startIsolatedServe(context, options)
  try {
    return { serve, port: candidatePort(await serve.openProject(options.project)) }
  } catch (error) {
    await serve.stop()
    throw error
  }
}

/** A real fifty-key list workload. The baseline callback runs only in a pinned revision's separate driver process. */
export async function runParallelWorkflowAgentsScenario(context: ScenarioContext): Promise<ScenarioResult> {
  const sampler = startRetainedHeapSampler({
    socketPath: join(context.workDir, "heap.sock"),
    markerPath: join(context.evidenceDir, "active-process-tree.txt"),
  })
  try {
    const measured = { ...context, environment: { ...context.environment, ...sampler.environment } }
    const result = context.measurementRole === "baseline"
      ? await runRevisionDriver(measured, "parallel-workflow-agents")
      : await runWorkflowAgentLoad(measured, candidateDriver)
    // The pinned driver's median is not retained memory. Replace it, never compare unlike measurements.
    delete result.metrics["parallelWorkflowAgents.activeHeapMb"]
    delete result.metrics["parallelWorkflowAgents.heapSamples"]
    try {
      const sample = await sampler.read()
      const { plateau } = Schema.decodeUnknownSync(Schema.Struct({
        plateau: Schema.Struct({ pid: Schema.Number, startedAt: Schema.Number, endedAt: Schema.Number }),
      }))(JSON.parse(readFileSync(join(context.evidenceDir, "active-workflow.json"), "utf8")))
      const memory = selectRetainedHeap(sample, plateau)
      result.metrics["parallelWorkflowAgents.activeHeapMb"] = memory.heapMb
      result.metrics["parallelWorkflowAgents.heapSamples"] = memory.count
      writeFileSync(join(context.evidenceDir, "retained-heap.json"), JSON.stringify({ method: "Heap.gc", sample, plateau, memory }))
    } catch (error) { result.failures.push(`active retained heap evidence: ${String(error)}`) }
    return result
  } finally { sampler.dispose() }
}

/** How many members stream at once on one account. The candidate has no
 *  account cap: every member and the competing chat stream at once. Published
 *  baselines before this change capped provider requests at 24 per account,
 *  so a baseline plateaus at that cap, its competing chat waits for released
 *  workflow streams, and neither role asserts a cap value. */
function accountCapacity(role: ScenarioContext["measurementRole"], members: number): { readonly plateau: number; readonly uncapped: boolean } {
  return role === "candidate" ? { plateau: members, uncapped: true } : { plateau: Math.min(members, 24), uncapped: false }
}

/** Shared workload and reductions for revision-matched ports. Ports change only the supported read surface, never load, cadence, or interval selection. */
export async function runWorkflowAgentLoad(context: ScenarioContext, driver: WorkflowLoadDriver): Promise<ScenarioResult> {
  const metrics: MetricValues = {}
  const failures: string[] = []
  const prefix = "parallelWorkflowAgents"
  const projectRoot = join(context.workDir, "projects", "active")
  const userDataRoot = join(context.workDir, ".flywheel")
  mkdirSync(join(projectRoot, ".git"), { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  writeFileSync(join(projectRoot, "active-load.workflow.yaml"), `id: active-load
name: Fifty active agents
description: Measure actual workflow agent execution.
input:
  fields:
    keys: { type: list, max: 50, of: { type: string }, description: The fifty load keys. }
phases:
  - phase: active
    over: input.keys
    brief: Run the controlled active workload for the item.
    output:
      fields:
        summary: { type: string, description: The completed workload. }
`)
  const provider = startWorkflowLoadProvider()
  let serve: IsolatedServe | undefined
  let port: WorkflowLoadPort | undefined
  let db: Database | undefined
  let unsubscribe: (() => void) | undefined
  let plateau: { runId: string; pid: number; startedAt: number; endedAt: number } | undefined
  const edges = new Map<string, number>()
  const bytes = { detail: 0, output: 0, workflow: 0, catalog: 0 }
  const catalogIds: string[] = []
  let accountingEvidence: {
    dispatched: number; expectedCatalogTokens: number;
    auxiliary: readonly { requestId: string; usageRecords: number }[];
    legacyGap: readonly { requestId: string; ownerId: string; aggregateId: string; ownerKind: string }[];
    candidateAuxiliaryComplete?: boolean;
  } | undefined
  let counting = false
  try {
    await writeAccountConfig(userDataRoot, { baseUrl: provider.baseUrl, models: [WORKFLOW_LOAD_MODEL] })
    const project = await registerProject(userDataRoot, projectRoot, "active")
    const started = await driver(context, { accountHome: context.workDir, projectRoot, project })
    serve = started.serve
    port = started.port
    await port.enable()
    unsubscribe = port.observe((event) => {
      const now = releaseMeasurementNow()
      for (const key of event.edgeKeys) if (!edges.has(key)) edges.set(key, now)
      if (event.domain === "session" && event.sessionId) catalogIds.push(event.sessionId)
      if (!counting) return
      if (event.domain === "output") bytes.output += event.bytes
      if (event.domain === "session_detail") bytes.detail += event.bytes
      if (event.domain.startsWith("workflow")) bytes.workflow += event.bytes
      if (event.domain === "session" && event.sessionId) bytes.catalog += event.bytes
    })
    db = new Database(resolveEventStoreDbFile(projectRoot), { readonly: true })
    const parentId = await port.openChat(WORKFLOW_LOAD_LAUNCH)
    const database = db
    const connection = port
    const run = await waitFor("production workflow launch", () => connection.run(database, parentId))
    const { id: workflowId, acceptedAt } = run
    await port.watch(workflowId)
    await waitFor("fifty first requests and controlled tool status edges", () => provider.firstRequests.size === 50 && edges.size === 50 ? true : undefined, 120_000, 20)
    const members = await port.members(workflowId)
    if (members.length !== 50) throw new Error(`workflow has ${members.length} members, not fifty`)
    port.assertOwnership(db, workflowId, parentId)
    const executorPid = await waitFor("serving executor identity", () => readDebugLogRecords(context.workDir)
      .filter((record) => record.payload?.message === "executor generation ready")
      .map((record) => record.payload?.executorPid).find((pid): pid is number => typeof pid === "number"))
    const tree = await processSample(serve.pid)
    if (!tree.evidence.split("\n").some((line) => Number(line.trim().split(/\s+/u)[0]) === executorPid)) throw new Error("serving executor is absent from the launched process tree")
    writeFileSync(join(context.evidenceDir, "active-process-tree.txt"), tree.evidence)
    provider.releaseCommands()
    const capacity = accountCapacity(context.measurementRole, members.length)
    await waitFor("production capacity plateau", () => provider.serving.size === capacity.plateau ? true : undefined, 120_000)
    counting = true
    plateau = { ...serve.memoryEvidence, pid: executorPid, startedAt: releaseMeasurementNow(), endedAt: 0 }
    const statusDurations: number[] = []
    const outputDurations: number[] = []
    let previous: Member | undefined
    const queryBytes = { detail: 0, output: 0, status: 0 }
    const statusKind = context.measurementRole === "candidate" ? "statusSnapshot" : "workflowLiveSnapshot"
    for (let tick = 0; releaseMeasurementNow() - plateau.startedAt < 45_000; tick++) {
      const member = members[tick % members.length]!
      const detail = await port.show(workflowId, member, previous)
      previous = member
      queryBytes.detail += detail
      let at = performance.now()
      const status = await port.status(workflowId, members)
      statusDurations.push(performance.now() - at)
      queryBytes.status += status
      at = performance.now()
      const output = await port.output(workflowId, member)
      outputDurations.push(performance.now() - at)
      queryBytes.output += output
      await Bun.sleep(250)
    }
    plateau.endedAt = releaseMeasurementNow()
    counting = false
    const competitorSubmitted = releaseMeasurementNow()
    const orderBefore = provider.order.length
    await port.openChat(WORKFLOW_LOAD_COMPETITOR)
    if (!capacity.uncapped) {
      await waitFor("competing chat's turn behind the baseline account cap", () => {
        if (provider.counts().competitorAt !== undefined) return true
        provider.releaseOne()
        return undefined
      }, 30_000, 250)
    }
    await waitFor("competing chat's first request", () => provider.counts().competitorAt, 30_000)
    const ahead = provider.order.slice(orderBefore).findIndex((entry) => entry.key === "chat")
    if (capacity.uncapped && ahead !== 0) throw new Error(`competing chat reached the provider behind ${ahead} workflow requests, not at once`)
    provider.settle()
    for (;;) {
      const state = await port.state(workflowId)
      if (state === "completed") break
      if (state === "failed" || state === "paused") throw new Error(`active workflow ended ${state}`)
      if (releaseMeasurementNow() - plateau.endedAt > 120_000) throw new Error("active workflow did not complete")
      await Bun.sleep(100)
    }
    await waitFor("durable terminal parent result", () => db!.query<{ n: number }, [string]>("select count(*) as n from event where type = 'tool.result.recorded' and session_id = ? and json_extract(payload, '$.toolUseId') = 'm14-launch' and json_extract(payload, '$.outcome') = 'ok'").get(parentId)!.n === 1 ? true : undefined)
    await waitFor("all provider streams to settle", () => provider.counts().concurrent === 0 ? true : undefined)
    if (context.measurementRole === "candidate") {
      await waitFor("every dispatched request to commit durable usage", () => database.query<{ n: number }, []>(
        "select count(*) as n from event d where d.type = 'model.request.dispatched' and not exists (select 1 from event u where u.type = 'model.usage.recorded' and json_extract(u.payload, '$.requestId') = json_extract(d.payload, '$.requestId'))",
      ).get()!.n === 0 ? true : undefined)
    }
    const usage = db.query<{ n: number; ids: number; input: number; output: number }, []>("select count(*) as n, count(distinct json_extract(payload, '$.requestId')) as ids, sum(json_extract(payload, '$.inputTokens')) as input, sum(json_extract(payload, '$.outputTokens')) as output from event where type = 'model.usage.recorded'").get()!
    const counts = provider.counts()
    const dispatched = db.query<{ n: number }, []>("select count(*) as n from event where type = 'model.request.dispatched'").get()!.n
    const legacyGap = db.query<{ requestId: string; ownerId: string; aggregateId: string; ownerKind: string }, [string]>("select json_extract(d.payload, '$.requestId') as requestId, d.session_id as ownerId, d.aggregate_id as aggregateId, case when d.aggregate_id like 'workflow:%' then 'workflow aggregate' when d.session_id = ? then 'legacy workflow session' else 'session' end as ownerKind from event d where d.type = 'model.request.dispatched' and not exists (select 1 from event u where u.type = 'model.usage.recorded' and json_extract(u.payload, '$.requestId') = json_extract(d.payload, '$.requestId'))").all(workflowId)
    const auxiliaryOwner = context.measurementRole === "candidate" ? `workflow:${workflowId}` : `session:${workflowId}`
    const auxiliary = db.query<{ requestId: string; usageRecords: number }, [string]>("select json_extract(d.payload, '$.requestId') as requestId, (select count(*) from event u where u.type = 'model.usage.recorded' and u.aggregate_id = d.aggregate_id and json_extract(u.payload, '$.requestId') = json_extract(d.payload, '$.requestId')) as usageRecords from event d where d.type = 'model.request.dispatched' and d.aggregate_id = ? and json_extract(d.payload, '$.identity.conversationId') is null").all(auxiliaryOwner)
    const expectedCatalogTokens = dispatched * 500
    accountingEvidence = {
      dispatched, expectedCatalogTokens, auxiliary, legacyGap,
      ...(context.measurementRole === "candidate" ? { candidateAuxiliaryComplete: auxiliary.length > 0 && auxiliary.every((request) => request.usageRecords === 1) } : {}),
    }
    if (context.measurementRole === "candidate") {
      if (legacyGap.length !== 0) throw new Error("candidate request dispatch has no durable usage")
      if (!accountingEvidence.candidateAuxiliaryComplete) throw new Error(`candidate auxiliary dispatches are absent or do not own exact workflow-aggregate usage: ${JSON.stringify(auxiliary)}`)
    }
    if (context.measurementRole === "candidate" && (usage.n !== usage.ids || usage.n + legacyGap.length !== dispatched || usage.input !== usage.n * 400 || usage.output !== usage.n * 100)) throw new Error(`owned request accounting differs from dispatched provider requests: ${JSON.stringify({ usage, dispatched, counts })}`)
    let catalogTokens: number | undefined
    const totalsDeadline = performance.now() + 30_000
    do {
      catalogTokens = await port.catalogTokens()
      if (context.measurementRole === "baseline" || catalogTokens === expectedCatalogTokens) break
      await Bun.sleep(50)
    } while (performance.now() < totalsDeadline)
    if (context.measurementRole === "candidate" && catalogTokens !== expectedCatalogTokens) throw new Error(`catalog totals ${catalogTokens} do not equal exact owned usage ${expectedCatalogTokens}`)
    const memberIds = new Set(members.map((member) => member.id))
    const churn = catalogIds.filter((id) => memberIds.has(id)).length
    if (context.measurementRole === "candidate" && churn !== 0) throw new Error(`${churn} member catalog patches crossed the boundary`)
    const first = members.map((member) => provider.firstRequests.get(member.key)! - member.startedAt)
    const admission = members.map((member) => member.startedAt - acceptedAt)
    const delivery = WORKFLOW_LOAD_KEYS.map((key) => edges.get(key)! - provider.toolEdges.get(key)!)
    metrics[`${prefix}.launchToFirstRequestMs`] = Math.min(...provider.firstRequests.values()) - acceptedAt
    // The state requests the project state worker served from launch
    // acceptance to the fiftieth member's first request, per launched member.
    // Commits share that one lane, so a reader that rereads history or each
    // member per change shows here as a count that grows with the member
    // count. The lane runs near saturation during launch, so extra requests
    // lengthen the window instead of raising the rate: the per-second rate is
    // evidence only. Both revisions record one `runtime.state.operation` per
    // request at DEBUG.
    const launchEndedAt = Math.max(...provider.firstRequests.values())
    const launchRequests = readDebugLogRecords(projectRoot).filter((record) => record.type === "runtime.state.operation" && record.ts >= acceptedAt && record.ts <= launchEndedAt)
    if (launchRequests.length === 0 || launchEndedAt <= acceptedAt) throw new Error("the launch window holds no state request records")
    metrics[`${prefix}.launchStateRequests`] = launchRequests.length
    metrics[`${prefix}.launchStateRequestsPerMember`] = launchRequests.length / members.length
    metrics[`${prefix}.launchStateRequestsPerSecond`] = launchRequests.length / ((launchEndedAt - acceptedAt) / 1000)
    const byOperation = new Map<string, number>()
    for (const record of launchRequests) byOperation.set(String(record.payload?.operation), (byOperation.get(String(record.payload?.operation)) ?? 0) + 1)
    writeFileSync(join(context.evidenceDir, "launch-state-requests.json"), JSON.stringify({ acceptedAt, launchEndedAt, requests: launchRequests.length, byOperation: Object.fromEntries([...byOperation].sort((a, b) => b[1] - a[1])) }, null, 2))
    for (const [name, values] of [["memberFirstRequest", first], ["admission", admission], ["statusDelivery", delivery], [statusKind, statusDurations], ["outputWindow", outputDurations]] as const) {
      if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`${name} contains missing, nonfinite, or negative observations`)
      metrics[`${prefix}.${name}P50Ms`] = percentile(values, 50)
      metrics[`${prefix}.${name}P95Ms`] = percentile(values, 95)
      metrics[`${prefix}.${name}MaxMs`] = Math.max(...values)
    }
    Object.assign(metrics, {
      [`${prefix}.members`]: members.length, [`${prefix}.firstRequests`]: first.length,
      [`${prefix}.statusEdges`]: delivery.length, [`${prefix}.childCatalogPatches`]: churn,
      [`${prefix}.maxConcurrentRequests`]: counts.maxConcurrent,
      [`${prefix}.competingChatMs`]: counts.competitorAt! - competitorSubmitted,
      [`${prefix}.competingChatRequestsAhead`]: ahead, [`${prefix}.accountedRequests`]: usage.n,
      [`${prefix}.inputTokens`]: usage.input, [`${prefix}.outputTokens`]: usage.output,
      [`${prefix}.catalogTokens`]: catalogTokens, [`${prefix}.processOnlyProviderRequests`]: counts.completed - dispatched,
      [`${prefix}.treeRssMb`]: tree.rssMb,
      ...Object.fromEntries(Object.entries(bytes).map(([name, value]) => [`${prefix}.${name}PatchBytes`, value])),
    })
    const diagnostics = readDebugLogRecords(projectRoot)
    writeFileSync(join(context.evidenceDir, "active-workflow.json"), JSON.stringify({
      workflowId, parentId, members, acceptedAt, plateau, firstRequests: [...provider.firstRequests], toolEdges: [...provider.toolEdges], observedEdges: [...edges],
      counts, usage, bytes, queryBytes, statusSurface: port.statusSurface,
      workload: { streamCadenceMs: provider.streamCadenceMs, keys: WORKFLOW_LOAD_KEYS, statusSamples: statusDurations.length, outputSamples: outputDurations.length },
      accountingCorrectnessOnly: accountingEvidence,
      candidateOnly: context.measurementRole === "candidate" ? ["fifty-member full StatusView", "statusSnapshot"] : [],
      delays: { prefixHold: diagnostics.filter((row) => row.payload?.message === "model.prefix_hold.settled") },
    }, null, 2))
  } catch (error) {
    failures.push(`parallel workflow agents: ${String(error)}`)
  } finally {
    writeFileSync(join(context.evidenceDir, "active-progress.json"), JSON.stringify({
      counts: provider.counts(), order: provider.order, firstRequests: [...provider.firstRequests],
      toolEdges: [...provider.toolEdges], observedEdges: [...edges], plateau, requestEvidence: provider.requestEvidence, accountingCorrectnessOnly: accountingEvidence,
    }, null, 2))
    provider.settle()
    unsubscribe?.()
    db?.close()
    await port?.close()
    try { await serve?.stop() } catch (error) { failures.push(`active workflow cleanup: ${String(error)}`) }
    await provider.stop()
  }
  if (serve && plateau) {
    try {
      const records = readdirSync(serve.memoryEvidence.directory).map((file): ReleaseMemoryEvidence => JSON.parse(readFileSync(join(serve!.memoryEvidence.directory, file), "utf8")))
      const memory = selectExecutorPlateau(records, plateau)
      metrics[`${prefix}.executorRssMb`] = memory.rssMb
      writeFileSync(join(context.evidenceDir, "plateau-memory.json"), JSON.stringify({ plateau, memory }))
    } catch (error) { failures.push(`active heap evidence: ${String(error)}`) }
  }
  return { metrics, failures }
}
