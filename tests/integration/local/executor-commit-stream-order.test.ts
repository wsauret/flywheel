/**
 * The executor's commit window rests on one ordering promise of the real
 * stack: the state Worker sends the commit notification of every commit made
 * on its store connection before the response of any request that runs after
 * it, and the account relays both to the executor in that order. A captured
 * position that the executor has heard through therefore proves that it heard
 * every such commit at or below it.
 *
 * The account side here is real: the project state Worker on its own thread,
 * served over the internal process channel by `serveProjectStateChannel`. The
 * executor side is a second process that composes the state port as the
 * executor does and writes and reads concurrently. The account writes on its
 * own lane, and a second SQLite connection on the same file writes as a
 * headless run would; no broadcast carries its commits, which is why the
 * window keeps a capture barrier.
 */

import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeWorkerUrl } from "../../../src/cli/runtime-launch.js"
import type { EventStoreAppend } from "../../../src/infra/event-store-types.js"
import { listenInternalProcessChannel, type InternalProcessChannelServer } from "../../../src/infra/internal-process-channel.js"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { projectExecutorChannelLimits } from "../../../src/orchestration/app-service/project-executor-protocol.js"
import { serveProjectStateChannel } from "../../../src/orchestration/app-service/project-state-channel.js"
import { spawnProjectStateWorker } from "../../../src/orchestration/app-service/project-state-worker-spawner.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

const PROBE_ENTRY = fileURLToPath(new URL("_executor-commit-stream-probe.ts", import.meta.url))
const WRITE_MS = 2_000

interface ProbeResult {
  readonly anchor: number
  readonly outOfOrder: number
  readonly late: number
  readonly responses: number
  readonly broadcast: readonly number[]
}

function fact(aggregateId: string, n: number): EventStoreAppend {
  return { aggregateId, sessionId: aggregateId, type: "probe.fact", version: 1, timestamp: n, actor: "probe", payload: { n } }
}

test("every commit of the account's store connection reaches the executor in position order and before any response that covers it", async () => {
  const root = temporaryDirectory("executor-commit-stream-")
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await mkdir(directories.userDataRoot, { recursive: true })
  const state = spawnProjectStateWorker(directories, root, runtimeWorkerUrl()).acquire()
  const served: (() => Promise<void>)[] = []
  let server: InternalProcessChannelServer | undefined
  let probe: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let foreign: ReturnType<typeof createSqliteEventStore> | undefined
  try {
    await state.capturePosition()
    expect(await state.execution({ kind: "generation.admit", projectId: "probe", generation: 1 })).toEqual({ kind: "ok" })
    // A Unix socket path has a limit of about 104 bytes, so the server
    // listens by a relative name with the root as the cwd.
    process.chdir(root)
    server = listenInternalProcessChannel<unknown, unknown>({
      path: "state.sock", decode: (value) => value, ...projectExecutorChannelLimits("state"),
      onConnection(endpoint) {
        served.push(serveProjectStateChannel(state, endpoint, { kind: "executor", projectId: "probe", generation: 1 }))
      },
    })
    await server.ready
    probe = Bun.spawn([process.execPath, PROBE_ENTRY, "state.sock"], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
    const output = Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited])
    foreign = createSqliteEventStore(resolveEventStoreDbFile(root))
    const foreignStore = foreign
    const foreignPositions: number[] = []
    const deadline = performance.now() + WRITE_MS
    await Promise.all([
      (async () => {
        for (let n = 0; performance.now() < deadline; n++) {
          await state.writer.append(fact("account", n))
          await Bun.sleep(2)
        }
      })(),
      (async () => {
        for (let n = 0; performance.now() < deadline; n++) {
          foreignPositions.push(foreignStore.append(fact("foreign", n)).position)
          await Bun.sleep(37)
        }
      })(),
    ])
    probe.stdin.write("done\n")
    await probe.stdin.flush()
    const [stdout, stderr, exitCode] = await output
    if (exitCode !== 0) throw new Error(`the executor-side probe exited ${exitCode}: ${stderr}`)
    const result: ProbeResult = JSON.parse(stdout.trim().split("\n").at(-1)!)
    const committed = (await state.readSlice({ types: ["probe.fact"], afterPosition: result.anchor })).facts.map((event) => event.position)

    expect(result.responses).toBeGreaterThan(100)
    expect(result.outOfOrder).toBe(0)
    expect(result.late).toBe(0)
    const foreignSet = new Set(foreignPositions)
    expect(foreignPositions.length).toBeGreaterThan(0)
    expect(result.broadcast.filter((position) => position > result.anchor)).toEqual(committed.filter((position) => !foreignSet.has(position)))
  } finally {
    // The server removes its socket by the relative name when it closes, so
    // the cwd changes back after that, also when a close step throws.
    try {
      probe?.kill()
      await probe?.exited
      foreign?.close()
      for (const stop of served) await stop()
      await server?.dispose()
      await state.close()
    } finally {
      process.chdir(cwd)
    }
  }
}, 60_000)
