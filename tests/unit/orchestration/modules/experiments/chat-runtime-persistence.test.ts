import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStoreAppend } from "../../../../../src/infra/event-store-types.js"
import { Log } from "../../../../../src/infra/log.js"
import type { OwnedCommandRunner, OwnedCommandResult } from "../../../../../src/infra/owned-command.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { resolveSessionDir } from "../../../../../src/infra/paths.js"
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/module-runtime-services.js"
import type { CommandHost } from "../../../../../src/orchestration/app-service/command-host.js"
import { experimentsModule } from "../../../../../src/orchestration/modules/experiments.js"
import { EXPERIMENT_OPERATION_KIND, experimentInterruptionMessage } from "../../../../../src/orchestration/modules/experiments/operation-owner.js"
import { createExperimentsRuntime, experimentsRuntime, type ExperimentsRuntime } from "../../../../../src/orchestration/modules/experiments/runtime.js"
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import type { CommandOutcome } from "../../../../../src/protocol/command-catalog-protocol-types.js"
import { testDirectories } from "../../../../helpers/directories.js"
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

/** Holds the first command that `matches` selects until the case releases it. */
function commandGate(matches: (command: readonly string[]) => boolean) {
  let release = () => {}
  let entered = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  const reached = new Promise<void>((resolve) => { entered = resolve })
  let armed = true
  return {
    reached,
    release,
    async pass(command: readonly string[]) {
      if (!armed || !matches(command)) return
      armed = false
      entered()
      await released
    },
  }
}

function controlledCommands(commands: string[], gate?: ReturnType<typeof commandGate>): OwnedCommandRunner {
  return async (command, options) => {
    commands.push(command.join(" "))
    await gate?.pass(command)
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
  gate?: ReturnType<typeof commandGate>,
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
    runOwnedCommand: controlledCommands(commands, gate),
    sessionEventStore: asAsyncEventReadSurface(store),
    sessionEventWriter: writer,
  }))
  if (!runtime) throw new Error("expected experiments runtime")
  await expect(stat(join(resolveSessionDir(sessionId, directory), "scratch"))).rejects.toMatchObject({ code: "ENOENT" })
  return { directory, store, writer, commands, runtime }
}

type Target = Awaited<ReturnType<typeof fixture>>

function toolContext(target: Target, toolUseId: string) {
  return {
    executionCwd: target.directory,
    userDataRoot: `${target.directory}/.test-account`, projectRoot: target.directory,
    sessionId: "test",
    toolUseId,
    artifactScopeId: "test-artifacts",
    retrievalSessionId: "test-retrieval",
  }
}

async function producePendingRun(target: Target): Promise<void> {
  expect((await target.runtime.tools.runExperiment.execute({}, toolContext(target, "run"))).outcome).toBe("ok")
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)
}

/** The literal hold payload that every release up to 0.1.3 wrote when a
 *  measurement began, as a process that ended mid-measurement left it. */
async function seedShippedRunningHold(target: Target): Promise<void> {
  const putInFlight = target.writer.putInFlight
  if (!putInFlight) throw new Error("expected in-flight authority")
  await putInFlight(EXPERIMENT_OPERATION_KIND, "run", { state: "running", command: "measure", cwd: target.directory })
}

function reopen(target: Target): ExperimentsRuntime {
  const reopened = createExperimentsRuntime(experimentServices({
    projectRoot: target.directory,
    executionCwd: target.directory,
    sessionId: "test",
    runOwnedCommand: controlledCommands(target.commands),
    sessionEventStore: asAsyncEventReadSurface(target.store),
    sessionEventWriter: target.writer,
  }))
  if (!reopened) throw new Error("expected reopened experiments runtime")
  return reopened
}

/** The module's `/experiment` registration in a session whose live runner
 *  holds `runtime`, as the command service invokes it. With no runtime the
 *  session has no live runner, as for a session whose runner ended. */
function experimentCommand(target: Target, runtime: ExperimentsRuntime | undefined): (argument: string) => Promise<CommandOutcome> {
  const reader = asAsyncEventReadSurface(target.store)
  const runtimes = composeModuleRuntimes(runtime ? [[experimentsRuntime.moduleId, runtime]] : [])
  const host: CommandHost = {
    session: {
      id: "test",
      executionCwd: target.directory,
      prompt: async () => true,
      startMethod: async () => ({ kind: "none" }),
      capabilities: async () => { throw new Error("must not plan a request") },
      systemLine: async () => { throw new Error("must not write history") },
      review: async () => false,
      interrupt: () => {},
      compact: async () => false,
      fork: async () => { throw new Error("must not fork") },
      runtime: (handle) => runtimes.get(handle),
      host: async (handle) => runtimes.get(handle),
      facts: () => target.writer,
      readInFlight: (kinds) => reader.readInFlight("test", kinds),
    },
    directories: testDirectories(target.directory),
    authDirectory: () => target.directory,
    projectionReader: reader,
    runOwnedCommand: controlledCommands(target.commands),
  }
  const registration = experimentsModule.contributions.find((contribution) => contribution.domain === "commands")
  if (registration?.domain !== "commands") throw new Error("expected the experiment command")
  return (argument) => registration.value.execute(host, argument)
}

