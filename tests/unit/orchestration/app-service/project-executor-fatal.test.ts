import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"

import * as crashPolicy from "../../../../src/infra/process/crash-policy.js"
import * as internalProcessChannel from "../../../../src/infra/process/channels/internal-process-channel.js"
import { Log } from "../../../../src/infra/diagnostics/log.js"
import * as processMemory from "../../../../src/infra/process/kernel/process-memory.js"
import * as processPriority from "../../../../src/infra/process/container/process-priority.js"
import * as processWatchdog from "../../../../src/infra/supervision/process-watchdog.js"
import * as executorStopSignals from "../../../../src/orchestration/app-service/executor/executor-stop-signals.js"
import * as executionComposition from "../../../../src/orchestration/app-service/executor/execution/project-execution-composition.js"
import type { RuntimeComposition } from "../../../../src/orchestration/app-service/executor/execution/project-execution-runtime.js"
import type { ProjectExecutorCommand } from "../../../../src/orchestration/app-service/executor/project-executor-protocol.js"
import { runProjectExecutorMain } from "../../../../src/orchestration/app-service/executor/execution/project-executor-main.js"

const ENDPOINT_KINDS = ["control", "state", "output", "lifecycle"] as const
const CREDENTIAL = Buffer.alloc(32, 7).toString("base64url")

type StartedRuntime = Pick<RuntimeComposition, "flushDurableState" | "onBlockersChanged" | "adoptHandedOverCommands" | "continueCapacityWaits" | "dispose" | "replacementSuccessorRows">
  & { readonly client: Pick<RuntimeComposition["client"], "subscribe"> }

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
  jest.restoreAllMocks()
})

/** Runs the executor's entry over in-memory channels with the account's side
 *  scripted. The process-wide boundaries it touches are replaced: its crash
 *  policy is captured rather than installed, its exit and the fatal record
 *  are written to `order` rather than taken, and a start composes a runtime
 *  whose durable flush is `flushDurableState`. */
