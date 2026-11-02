import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { readOutcomeRecord, writeOutcomeRecord } from "../../../../src/infra/command-handover.js"
import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createCommandKeeper } from "../../../../src/orchestration/app-service/command-keeper.js"
import { composeExecutorCommandHandover, sweepCommandHandovers, type ChatHostAttach } from "../../../../src/orchestration/app-service/executor-command-handover.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, type CommandHandoverRow } from "../../../../src/orchestration/session/command-handover.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { authorizePlannedSessionContinuation } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { fakeContainer, handedOverRow } from "../agent-runtime/_command-handover-fixtures.js"

describe("the adoption sweep of a later executor generation", () => {
  let ctx: SupervisorTestContext

  beforeEach(() => {
    ctx = createSupervisorTestContext()
  })

  afterEach(async () => {
    await disposeSupervisorTestContext(ctx)
  })

  const writer = () => ctx.runtime.runSync(EventStoreWriterService)

  async function storeRow(row: CommandHandoverRow): Promise<void> {
    await writer().putInFlight?.(row.sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
  }

  /** A workflow session's step command, which no chat owns. */
  function stepRow(overrides: Partial<CommandHandoverRow>): CommandHandoverRow {
    return handedOverRow(ctx.baseDir, { sessionId: "workflow-1", conversationId: "agent-step-1" }, overrides)
  }

  /** Sweeps with a launcher that finds each row's supervisor as `running`
   *  says: still serving its channel, which answers the adoption, or ended
   *  with the record it kept. Answers the keeper the sweep gave the rest to. */
  async function sweep(attached: string[], running: (row: { readonly pid: number }) => boolean = () => false) {
    const supervisor: ChatHostAttach["supervisor"] = {
      activateSession: async () => true,
      ensureChatRunner: async (sessionId) => ({ adoptHandedOver: async () => { attached.push(sessionId) } }),
    }
    const keeper = createCommandKeeper({ reader: asAsyncEventReadSurface(ctx.store), writer: writer(), manager: ctx.manager })
    const handover = composeExecutorCommandHandover({
      reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer: writer(), userDataRoot: ctx.baseDir, keeper,
      launcher: {
        adoptOwned: async (command) => (running(command) ? { kind: "adopted", owned: fakeContainer([]).owned } : { kind: "ended", record: readOutcomeRecord(command.recordPath) }),
        spawnOwned: async () => { throw new Error("nothing is launched") },
      },
    })
    await sweepCommandHandovers({ ...handover, manager: ctx.manager, supervisor })
    return keeper
  }

  const rows = (sessionId: string) => ctx.store.readInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND).map((row) => row.key)
  const held = (sessionId: string) => ctx.store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    .map((row) => ({ key: row.key, conversationId: row.payload.conversationId, text: String(row.payload.text) }))

  test("attaches the host of a chat that owns a row, which adopts it", async () => {
    const conversationId = `conversation-${crypto.randomUUID()}`
    const chat = await ctx.manager.createChat({ conversationId })
    await storeRow(handedOverRow(ctx.baseDir, { sessionId: chat, conversationId }, {}))
    const attached: string[] = []

    await sweep(attached)

    expect(attached).toEqual([chat])
    // The chat's host adopts the row; the sweep settles nothing of it.
    expect(rows(chat)).toEqual(["bash-bg-previous"])
    expect(held(chat)).toEqual([])
  })

  test("settles a row whose supervisor has ended with one keyed completion, retires it, and removes its record", async () => {
    const row = stepRow({})
    await Bun.write(row.logPath, "compiled 12 modules\nfixture-command-finished\n")
    writeOutcomeRecord(row.recordPath, { version: 1, handedOverAtMs: Date.now() - 2_000, outcome: { code: 0, signal: null, deadlineExpired: false, endedAtMs: Date.now() - 1_000 } })
    await storeRow(row)

    await sweep([])

    expect(held("workflow-1")).toEqual([{ key: "command:bash-bg-previous", conversationId: "agent-step-1", text: expect.stringContaining("exited with code 0") }])
    expect(held("workflow-1")[0]?.text).toContain("fixture-command-finished")
    expect(rows("workflow-1")).toEqual([])
    expect(existsSync(row.recordPath)).toBe(false)
  })

  test("gives the keeper a row whose supervisor still serves its channel, which holds the running command, and whose row stands until a host takes it", async () => {
    await storeRow(stepRow({}))
    const attached: string[] = []

    const keeper = await sweep(attached, () => true)

    expect(attached).toEqual([])
    expect(keeper.sessions()).toEqual(["workflow-1"])
    expect(rows("workflow-1")).toEqual(["bash-bg-previous"])
    expect(held("workflow-1")).toEqual([])
    await keeper.close()
  })

  // The one that retires a row publishes, so the sweep needs no knowledge of
  // which host a resume will construct.
  test("settles the row of a session a successor still owes its continuation, and holds its one completion for the resumed host", async () => {
    await storeRow(stepRow({ recordPath: join(ctx.baseDir, "absent.outcome.json") }))
    await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer: writer(), continuation: { target: { kind: "workflow", workflowId: "workflow-1" }, handoffId: "handoff-1" } })

    await sweep([])

    expect(rows("workflow-1")).toEqual([])
    expect(held("workflow-1")).toEqual([{ key: "command:bash-bg-previous", conversationId: "agent-step-1", text: expect.stringContaining("ended with the previous runtime") }])
  })
})
