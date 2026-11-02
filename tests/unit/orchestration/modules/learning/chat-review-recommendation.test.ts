import { describe, expect, it } from "bun:test"

import type { AgentLoopInput, InputSource } from "../../../../../src/infra/agent-loop-events"
import { EventBus } from "../../../../../src/infra/event-bus"
import { createChatRunnerLifecycle } from "../../../../../src/orchestration/chat/runner-lifecycle"
import { learningChatHost } from "../../../../../src/orchestration/modules/learning/chat-review"
import { ChatSessionState } from "../../../../../src/orchestration/chat/types"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types"
import type { SkillRecommendation } from "../../../../../src/orchestration/agent-runtime/review-types.ts"
import {
  askUserStub,
  createTestChatSessionDeps,
  makeMemoryTreeWriter,
  outputSessionStub,
} from "../../chat/_chat-session-agent-runtime-fixtures"
import { roleCapture } from "../../../../helpers/role-capture.js"

const RECOMMENDATION: SkillRecommendation = {
  recommendationId: "c0ffee".padEnd(64, "0"),
  name: "deploy-runbook",
  action: "promote",
  reach: "global",
  packageIdentity: { sha256: "ab".repeat(32), bytes: 128 },
  summary: "Promote deploy-runbook to the global store.",
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  // The turn pipeline runs as a forked Effect fiber and the review's spawn
  // chains several awaits (admission, replay build, memory snapshot); a
  // macrotask lets both settle before assertions.
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

interface SpawnedRunner {
  options: AgentOptions
  resolve: (result: AgentRunResult) => void
}

function inputSourceOf(runner: SpawnedRunner): InputSource {
  if (!runner.options.lifecycle.inputSource) throw new Error("expected the chat runner input source")
  return runner.options.lifecycle.inputSource
}

function reviewOf(runner: SpawnedRunner) {
  const purpose = runner.options.purpose
  if (purpose.kind !== "chat-learning-review" && purpose.kind !== "workflow-learning-review") throw new Error("expected a review runner")
  return purpose.review
}

/** Lifecycle with the review enabled. Runner index 0 is the chat runner;
 *  `learn()` spawns the review fork as runner index 1. Zero intervals keep
 *  the counter cadence out of the tests; reflect fires regardless. */
function makeLifecycle(seedContext?: string) {
  const runners: SpawnedRunner[] = []
  const chatStarted = Promise.withResolvers<void>()
  const reviewStarted = Promise.withResolvers<void>()
  const createAgent = (options: AgentOptions): Agent => {
    const spawned: SpawnedRunner = { options, resolve: () => {} }
    const done = new Promise<AgentRunResult>((resolve) => { spawned.resolve = resolve })
    runners.push(spawned)
    ;(runners.length === 1 ? chatStarted : reviewStarted).resolve()
    return {
      send() {},
      end() {},
      abort() {},
      done,
    }
  }
  const capture = roleCapture(["gpt-5.4"])
  const deps = createTestChatSessionDeps({
    sessionId: "session-recommendation",
    createAgent,
    auth: capture.connection.auth,
    captureProviderConnection: async () => ({
      ...capture,
      admit: () => ({ createAgent, createLLMClient: async () => { throw new Error("audit client not expected") } }),
    }),
    treeWriter: makeMemoryTreeWriter(),
    reviewConfig: { memory: { review_interval_turns: 0 }, skills: { notifications: "off", review_interval_iterations: 0, stale_after_days: 30, archive_after_days: 90 } },
    seedContext,
    // The review's own policy resolves through the same admitted model as Chat.
    resolveRoles: async () => new Map([
      ["chat", { roleId: "chat", model: "gpt-5.4", effort: "high" }],
      ["learning-review", { roleId: "learning-review", model: "gpt-5.4", effort: "high" }],
    ]),
  })
  const state = new ChatSessionState(undefined, () => {})
  const lifecycle = createChatRunnerLifecycle({
    deps,
    eventBus: new EventBus(),
    session: outputSessionStub("session-recommendation"),
    state,
    askUser: askUserStub(),
    setConnectionState() {},
    applyNestedStoredFact: () => {},
    awaitDurableFacts: async () => {},
  })
  return { lifecycle, runners, chatStarted: chatStarted.promise, reviewStarted: reviewStarted.promise }
}

/** Drive the chat runner to the parked state: logical turn ended, loop
 *  waiting on the session mailbox. Returns the runner, the park promise, and
 *  the abort controller that releases the waiter. */
async function startAndParkChatTurn(lifecycle: ReturnType<typeof makeLifecycle>["lifecycle"], runners: SpawnedRunner[], started: Promise<void>) {
  lifecycle.enqueueInput("first message")
  await started
  const chat = runners[0]
  if (!chat) throw new Error("expected the chat runner")
  chat.options.lifecycle.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
  const abort = new AbortController()
  const reservation = inputSourceOf(chat).prepareWaitForInput?.(abort.signal)
  if (!reservation) throw new Error("expected a parking input source")
  const parked = reservation.commit()
  await flushMicrotasks()
  return { chat, parked, abort }
}

async function fireReview(lifecycle: ReturnType<typeof makeLifecycle>["lifecycle"], runners: SpawnedRunner[], started: Promise<void>): Promise<SpawnedRunner> {
  expect(lifecycle.learn()).toBe(true)
  await started
  const review = runners[1]
  if (!review) throw new Error("expected the review runner")
  return review
}

describe("chat runner lifecycle recommendation delivery", () => {
  it("preserves seed context in the chat runner and its learning review", async () => {
    const seedContext = "Continue the approved architecture review."
    const { lifecycle, runners, chatStarted, reviewStarted } = makeLifecycle(seedContext)
    const admittedHost = lifecycle.chatModuleHosts.get(learningChatHost)
    expect(admittedHost).toBeDefined()
    expect(runners).toHaveLength(0)
    const { chat, parked, abort } = await startAndParkChatTurn(lifecycle, runners, chatStarted)
    const review = await fireReview(lifecycle, runners, reviewStarted)
    expect(lifecycle.chatModuleHosts.get(learningChatHost)).toBe(admittedHost)

    // The seed context is a turn of the chat's tree, so the review's replay
    // of that tree carries it too.
    for (const options of [chat.options, review.options]) {
      if (!("priorMessages" in options.conversation) || !options.conversation.priorMessages) throw new Error("expected prior messages")
      expect(options.conversation.priorMessages.filter((message) => JSON.stringify(message).includes(seedContext))).toHaveLength(1)
    }

    review.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    abort.abort()
    expect(await parked).toBeNull()
  })

  it("drops a recommendation that settles after the runner parks instead of waking the model", async () => {
    const { lifecycle, runners, chatStarted, reviewStarted } = makeLifecycle()
    const { chat, parked, abort } = await startAndParkChatTurn(lifecycle, runners, chatStarted)
    const review = await fireReview(lifecycle, runners, reviewStarted)

    let woken: AgentLoopInput | null | undefined
    void parked.then((input) => { woken = input })

    // The review settles while the session is idle: the turn slot still
    // exists (the parked runner holds it), so the slot alone cannot gate
    // delivery. The parked mailbox must.
    reviewOf(review).onRecommended?.(RECOMMENDATION)
    review.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await flushMicrotasks()

    // No wake and nothing queued: the durable turn-head reconciliation sweep
    // owns delivery for idle sessions.
    expect(woken).toBeUndefined()
    expect(inputSourceOf(chat).drainPending()).toBeNull()

    abort.abort()
    expect(await parked).toBeNull()
  })

  it("enqueues a recommendation that settles mid-turn as silent-system input for the loop's between-batches drain", async () => {
    const { lifecycle, runners, chatStarted, reviewStarted } = makeLifecycle()
    const { chat, parked } = await startAndParkChatTurn(lifecycle, runners, chatStarted)
    const review = await fireReview(lifecycle, runners, reviewStarted)

    // The user speaks again while the review still runs: the parked loop
    // wakes with the message and is now mid-turn, between tool batches.
    lifecycle.enqueueInput("second message")
    const wake = await parked
    if (wake?.kind !== "message") throw new Error("expected the parked loop to wake with the user message")
    expect(wake.text).toBe("second message")

    reviewOf(review).onRecommended?.(RECOMMENDATION)
    review.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await flushMicrotasks()

    // The lifecycle enqueued one silent-system message on the loop's input
    // source: model-visible, never rendered, not deferred to turn end. The
    // loop side (post-tool-batch drain into the next model call) is proven in
    // tests/unit/orchestration/agent-runtime/context/loop-silent-system.test.ts.
    const drained = inputSourceOf(chat).drainPending()
    if (drained?.kind !== "message") throw new Error("expected the queued notification")
    expect(drained.origin).toBe("silent-system")
    expect(drained.text).toContain("<skill_recommendation>")
    expect(drained.text).toContain(RECOMMENDATION.recommendationId)
  })

})