function executor(order: string[], flushDurableState: () => Promise<void>) {
  const peers = new Map<string, internalProcessChannel.InternalProcessEndpoint<unknown, unknown>>()
  const lifecycle = { heartbeat: Promise.withResolvers<void>(), ready: Promise.withResolvers<void>() }
  const exited = Promise.withResolvers<number>()
  let fatal: crashPolicy.CrashPolicyOptions["fatal"] | undefined
  spyOn(processPriority, "establishProcessPriority").mockReturnValue(true)
  spyOn(Log, "init").mockResolvedValue(undefined)
  spyOn(Log, "closeGlobal").mockResolvedValue(undefined)
  spyOn(processMemory, "ensureProcessMemorySampler").mockReturnValue(undefined)
  const exit = (code?: number | string | null): void => {
    order.push(`exit ${code}`)
    exited.resolve(Number(code ?? 0))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: process.exit returns never, and a stand-in that records the exit must return so that the test process lives on
  spyOn(process, "exit").mockImplementation(exit as typeof process.exit)
  spyOn(crashPolicy, "installCrashPolicy").mockImplementation((options) => { fatal = options.fatal })
  spyOn(crashPolicy, "recordFatal").mockImplementation((_log, kind) => { order.push(`record ${kind}`) })
  spyOn(executorStopSignals, "listenForExecutorStopSignals").mockReturnValue({ serve() {} })
  spyOn(processWatchdog, "createProcessWatchdog").mockReturnValue({ arm() {}, async dispose() {} })
  spyOn(internalProcessChannel, "connectInternalProcessChannel").mockImplementation(async (input) => {
    const pair = new MessageChannel()
    cleanup.push(() => { pair.port1.close(); pair.port2.close() })
    const peer = internalProcessChannel.createMessagePortProcessEndpoint({ port: pair.port2, decode: (value) => value })
    if (input.path === "lifecycle") {
      peer.onMessage((value) => {
        // The first heartbeat follows the install of the executor's handlers.
        if (isEvent(value, "heartbeat")) lifecycle.heartbeat.resolve()
        if (isEvent(value, "ready")) lifecycle.ready.resolve()
      })
    }
    peers.set(input.path, peer)
    return internalProcessChannel.createMessagePortProcessEndpoint({ port: pair.port1, decode: input.decode })
  })
  // The members that the executor's start, serving, and stop read.
  const runtime: StartedRuntime = {
    flushDurableState,
    client: { subscribe: () => () => {} },
    onBlockersChanged: () => () => {},
    adoptHandedOverCommands: async () => {},
    continueCapacityWaits: async () => ({ pending: 0, at: null, next: null }),
    dispose: async () => ({ kind: "settled" }),
    replacementSuccessorRows: () => undefined,
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a whole runtime composition opens the project store and boots its Workers, and the executor reads only the members above
  spyOn(executionComposition, "createProjectExecutionRuntime").mockResolvedValue(runtime as RuntimeComposition)
  process.env.FLYWHEEL_PROJECT_EXECUTOR = JSON.stringify({
    projectId: "project", projectLabel: "project", generation: 1, workerUrl: "file:///worker.ts",
    allowPersistentProcesses: false, heartbeatIntervalMs: 60_000,
    directories: { userDataRoot: "/scratch/account/.flywheel", accountHome: "/scratch/account", projectRoot: "/scratch/project", executionCwd: "/scratch/project" },
    endpoints: Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, kind])),
    credentials: Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, CREDENTIAL])),
  })
  const main = runProjectExecutorMain()
  const send = async (command: ProjectExecutorCommand): Promise<void> => {
    await lifecycle.heartbeat.promise
    await peers.get("lifecycle")!.send(command)
  }
  return {
    exited: exited.promise,
    /** Fails the process as an uncaught failure does. */
    async fail(kind: crashPolicy.UncaughtKind) {
      await lifecycle.heartbeat.promise
      void fatal!(new Error("store lost"), kind)
    },
    /** Starts the runtime, as the account does, and waits for `ready`. */
    async start() {
      await send({ kind: "start", chatDefault: { kind: "pending" } })
      await lifecycle.ready.promise
    },
    /** The account stops the executor, which ends its entry. */
    async stop() {
      await send({ kind: "stop", clientsHold: false })
      await main
    },
  }
}

function isEvent(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind
}

/** Lets the fatal path run every step it can take without a timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("a project executor's fatal path", () => {
  test("records the failure, flushes the durable writers of the runtime composed by then, and only then exits 1", async () => {
    const order: string[] = []
    const flushed = Promise.withResolvers<void>()
    const run = executor(order, () => {
      order.push("flush")
      return flushed.promise
    })
    await run.start()

    await run.fail("unhandled rejection")
    await settle()
    expect(order).toEqual(["record unhandled rejection", "flush"])
    flushed.resolve()

    expect(await run.exited).toBe(1)
    expect(order).toEqual(["record unhandled rejection", "flush", "exit 1"])
    await run.stop()
  })

  test("exits 1 one second after a flush that never settles", async () => {
    const order: string[] = []
    const run = executor(order, () => {
      order.push("flush")
      return new Promise<void>(() => {})
    })
    await run.start()
    jest.useFakeTimers()
    try {
      await run.fail("uncaught exception")
      jest.advanceTimersByTime(999)
      await settle()
      expect(order).toEqual(["record uncaught exception", "flush"])
      jest.advanceTimersByTime(1)

      expect(await run.exited).toBe(1)
      expect(order).toEqual(["record uncaught exception", "flush", "exit 1"])
    } finally {
      jest.useRealTimers()
    }
    await run.stop()
  })

  test("exits 1 without a flush when the failure comes before the runtime is composed", async () => {
    const order: string[] = []
    const run = executor(order, async () => { order.push("flush") })

    await run.fail("unhandled rejection")

    expect(await run.exited).toBe(1)
    expect(order).toEqual(["record unhandled rejection", "exit 1"])
    await run.stop()
  })
})
