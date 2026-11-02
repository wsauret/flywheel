import { describe, expect, it, spyOn } from "bun:test"

import type { TurnParkState } from "../../../../src/infra/agent-loop-events"
import { DebugLog } from "../../../../src/infra/debug-log"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import type { AgentRunResult } from "../../../../src/orchestration/agent-runtime/types"
import { composeModuleRuntimes } from "../../../../src/infra/module-runtime"
import { registerCapacityWaits } from "../../../../src/orchestration/session/capacity-wait"
import { authorizePlannedSessionContinuation, capacityContinuations } from "../../../../src/orchestration/session/planned-session-continuation"
import { temporaryDirectories } from "../../../helpers/directories"
import { flushMicrotasks, makeLifecycle, useStore } from "./_chat-runner-lifecycle-fixtures"

const makeDirectory = temporaryDirectories()
const spent = (atMs: number): AgentRunResult => ({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "No access provider can run the model", recovery: { kind: "at", atMs } } })

/** A lifecycle on a real store whose capacity ledger is registered, as the
 *  executor composes a chat. */
function capacityLifecycle(prefix: string) {
  let store!: ReturnType<typeof useStore>
  let ledger!: ReturnType<typeof registerCapacityWaits>
  const made = makeLifecycle(undefined, (prepared) => {
    store = useStore(prepared, makeDirectory(prefix))
    ledger = registerCapacityWaits(prepared.infra.eventStore, { reader: prepared.infra.eventStore, writer: asAsyncEventWriter(store) })
  })
  const turnEnds: string[] = []
  made.deps.treeWriter.commitTurnEnd = async (by) => { turnEnds.push(String(by)); return { kind: "user", content: "interrupted", origin: "system" } }
  const rows = () => capacityContinuations(made.deps.infra.eventStore)
  const owe = (continuesAt: number) => authorizePlannedSessionContinuation({ reader: made.deps.infra.eventStore, writer: asAsyncEventWriter(store), continuation: { target: { kind: "chat", sessionId: made.deps.sessionId }, continuesAt } })
  const dispose = async () => {
    made.state.end()
    made.resolvers.at(-1)?.({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
    await made.lifecycle.settle()
    await made.lifecycle.terminateBackgroundWorks()
    await made.deps.treeWriter.dispose()
    ledger.dispose()
    store.close()
  }
  return { ...made, turnEnds, rows, owe, dispose }
}

describe("chat runner lifecycle capacity wait", () => {
  it("waits for model capacity until the stated time and continues the same turn on its own; an interrupt ends the wait with the person's turn end", async () => {
    const { lifecycle, resolvers, deps } = makeLifecycle()
    const turnEnds: string[] = []
    deps.treeWriter.commitTurnEnd = async (by) => { turnEnds.push(String(by)); return { kind: "user", content: "interrupted", origin: "system" } }
    lifecycle.enqueueInput("first message")
    await flushMicrotasks()
    resolvers[0]?.(spent(Date.now() + 10))
    await Bun.sleep(25)
    await flushMicrotasks()
    expect(resolvers.length).toBe(2)
    expect(lifecycle.turnState).toBe("active")

    resolvers[1]?.(spent(Date.now() + 10))
    await flushMicrotasks()
    expect(lifecycle.interruptGeneration()).toBe(true)
    await flushMicrotasks()
    expect(resolvers.length).toBe(2)
    expect(turnEnds).toEqual(["person"])
    expect(lifecycle.turnState).toBe("idle")
  })

  it("resumes on attach a turn whose row owes a capacity wait ahead, which waits under the host: hold answers and the runtime's stop ends it with no request; nothing owed starts nothing", async () => {
    const chat = capacityLifecycle("flywheel-owed-capacity-")
    const notices: string[] = []
    chat.eventBus.subscribeToType("agent.notice.changed", (event) => {
      const { operation } = event.data
      if (operation.type === "upsert") notices.push(operation.notice.title)
    }, { deliveryClass: "ui", delivery: "direct" })
    try {
      expect(await chat.lifecycle.awaitOwedCapacity()).toBe(false)
      expect(chat.lifecycle.turnState).toBe("idle")

      const continuesAt = Date.now() + 60_000
      await chat.owe(continuesAt)
      expect(await chat.lifecycle.awaitOwedCapacity()).toBe(true)
      while (chat.resolvers.length < 1) await flushMicrotasks()
      // The runner reads the Resume and assembles its runtime before its
      // first request, which the account's availability refuses until the
      // row's time.
      const runner = chat.runnerOptions[0]?.lifecycle
      expect(runner?.inputSource?.drainPending()?.kind).toBe("resume")
      const modules = composeModuleRuntimes([])
      await runner?.onRuntimeAssembled?.({ modules })
      chat.resolvers[0]?.(spent(continuesAt))
      while (!notices.includes("Waiting for model capacity")) await flushMicrotasks()
      expect(chat.lifecycle.turnState).toBe("active")
      expect(await chat.lifecycle.hold()).toBe(modules)

      expect(chat.lifecycle.abortRunningTurn()).toBe(true)
      await chat.lifecycle.settle()
      expect(chat.lifecycle.turnState).toBe("idle")
      expect(chat.resolvers.length).toBe(1)
      expect(chat.turnEnds).toEqual([])
    } finally {
      await chat.dispose()
    }
  })

  it("withdraws a capacity row once the turn that continued from it parks, and leaves a row it never continued from owed", async () => {
    const chat = capacityLifecycle("flywheel-chat-capacity-")
    const records: Array<{ readonly type: string; readonly payload?: unknown }> = []
    const recordSpy = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry) })
    const park = (state: TurnParkState) => chat.runnerOptions.at(-1)?.lifecycle.onTurnParked?.({
      handoffWritten: false, turnCount: 1, activeBackgroundCount: 0, parkedOnBackgroundWork: false, waitRequested: false, userResumeRequired: false, park: state,
    })
    try {
      // A row an earlier executor left, which no run of this one continued,
      // stays owed when a turn of the session parks.
      await chat.owe(Date.now() + 60_000)
      chat.lifecycle.enqueueInput("first message")
      while (chat.resolvers.length < 1) await flushMicrotasks()
      await park("idle")
      expect(await chat.rows()).toHaveLength(1)

      chat.resolvers[0]?.(spent(Date.now() + 10))
      while (chat.resolvers.length < 2) await flushMicrotasks()
      // The arm lands beside the wait, which does not wait for it. The run
      // that continues keeps the wait owed until its turn ends.
      while ((await chat.rows()).some(({ continuesAt }) => continuesAt > Date.now())) await flushMicrotasks()
      expect(await chat.rows()).toHaveLength(1)

      await park("idle")
      expect(await chat.rows()).toEqual([])
      expect(records.filter(({ type }) => type === "agent.capacity_wait").map(({ payload }) => payload)).toContainEqual({ event: "withdrawn", sessionId: chat.deps.sessionId, reason: "continued" })
    } finally {
      recordSpy.mockRestore()
      await chat.dispose()
    }
  })
})
