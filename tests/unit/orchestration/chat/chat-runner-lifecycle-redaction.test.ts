import { describe, expect, it } from "bun:test"

import { EventBus } from "../../../../src/infra/event-bus"
import { chatInputText, type ChatInputLike } from "../../../../src/infra/chat-input"
import { createChatRunnerLifecycle } from "../../../../src/orchestration/chat/runner-lifecycle"
import { ChatSessionState } from "../../../../src/orchestration/chat/types"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import {
  askUserStub,
  createTestChatSessionDeps,
  makeMemoryTreeWriter,
  outputSessionStub,
} from "./_chat-session-agent-runtime-fixtures"

async function flushMicrotasks(): Promise<void> {
  // Resolve the runner-detach `.then` chain, the learning reconciliation the
  // lifecycle awaits at the head of every turn, and the registry's
  // settle/notify microtasks, without a real timer (unit tests must not
  // setTimeout > 30ms).
  for (let i = 0; i < 24; i++) await Promise.resolve()
}

describe("chat runner lifecycle secret redaction (provenance policy)", () => {
  it("routes a background notification through its masked system-origin commit, never the human commit", async () => {
    const commitUserTurnCalls: string[] = []
    const commitBackgroundNotificationCalls: string[] = []
    let capturedBackground: BackgroundExecutionOwner | undefined
    let resolveRunnerDone: ((result: AgentRunResult) => void) | undefined
    let markCleanTurnEnd: (() => void) | undefined

    const treeWriter = makeMemoryTreeWriter()
    const baseUserCommit = treeWriter.commitUserTurn
    treeWriter.commitUserTurn = async (input: ChatInputLike) => {
      commitUserTurnCalls.push(chatInputText(input))
      return baseUserCommit(input)
    }
    const baseBackgroundCommit = treeWriter.commitBackgroundNotification
    treeWriter.commitBackgroundNotification = async (notification) => {
      commitBackgroundNotificationCalls.push(notification.text)
      return baseBackgroundCommit(notification)
    }

    const createAgent = (options: AgentOptions): Agent => {
      capturedBackground = options.runtimeSurfaces?.background
      // Turn-boundary signal: a real runner fires onTurnEnded when its loop
      // parks at end_turn, driving the per-turn flush; liveness itself comes
      // from the typed terminal the run resolves with.
      markCleanTurnEnd = () => options.lifecycle.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
      const done = new Promise<AgentRunResult>((resolve) => { resolveRunnerDone = resolve })
      return {
        send() {},
        end() {},
        abort() {},
        done,
      }
    }

    const deps = createTestChatSessionDeps({
      sessionId: "session-redaction",
      createAgent,
      treeWriter,
    })

    const state = new ChatSessionState(undefined, () => {})
    const lifecycle = createChatRunnerLifecycle({
      deps,
      eventBus: new EventBus(),
      session: outputSessionStub("session-redaction"),
      applyNestedStoredFact: () => {},
      state,
      askUser: askUserStub(),
      setConnectionState() {},
      awaitDurableFacts: async () => {},
    })

    // Human first turn through submit (source absent). The lifecycle spawns a
    // runner but does NOT commit the user turn here -- chat-controls owns the
    // human commit, verbatim. So submit must not have called commitUserTurn.
    lifecycle.enqueueInput("here is my key sk-live_humanSecret123, use it")
    await flushMicrotasks()
    expect(state.runner).not.toBeNull()
    expect(capturedBackground).toBeDefined()
    expect(commitUserTurnCalls).toEqual([])

    // The runner finishes its turn cleanly and detaches; now no runner is available.
    markCleanTurnEnd?.()
    resolveRunnerDone?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await flushMicrotasks()
    expect(state.runner).toBeNull()

    // A background task completes while no runner is attached. Its produced
    // content uses the notification-only masked system-origin commit, never the
    // verbatim human commit.
    if (capturedBackground?.tasks.kind !== "chat") throw new Error("expected a chat background registry")
    const recognizedSecret = ["sk", "proj", "aB3".repeat(12)].join("-")
    capturedBackground.tasks.track({
      done: Promise.resolve({ status: "completed" as const, content: `AWS_SECRET_ACCESS_KEY=${recognizedSecret}` }),
      meta: { id: "notif-1", type: "notification", description: "background notification" },
    })
    await flushMicrotasks()

    expect(commitUserTurnCalls).toEqual([])
    expect(commitBackgroundNotificationCalls).toHaveLength(1)
    const { messages } = await treeWriter.buildContext()
    const committed = messages.at(-1)
    if (committed?.kind !== "user" || typeof committed.content !== "string") throw new Error("expected committed user turn")
    expect(committed.origin).toBe("system")
    expect(committed.content).toContain("[redacted secret]")
    expect(committed.content).not.toContain(recognizedSecret)
  })
})
