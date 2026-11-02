/** Many sessions streaming at once. A loopback OpenAI-compatible provider
 *  streams text and a cheap bash call into every session without pause, so
 *  the executor carries the load a person sees with dozens of agents working
 *  in parallel. While it does, one protocol client polls the queries a
 *  foreground TUI issues (status for every session, the transcript tail of
 *  one) and the scenario reads the executor's own event-loop stall records.
 *  The metrics are the runtime's fairness under that load: how often and how
 *  long its loop stalls, and how long a client waits for an answer.
 *
 *  The `children` variant is the same load with a subagent dispatch in place
 *  of the bash call: every parent dispatches an explorer child in a loop and
 *  each child runs one command before it answers. Its deciding metric is how
 *  many `session` domain patches the client's catalog receives while children
 *  come and go, which is zero once children are no longer catalog rows
 *  (ARCH-PROTOCOL-048).
 *
 *  Every tool call's arguments stream in small pieces, as a real provider
 *  sends them, and every other `sessions` call writes a file, so edit previews
 *  stream too. The output byte metrics bound what the wire carries per model
 *  request and in its largest patch: a live value that re-sent its whole
 *  accumulated state per piece would multiply both (ARCH-PROTOCOL-056). */

import { Database } from "bun:sqlite"
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import type { RuntimeClient, SessionRow } from "../../../src/protocol/app-service-types.js"
import { readDebugLogRecords } from "../lib/debug-log-reader.js"
import { registerProject, startIsolatedServe, waitFor, writeAccountConfig, type IsolatedServe } from "../lib/isolated-serve.js"
import { followOutput } from "../lib/follow-output.js"
import { percentile, type MetricValues } from "../lib/metrics.js"
import { runRevisionDriver } from "../lib/revision-driver.js"
import type { ScenarioContext, ScenarioResult } from "./scenario-context.js"

const SESSION_COUNT = 40
const MEASURE_MS = 45_000
const POLL_INTERVAL_MS = 250
const MODEL = "load-model"
/** One response streams this many text chunks at this cadence, then one bash
 *  call, so a session spends most of its time in the stream and spawns a
 *  process about every three seconds, the shape of an agent at work. */
const CHUNKS_PER_RESPONSE = 120
const CHUNK_INTERVAL_MS = 25
const CHUNK_TEXT = "streamed words arrive in order and the transcript grows "
/** Tool arguments stream in this many pieces, one per chunk interval. */
const ARGUMENT_PIECES = 60
/** What every other `sessions` call writes: a small source file. */
const WRITTEN_FILE = Array.from({ length: 120 }, (_, line) => `export const value${line} = ${line} // a written line of the fixture\n`).join("")
/** Each bash call prints this many bytes: a file listing or a test summary, not a one-word echo. */
const TOOL_OUTPUT_BYTES = 16 * 1024
/** A child's one command prints this much: enough that a card carrying its
 *  children's bodies would show in the byte metrics. */
const CHILD_OUTPUT_BYTES = 4 * 1024
/** The child's assignment. Its user message is how the provider tells a
 *  child's request from a parent's, so it is a sentence no parent ever types. */
const CHILD_PROMPT = "Report the load fixture's shape in one sentence (parallel-children child assignment)."
const WORKFLOW_PROMPT = "Investigate the parallel-children workflow assignment using read-only inspection."
const WORKFLOW_LAUNCH_PROMPT = "Launch parallel-load.workflow.yaml by path with the workflow tool and wait for its result."

export type ParallelVariant = "sessions" | "children"

interface JsonRecord { [key: string]: unknown }
interface OutputFrameEvidence {
  timestamp: number
  sessionId: string | undefined
  measuring: boolean
  bytes: number
  operations: { kind: string; blockId: string; blockKind?: string; bytes: number }[]
  streamingOperations: { kind: string; bytes: number; textBytes?: number; edits?: { kind: string; textBytes: number }[] }[]
}

function detailAdmissionIdentity(row: SessionRow | null): string {
  return JSON.stringify(row === null ? null : {
    kind: row.kind, title: row.title, shortTitle: row.shortTitle, lifecycleState: row.lifecycleState,
    inputMode: row.inputMode, activity: row.activity, admittedActions: row.admittedActions,
    parentSessionId: row.parentSessionId, parentToolUseId: row.parentToolUseId, stoppedBy: row.stoppedBy,
    workflowMembership: row.kind === "workflow-agent" ? row.workflowMembership : undefined,
    executionCwd: row.executionCwd, notices: row.notices, childSessionIds: row.childSessionIds,
    degraded: row.degraded, unavailableFields: row.unavailableFields,
  })
}

