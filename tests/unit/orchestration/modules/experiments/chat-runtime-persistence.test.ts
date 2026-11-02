import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStoreAppend } from "../../../../../src/infra/event-store-types.js"
import type { OwnedCommandRunner, OwnedCommandResult } from "../../../../../src/infra/owned-command.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { resolveSessionDir } from "../../../../../src/infra/paths.js"
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/module-runtime-services.js"
import { executeExperimentCommand } from "../../../../../src/orchestration/modules/experiments/experiment-command.js"
import { findExperimentInterruption, EXPERIMENT_OPERATION_KIND } from "../../../../../src/orchestration/modules/experiments/operation-owner.js"
import { createExperimentsRuntime } from "../../../../../src/orchestration/modules/experiments/runtime.js"
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { moduleRuntimeServices } from "../../../../helpers/module-runtime-services.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const tree = "a".repeat(40)

/** The kernel services the experiments runtime reads, over one interactive
 *  chat runner; every other service is unused by the loop under test. */
function experimentServices(input: Pick<ModuleRuntimeServices, "projectRoot" | "executionCwd" | "sessionId" | "runOwnedCommand" | "sessionEventStore" | "sessionEventWriter">): ModuleRuntimeServices {
  return moduleRuntimeServices({ ...input, projectionReader: input.sessionEventStore })
}
const commandResult = (stdout = ""): OwnedCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutBytes: new TextEncoder().encode(stdout),
  timedOut: false,
})

function controlledCommands(commands: string[]): OwnedCommandRunner {
  return async (command, options) => {
    commands.push(command.join(" "))
    if (command[0] === "git" && command[3] === "read-tree") {
      const index = options?.env?.GIT_INDEX_FILE
      if (!index) throw new Error("expected isolated index")
      expect((await stat(dirname(index))).isDirectory()).toBe(true)
    }
    if (command[0] === "git" && command[3] === "write-tree") return commandResult(`${tree}\n`)
    if (command[0] === "git" && command[3] === "rev-parse") return commandResult("1234567\n")
    if (command[0] !== "git") return commandResult("METRIC latency=8\n")
    return commandResult()
  }
}

const modeFact = (active: boolean, workDir: string | null): ExperimentFact => ({
  type: "experiment.mode.changed",
  version: 1,
  actor: "flywheel",
  payload: { active, workDir },
})

function initializedFact(workDir: string, maxIterations: number | null): ExperimentFact {
  return {
    type: "experiment.initialized",
    version: 1,
    actor: "flywheel",
    payload: {
      segment: 0,
      name: "latency",
      metricName: "latency",
      metricUnit: "ms",
      direction: "lower",
      measureCommand: "measure",
      checksCommand: null,
      workDir,
      maxIterations,
      protectedPaths: [],
      sealedPaths: [],
    },
  }
}

async function fixture(
  sessionId: string,
  maxIterations: number | null,
  writerTransform?: (writer: AsyncEventWriter) => AsyncEventWriter,
) {
  const directory = await mkdtemp(join(tmpdir(), "flywheel-experiment-persistence-"))
  directories.push(directory)
  const store = createSqliteEventStore(join(directory, ".flywheel", "flywheel.sqlite"))
  const actual = asAsyncEventWriter(store)
  const writer = createSessionFactWriter({
    sessionId,
    writer: writerTransform?.(actual) ?? actual,
  })
  await writer.record(modeFact(true, directory))
  await writer.record(initializedFact(directory, maxIterations))
  const commands: string[] = []
  const runtime = createExperimentsRuntime(experimentServices({
    projectRoot: directory,
    executionCwd: directory,
    sessionId,
    runOwnedCommand: controlledCommands(commands),
    sessionEventStore: asAsyncEventReadSurface(store),
    sessionEventWriter: writer,
  }))
  if (!runtime) throw new Error("expected experiments runtime")
  await expect(stat(join(resolveSessionDir(sessionId, directory), "scratch"))).rejects.toMatchObject({ code: "ENOENT" })
  return { directory, store, writer, commands, runtime }
}

async function producePendingRun(target: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  expect((await target.runtime.tools.runExperiment.execute({}, {
    executionCwd: target.directory,
    userDataRoot: `${target.directory}/.test-account`, projectRoot: target.directory,
    sessionId: "test",
    toolUseId: "run",
    artifactScopeId: "test-artifacts",
    retrievalSessionId: "test-retrieval",
  })).outcome).toBe("ok")
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)
}

