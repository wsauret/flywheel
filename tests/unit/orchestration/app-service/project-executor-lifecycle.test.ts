import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createCommandKeeper } from "../../../../src/orchestration/app-service/command-keeper.js"
import { composeExecutorCommandHandover } from "../../../../src/orchestration/app-service/executor-command-handover.js"
import { createMutationAdmission } from "../../../../src/orchestration/app-service/mutation-admission.js"
import { serveProjectExecutorLifecycle } from "../../../../src/orchestration/app-service/project-executor-lifecycle.js"
import { projectExecutorReattachDelayMs, PROJECT_EXECUTOR_REATTACH_DEADLINE_MS } from "../../../../src/orchestration/app-service/project-executor-protocol.js"
import { createReplacementReport, type ReplacementBlocker } from "../../../../src/orchestration/app-service/replacement-blockers.js"
import { createProcessorClaims, type ProcessorClaims } from "../../../../src/orchestration/agent-runtime/tools/processor-claims.js"
import { makeMockOwnedProcess } from "../agent-runtime/tools/_bash-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporary = temporaryDirectories()

type ProjectExecutorLifecycleHandlers = Parameters<typeof serveProjectExecutorLifecycle>[0]["handlers"]

/** The executor's end of the lifecycle channel, with the account's side as a list. */
function lifecycleFixture(handlers: Partial<ProjectExecutorLifecycleHandlers> = {}, processor: ProcessorClaims = createProcessorClaims()) {
  const sent: unknown[] = []
  const ended: string[] = []
  let deliver: ((value: unknown) => void | Promise<void>) | undefined
  const reattached = new Set<() => void>()
  const served = serveProjectExecutorLifecycle({
    lifecycle: {
      async send(message) { sent.push(message) },
      onMessage(handler) { deliver = handler; return () => { deliver = undefined } },
      onReattach(handler) { reattached.add(handler); return () => { reattached.delete(handler) } },
    },
    processor,
    handlers: {
      start: async () => {},
      stop: async () => {},
      runtime: () => undefined,
      adoptLoginShellPath: () => {},
      ...handlers,
    },
    log: { warn() {} },
    async end(reason) { ended.push(reason) },
  })
  return {
    sent, ended,
    command: async (value: unknown) => { await deliver?.(value) },
    /** The runtime reports, unasked, that its blockers changed. */
    reportBlockers: () => served.reportBlockers(),
    recordCapacityWake: (at: number | null) => served.recordCapacityWake(at),
    /** A new transport carries the lifecycle channel again. */
    reattach: () => { for (const handler of reattached) handler() },
  }
}