function sse(data: JsonRecord): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function completionChunk(delta: JsonRecord, finishReason: string | null = null): string {
  return sse({ id: "load-response", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] })
}

/** Whether a request comes from a child: its assignment is a user message. */
function isChildRequest(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || !("messages" in parsed) || !Array.isArray(parsed.messages)) return false
    return parsed.messages.some((message: unknown) => typeof message === "object" && message !== null
      && "role" in message && message.role === "user"
      && "content" in message && typeof message.content === "string" && message.content.includes(CHILD_PROMPT))
  } catch {
    return false
  }
}

/** The tool call that ends a parent's response: a bash call under the
 *  `sessions` variant, an explorer dispatch under `children`. */
/** One tool call the loopback provider streams: its id, tool, and argument JSON. */
interface FixtureToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

function parentToolCall(variant: ParallelVariant, requestIndex: number): FixtureToolCall {
  if (variant === "sessions" && requestIndex % 2 === 0) {
    return { id: `write-${requestIndex}`, name: "write", arguments: JSON.stringify({ path: `notes/written-${requestIndex}.ts`, content: WRITTEN_FILE }) }
  }
  if (variant === "sessions") {
    return { id: `bash-${requestIndex}`, name: "bash", arguments: JSON.stringify({ command: `head -c ${TOOL_OUTPUT_BYTES} /dev/zero | tr "\\0" x` }) }
  }
  return {
    id: `dispatch-${requestIndex}`, name: "subagent", arguments: JSON.stringify({
      persona: "explorer",
      description: "Describe the load fixture",
      rationale: "The load scenario needs a child session per turn so the catalog and the runtime carry many children at once.",
      prompt: CHILD_PROMPT,
    }),
  }
}

/** One tool call, its arguments in pieces the way a provider streams them. */
async function streamToolCall(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, call: FixtureToolCall, stopped: () => boolean): Promise<void> {
  controller.enqueue(encoder.encode(completionChunk({ tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] })))
  const piece = Math.ceil(call.arguments.length / ARGUMENT_PIECES)
  for (let offset = 0; offset < call.arguments.length && !stopped(); offset += piece) {
    controller.enqueue(encoder.encode(completionChunk({ tool_calls: [{ index: 0, function: { arguments: call.arguments.slice(offset, offset + piece) } }] })))
    await Bun.sleep(CHUNK_INTERVAL_MS)
  }
}

/** The loopback provider. Every parent request streams the same long response
 *  and ends in a tool call, so the runner immediately asks again with the tool
 *  result: a session runs until the scenario stops the server. A child's
 *  request is answered at once with a short completion, so a child settles and
 *  its parent dispatches the next one. */
