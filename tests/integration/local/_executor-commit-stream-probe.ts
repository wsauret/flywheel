/**
 * The executor side of the commit-stream order test, run as its own process.
 *
 * It composes the state port as `runProjectExecutorMain` does, then runs
 * writers on the execution lane and readers that capture positions and read
 * pages until stdin says `done`. For every response that states a position H
 * (a capture, a page ceiling, or an append acknowledgement), it records which
 * broadcast positions at or below H had not yet arrived. A position that never
 * arrives is a commit of another store connection, which no broadcast carries.
 *
 * It writes one JSON line to stdout: the position the executor anchored at,
 * the broadcasts that arrived out of position order, the responses that
 * arrived before a broadcast they covered, the response count, and every
 * broadcast position.
 *
 * Arguments: the state socket path.
 */

import { connectInternalProcessChannel } from "../../../src/infra/internal-process-channel.js"
import { createReattachableProcessEndpoint } from "../../../src/infra/reattachable-process-endpoint.js"
import type { EventStoreAppend } from "../../../src/infra/event-store-types.js"
import { createProjectExecutionState } from "../../../src/orchestration/app-service/project-execution-state.js"
import { PROJECT_EXECUTOR_REATTACH_DEADLINE_MS, projectExecutorChannelLimits } from "../../../src/orchestration/app-service/project-executor-protocol.js"
import { connectProjectStateChannel } from "../../../src/orchestration/app-service/project-state-channel.js"

const WRITERS = 6
const READERS = 6

const [path] = process.argv.slice(2)
if (!path) throw new Error("usage: _executor-commit-stream-probe.ts <state socket>")

const channel = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: PROJECT_EXECUTOR_REATTACH_DEADLINE_MS })
channel.attach(await connectInternalProcessChannel<unknown, unknown>({ path, decode: (value) => value, ...projectExecutorChannelLimits("state") }))
const state = connectProjectStateChannel(channel, { kind: "executor", projectId: "probe", generation: 1 })
let tick = 0
const arrival = new Map<number, number>()
let highestArrived = 0
let outOfOrder = 0
state.onStored((events) => {
  const at = ++tick
  for (const event of events) {
    if (event.position <= highestArrived) outOfOrder++
    highestArrived = Math.max(highestArrived, event.position)
    arrival.set(event.position, at)
  }
})
const anchor = await state.capturePosition()
const execution = await createProjectExecutionState(state)
const responses: { at: number; position: number }[] = []
let stop = false
const running = () => !stop
const stopped = (async () => {
  for await (const chunk of Bun.stdin.stream()) if (new TextDecoder().decode(chunk).includes("done")) break
  stop = true
})()

function fact(aggregateId: string, n: number): EventStoreAppend {
  return { aggregateId, sessionId: aggregateId, type: "probe.fact", version: 1, timestamp: n, actor: "probe", payload: { n } }
}

async function write(id: number): Promise<void> {
  for (let n = 0; running(); n++) {
    const stored = await execution.eventStore.append(fact(`executor-${id}`, n))
    responses.push({ at: ++tick, position: stored.position })
  }
}

async function read(id: number): Promise<void> {
  for (let n = 0; running(); n++) {
    const position = n % 2 === 0
      ? await state.capturePosition()
      : (await state.readPage({ aggregateId: `executor-${id % WRITERS}` }, undefined, 0, false, "deferred")).upperPosition
    responses.push({ at: ++tick, position })
  }
}

await Promise.all([...Array.from({ length: WRITERS }, (_, id) => write(id)), ...Array.from({ length: READERS }, (_, id) => read(id)), stopped])
const positions = [...arrival.keys()].sort((a, b) => a - b)
let late = 0
for (const response of responses) {
  for (const position of positions) {
    if (position > response.position) break
    if (position > anchor && arrival.get(position)! > response.at) {
      late++
      break
    }
  }
}
process.stdout.write(`${JSON.stringify({ anchor, outOfOrder, late, responses: responses.length, broadcast: positions })}\n`)
await execution.eventStoreRuntime.dispose()
await state.close()