describe("executor lifecycle commands", () => {
  test("a command that fails answers its own failure and the generation keeps serving", async () => {
    const runtime = {
      startChatDefault() { throw new Error("model catalog unreadable") },
      blockers: async () => { throw new Error("session table busy") },
      setReplacement() {},
      interruptForReplacement: async () => [],
      continueAfterReplacement: async () => [],
      continueCapacityWaits: async () => ({ pending: 0, at: null, next: null }),
    }
    const executor = lifecycleFixture({ runtime: () => runtime })
    await executor.command({ kind: "blockers", id: 4 })
    await executor.command({ kind: "start_chat_default" })
    await executor.command({ kind: "not-a-command" })
    expect(executor.sent).toEqual([
      { kind: "command_failed", command: "blockers", id: 4, reason: "session table busy" },
      { kind: "command_failed", command: "start_chat_default", reason: "model catalog unreadable" },
      { kind: "command_failed", reason: "project executor lifecycle command is invalid" },
    ])
    expect(executor.ended).toEqual([])
  })

  test("blockers lists leave in the order they were computed, unasked reports and answers alike", async () => {
    // The account keeps the last list to arrive as the latest one, so a list
    // computed earlier must never arrive after one computed later. Each
    // computation reads the blockers when it begins and finishes when the
    // test releases it, the newest first.
    const shell = { projectRoot: "/project", projectLabel: "project", sessionId: "s-1", reason: "shell" as const }
    let current: ReplacementBlocker[] = []
    const computing: (() => void)[] = []
    const runtime = {
      startChatDefault() {},
      blockers: () => {
        const read = current
        return new Promise<ReplacementBlocker[]>((resolve) => { computing.push(() => resolve(read)) })
      },
      setReplacement() {},
      interruptForReplacement: async () => [],
      continueAfterReplacement: async () => [],
      continueCapacityWaits: async () => ({ pending: 0, at: null, next: null }),
    }
    const executor = lifecycleFixture({ runtime: () => runtime })
    executor.reportBlockers()
    await Bun.sleep(1)
    current = [shell]
    const answered = executor.command({ kind: "blockers", id: 7 })
    for (let round = 0; round < 2; round++) {
      await Bun.sleep(1)
      computing.pop()?.()
    }
    await answered
    await Bun.sleep(1)
    expect(executor.sent).toEqual([
      { kind: "blockers", blockers: [] },
      { kind: "blockers", id: 7, blockers: [shell] },
    ])
  })

  test("the drain's handoff in the replacement frame reaches the command handover authority, and each handoff answers its sessions", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("executor-lifecycle-")))
    // The report and the authority as the executor composes them: the
    // authority reads the handoff the frame set.
    const report = createReplacementReport({
      projectRoot: "/work/app", projectLabel: undefined, listMetadata: async () => ({ sessions: [], errors: [] }), runningChildren: () => [], runningWorkflows: () => [], keptSessions: () => [],
      sessionStore: { allIds: () => [], get: () => undefined },
      client: { query: async () => { throw new Error("no blockers are read") }, admission: createMutationAdmission() },
    })
    const handover = composeExecutorCommandHandover({
      reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), launcher: { adoptOwned: async () => { throw new Error("nothing is adopted") }, spawnOwned: async () => { throw new Error("nothing is launched") } },
      userDataRoot: "/home/a/.flywheel", keeper: createCommandKeeper({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), manager: { subscribe: () => () => {} } }),
    })
    handover.hearThrough(report)
    const { authority } = handover
    const runtime = {
      startChatDefault() {},
      blockers: async () => [],
      setReplacement: report.set,
      interruptForReplacement: async () => ["cut-chat"],
      continueAfterReplacement: async () => ["chat-1"],
      continueCapacityWaits: async () => ({ pending: 0, at: null, next: null }),
    }
    const executor = lifecycleFixture({ runtime: () => runtime })
    try {
      await executor.command({ kind: "replacement", state: { kind: "requested", blockers: [] } })
      expect(authority.handoffId()).toBeUndefined()
      await executor.command({ kind: "replacement", state: { kind: "draining", handoffId: "h1" } })
      expect(authority.handoffId()).toBe("h1")

      await executor.command({ kind: "interrupt_for_replacement", id: 1, handoffId: "h1" })
      await executor.command({ kind: "continue_after_replacement", id: 2, handoffId: "h0" })
      await Bun.sleep(1)
      expect(executor.sent).toEqual([
        { kind: "handoff", id: 1, sessionIds: ["cut-chat"] },
        { kind: "handoff", id: 2, sessionIds: ["chat-1"] },
      ])
    } finally {
      report.stop()
      store.close()
    }
  })

  test("a second start is refused as a command and the started generation keeps serving", async () => {
    let starts = 0
    const executor = lifecycleFixture({ start: async () => { starts += 1 } })
    await executor.command({ kind: "start", chatDefault: { kind: "pending" } })
    await executor.command({ kind: "start", chatDefault: { kind: "pending" } })
    expect(starts).toBe(1)
    expect(executor.sent).toEqual([{ kind: "command_failed", command: "start", reason: "project executor was already started" }])
    expect(executor.ended).toEqual([])
  })

  test("the account's login shell PATH is adopted before and after the start", async () => {
    const adopted: string[] = []
    const executor = lifecycleFixture({ adoptLoginShellPath: (path) => { adopted.push(path) } })
    await executor.command({ kind: "login_shell_path", path: "/opt/homebrew/bin:/usr/bin" })
    await executor.command({ kind: "start", chatDefault: { kind: "pending" } })
    await executor.command({ kind: "login_shell_path", path: "/usr/local/bin:/usr/bin" })
    expect(adopted).toEqual(["/opt/homebrew/bin:/usr/bin", "/usr/local/bin:/usr/bin"])
    expect(executor.sent).toEqual([])
  })

  test("only a failed start ends the generation, because nothing serves until a start succeeds", async () => {
    const executor = lifecycleFixture({ start: async () => { throw new Error("composition failed") } })
    await executor.command({ kind: "start", chatDefault: { kind: "pending" } })
    expect(executor.sent).toEqual([{ kind: "failed", reason: "composition failed" }])
    expect(executor.ended).toEqual(["project executor start failed"])
  })
})