test("a persisted run marker blocks every restart entry point without mutation", async () => {
  const target = await fixture("test", null)
  await producePendingRun(target)
  const beforeCommands = target.commands.length
  const beforeFacts = target.store.countByAggregate("session:test")
  const beforeCell = target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)
  const reopened = createExperimentsRuntime(experimentServices({
    projectRoot: target.directory,
    executionCwd: target.directory,
    sessionId: "test",
    runOwnedCommand: controlledCommands(target.commands),
    sessionEventStore: asAsyncEventReadSurface(target.store),
    sessionEventWriter: target.writer,
  }))
  if (!reopened) throw new Error("expected reopened experiments runtime")
  const context = {
    executionCwd: target.directory,
    userDataRoot: `${target.directory}/.test-account`, projectRoot: target.directory,
    sessionId: "test",
    toolUseId: "blocked",
    artifactScopeId: "test-artifacts",
    retrievalSessionId: "test-retrieval",
  }

  expect((await reopened.tools.initExperiment.execute({}, context)).outcome).toBe("error")
  expect((await reopened.tools.runExperiment.execute({}, context)).outcome).toBe("error")
  expect((await reopened.tools.logExperiment.execute({}, context)).outcome).toBe("error")
  expect((await executeExperimentCommand("start", {
    executionCwd: target.directory,
    projectRoot: target.directory,
    snapshot: async () => ({ mode: { active: false, workDir: target.directory } }),
    readCharter: async () => { throw new Error("must not read") },
    validateWorktree: async () => { throw new Error("must not validate") },
    trackedFilesAreClean: async () => { throw new Error("must not inspect") },
    recordMode: async () => { throw new Error("must not record") },
    prompt: async () => { throw new Error("must not dispatch") },
    startMethod: async () => { throw new Error("must not dispatch") },
    clearPending: () => {},
    interrupt: () => {},
    interruption: () => findExperimentInterruption(async (kinds) => target.store.readInFlight("test", kinds)),
  })).kind).toBe("warning")
  expect(target.commands).toHaveLength(beforeCommands)
  expect(target.store.countByAggregate("session:test")).toBe(beforeFacts)
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toEqual(beforeCell)
  target.store.close()
})

test("a post-Git publication failure retains the durable run marker", async () => {
  let failRunPublication = false
  const target = await fixture("test", null, (actual) => ({
    ...actual,
    append: async (event) => {
      if (failRunPublication && event.type === "experiment.run.recorded") throw new Error("publication failed")
      return actual.append(event)
    },
  }))
  await producePendingRun(target)
  failRunPublication = true

  const response = await target.runtime.tools.logExperiment.execute({
    commit: "ignored",
    metric: 8,
    status: "discard",
    description: "discard",
  }, {
    executionCwd: target.directory,
    userDataRoot: `${target.directory}/.test-account`, projectRoot: target.directory,
    sessionId: "test",
    toolUseId: "log",
    artifactScopeId: "test-artifacts",
    retrievalSessionId: "test-retrieval",
  })

  expect(response).toEqual({ outcome: "error", content: "publication failed" })
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)
  expect(target.store.read({ aggregateId: "session:test", types: ["experiment.run.recorded"] })).toHaveLength(0)
  target.store.close()
})

for (const [label, maxIterations, expectedModeFacts] of [
  ["normal", null, 1],
  ["capped", 1, 2],
] as const) {
  test(`${label} settlement atomically retires the marker with its expected facts`, async () => {
    const batches: EventStoreAppend[][] = []
    const target = await fixture("test", maxIterations, (actual) => ({
      ...actual,
      appendBatch: async (events) => {
        batches.push([...events])
        return actual.appendBatch(events)
      },
    }))
    await producePendingRun(target)

    expect((await target.runtime.tools.logExperiment.execute({
      commit: "ignored",
      metric: 8,
      status: "discard",
      description: "discard",
    }, {
      executionCwd: target.directory,
      userDataRoot: `${target.directory}/.test-account`, projectRoot: target.directory,
      sessionId: "test",
      toolUseId: "log",
      artifactScopeId: "test-artifacts",
      retrievalSessionId: "test-retrieval",
    })).outcome).toBe("ok")

    expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
    expect(target.store.read({ aggregateId: "session:test", types: ["experiment.run.recorded"] })).toHaveLength(1)
    expect(target.store.read({ aggregateId: "session:test", types: ["experiment.mode.changed"] })).toHaveLength(expectedModeFacts)
    if (maxIterations === null) {
      const run = target.store.read({ aggregateId: "session:test", types: ["experiment.run.recorded"] })[0]
      expect(run?.payload.status).toBe("discard")
      expect(run?.payload.commit).toBe("1234567")
    } else {
      const settlementBatch = batches.at(-1)
      expect(settlementBatch?.map((event) => event.type)).toEqual([
        "experiment.run.recorded",
        "experiment.mode.changed",
      ])
      expect(settlementBatch?.at(-1)?.inFlight).toEqual([
        { op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: "run" },
      ])
    }
    target.store.close()
  })
}
