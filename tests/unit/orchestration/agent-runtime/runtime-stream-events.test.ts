import { describe, expect, test } from "bun:test"

import type { ConnectionState } from "../../../../src/infra/output-blocks.js"
import { applySessionNoticeOperation, type SessionNotice, type SessionNoticeOperation } from "../../../../src/infra/session-notice.js"
import type { StreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createRuntimeStreamEvents } from "../../../../src/orchestration/agent-runtime/runtime-stream-events.js"
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js"
import type { RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { testDirectories } from "../../../helpers/directories.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { RequestToolMap, testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"

/** The session state that one runner's notices and connection state fold into, across its runs. */
function sessionState() {
  let notices: readonly SessionNotice[] = []
  const states: ConnectionState[] = []
  const operations: SessionNoticeOperation[] = []
  const onNotice = (operation: SessionNoticeOperation): void => {
    operations.push(operation)
    notices = applySessionNoticeOperation(notices, operation, Date.now())
  }
  return {
    onNotice,
    onConnectionState: (state: ConnectionState) => { states.push(state) },
    notices: () => notices.map((notice) => notice.title),
    states,
    resolves: () => operations.filter((operation) => operation.type === "resolve-scope").length,
  }
}

/** The stream events of one run, as runtime assembly creates them for the run. */
async function runStream(session: ReturnType<typeof sessionState>) {
  const modules = testCapabilityModules()
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: { kind: "interactive-chat" },
    agentsMd: "",
    onEvent: () => {},
    onNotice: session.onNotice,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    captureProviderConnection: () => { throw new Error("unused in this test") },
    runtimeSurfaces: { launcher: refusingLauncher },
    moduleSelection: () => modules,
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot", onConnectionState: session.onConnectionState },
  }
  const surface = new RequestToolMap()
  await surface.resolve()
  return createRuntimeStreamEvents({
    options,
    contextWindow: () => 100_000,
    costTracker: createTurnUsageTracker({ emit: () => {}, budgetStreamId: "test" }),
    providerSessionKey: "provider-session",
    sessionId: "session-1",
    parentToolUseId: undefined,
    surface,
  })
}

const text: StreamEvent = { kind: "text_delta", blockKey: "a", text: "token" }
const retry: StreamEvent = {
  kind: "stream_retry", attempt: 1, maxAttempts: 3, reason: "overloaded", delayMs: 10,
  error: { name: "Error", message: "overloaded" },
}
const resample: StreamEvent = { kind: "stream_resample", attempt: 1, maxAttempts: 2, nextAttemptDisablesReasoning: false }
const status: StreamEvent = { kind: "provider_status", message: "Degraded", level: "info" }

describe("runtime stream events: notices and connection state change on transitions", () => {
  test.each([
    ["stream_retry", retry, "Reconnecting to model provider"],
    ["stream_resample", resample, "Model repeated itself"],
    ["provider_status", status, "Provider status"],
  ] as const)("after a %s notice the first text delta resolves notices once and sets connected; 100 more resolve nothing", async (_kind, notice, title) => {
    const session = sessionState()
    const stream = await runStream(session)
    stream.onEvent(text)
    const before = { resolves: session.resolves(), states: session.states.length }
    stream.onEvent(notice)
    expect(session.notices()).toEqual([title])
    stream.onEvent(text)
    expect(session.notices()).toEqual([])
    expect(session.resolves()).toBe(before.resolves + 1)
    expect(session.states.at(-1)).toBe("connected")
    const settled = { resolves: session.resolves(), states: session.states.length }
    for (let index = 0; index < 100; index++) stream.onEvent(text)
    expect({ resolves: session.resolves(), states: session.states.length }).toEqual(settled)
  })

  test("a provider_response_started event as the first event after a retry clears the notice and sets connected", async () => {
    const session = sessionState()
    const stream = await runStream(session)
    stream.onEvent(retry)
    expect(session.states).toEqual(["retrying"])
    stream.onEvent({ kind: "provider_response_started" })
    expect(session.notices()).toEqual([])
    expect(session.states).toEqual(["retrying", "connected"])
  })

  test.each<[string, StreamEvent]>([
    ["context_update", { kind: "context_update", promptTokens: 10, contextWindow: 100 }],
    ["compaction_start", { kind: "compaction_start" }],
    ["stream_attempt_start", { kind: "stream_attempt_start", disableReasoning: false }],
  ])("a %s event after a notice clears nothing", async (_kind, event) => {
    const session = sessionState()
    const stream = await runStream(session)
    stream.onEvent(retry)
    stream.onEvent(event)
    expect(session.notices()).toEqual(["Reconnecting to model provider"])
    expect(session.states).toEqual(["retrying"])
    expect(session.resolves()).toBe(0)
  })

  test("a notice that an earlier run left in the scope clears at the first matching event of the next run", async () => {
    const session = sessionState()
    const firstRun = await runStream(session)
    firstRun.onEvent(retry)
    const nextRun = await runStream(session)
    nextRun.onEvent({ kind: "context_update", promptTokens: 10, contextWindow: 100 })
    expect(session.notices()).toEqual(["Reconnecting to model provider"])
    nextRun.onEvent(text)
    expect(session.notices()).toEqual([])
    expect(session.states.at(-1)).toBe("connected")
  })

  test("each run sets connected at its first matching event, also with no notice", async () => {
    const session = sessionState()
    for (const run of [await runStream(session), await runStream(session)]) {
      const before = session.states.length
      run.onEvent(text)
      run.onEvent(text)
      expect(session.states.slice(before)).toEqual(["connected"])
    }
  })
})
