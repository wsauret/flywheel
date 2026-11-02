import { expect, test } from "bun:test"

import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js"
import { liveChildRun } from "../../../../../src/orchestration/session/live-session-control.js"
import { deliverSessionInput } from "../../../../../src/orchestration/session/session-input-delivery.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { sessionStoreReaches, subagentChildHarnesses } from "./_subagent-child-fixtures.js"

const createHarness = subagentChildHarnesses()

test("a parent message and a person message to a running child render queued in receive order and the batch becomes sent", async () => {
  const done = Promise.withResolvers<AgentRunResult>()
  const started = Promise.withResolvers<AgentOptions>()
  const harness = createHarness((options) => ({
    send() { started.resolve(options) },
    end() {},
    abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
    done: done.promise,
  }))
  try {
    const parentSessionId = await harness.manager.createChat({
      id: "root",
      conversationId: "root-conversation",
      name: "root",
    })
    await harness.tool(parentSessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Inspect steering" },
      makeContext({ conversationId: "root-conversation" }),
    )
    const parent = await harness.manager.read(parentSessionId)
    const childSessionId = parent?.childSessionIds?.[0]
    if (!childSessionId) throw new Error("Dispatch did not publish a child session")
    const options = await started.promise

    expect(await deliverSessionInput({
      manager: harness.manager,
      projectionReader: harness.reader,
      eventWriter: harness.writer,
    }, childSessionId, {
      text: "parent guidance",
      producer: { kind: "session", sessionId: parentSessionId, conversationId: "root-conversation", toolUseId: "parent-message", hop: 0, envelope: { name: "root", relation: "parent", waits: false } },
    })).toEqual({ status: "delivered", startsTurn: false })
    expect(await deliverSessionInput({
      manager: harness.manager,
      projectionReader: harness.reader,
      eventWriter: harness.writer,
    }, childSessionId, "human guidance")).toEqual({ status: "delivered", startsTurn: false })

    const guidance = () => harness.sessionStore.get(childSessionId)?.outputBlocks().filter((block) =>
      block.kind === "userMessage" && (block.content === "parent guidance" || block.content === "human guidance")
    ) ?? []
    await sessionStoreReaches(harness, () => guidance().length === 2)
    expect(guidance()).toEqual([
      expect.objectContaining({ content: "parent guidance", pending: true, from: { sessionId: parentSessionId, name: "root", relation: "parent" } }),
      expect.objectContaining({ content: "human guidance", pending: true }),
    ])

    options.onEvent(createRuntimeEvent("model.user_message.recorded", {
      type: "model.user_message.recorded",
      message: { origin: "user", content: [{ type: "text", text: "parent guidance" }] },
    }))
    await sessionStoreReaches(harness, () => guidance().every((block) => block.kind === "userMessage" && !block.pending))
    expect(guidance()).toEqual([
      expect.objectContaining({ content: "parent guidance", pending: false }),
      expect.objectContaining({ content: "human guidance", pending: false }),
    ])
  } finally {
    done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await harness.close()
  }
})

test("a person message that resumes an interrupted child renders queued in the resumed run and becomes sent", async () => {
  const runs: { options: AgentOptions; done: PromiseWithResolvers<AgentRunResult> }[] = []
  const harness = createHarness((options) => {
    const done = Promise.withResolvers<AgentRunResult>()
    runs.push({ options, done })
    return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
  })
  try {
    const parentSessionId = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" })
    await harness.tool(parentSessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Inspect steering" },
      makeContext({ conversationId: "root-conversation", toolUseId: "dispatch-call" }),
    )
    const childSessionId = (await harness.manager.read(parentSessionId))?.childSessionIds?.[0]
    if (!childSessionId) throw new Error("Dispatch did not publish a child session")
    await liveChildRun(harness.reader, childSessionId)?.child.interrupt("person")

    // The interrupted child holds the message, and its resumed run adopts it.
    expect(await deliverSessionInput({
      manager: harness.manager,
      projectionReader: harness.reader,
      eventWriter: harness.writer,
    }, childSessionId, { text: "resume note", producer: { kind: "human" } })).toEqual({ status: "held", reason: "interrupted" })
    await harness.tool(parentSessionId).processResume(childSessionId, makeContext({ conversationId: "root-conversation", toolUseId: "resume-call" }))
    const resumed = runs.at(-1)
    if (!resumed || runs.length !== 2) throw new Error("expected the resumed run")

    const note = () => harness.sessionStore.get(childSessionId)?.outputBlocks().filter((block) => block.kind === "userMessage" && block.content === "resume note") ?? []
    await sessionStoreReaches(harness, () => note().length === 1)
    expect(note()).toEqual([expect.objectContaining({ content: "resume note", pending: true })])

    resumed.options.onEvent(createRuntimeEvent("model.user_message.recorded", {
      type: "model.user_message.recorded",
      message: { origin: "user", content: [{ type: "text", text: "resume note" }] },
    }))
    await sessionStoreReaches(harness, () => note().every((block) => block.kind === "userMessage" && !block.pending))
    expect(note()).toEqual([expect.objectContaining({ content: "resume note", pending: false })])
  } finally {
    for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await harness.close()
  }
})
