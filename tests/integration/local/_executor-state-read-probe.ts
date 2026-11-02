/**
 * The executor side of the state read-port probe, run as its own process.
 *
 * It composes the read port as `runProjectExecutorMain` does: a reattachable
 * endpoint over the internal process channel with the state channel limits,
 * `connectProjectStateChannel`, and the execution-state adapter. Then it reads
 * every fact of the aggregate that `argv[3]` names, page by page through one
 * captured position, while a 5 ms interval on this main thread records the
 * most CPU time that this thread spent between two of its ticks. That is the
 * longest stretch that the thread ran without a return to the event loop. The
 * final interval, which is still open when the read settles, counts too.
 *
 * The probe measures thread CPU time and not the wall gap between ticks
 * because a loaded machine deschedules the whole process: under load the wall
 * gap grows past 60 ms with no read outstanding and less than 1 ms of CPU
 * time, which says nothing about the work that the read puts on this thread.
 * Thread CPU time does not count the time that the process waits for a core.
 *
 * It writes one JSON line to stdout: the busy time, the ticks during the read, the
 * read time, the facts, and the content that the `output` reference of each
 * fact resolves to. The output goes after the measurement, so it is not
 * inside the window.
 *
 * Arguments: the state socket path, the aggregate id.
 */

import { connectInternalProcessChannel } from "../../../src/infra/internal-process-channel.js"
import { createReattachableProcessEndpoint } from "../../../src/infra/reattachable-process-endpoint.js"
import { createProjectExecutionState } from "../../../src/orchestration/app-service/project-execution-state.js"
import { PROJECT_EXECUTOR_REATTACH_DEADLINE_MS, projectExecutorChannelLimits } from "../../../src/orchestration/app-service/project-executor-protocol.js"
import { connectProjectStateChannel } from "../../../src/orchestration/app-service/project-state-channel.js"

const PROBE_INTERVAL_MS = 5

const [path, aggregateId] = process.argv.slice(2)
if (!path || !aggregateId) throw new Error("usage: _executor-state-read-probe.ts <state socket> <aggregate id>")

const channel = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: PROJECT_EXECUTOR_REATTACH_DEADLINE_MS })
channel.attach(await connectInternalProcessChannel<unknown, unknown>({ path, decode: (value) => value, ...projectExecutorChannelLimits("state") }))
const state = connectProjectStateChannel(channel, { kind: "executor", projectId: "probe", generation: 1 })
const execution = await createProjectExecutionState(state)
try {
  let previous = process.threadCpuUsage()
  let maxBusyMs = 0
  let ticks = 0
  const recordInterval = () => {
    const now = process.threadCpuUsage()
    maxBusyMs = Math.max(maxBusyMs, (now.user - previous.user + now.system - previous.system) / 1000)
    previous = now
  }
  const timer = setInterval(() => {
    recordInterval()
    ticks++
  }, PROBE_INTERVAL_MS)
  const startedAt = performance.now()
  let slice: Awaited<ReturnType<typeof execution.eventStore.readSlice>>
  try {
    slice = await execution.eventStore.readSlice({ aggregateId })
  } finally {
    clearInterval(timer)
  }
  recordInterval()
  const settledAt = performance.now()
  const contents = slice.facts.map((fact) => {
    if (fact instanceof Error) return null
    const output = fact.payload.output
    const sha256 = typeof output === "object" && output !== null && "sha256" in output ? output.sha256 : undefined
    return typeof sha256 === "string" ? slice.toolContent.resolve(fact.sessionId, sha256) : null
  })
  process.stdout.write(`${JSON.stringify({ maxBusyMs, ticks, readMs: settledAt - startedAt, facts: slice.facts, contents })}\n`)
} finally {
  await execution.eventStoreRuntime.dispose()
  await state.close()
}