describe("executor processor admission messages", () => {
  test("the whole claimed set is sent at each change and again at each reattach, and a held set from the account reaches the claims", async () => {
    const claims = createProcessorClaims()
    const executor = lifecycleFixture({}, claims)
    const exit = Promise.withResolvers<{ code: number; signal: null; statusOf: "payload"; ownership: "surrendered" }>()
    claims.claim(makeMockOwnedProcess({ token: "owned:a", pid: 41, exited: exit.promise }), { order: 10, exempt: true, sessionId: "s-1", toolUseId: "toolu_a" })
    claims.claim(makeMockOwnedProcess({ token: "owned:b", pid: 42, exited: new Promise(() => {}) }), { order: 20, exempt: false, sessionId: "s-1", toolUseId: "toolu_b" })
    await Bun.sleep(0)
    // Changes that arrive while a set waits to be sent join that set.
    expect(executor.sent).toEqual([{ kind: "processor_claims", claims: [
      { token: "owned:a", pid: 41, order: 10, exempt: true },
      { token: "owned:b", pid: 42, order: 20, exempt: false },
    ] }])
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
    await Bun.sleep(0)
    executor.reattach()
    await Bun.sleep(0)
    const onlyB = { kind: "processor_claims", claims: [{ token: "owned:b", pid: 42, order: 20, exempt: false }] }
    expect(executor.sent.slice(1)).toEqual([onlyB, onlyB])

    await executor.command({ kind: "processor_holds", held: [{ token: "owned:b", ahead: 3 }] })
    expect(claims.heldToolCallIds("s-1")).toEqual(["toolu_b"])
    expect(claims.heldTime("owned:b").hold()).toEqual({ ahead: 3 })
    expect(executor.sent).toHaveLength(3)
  })
})

describe("executor capacity wake reports", () => {
  test("a wake time whose answer a lost transport carried is sent again at the reattach, in order, and settles with the answer", async () => {
    const executor = lifecycleFixture()
    const wakes = () => executor.sent.filter((frame) => typeof frame === "object" && frame !== null && "kind" in frame && frame.kind === "capacity_wake")
    let settled = 0
    const first = executor.recordCapacityWake(1_000).then(() => { settled += 1 })
    const second = executor.recordCapacityWake(null).then(() => { settled += 1 })
    await Bun.sleep(0)
    // Neither answer arrives on the transport that carried the times.
    executor.reattach()
    await Bun.sleep(0)
    expect(wakes()).toEqual([
      { kind: "capacity_wake", id: 1, at: 1_000 },
      { kind: "capacity_wake", id: 2, at: null },
      { kind: "capacity_wake", id: 1, at: 1_000 },
      { kind: "capacity_wake", id: 2, at: null },
    ])
    await executor.command({ kind: "capacity_wake_recorded", id: 1 })
    await executor.command({ kind: "capacity_wake_recorded", id: 2 })
    await Promise.all([first, second])
    expect(settled).toBe(2)
    // An answered time is not sent again.
    executor.reattach()
    await Bun.sleep(0)
    expect(wakes()).toHaveLength(4)
  })
})

describe("executor channel reattach walk", () => {
  test("keeps trying until the account's reattach deadline has passed", () => {
    // The account ends the generation once a channel has stayed detached for
    // the deadline; a walk that gave up earlier would waste the rest of it.
    let elapsed = 0
    let lastAttemptAt = 0
    for (let attempt = 0; ; attempt++) {
      elapsed += projectExecutorReattachDelayMs(attempt)
      lastAttemptAt = elapsed
      if (elapsed >= PROJECT_EXECUTOR_REATTACH_DEADLINE_MS) break
    }
    expect(lastAttemptAt).toBeGreaterThanOrEqual(PROJECT_EXECUTOR_REATTACH_DEADLINE_MS)
    // No wait is longer than the walk's cap, so a reattach is never far behind a returning account.
    expect(projectExecutorReattachDelayMs(40)).toBe(8_000)
  })
})
