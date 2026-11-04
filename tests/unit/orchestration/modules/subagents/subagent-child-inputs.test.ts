import { describe, expect, test } from "bun:test"
import { subagentChildHarnesses, heldRunner, createRoot } from "./_subagent-child-fixtures.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { deliverSessionInput } from "../../../../../src/orchestration/session/session-input-delivery.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { publishTestSubagent } from "../../session/_session-manager-fixtures.js"
import { recoverStaleSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-recovery.js"
import { COMPOSER_RETURN_KIND } from "../../../../../src/orchestration/session/composer-returns.js"
import { removeOwnerPid } from "../../../../../src/orchestration/session/pid-lock.js"
import { readSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { liveSessionControl } from "../../../../../src/orchestration/session/live-session-control.js"

const createHarness = subagentChildHarnesses()
describe("subagent private input at handoff", () => {
  test.each(["drain", "wait"] as const)("handoff start holds every input through %s and returns unread human input to the parent's composer", async (mode) => {
    const runs = heldRunner()
    const harness = createHarness(runs.createAgent)
    try {
      const { sessionId: parent, conversationId: parentConversation } = await createRoot(harness.manager)
      await harness.tool(parent).execute({ persona: "delegator", description: "input test", rationale: TEST_RATIONALE, prompt: "inspect" }, makeContext({ toolUseId: "dispatch" }))
      const child = (await harness.manager.read(parent))!.childSessionIds![0]!
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }
      const options = runs.options[0]!
      const control = liveSessionControl(harness.reader, child)!
      expect(await control.notify({ key: "subagent-result:run-1", text: "nested result" })).toBe(true)
      expect(await control.notify({ key: "subagent-result:run-1", text: "nested result" })).toBe(true)
      expect(options.lifecycle.inputSource!.drainPending()).toMatchObject({ kind: "message", text: expect.stringContaining("nested result"), backgroundNotificationIds: ["subagent-result:run-1"] })
      expect(options.lifecycle.inputSource!.drainPending()).toBeNull()
      await deliverSessionInput(delivery, child, { text: "keep my words", producer: { kind: "human" } })
      options.lifecycle.onHandoffStarted!()
      expect(await deliverSessionInput(delivery, child, { text: "too late", producer: { kind: "human" } })).toEqual({ status: "refused", reason: "handing_off" })
      const source = options.lifecycle.inputSource!
      let woke = false
      const abort = new AbortController()
      const waiting = mode === "wait" ? source.prepareWaitForInput!(abort.signal).commit().then((input) => { woke = true; return input }) : undefined
      if (mode === "drain") expect(source.drainPending()).toBeNull()
      else {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(woke).toBe(false)
      }
      expect(await liveSessionControl(harness.reader, child)!.notify({ text: "background task finished" })).toBe(false)
      expect(await deliverSessionInput(delivery, child, { text: "parent reply", producer: { kind: "session", sessionId: parent, conversationId: parentConversation, toolUseId: "reply", hop: 0 } })).toEqual({ status: "refused", reason: "handing_off" })
      source.enqueueRuntimeNotice?.("wait expired")
      abort.abort()
      if (waiting) expect(await waiting).toBeNull()
      expect(source.drainPending()).toBeNull()
      options.runtimeSurfaces!.handoff!.onContent({ summary: "done" })
      runs.results[0]!.resolve({ servedRequests: 0, terminal: { kind: "completed" }, durationMs: 1 })
      await Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)))
      const tree = await tryOpenConversationTree({ sessionId: parent, conversationId: parentConversation, store: harness.reader, writer: harness.writer })
      expect(JSON.stringify(await tree!.getBranch())).toContain("keep my words")
      expect(JSON.stringify(await tree!.buildContext())).not.toContain("keep my words")
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toMatchObject([{ payload: { input: { text: "keep my words" } } }])
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
      tree!.getStorage().dispose()
    } finally { for (const result of runs.results) result.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); await harness.close() }
  })
  test("handoff close waits for a pending recall without also returning its input to the parent", async () => {
    const runs = heldRunner()
    const harness = createHarness(runs.createAgent)
    const retiring = Promise.withResolvers<void>()
    const retirement = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const drop = harness.writer.dropInFlight!
    harness.writer.dropInFlight = async (...args) => {
      if (args[1] === QUEUED_USER_INPUT_IN_FLIGHT_KIND && args[2] === "person:recall") {
        retiring.resolve()
        await retirement.promise
      }
      await drop(...args)
    }
    try {
      const { sessionId: parent, conversationId: parentConversation } = await createRoot(harness.manager)
      await harness.tool(parent, { childSlots: { acquire: () => ({ status: "acquired", reservation: { release: () => released.resolve() } }) } })
        .execute({ persona: "delegator", description: "recall race", rationale: TEST_RATIONALE, prompt: "inspect" }, makeContext({ toolUseId: "dispatch" }))
      const child = (await harness.manager.read(parent))!.childSessionIds![0]!
      await deliverSessionInput({ manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }, child,
        { text: "recalled words", producer: { kind: "human" }, submissionIds: ["recall"] })
      const recalling = liveSessionControl(harness.reader, child)!.recallQueuedMessage!()
      await retiring.promise
      const options = runs.options[0]!
      expect(options.lifecycle.inputSource!.drainPending()).toBeNull()
      options.lifecycle.onHandoffStarted!()
      options.runtimeSurfaces!.handoff!.onContent({ summary: "done" })
      let closed = false
      const completion = Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)))
        .then(() => { closed = true })
      runs.results[0]!.resolve({ servedRequests: 0, terminal: { kind: "completed" }, durationMs: 1 })
      await released.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual([])
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(1)
      retirement.resolve()
      expect(await recalling).toEqual({ text: "recalled words", producer: { kind: "human" }, submissionIds: ["recall"] })
      await completion
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual([])
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
      const tree = await tryOpenConversationTree({ sessionId: parent, conversationId: parentConversation, store: harness.reader, writer: harness.writer })
      try { expect(JSON.stringify(await tree!.getBranch())).not.toContain("recalled words") }
      finally { tree!.getStorage().dispose() }
    } finally {
      retirement.resolve()
      for (const result of runs.results) result.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await harness.close()
    }
  })
  test("handoff close waits for pending admission to drop its refused hold before settlement", async () => {
    const runs = heldRunner()
    const harness = createHarness(runs.createAgent)
    const holding = Promise.withResolvers<void>()
    const admission = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const swap = harness.writer.swapInFlight!
    harness.writer.swapInFlight = async (...args) => {
      const held = await swap(...args)
      if (args[1] === QUEUED_USER_INPUT_IN_FLIGHT_KIND && args[2] === "person:admission" && args[4] !== null) {
        holding.resolve()
        await admission.promise
      }
      return held
    }
    try {
      const { sessionId: parent, conversationId: parentConversation } = await createRoot(harness.manager)
      await harness.tool(parent, { childSlots: { acquire: () => ({ status: "acquired", reservation: { release: () => released.resolve() } }) } })
        .execute({ persona: "delegator", description: "admission race", rationale: TEST_RATIONALE, prompt: "inspect" }, makeContext({ toolUseId: "dispatch" }))
      const child = (await harness.manager.read(parent))!.childSessionIds![0]!
      const sending = deliverSessionInput({ manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }, child,
        { text: "refused words", producer: { kind: "human" }, submissionIds: ["admission"] })
      await holding.promise
      const options = runs.options[0]!
      options.lifecycle.onHandoffStarted!()
      options.runtimeSurfaces!.handoff!.onContent({ summary: "done" })
      let closed = false
      const completion = Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)))
        .then(() => { closed = true })
      runs.results[0]!.resolve({ servedRequests: 0, terminal: { kind: "completed" }, durationMs: 1 })
      await released.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual([])
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(1)
      expect(await deliverSessionInput({ manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }, child,
        { text: "later words", producer: { kind: "human" }, submissionIds: ["late-admission"] })).toEqual({ status: "refused", reason: "handing_off" })
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(1)
      admission.resolve()
      expect(await sending).toEqual({ status: "refused", reason: "handing_off" })
      await completion
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toEqual([])
      expect((await readSubagentRuns(harness.reader, child)).at(-1)?.status).toBe("completed")
      const childMetadata = await harness.manager.read(child)
      if (!childMetadata || childMetadata.kind === "workflow") throw new Error("Expected a child conversation")
      for (const [sessionId, conversationId] of [[parent, parentConversation], [child, childMetadata.conversationId]] as const) {
        const tree = await tryOpenConversationTree({ sessionId, conversationId, store: harness.reader, writer: harness.writer })
        try { expect(JSON.stringify(await tree!.getBranch())).not.toContain("refused words") }
        finally { tree!.getStorage().dispose() }
      }
    } finally {
      admission.resolve()
      for (const result of runs.results) result.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
      await harness.close()
    }
  })
  test("a recorded successful handoff returns the previous queued-human shape before crash recovery can adopt it", async () => {
    const harness = createHarness(heldRunner().createAgent)
    try {
      const { sessionId: parent } = await createRoot(harness.manager)
      const child = await publishTestSubagent(harness.manager, harness.projectRoot, "child", parent, "root-conversation")
      const tree = await tryOpenConversationTree({ sessionId: child, conversationId: "child-conversation", store: harness.reader, writer: harness.writer })
      await tree!.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "handoff", name: "handoff", input: { summary: "done" } }] })
      await tree!.appendMessage({ kind: "toolResult", toolUseId: "handoff", content: [{ type: "text", text: "recorded" }] })
      tree!.getStorage().dispose()
      harness.store.putInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "person:send", { conversationId: "child-conversation", text: "previous unread words", origin: "human", submissionIds: ["send"] })
      removeOwnerPid(child, harness.projectRoot)
      await recoverStaleSubagentRuns({ sessionId: child, fallbackConversationId: "child-conversation", projectRoot: harness.projectRoot, reader: harness.reader, projectionReader: harness.reader, writer: harness.writer })
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
      expect(harness.store.readInFlight(parent, COMPOSER_RETURN_KIND)).toHaveLength(1)
      expect((await readSubagentRuns(harness.reader, child)).at(-1)?.status).toBe("completed")
    } finally { await harness.close() }
  })
})