const latestMode = (target: Target) => target.store.read({ aggregateId: "session:test", types: ["experiment.mode.changed"] }).at(-1)?.payload

test("a previous-shape run marker blocks every restart entry point without mutation", async () => {
  const target = await fixture("test", null)
  await seedShippedRunningHold(target)
  const warn = spyOn(Log.create({ service: "experiment-operation" }), "warn")
  const beforeCommands = target.commands.length
  const beforeFacts = target.store.countByAggregate("session:test")
  const beforeCell = target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)
  const reopened = reopen(target)
  const context = toolContext(target, "blocked")

  expect((await reopened.tools.initExperiment.execute({}, context)).outcome).toBe("error")
  expect((await reopened.tools.runExperiment.execute({}, context)).outcome).toBe("error")
  expect(await reopened.tools.logExperiment.execute({ metric: 1, status: "discard", description: "x" }, context)).toEqual({ outcome: "error", content: experimentInterruptionMessage })
  expect(await experimentCommand(target, reopened)("start")).toEqual({ kind: "warning", message: experimentInterruptionMessage })
  expect(target.commands).toHaveLength(beforeCommands)
  expect(target.store.countByAggregate("session:test")).toBe(beforeFacts)
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toEqual(beforeCell)
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
  target.store.close()
})

test("a measured result survives a runtime restart and settles on the reopened runner", async () => {
  const target = await fixture("test", null)
  await producePendingRun(target)
  const reopened = reopen(target)

  expect((await reopened.tools.logExperiment.execute({ metric: 8, status: "keep", description: "faster" }, toolContext(target, "log"))).outcome).toBe("ok")

  const runs = target.store.read({ aggregateId: "session:test", types: ["experiment.run.recorded"] })
  expect(runs.map((run) => [run.payload.status, run.payload.commit])).toEqual([["keep", "1234567"]])
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  expect(await experimentCommand(target, reopened)("start")).toEqual({ kind: "warning", message: "Experiment mode is already active." })
  target.store.close()
})

test("a restart during a settlement's Git work stays interrupted", async () => {
  const head = commandGate((command) => command[0] === "git" && command[3] === "rev-parse")
  const target = await fixture("test", null, undefined, head)
  await producePendingRun(target)
  const settling = target.runtime.tools.logExperiment.execute({ metric: 8, status: "keep", description: "faster" }, toolContext(target, "log"))
  await head.reached

  expect(await reopen(target).operation.blocker()).toBe(experimentInterruptionMessage)
  head.release()
  expect((await settling).outcome).toBe("ok")
  target.store.close()
})

test("off on a reopened runner retires a pending result", async () => {
  const target = await fixture("test", null)
  await producePendingRun(target)
  const reopened = reopen(target)

  expect(await experimentCommand(target, reopened)("off")).toEqual({ kind: "none" })

  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  expect(reopened.operation.snapshot()).toEqual({ status: "idle" })
  expect(await reopen(target).operation.blocker()).toBeUndefined()
  target.store.close()
})

for (const verb of ["off", "clear", "clear discard"] as const) {
  test(`a stop with no live runner retires a pending result with the mode (${verb})`, async () => {
    const appends: EventStoreAppend[] = []
    const target = await fixture("test", null, (actual) => ({
      ...actual,
      append: async (event) => {
        appends.push(event)
        return actual.append(event)
      },
    }))
    await producePendingRun(target)

    expect(await experimentCommand(target, undefined)(verb)).toEqual({ kind: "none" })

    const stop = appends.at(-1)
    expect(stop?.type).toBe("experiment.mode.changed")
    expect(stop?.payload).toMatchObject({ active: false })
    expect(stop?.inFlight).toEqual([{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: "run" }])
    expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
    expect(await reopen(target).operation.blocker()).toBeUndefined()
    target.store.close()
  })
}