function startProvider(variant: ParallelVariant) {
  let requests = 0
  let childRequests = 0
  let stopped = false
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      }
      const body = await request.text()
      const launch = body.includes(WORKFLOW_LAUNCH_PROMPT)
      const subagent = isChildRequest(body)
      const workflow = body.includes(WORKFLOW_PROMPT)
      const child = subagent || workflow
      requests += 1
      if (subagent) childRequests += 1
      const requestIndex = requests
      // A child runs one command, then answers once its result is back.
      const childWorks = child && !body.includes('"role":"tool"')
      const call = launch
        ? body.includes('"role":"tool"') ? undefined : { id: `workflow-${requestIndex}`, name: "workflow", arguments: JSON.stringify({ summary: "Inspect parallel load", source: { kind: "path", path: "parallel-load.workflow.yaml" }, description: "Inspect the parallel load fixture." }) }
        : childWorks
        ? { id: `child-bash-${requestIndex}`, name: "bash", arguments: JSON.stringify({ command: `head -c ${CHILD_OUTPUT_BYTES} /dev/zero | tr "\\0" y` }) }
        : child ? undefined : parentToolCall(variant, requestIndex)
      return new Response(new ReadableStream({
        async start(controller) {
          const chunks = subagent ? 1 : CHUNKS_PER_RESPONSE
          for (let index = 0; index < chunks; index += 1) {
            if (stopped) break
            controller.enqueue(encoder.encode(completionChunk({ content: child ? "The fixture is one project with many parents." : CHUNK_TEXT })))
            if (!subagent) await Bun.sleep(CHUNK_INTERVAL_MS)
          }
          if (call !== undefined && !stopped) await streamToolCall(controller, encoder, call, () => stopped)
          if (!stopped) {
            controller.enqueue(encoder.encode(completionChunk({}, call === undefined ? "stop" : "tool_calls")))
            controller.enqueue(encoder.encode(sse({ id: "load-response", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 400, completion_tokens: chunks * 10, total_tokens: 400 + chunks * 10 } })))
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          }
          controller.close()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests: () => requests,
    childRequests: () => childRequests,
    stop() {
      stopped = true
      server.stop(true)
    },
  }
}

interface LatencySamples {
  readonly durationsMs: number[]
  failures: number
}

async function timed<T>(samples: LatencySamples, run: () => Promise<T>): Promise<void> {
  const started = performance.now()
  try {
    await run()
    samples.durationsMs.push(performance.now() - started)
  } catch {
    samples.failures += 1
  }
}

/** Measures the candidate only: its metrics are absolute ceilings on runtime fairness. */
export async function runParallelSessionsScenario(context: ScenarioContext, variant: ParallelVariant = "sessions"): Promise<ScenarioResult> {
  if (context.measurementRole === "baseline") return runRevisionDriver(context, `parallel-${variant}`)
  const failures: string[] = []
  const metrics: MetricValues = {}
  const prefix = variant === "sessions" ? "parallelSessions" : "parallelChildren"
  const accountHome = context.workDir
  const userDataRoot = join(accountHome, ".flywheel")
  const projectRoot = join(accountHome, "projects", "load")
  mkdirSync(join(projectRoot, ".git"), { recursive: true })
  mkdirSync(userDataRoot, { recursive: true, mode: 0o700 })

  const provider = startProvider(variant)
  await writeAccountConfig(userDataRoot, { baseUrl: provider.baseUrl, models: [MODEL] })
  const project = await registerProject(userDataRoot, projectRoot, "load")

  let serve: IsolatedServe | undefined
  let client: RuntimeClient | undefined
  const { timeline } = context
  try {
    serve = await startIsolatedServe(context, { accountHome, projectRoot })
    const attached = await serve.openProject(project)
    client = attached
    if (variant === "children") {
      writeFileSync(join(projectRoot, "parallel-load.workflow.yaml"), `id: parallel-load
name: Parallel load
description: Inspect the parallel load fixture.
phases:
  - phase: inspect
    brief: ${WORKFLOW_PROMPT}
`)
      const modules = await attached.query({ type: "moduleSnapshot" })
      const enabled = await attached.dispatch({ type: "settings.set_workflow_mode", expected: modules.capabilities.workflowsMode, mode: "on" })
      if (!enabled.ok) throw new Error("load workflow capability refused")
    }
    // A foreground TUI holds the patch stream open; the runtime publishes every
    // session change to it, and that publication is part of the measured load.
    // The catalog patches it receives during the window are counted: with
    // children coming and going, that count is the churn every client's
    // session list pays.
    // Output patches are measured the same way, as the bytes they cost on the wire.
    let countingCatalogPatches = false
    let catalogPatches = 0
    const catalogIds: string[] = []
    let detailPatches = 0
    let detailBytes = 0
    let redundantDetailPatches = 0
    const detailIdentities = new Map<string, string>()
    let outputBytes = 0
    let maxOutputPatchBytes = 0
    let largestOutputFrame: OutputFrameEvidence | undefined
    let measuring = false
    const unsubscribe = attached.subscribe((event) => {
      if (!countingCatalogPatches || event.type !== "patch") return
      if (event.patch.cursor.domain === "session_detail" || event.patch.cursor.domain === "workflow_detail") {
        detailPatches++
        detailBytes += new TextEncoder().encode(JSON.stringify(event.patch)).byteLength
        if (event.patch.cursor.scope === "session" && event.patch.payload.kind === "session_detail.changed") {
          const detailIdentity = detailAdmissionIdentity(event.patch.payload.row)
          const sessionId = event.patch.cursor.sessionId
          if (detailIdentities.get(sessionId) === detailIdentity) redundantDetailPatches++
          detailIdentities.set(sessionId, detailIdentity)
        }
        if (event.patch.cursor.scope === "workflow" && event.patch.payload.kind === "workflow_detail.changed") {
          const identity = JSON.stringify(event.patch.payload.view)
          const key = `workflow:${event.patch.cursor.workflowId}`
          if (detailIdentities.get(key) === identity) redundantDetailPatches++
          detailIdentities.set(key, identity)
        }
        return
      }
      if (event.patch.cursor.domain === "output") {
        const bytes = new TextEncoder().encode(JSON.stringify(event.patch)).byteLength
        outputBytes += bytes
        if (bytes > maxOutputPatchBytes && event.patch.payload.kind === "output.delta") {
          largestOutputFrame = {
            timestamp: Date.now(), measuring, bytes,
            sessionId: event.patch.cursor.scope === "session" ? event.patch.cursor.sessionId : undefined,
            operations: event.patch.payload.delta.blocks.map((op) => ({
              kind: op.kind, blockId: op.blockId,
              ...("block" in op ? { blockKind: op.block.kind } : {}),
              bytes: new TextEncoder().encode(JSON.stringify(op)).byteLength,
            })),
            streamingOperations: (event.patch.payload.delta.streamingToolTextOps ?? []).map((op) => ({
              kind: op.kind, bytes: Buffer.byteLength(JSON.stringify(op)),
              ...(op.kind === "set" && typeof op.entry.content === "string" ? { textBytes: Buffer.byteLength(op.entry.content) } : {}),
              ...(op.kind === "edit" ? { edits: op.edits.map((edit) => ({
                kind: edit.kind,
                textBytes: edit.kind === "append" || edit.kind === "window" ? Buffer.byteLength(edit.text)
                  : edit.kind === "assign" && typeof edit.value === "string" ? Buffer.byteLength(edit.value) : 0,
              })) } : {}),
            })),
          }
        }
        maxOutputPatchBytes = Math.max(maxOutputPatchBytes, bytes)
        return
      }
      if (event.patch.cursor.domain !== "session") return
      if (event.patch.cursor.scope === "session" && (event.patch.payload.kind === "session.added" || event.patch.payload.kind === "session.updated" || event.patch.payload.kind === "session.removed")) {
        catalogPatches += 1
        catalogIds.push(event.patch.cursor.sessionId)
      }
    })

    const sessionIds = await timeline.time("open-sessions", async () => {
      const ids: string[] = []
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        const result = await attached.dispatch({ type: "chat.open", initialMessage: `Session ${index + 1}: keep working.` })
        if (!result.ok || result.sessionId === undefined) throw new Error(`chat.open ${index + 1} failed: ${"error" in result ? result.error : "no session id"}`)
        ids.push(result.sessionId)
      }
      return ids
    })
    // The poll reads every session's tail in turn, as a person who moves
    // through tabs that each stay open, so every session's live output is
    // watched and its patches are part of the measured load.
    const stopWatching = followOutput(attached, sessionIds)
    await timeline.time("ramp", () => waitFor("every session to reach the provider", () => provider.requests() >= SESSION_COUNT ? true : undefined))

    const status: LatencySamples = { durationsMs: [], failures: 0 }
    const outputWindow: LatencySamples = { durationsMs: [], failures: 0 }
    const requestsBefore = provider.requests()
    const childRequestsBefore = provider.childRequests()
    countingCatalogPatches = true
    const workflowIds: string[] = []
    if (variant === "children") {
      for (let index = 0; index < 4; index++) {
        const parent = await attached.dispatch({ type: "chat.open", initialMessage: WORKFLOW_LAUNCH_PROMPT })
        if (!parent.ok || !parent.sessionId) throw new Error("load workflow parent creation failed")
        const originSessionId = parent.sessionId
        const db = new Database(resolveEventStoreDbFile(projectRoot), { readonly: true })
        try {
          const workflowId = await waitFor("chat to launch the load workflow", () => db.query<{ sessionId: string }, [string]>(
            "select substr(aggregate_id, 10) as sessionId from event where type = 'workflow.run.registered' and json_extract(payload, '$.launchedFrom.parentSessionId') = ? order by position desc limit 1",
          ).get(originSessionId)?.sessionId)
          workflowIds.push(workflowId)
        } finally {
          db.close()
        }
      }
      for (const workflowId of workflowIds) {
        const { view } = await attached.query({ type: "workflowDetail", workflowId })
        const key = `workflow:${workflowId}`
        if (!detailIdentities.has(key)) detailIdentities.set(key, JSON.stringify(view))
      }
    }
    const startedAt = Date.now()
    measuring = true
    await timeline.time("measure", async () => {
      for (let tick = 0; Date.now() - startedAt < MEASURE_MS; tick += 1) {
        const sessionId = sessionIds[tick % sessionIds.length]!
        await Promise.all([
          timed(status, () => attached.query({ type: "statusSnapshot", sessionIds })),
          timed(outputWindow, () => attached.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 200, maxBytes: 256 * 1024 } } })),
        ])
        await Bun.sleep(POLL_INTERVAL_MS)
      }
    })
    const endedAt = Date.now()
    stopWatching()
    countingCatalogPatches = false
    const requestsServed = provider.requests() - requestsBefore
    const childRequestsServed = provider.childRequests() - childRequestsBefore

    const stalls = readDebugLogRecords(projectRoot)
      .filter((record) => record.payload?.service === "event-loop-lag" && record.payload.message === "event loop stall observed" && record.ts >= startedAt && record.ts <= endedAt)
      .map((record) => record.payload?.lagMs)
      .filter((lagMs): lagMs is number => typeof lagMs === "number")
    metrics[`${prefix}.sessions`] = SESSION_COUNT
    metrics[`${prefix}.providerRequests`] = requestsServed
    metrics[`${prefix}.stallCount`] = stalls.length
    metrics[`${prefix}.maxStallMs`] = stalls.length === 0 ? 0 : Math.max(...stalls)
    metrics[`${prefix}.stalledPct`] = (100 * stalls.reduce((sum, lagMs) => sum + lagMs, 0)) / (endedAt - startedAt)
    for (const [name, samples] of [["statusSnapshot", status], ["outputWindow", outputWindow]] as const) {
      if (samples.durationsMs.length === 0) {
        failures.push(`no ${name} query was answered during the window`)
        continue
      }
      metrics[`${prefix}.${name}P50Ms`] = percentile(samples.durationsMs, 50)
      metrics[`${prefix}.${name}P95Ms`] = percentile(samples.durationsMs, 95)
    }
    metrics[`${prefix}.queryFailures`] = status.failures + outputWindow.failures
    metrics[`${prefix}.outputKbPerRequest`] = requestsServed === 0 ? 0 : outputBytes / 1024 / requestsServed
    metrics[`${prefix}.maxOutputPatchKb`] = maxOutputPatchBytes / 1024
    if (requestsServed < SESSION_COUNT) failures.push(`provider served ${requestsServed} requests during the window; ${SESSION_COUNT} sessions should each have asked at least once`)
    if (variant === "children") {
      const db = new Database(resolveEventStoreDbFile(projectRoot), { readonly: true })
      let knownChildren: Set<string>
      let workflowSessions: number
      let members: number
      try {
        knownChildren = new Set(db.query<{ sessionId: string }, []>("select distinct session_id as sessionId from event where type = 'session.created' and json_extract(payload, '$.kind') in ('subagent', 'workflow-agent')").all().map((row) => row.sessionId))
        workflowSessions = db.query<{ count: number }, []>("select count(*) as count from event where type = 'session.created' and json_extract(payload, '$.kind') = 'workflow'").get()!.count
        members = db.query<{ count: number }, []>("select count(*) as count from event where type = 'session.created' and json_extract(payload, '$.kind') = 'workflow-agent'").get()!.count
      } finally {
        db.close()
      }
      const childCatalogPatches = catalogIds.filter((id) => knownChildren.has(id)).length
      metrics["parallelChildren.childCatalogPatches"] = childCatalogPatches
      metrics["parallelChildren.workflowRuns"] = workflowIds.length
      metrics["parallelChildren.detailPatches"] = detailPatches
      metrics["parallelChildren.detailBytes"] = detailBytes
      metrics["parallelChildren.redundantDetailPatches"] = redundantDetailPatches
      if (childCatalogPatches !== 0) failures.push(`${childCatalogPatches} child catalog patches crossed the runtime boundary`)
      if (redundantDetailPatches !== 0) failures.push(`${redundantDetailPatches} detail replacements changed only statistics or repeated equivalent metadata/admission`)
      if (workflowSessions !== 0) failures.push(`${workflowSessions} workflow session rows were published`)
      if (members < workflowIds.length) failures.push("a workflow did not publish an actual agent session")
      metrics["parallelChildren.dispatches"] = childRequestsServed
      metrics["parallelChildren.catalogPatches"] = childCatalogPatches
      if (childRequestsServed < SESSION_COUNT) failures.push(`children served ${childRequestsServed} requests during the window; ${SESSION_COUNT} parents should each have dispatched at least once`)
    }
    writeFileSync(join(context.evidenceDir, "latencies.json"), JSON.stringify({ status, outputWindow, stalls, catalogPatches, catalogIds, detailPatches, detailBytes, redundantDetailPatches, workflowIds, childRequestsServed, largestOutputFrame }, null, 2))
    unsubscribe()
  } catch (error) {
    failures.push(`parallel ${variant}: ${String(error)}`)
  } finally {
    // The provider stops first so no session can start another turn while the
    // service drains; a request that is mid-stream ends with the connection.
    provider.stop()
    if (client) await client.close().catch(() => {})
    if (existsSync(join(projectRoot, ".flywheel", "log"))) cpSync(join(projectRoot, ".flywheel", "log"), join(context.evidenceDir, "executor-log"), { recursive: true })
    try {
      await serve?.stop()
    } catch (error) {
      failures.push(`parallel ${variant} cleanup: ${String(error)}`)
    }
  }
  return { metrics, failures }
}
