import { expect, test } from "bun:test"
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createConversationTreeProjection } from "../../../../../src/orchestration/session/conversation/conversation-projection.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { subagentChildHarnesses } from "./_subagent-child-fixtures.js"

const createHarness = subagentChildHarnesses()

function completedRunner(): (options: AgentOptions) => Agent {
  return (options) => {
    const done = Promise.withResolvers<AgentRunResult>()
    return {
      send() {
        options.runtimeSurfaces?.handoff?.onContent({ summary: "completed" })
        done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      },
      end() {},
      abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }
  }
}

test("a settled child releases the conversation tree its execution held", async () => {
  const harness = createHarness(completedRunner())
  const publish = harness.authority.publish
  const released = Promise.withResolvers<boolean>()
  harness.authority.publish = async (input) => {
    const execution = await publish(input)
    return {
      ...execution,
      async settle() {
        const tree = createConversationTreeProjection(harness.reader, input.childConversationId)
        await execution.settle()
        released.resolve(createConversationTreeProjection(harness.reader, input.childConversationId) !== tree)
      },
    }
  }
  try {
    const sessionId = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" })
    await harness.tool(sessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Complete the child" },
      makeContext({ conversationId: "root-conversation" }),
    )
    expect(await released.promise).toBe(true)
  } finally {
    await harness.close()
  }
})