test("a stop with no live runner keeps interrupted work until discard", async () => {
  const target = await fixture("test", null)
  await seedShippedRunningHold(target)
  const command = experimentCommand(target, undefined)

  const kept = await command("clear")
  expect(kept.kind).toBe("message")
  expect(kept.kind === "message" ? kept.message : "").toContain("/experiment clear discard")
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)

  expect(await command("clear discard")).toEqual({ kind: "none" })
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  expect(await reopen(target).operation.blocker()).toBeUndefined()
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

for (const verb of ["off", "clear"] as const) {
  test(`an ordinary stop after a measured run retires the marker with the mode change (${verb})`, async () => {
    const appends: EventStoreAppend[] = []
    const target = await fixture("test", null, (actual) => ({
      ...actual,
      append: async (event) => {
        appends.push(event)
        return actual.append(event)
      },
    }))
    await producePendingRun(target)
    const command = experimentCommand(target, target.runtime)

    expect(await command(verb)).toEqual({ kind: "none" })

    expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
    const stop = appends.at(-1)
    expect(stop?.type).toBe("experiment.mode.changed")
    expect(stop?.payload).toEqual({ active: false, workDir: verb === "off" ? target.directory : null })
    expect(stop?.inFlight).toEqual([{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: "run" }])
    expect(target.runtime.operation.snapshot().status).toBe("idle")
    expect(await command("start")).not.toEqual({ kind: "warning", message: experimentInterruptionMessage })
    expect(await reopen(target).operation.blocker()).toBeUndefined()
    target.store.close()
  })
}

test("a stop while the measure command runs retires the marker and refuses a new run until the command returns", async () => {
  const measure = commandGate((command) => command[0] !== "git")
  const target = await fixture("test", null, undefined, measure)
  const running = target.runtime.tools.runExperiment.execute({}, toolContext(target, "run"))
  await measure.reached

  expect(await experimentCommand(target, target.runtime)("off")).toEqual({ kind: "none" })
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  expect(latestMode(target)).toEqual({ active: false, workDir: target.directory })
  await target.writer.record(modeFact(true, target.directory))
  expect(await target.runtime.tools.runExperiment.execute({}, toolContext(target, "again"))).toEqual({ outcome: "error", content: "Experiment execution is not idle." })

  measure.release()
  expect((await running).outcome).toBe("ok")
  expect(target.runtime.operation.snapshot().status).toBe("idle")
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  target.store.close()
})

test("a stop during a keep settlement waits for it, so the kept run is recorded and the marker retired", async () => {
  const head = commandGate((command) => command[0] === "git" && command[3] === "rev-parse")
  const target = await fixture("test", null, undefined, head)
  await producePendingRun(target)
  const settling = target.runtime.tools.logExperiment.execute({ metric: 8, status: "keep", description: "faster" }, toolContext(target, "log"))
  await head.reached

  const stopping = experimentCommand(target, target.runtime)("off")
  let stopSettled = false
  void stopping.finally(() => { stopSettled = true })
  for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(stopSettled).toBe(false)
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)
  head.release()

  expect((await settling).outcome).toBe("ok")
  expect(await stopping).toEqual({ kind: "none" })
  const runs = target.store.read({ aggregateId: "session:test", types: ["experiment.run.recorded"] })
  expect(runs.map((run) => [run.payload.status, run.payload.commit])).toEqual([["keep", "1234567"]])
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  const stop = target.store.read({ aggregateId: "session:test", types: ["experiment.mode.changed"] }).at(-1)
  expect(stop?.payload).toEqual({ active: false, workDir: target.directory })
  expect(stop?.position).toBeGreaterThan(runs[0]?.position ?? Infinity)
  target.store.close()
})

test("clear keeps an interrupted operation until the person confirms with clear discard, which leaves the worktree alone", async () => {
  const target = await fixture("test", null)
  await seedShippedRunningHold(target)
  const reopened = reopen(target)
  const command = experimentCommand(target, reopened)
  const commandsBefore = target.commands.length

  const kept = await command("clear")
  expect(kept.kind).toBe("message")
  expect(kept.kind === "message" ? kept.message : "").toContain("/experiment clear discard")
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(1)
  expect(experimentInterruptionMessage).toContain("/experiment clear discard")

  expect(await command("clear discard")).toEqual({ kind: "none" })
  expect(target.store.readInFlight("test", EXPERIMENT_OPERATION_KIND)).toHaveLength(0)
  expect(target.commands).toHaveLength(commandsBefore)
  expect(latestMode(target)).toEqual({ active: false, workDir: null })
  expect(await reopened.operation.blocker()).toBeUndefined()
  expect(await command("start")).not.toEqual({ kind: "warning", message: experimentInterruptionMessage })
  target.store.close()
})
