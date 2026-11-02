/**
 * E9: a large read through the executor's state read port leaves the
 * executor's main thread free. The account side here is real: the project
 * state Worker on its own thread, served over the internal process channel by
 * `serveProjectStateChannel` to an admitted executor generation. The executor
 * side is a second process that composes the read port as the executor does,
 * so its main thread is not this test's main thread, and a 5 ms interval there
 * measures only the work that the read puts on the executor. The probe counts
 * that work as thread CPU time, so a loaded machine that deschedules the probe
 * does not count as executor work.
 */

import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeWorkerUrl } from "../../../src/cli/runtime-launch.js"
import type { StoredFact } from "../../../src/infra/event-store-types.js"
import { listenInternalProcessChannel, type InternalProcessChannelServer } from "../../../src/infra/internal-process-channel.js"
import { extractContent } from "../../../src/infra/tool-content.js"
import { projectExecutorChannelLimits } from "../../../src/orchestration/app-service/project-executor-protocol.js"
import { serveProjectStateChannel } from "../../../src/orchestration/app-service/project-state-channel.js"
import { spawnProjectStateWorker } from "../../../src/orchestration/app-service/project-state-worker-spawner.js"
import { PROJECT_STATE_MAX_PAGE_ROWS } from "../../../src/orchestration/app-service/project-state-protocol.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

const PROBE_ENTRY = fileURLToPath(new URL("_executor-state-read-probe.ts", import.meta.url))
/** The E9 ceiling from the plan: the most executor main-thread CPU time
 *  between two 5 ms ticks. */
const EXECUTOR_BUSY_CEILING_MS = 50
/** Fewer ticks than this would mean that the read was too short to show
 *  whether timers progress while it is outstanding. */
const MIN_TICKS_DURING_READ = 3
const AGGREGATE_ID = "state-read-probe"
/** Two whole pages. Each page holds about 6 MiB of fact payloads and 6 MiB
 *  of referenced content, below the 8 MiB bound of each state response, so
 *  the read is at least four Worker responses and tens of milliseconds of
 *  Worker work. */
const FACTS = 2 * PROJECT_STATE_MAX_PAGE_ROWS
const PADDING_BYTES = 24 * 1024
const CONTENT_BYTES = 24 * 1024
const APPEND_BATCH = 32

interface ProbeResult {
  readonly maxBusyMs: number
  readonly ticks: number
  readonly readMs: number
  readonly facts: readonly StoredFact[]
  readonly contents: readonly (string | null)[]
}

test("an executor process keeps its 5 ms timer while a large read through its state port is outstanding, and reads the exact facts and content", async () => {
  const root = temporaryDirectory("executor-state-read-")
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await mkdir(directories.userDataRoot, { recursive: true })
  const state = spawnProjectStateWorker(directories, root, runtimeWorkerUrl()).acquire()
  const served: (() => Promise<void>)[] = []
  let server: InternalProcessChannelServer | undefined
  let probe: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  try {
    await state.capturePosition()
    expect(await state.execution({ kind: "generation.admit", projectId: "probe", generation: 1 })).toEqual({ kind: "ok" })
    const contents = Array.from({ length: FACTS }, (_, index) => `${index}:`.padEnd(CONTENT_BYTES, String.fromCharCode(97 + (index % 26))))
    const committed: StoredFact[] = []
    for (let start = 0; start < FACTS; start += APPEND_BATCH) {
      committed.push(...await state.writer.appendBatch(contents.slice(start, start + APPEND_BATCH).map((content, offset) => {
        const extracted = extractContent(content)
        if (extracted.kind !== "reference") throw new Error("expected referenced tool content")
        // A reader resolves a reference only at a tool text site, so each
        // fact is a stored reference-capable tool output. Its model request id
        // is the schema-valid string field that carries the payload bytes.
        return {
          aggregateId: AGGREGATE_ID, sessionId: AGGREGATE_ID, type: "tool.execution_output.recorded", version: 2, timestamp: start + offset, actor: "flywheel",
          payload: { toolUseId: `tool-${start + offset}`, output: extracted.reference, modelRequestId: "n".repeat(PADDING_BYTES) }, contentRows: [extracted.row],
        }
      })))
    }

    // A Unix socket path has a limit of about 104 bytes, and a long
    // temporary directory exceeds it. A relative socket name in the root
    // stays short on every platform, so the server listens with the root as
    // the cwd.
    process.chdir(root)
    server = listenInternalProcessChannel<unknown, unknown>({
      path: "state.sock", decode: (value) => value, ...projectExecutorChannelLimits("state"),
      onConnection(endpoint) {
        served.push(serveProjectStateChannel(state, endpoint, { kind: "executor", projectId: "probe", generation: 1 }))
      },
    })
    await server.ready
    probe = Bun.spawn([process.execPath, PROBE_ENTRY, "state.sock", AGGREGATE_ID], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited])
    if (exitCode !== 0) throw new Error(`the executor-side probe exited ${exitCode}: ${stderr}`)
    const result: ProbeResult = JSON.parse(stdout)

    expect(result.facts).toEqual(committed)
    expect(result.contents).toEqual(contents)
    expect(result.ticks).toBeGreaterThanOrEqual(MIN_TICKS_DURING_READ)
    expect(result.maxBusyMs).toBeLessThanOrEqual(EXECUTOR_BUSY_CEILING_MS)
  } finally {
    // The server removes its socket by the relative name when it closes, so
    // the cwd changes back after that. The inner `finally` changes it back
    // also when a close step throws, so a failure here does not move the
    // later tests of this process into a removed directory.
    try {
      probe?.kill()
      await probe?.exited
      for (const stop of served) await stop()
      await server?.dispose()
      await state.close()
    } finally {
      process.chdir(cwd)
    }
  }
}, 60_000)
