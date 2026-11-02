import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { readOutcomeRecord, writeOutcomeRecord } from "../../../../src/infra/command-handover.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createCommandKeeper, type CommandKeeper, type KeptOutputChange } from "../../../../src/orchestration/app-service/command-keeper.js"
import { privateCopyRemovals, takePrivateProjectCopy } from "../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, commandHandoversOfAsync, keptCommandsOf, type CommandHandoverRow } from "../../../../src/orchestration/session/command-handover.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { FIXTURE_EXECUTION_CWD, temporaryDirectories } from "../../../helpers/directories.js"
import { fakeContainer, handedOverRow, handoverAuthority, type AdoptionAnswer } from "../agent-runtime/_command-handover-fixtures.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { readOutputSequence } from "../../../../src/orchestration/app-service/output-sequence.js"
import { chatEntry } from "./_frontend-projection-fixtures.js"
import { createKeptOutputProjection } from "../../../../src/orchestration/app-service/kept-output-projection.js"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"

const temporaryDirectory = temporaryDirectories()
const STEP = { sessionId: "workflow-paused", conversationId: "agent-step-1" }

/** Resolves once `check` holds: each step below settles through a few
 *  microtasks and one store write. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !check(); attempt++) await Bun.sleep(1)
  expect(check()).toBe(true)
}

describe("the executor's keeper of handed-over commands", () => {
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closing.splice(0)) await close()
  })

  /** A project store holding one handed-over row, whose command has written
   *  its log and whose supervisor kept its record, a keeper over it whose
   *  adoptions answer as `adopt` says, one running container by default, and
   *  the session deletions a test announces. */
  async function kept(options: { readonly stopping?: () => boolean; readonly adopt?: () => AdoptionAnswer; readonly row?: Partial<CommandHandoverRow>; readonly writeOutput?: AsyncEventWriter["append"] } = {}) {
    const dir = temporaryDirectory("fw-command-keeper-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const events: string[] = []
    const container = fakeContainer(events, "handed_over")
    const deletions = new Set<(change: SessionMetadataChange) => void>()
    const keeperWriter = { ...writer, append: (event: Parameters<AsyncEventWriter["append"]>[0]) => event.type === "tool.execution_output.recorded" && options.writeOutput ? options.writeOutput(event) : writer.append(event) }
    const keeper: CommandKeeper = createCommandKeeper({ reader, writer: keeperWriter, manager: { subscribe: (listener) => { deletions.add(listener); return () => { deletions.delete(listener) } } } })
    const authority = handoverAuthority({
      reader: store, writer,
      stopping: options.stopping ?? (() => false),
      adopt: options.adopt ?? (() => ({ kind: "adopted", owned: container.owned })),
      takeKept: (stored, receiveOutput) => keeper.take(stored, receiveOutput),
    })
    const row: CommandHandoverRow = handedOverRow(dir, STEP, options.row)
    await Bun.write(row.logPath, "server ready\n")
    await Bun.write(row.recordPath, JSON.stringify({ version: 1, handedOverAtMs: 1 }))
    await writer.putInFlight?.(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
    closing.push(async () => {
      container.end(0)
      await keeper.close()
      store.close()
    })
    return {
      keeper, authority, row, events, container,
      rows: async () => (await commandHandoversOfAsync(reader, STEP.sessionId, STEP.conversationId)).map((stored) => stored.row),
      shown: () => keptCommandsOf(reader, STEP.sessionId),
      held: () => store.readInFlight(STEP.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map((stored) => ({ key: stored.key, conversationId: stored.payload.conversationId })),
      recordedOutputs: () => store.read({ sessionId: STEP.sessionId, types: ["tool.execution_output.recorded"] }).map((fact) => fact.payload.toolUseId),
      commandRecords: () => store.read({ sessionId: STEP.sessionId, types: ["tool.background_command.recorded"] }).map((fact) => fact.payload),
      delete: (sessionId: string) => { for (const listener of deletions) listener({ kind: "deleted", sessionId }) },
      keep: async () => keeper.keep(authority, await commandHandoversOfAsync(reader, STEP.sessionId, STEP.conversationId)),
    }
  }

  test("adopts a command no host holds and marks its row kept, so every status of its session shows it with Stop, and keeps its project open", async () => {
    const fixture = await kept()
    const shownAtChange: Promise<number>[] = []
    fixture.keeper.onChange(() => { shownAtChange.push(fixture.shown().then((shown) => shown.length)) })

    await fixture.keep()

    expect(await fixture.rows()).toEqual([{ ...fixture.row, kept: true }])
    expect(await fixture.shown()).toEqual([{ id: fixture.row.processId, description: "bun run dev", toolUseId: "toolu_previous", startedAtMs: fixture.row.startedAtMs }])
    expect(fixture.keeper.sessions()).toEqual([STEP.sessionId])
    // Every change the keeper reports finds the command shown already.
    expect(shownAtChange.length).toBeGreaterThan(0)
    expect(new Set(await Promise.all(shownAtChange))).toEqual(new Set([1]))
  })

  test("settles a row that a keeper that crashed left kept, and the change it reports shows the command no more", async () => {
    const fixture = await kept({ adopt: () => ({ kind: "ended", record: { kind: "absent" } }) })
    await fixture.authority.writer.putInFlight?.(STEP.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, fixture.row.processId, { ...fixture.row, kept: true })
    expect(await fixture.shown()).toHaveLength(1)
    const shownAtChange: Promise<number>[] = []
    fixture.keeper.onChange(() => { shownAtChange.push(fixture.shown().then((shown) => shown.length)) })

    await fixture.keep()

    expect(await fixture.rows()).toEqual([])
    expect(await Promise.all(shownAtChange)).toEqual([0])
    expect(fixture.held()).toEqual([{ key: `command:${fixture.row.processId}`, conversationId: STEP.conversationId }])
  })

  test("Stop ends a kept command, whose end records its settled tail and retires its row with the one completion, and the status it reports then shows it no more", async () => {
    const outputWrite = Promise.withResolvers<void>()
    const fixture = await kept({ writeOutput: (event) => outputWrite.promise.then(() => fixture.authority.writer.append(event)) })
    await fixture.keep()
    const shownAtChange: number[] = []
    fixture.keeper.onChange(() => { void fixture.shown().then((shown) => { shownAtChange.push(shown.length) }) })

    expect(fixture.keeper.terminate(STEP.sessionId, "toolu_previous")).toBe(true)
    await until(() => fixture.commandRecords().some((record) => record.state === "settled"))
    try {
      expect(await fixture.rows()).toEqual([{ ...fixture.row, kept: true }])
      expect(existsSync(fixture.row.recordPath)).toBe(true)
      expect(fixture.held()).toEqual([])
    } finally {
      outputWrite.resolve()
    }
    await until(() => fixture.held().length > 0 && shownAtChange.at(-1) === 0)

    expect(fixture.events).toEqual(["terminate"])
    expect(fixture.held()).toEqual([{ key: `command:${fixture.row.processId}`, conversationId: STEP.conversationId }])
    expect(await fixture.rows()).toEqual([])
    expect(fixture.recordedOutputs()).toEqual(["toolu_previous"])
    // The background index of the session lists the command as a person stopped it.
    await until(() => fixture.commandRecords().some((record) => record.state === "settled"))
    expect(fixture.commandRecords().at(-1)).toMatchObject({ toolUseId: "toolu_previous", processId: fixture.row.processId, state: "settled", status: "stopped" })
    // The completion carries what the record held, so the record goes.
    expect(existsSync(fixture.row.recordPath)).toBe(false)
    expect(fixture.keeper.sessions()).toEqual([])
  })

  test.each(["running", "recovering"] as const)("a rejected settled-output write while %s leaves the row and supervisor evidence for a later keeper to recover", async (source) => {
    const fixture = await kept({
      row: { kept: true },
      ...(source === "recovering" ? { adopt: (): AdoptionAnswer => ({ kind: "ended", record: readOutcomeRecord(fixture.row.recordPath) }) } : {}),
      writeOutput: async () => { throw new Error("final output write refused") },
    })
    writeOutcomeRecord(fixture.row.recordPath, {
      version: 1, handedOverAtMs: 1,
      outcome: { code: 0, signal: null, deadlineExpired: false, endedAtMs: Date.now() },
    })
    const evidence = readFileSync(fixture.row.recordPath, "utf8")

    await fixture.keep()
    fixture.container.end(0)
    await until(() => fixture.commandRecords().some((record) => record.state === "settled"))
    await fixture.keeper.close()

    expect(fixture.recordedOutputs()).toEqual([])
    expect(await fixture.rows()).toEqual([{ ...fixture.row, kept: true }])
    expect(readFileSync(fixture.row.recordPath, "utf8")).toBe(evidence)
    expect(readFileSync(fixture.row.logPath, "utf8")).toBe("server ready\n")
    expect(fixture.held()).toEqual([])

    const recovery = createCommandKeeper({
      reader: fixture.authority.reader, writer: fixture.authority.writer,
      manager: { subscribe: () => () => {} },
    })
    closing.push(() => recovery.close())
    const authority = {
      ...fixture.authority,
      launcher: { ...fixture.authority.launcher, adoptOwned: async (): Promise<AdoptionAnswer> => ({ kind: "ended", record: readOutcomeRecord(fixture.row.recordPath) }) },
    }
    await recovery.keep(authority, await commandHandoversOfAsync(authority.reader, STEP.sessionId, STEP.conversationId))
    await recovery.close()

    expect(fixture.recordedOutputs()).toEqual(["toolu_previous"])
    expect(await fixture.rows()).toEqual([])
    expect(existsSync(fixture.row.recordPath)).toBe(false)
    expect(fixture.held()).toEqual([{ key: `command:${fixture.row.processId}`, conversationId: STEP.conversationId }])
  })

  test("lands the private copy of a kept mutation command when the command ends, as an edit of its tool call, and the completion it holds carries the landing", async () => {
    const project = realpathSync(temporaryDirectory("fw-command-keeper-project-"))
    writeFileSync(path.join(project, "a.txt"), "a\n")
    const home = path.join(project, ".flywheel", "scratch", "edits", "1")
    const notGit = async () => ({ exitCode: 128, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut: false })
    const copy = await takePrivateProjectCopy({ projectRoot: project, executionCwd: project, home, runGit: notGit, guard: "none" })
    writeFileSync(path.join(copy.copyRoot, "a.txt"), "mine\n")
    const fixture = await kept({ row: { privateCopyHome: home } })
    await fixture.keep()

    fixture.container.end(0)
    await until(() => fixture.held().length > 0)
    await privateCopyRemovals()

    expect(readFileSync(path.join(project, "a.txt"), "utf8")).toBe("mine\n")
    const store = fixture.authority.reader
    expect((await store.readInFlight(STEP.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).map((held) => held.payload.text)).toEqual([expect.stringContaining("Applied to the project:\nUpdated a.txt")])
    expect((await store.readSlice({ sessionId: STEP.sessionId, types: ["tool.execution_output.recorded"] })).facts.map((fact) => {
      if (fact instanceof CorruptEventRowError) throw fact
      return [fact.payload.toolUseId, fact.payload.mutationEvidence !== undefined]
    })).toEqual([["toolu_previous", true]])
    expect((await store.readSlice({ sessionId: STEP.sessionId, types: ["file.changed"] })).facts.map((fact) => {
      if (fact instanceof CorruptEventRowError) throw fact
      return fact.payload
    })).toEqual([expect.objectContaining({ displayPath: "a.txt", origin: expect.objectContaining({ toolUseId: "toolu_previous" }) })])
    expect(await fixture.rows()).toEqual([])
    expect(existsSync(home)).toBe(false)
  })

  test("a row whose supervisor it cannot adopt from shows no Stop, which nothing could answer, and stands for a later attempt", async () => {
    const fixture = await kept({ adopt: () => ({ kind: "refused" }) })

    await fixture.keep()

    expect(await fixture.rows()).toEqual([fixture.row])
    expect(await fixture.shown()).toEqual([])
    expect(fixture.keeper.sessions()).toEqual([])
    expect(fixture.keeper.terminate(STEP.sessionId, "toolu_previous")).toBe(false)
  })

  test("a host that later holds the conversation takes the running command over before its first request and retires its row, and the keeper holds nothing for it after", async () => {
    const fixture = await kept()
    await fixture.keep()
    await until(() => fixture.keeper.liveOutput(STEP.sessionId)["toolu_previous"] !== undefined)
    const notifications: string[] = []
    const tails: string[] = []
    const finals: string[] = []
    const host = createBackgroundExecutionOwner(
      createBackgroundWorkRegistry({
        kind: "workflow",
        enqueueNotification: (text) => { notifications.push(text) },
        onExecutionOutput: (_id, text) => { tails.push(text) },
        onExecutionOutputRecorded: (_id, text) => { finals.push(text) },
      }),
      { authority: fixture.authority, ...STEP, holder: "conversation", deliver: async () => {} },
    )
    closing.push(() => host.close())

    await host.adoptHandedOver()
    expect(tails).toEqual(["server ready\n"])

    expect(host.tasks.processRecord(fixture.row.processId)?.status).toBe("running")
    expect(await fixture.rows()).toEqual([])
    expect(fixture.keeper.sessions()).toEqual([])
    expect(fixture.events).toEqual([])
    // The host's turn parks on the command, and its end reaches the host
    // live; the keeper holds nothing for the conversation.
    await Bun.write(fixture.row.logPath, "server ready\nfinished after transfer\n")
    fixture.container.end(0)
    await until(() => notifications.length > 0)
    expect(notifications).toEqual([expect.stringContaining("exited with code 0")])
    expect(fixture.held()).toEqual([])
    expect(finals).toEqual(["server ready\nfinished after transfer\n"])
    expect(fixture.keeper.liveOutput(STEP.sessionId)).toEqual({})
    expect(fixture.keeper.drainLiveOutput(STEP.sessionId).size).toBe(0)
  })

  test("a kept command's live tail grows in its snapshot and its changes, and a host that takes the command shows the tail from then on", async () => {
    const fixture = await kept()
    const changes: Array<[string, KeptOutputChange]> = []
    fixture.keeper.onLiveOutput((sessionId, change) => { changes.push([sessionId, change]) })
    await fixture.keep()
    const tail = () => fixture.keeper.liveOutput(STEP.sessionId)["toolu_previous"]?.content

    await until(() => tail() === "server ready\n")
    await Bun.write(fixture.row.logPath, "server ready\nlistening on 3000\n")
    await until(() => tail() === "server ready\nlistening on 3000\n")

    expect(changes.every(([sessionId, change]) => sessionId === STEP.sessionId && change.kind === "grew")).toBe(true)
    expect(changes.length).toBeGreaterThan(1)
    const [stored] = await commandHandoversOfAsync(fixture.authority.reader, STEP.sessionId, STEP.conversationId)
    if (!stored) throw new Error("no row")

    const transferred: string[] = []
    expect(await fixture.keeper.take(stored, (text) => {
      expect(tail()).toBe(text)
      transferred.push(text)
    })).toBeDefined()
    expect(transferred).toEqual(["server ready\nlistening on 3000\n"])

    expect(fixture.keeper.liveOutput(STEP.sessionId)).toEqual({})
  })

  test("a kept command's live tail gives way only once its settled tail is recorded, and the change says so", async () => {
    const fixture = await kept()
    const entry = chatEntry()
    const output = createOutputSession({
      executionCwd: "/workspace",
      updateEntry: ({ outputBlocks, ...patch }) => {
        Object.assign(entry, patch)
        if (outputBlocks) entry.outputBlocks = () => outputBlocks
      },
      priorBlocks: [{
        kind: "tool", id: "toolu_previous", name: "bash",
        presentation: { name: "Bash", detail: "serve" },
        status: "completed", timestamp: 1, content: "old seeded body",
      }],
    })
    closing.push(async () => { output.dispose() })
    output.flush()
    const readSequence = () => readOutputSequence(STEP.sessionId, { kind: "chat", command: "chat", conversationId: "conversation", label: "Chat", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive", executionCwd: FIXTURE_EXECUTION_CWD, name: "Chat", createdAt: "2026-01-01T00:00:00.000Z" }, {
      sessionStore: { get: () => entry },
      keptOutput: fixture.keeper,
      reader: fixture.authority.reader,
      projectionReader: fixture.authority.reader,
      projectRoot: FIXTURE_EXECUTION_CWD,
      transcriptCache: {
        projectBlock: async (_sessionId, block) => block,
        read: async () => null,
        createSessionReader: () => { throw new Error("not needed for the resident chat") },
        children: async () => { throw new Error("not needed for a tool row") },
        projectGroupChildren: (indexed) => indexed,
      },
    })
    const kinds: string[] = []
    const tailAtChange: Array<boolean> = []
    const patches: RuntimeUiPatchInput[] = []
    const projection = createKeptOutputProjection({
      keeper: fixture.keeper,
      readSequence,
      projectSettled: (_sessionId, change) => {
        output.applyProjectionEvent(change.event)
        output.flush()
      },
      shipped: createShippedOutput({ publish: (patch) => {
        patches.push(patch)
        return { ...patch, position: patches.length, prevPosition: patches.length - 1 }
      } }),
    })
    closing.push(async () => { projection.dispose() })
    fixture.keeper.onLiveOutput((_sessionId, change) => {
      kinds.push(change.kind)
      if (change.kind === "settled") {
        tailAtChange.push(fixture.recordedOutputs().length === 1 && fixture.keeper.liveOutput(STEP.sessionId)["toolu_previous"] === undefined)
      }
    })
    await fixture.keep()
    await until(() => fixture.keeper.liveOutput(STEP.sessionId)["toolu_previous"] !== undefined)

    fixture.container.end(0)
    await until(() => kinds.includes("settled"))
    await until(() => patches.some((patch) => patch.payload.kind === "output.delta" && patch.payload.delta.blocks.length > 0))

    expect(tailAtChange).toEqual([true])
    const final = patches.find((patch) => patch.payload.kind === "output.delta" && patch.payload.delta.blocks.length > 0)
    expect(final?.payload).toMatchObject({ kind: "output.delta", delta: {
      blocks: [{ kind: "upsert", block: { id: "toolu_previous", content: "server ready\n" } }],
      streamingToolTextOps: [{ kind: "remove", toolUseId: "toolu_previous" }],
    } })
    expect(fixture.keeper.liveOutput(STEP.sessionId)).toEqual({})
    expect(await (await readSequence())?.readBlock(0)).toMatchObject({ id: "toolu_previous", content: "server ready\n" })
    output.pushSystemMessage("later update", 2)
    output.flush()
    expect(await (await readSequence())?.readBlock(0)).toMatchObject({ id: "toolu_previous", content: "server ready\n" })
  })

  test("a person's deletion of the session ends what the keeper holds for it", async () => {
    const fixture = await kept()
    await fixture.keep()

    fixture.delete(STEP.sessionId)
    await until(() => fixture.events.length > 0)

    expect(fixture.events).toEqual(["terminate"])
    await until(() => fixture.keeper.sessions().length === 0)
  })

  test("a planned replacement's stop hands the kept command to the next build, whose row names no keeper, and a take after the close began gives nothing", async () => {
    const fixture = await kept({ stopping: () => true })
    await fixture.keep()
    const [stored] = await commandHandoversOfAsync(fixture.authority.reader, STEP.sessionId, STEP.conversationId)
    if (!stored) throw new Error("no row")

    const closed = fixture.keeper.close()
    expect(await fixture.keeper.take(stored, () => {})).toBeUndefined()
    await closed

    expect(fixture.events.map((event) => event.split(" ")[0])).toEqual(["handOver"])
    expect((await fixture.rows()).map((row) => ({ processId: row.processId, kept: row.kept }))).toEqual([{ processId: fixture.row.processId, kept: undefined }])
    expect(fixture.held()).toEqual([])
  })

  test("any other stop ends the kept command, and its end retires its row with the one completion", async () => {
    const fixture = await kept({ stopping: () => false })
    await fixture.keep()

    await fixture.keeper.close()

    expect(fixture.events).toEqual(["terminate"])
    expect(await fixture.rows()).toEqual([])
    expect(fixture.held()).toEqual([{ key: `command:${fixture.row.processId}`, conversationId: STEP.conversationId }])
  })
})
