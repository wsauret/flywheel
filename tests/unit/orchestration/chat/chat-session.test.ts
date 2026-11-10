import { describe, expect, it } from "bun:test"
import {
  createBackgroundWorkRegistry,
  type BackgroundWorkResult,
} from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createChatSession } from "../../../../src/orchestration/chat/session.js"
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js"
import { ChatSessionState } from "../../../../src/orchestration/chat/types.js"
import { capabilityAccessHolding } from "../agent-runtime/tools/_fixtures"
import type { Agent, AgentFactory, AgentOptions, AgentRunResult } from "../../../../src/orchestration/agent-runtime/types.js"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles.js"
import { createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"

// The mailbox makes Flywheel's chat input semantics explicit: every external
// arrival (user message, background-work completion) is deferred to the NEXT
// turn. The current-turn channel is intentionally not exposed — no caller
// today injects into the in-flight turn, and adding the channel before there
// is a producer would be speculative.

describe("ChatTurnMailbox.enqueueNextTurn", () => {
  it("buffers next-turn items until drained", () => {
    const mailbox = new ChatTurnMailbox()
    mailbox.enqueueNextTurn("hello")
    mailbox.enqueueNextTurn("world")

    const drained = mailbox.drainPending()
    expect(drained).toEqual({ kind: "message", text: "hello\n\nworld", origin: "human" })
    expect(mailbox.drainPending()).toBeNull()
    mailbox.enqueueNextTurn({ text: "hello", dispatchIds: ["entry-1"] })
    mailbox.enqueueNextTurn({ text: "world", dispatchIds: ["entry-2"] })
    expect(mailbox.drainPending()).toMatchObject({ text: "hello", dispatchIds: ["entry-1"] })
    expect(mailbox.drainPending()).toMatchObject({ text: "world", dispatchIds: ["entry-2"] })
  })

  it("preserves image attachments when batching next-turn items", () => {
    const mailbox = new ChatTurnMailbox()
    mailbox.enqueueNextTurn({ text: "look [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "abc" }] })
    mailbox.enqueueNextTurn("then respond")

    expect(mailbox.drainPending()).toEqual({
      kind: "message",
      text: "look [Image #1]\n\nthen respond",
      origin: "human",
      attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "abc" }],
    })
  })

  it("recalls the latest queued user message without removing earlier input", () => {
    const mailbox = new ChatTurnMailbox()
    const image = { marker: "[Image #1]", mediaType: "image/png", data: "abc" }
    mailbox.enqueueNextTurn({ text: "first", submissionIds: ["first-1"] })
    mailbox.enqueueSilentSystem("background")
    mailbox.enqueueNextTurn({ text: "second [Image #1]", attachments: [image], submissionIds: ["second-1"] })
    mailbox.enqueueNextTurn({ text: "from a peer", producer: { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "peer-message", hop: 0, envelope: { name: "Peer", relation: "other", waits: false } } })

    expect(mailbox.withdrawHuman()?.input).toEqual({ text: "second [Image #1]", attachments: [image], submissionIds: ["second-1"] })
    expect(mailbox.drainUserMessages()).toEqual([{ text: "first", submissionIds: ["first-1"] }])
    expect(mailbox.drainPending()).toEqual({ kind: "message", text: "background", origin: "silent-system" })
    expect(mailbox.drainPending()).toMatchObject({ text: "from a peer" })
  })

  it("restores a withdrawn message in send order, wakes a parked wait, and never counts it as new input", async () => {
    const mailbox = new ChatTurnMailbox()
    mailbox.enqueueNextTurn({ text: "drained", dispatchIds: ["a"] })
    mailbox.enqueueNextTurn({ text: "withdrawn", dispatchIds: ["b"] })
    const withdrawal = mailbox.withdrawHuman()
    expect(mailbox.drainPending()).toMatchObject({ text: "drained" })
    mailbox.enqueueNextTurn({ text: "sent meanwhile", dispatchIds: ["c"] })
    withdrawal?.restore()
    expect(mailbox.drainPending()).toMatchObject({ text: "withdrawn" })
    expect(mailbox.drainPending()).toMatchObject({ text: "sent meanwhile" })

    mailbox.enqueueNextTurn({ text: "kept", dispatchIds: ["d"] })
    const parked = mailbox.withdrawHuman()
    const observed = mailbox.observeUserInput()
    const wake = mailbox.prepareWaitForInput().commit()
    parked?.restore()
    expect(observed()).toBe(false)
    await expect(wake).resolves.toMatchObject({ text: "kept" })
    mailbox.enqueueNextTurn("new")
    expect(observed()).toBe(true)
  })
  it("prepared input resolves on enqueue after commit", async () => {
    const mailbox = new ChatTurnMailbox()
    const promise = mailbox.prepareWaitForInput().commit()
    mailbox.enqueueNextTurn("delayed")
    const result = await promise
    expect(result).toEqual({ kind: "message", text: "delayed", origin: "human" })
  })

  it("abort while parked does not consume input enqueued after cancellation", async () => {
    const mailbox = new ChatTurnMailbox()
    const controller = new AbortController()
    const promise = mailbox.prepareWaitForInput(controller.signal).commit()
    controller.abort()
    mailbox.enqueueNextTurn("arrived after abort")

    await expect(promise).resolves.toBeNull()
    expect(mailbox.drainPending()).toEqual({ kind: "message", text: "arrived after abort", origin: "human" })
  })

  it("abort does not discard pending next-turn input — drained after the wait resolves", async () => {
    const mailbox = new ChatTurnMailbox()
    mailbox.enqueueNextTurn("user said this")
    const controller = new AbortController()
    controller.abort()
    const wait = await mailbox.prepareWaitForInput(controller.signal).commit()
    // The pre-aborted wait still returns the queued item because drainPending
    // runs synchronously before the abort branch is checked.
    expect(wait).toEqual({ kind: "message", text: "user said this", origin: "human" })
  })

  it("compact requests wake prepared input without becoming user text", async () => {
    const mailbox = new ChatTurnMailbox()
    const promise = mailbox.prepareWaitForInput().commit()
    mailbox.enqueueCompact()
    await expect(promise).resolves.toEqual({ kind: "compact" })
  })

  it("parked reflects whether an input reservation is pending", async () => {
    // The chat lifecycle reads `parked` to decide whether a model-assignment
    // change can recycle the runner without losing in-flight work.
    const mailbox = new ChatTurnMailbox()
    expect(mailbox.parked).toBe(false)
    const promise = mailbox.prepareWaitForInput().commit()
    expect(mailbox.parked).toBe(true)
    mailbox.enqueueNextTurn("wake up")
    await promise
    expect(mailbox.parked).toBe(false)
  })
})

describe("chat subagent registry wired to the next-turn mailbox", () => {
  // Produced notifications use the silent channel, never human delivery.
  it("registry notifications deliver as the next turn's input", async () => {
    const mailbox = new ChatTurnMailbox()
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => { mailbox.enqueueSilentSystem(text) },
    })
    const done = Promise.withResolvers<BackgroundWorkResult>()
    registry.track({
      done: done.promise,
      meta: { id: "t1", type: "subagent", description: "Read config" },
    })
    // The registry delivers a settled batch from a later timer, so the test
    // parks on the next turn's input the way a chat turn does.
    const nextTurn = mailbox.prepareWaitForInput().commit()
    done.resolve({ status: "completed", content: "config found" })

    const drained = await nextTurn
    expect(drained).not.toBeNull()
    if (drained?.kind !== "message") throw new Error("expected message input")
    expect(drained.origin).toBe("silent-system")
    expect(drained.text).toContain("<subagent_notifications>")
    expect(drained.text).toContain("config found")
  })
})

describe("ChatSessionState providerConversationId (single authority)", () => {
  it("reflects only the explicitly captured id, not OutputSession session ids", () => {
    const state = new ChatSessionState(undefined, () => {})
    expect(state.providerConversationId).toBeNull()
    expect(state.captureProviderConversationId("captured-1")).toBe(true)
    expect(state.providerConversationId).toBe("captured-1")
    expect(state.captureProviderConversationId("captured-1")).toBe(false)
  })

  it("clearProviderConversationId resets to null without touching other state", () => {
    const state = new ChatSessionState("initial", () => {})
    expect(state.providerConversationId).toBe("initial")
    state.clearProviderConversationId()
    expect(state.providerConversationId).toBeNull()
    // Capture works again after clear (prompt-too-long flow).
    expect(state.captureProviderConversationId("new-id")).toBe(true)
    expect(state.providerConversationId).toBe("new-id")
  })
})

describe("chat runner reflect contract", () => {
  // learn() reports whether a learning review is hosted: the
  // boolean is produced where the knowledge lives (the lifecycle's
  // learningReview presence) and forwarded unchanged through every layer.
  it("returns false when the session hosts no review", async () => {
    const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-reflect-none",
      createAgent: () => { throw new Error("reflect must not spawn a runner without a review") },
    }))
    expect(session.learn?.()).toBe(false)
    await session.dispose()
  })

  it("returns true when a learning review is hosted", async () => {
    const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
      sessionId: "chat-reflect-hosted",
      // The review spawn is a best-effort background side effect; reflect's
      // return value must not wait on it. The stub throwing proves the
      // boolean comes from the hosted-review check, not the spawn outcome.
      createAgent: () => { throw new Error("review spawn is asynchronous best-effort") },
      reviewConfig: { memory: { review_interval_turns: 0 }, skills: { notifications: "off", review_interval_iterations: 0, stale_after_days: 30, archive_after_days: 90 } },
      capabilityAccess: capabilityAccessHolding(["learning"]),
    }))
    expect(session.learn?.()).toBe(true)
    await session.dispose()
  })
})

describe("chat title from a command's turn", () => {
  it("titles a chat that a slash command starts from the command, once", async () => {
    const createAgent: AgentFactory = (): Agent => ({
      done: Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }),
      send() {},
      end() {},
      abort() {},
    })
    const titles: Array<{ label: string; shortLabel: string }> = []
    const session = await createChatSession(
      { onError: () => {}, onEnded: () => {} },
      createTestChatSessionDeps({ sessionId: "chat-command-title", createAgent, onSessionName: (title) => { titles.push(title) } }),
    )

    const method = { text: "# Skill: experiment-charter\nBuild an approved charter.\n\nARGUMENTS: reduce test suite wall time", invocation: { label: "/experiment design", args: "reduce test suite wall time" } }
    expect(session.requestWithContext(method, "backlog")).toBe(true)
    expect(session.deliverCommitted("a later message")).toBe(true)

    expect(titles.map((title) => title.label)).toEqual(["/experiment design reduce test suite wall time"])
    await session.dispose()
  })

  // Every headless entry point (`--headless --jsonl`, `--headless --acp`, and `--headless --acp --unattended`) composes
  // a non-interactive runtime, whose deps carry `headless`; only the unattended one also holds an unattended boundary.
  it.each([
    ["a headless chat", { headless: true as const }, false],
    ["an unattended headless chat", { headless: true as const, capabilityAccess: { ...capabilityAccessHolding([]), unattended: true as const } }, false],
    ["an interactive chat", {}, true],
  ])("names %s with the quick title, and starts a title model only when it is interactive", async (name, mode, modelTitle) => {
    const purposes: string[] = []
    const createAgent: AgentFactory = (options: AgentOptions): Agent => {
      purposes.push(options.purpose.kind)
      return {
        done: Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }),
        send() {},
        end() {},
        abort() {},
      }
    }
    const titles: Array<{ label: string; shortLabel: string }> = []
    const session = await createChatSession(
      { onError: () => {}, onEnded: () => {} },
      createTestChatSessionDeps({
        sessionId: `chat-title-${name.replaceAll(" ", "-")}`,
        createAgent,
        resolveRoles: async (): Promise<ResolvedRoles> => new Map([
          ["chat", { roleId: "chat", model: "chat-model", effort: "medium" }],
          ["title-generation", { roleId: "title-generation", model: "title-model", effort: "low" }],
        ]),
        ...mode,
        onSessionName: (title) => { titles.push(title) },
      }),
    )

    expect(session.deliverCommitted("fix the failing build in the parser")).toBe(true)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(titles).toEqual([{ label: "fix the failing build in the parser", shortLabel: "Fix The" }])
    expect(purposes.includes("session-title")).toBe(modelTitle)
    await session.dispose()
  })
})

describe("chat title environment refresh", () => {
  it("uses the title role and retries it after environment refresh", async () => {
    const refresh = Promise.withResolvers<void>()
    const initialTitleAttemptsSettled = Promise.withResolvers<void>()
    const generatedTitle = Promise.withResolvers<void>()
    let model = "blocked-title-model"
    let titleAttempts = 0
    const titleModels: Array<string | undefined> = []
    const createAgent: AgentFactory = (options: AgentOptions): Agent => {
      if (options.purpose.kind !== "session-title") {
        return {
          done: Promise.resolve<AgentRunResult>({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }),
          send() {},
          end() {},
          abort() {},
        }
      }
      titleAttempts++
      titleModels.push(options.model)
      if (titleAttempts === 1) initialTitleAttemptsSettled.resolve()
      const succeeds = titleAttempts === 2
      if (succeeds) {
        options.onEvent({
          type: "model.assistant_message.recorded",
          data: { message: { content: [{ type: "text", text: "TITLE: Refreshed Title\nSHORT: Refreshed" }] } },
        })
      }
      return {
        done: Promise.resolve<AgentRunResult>({ servedRequests: 0,
          durationMs: 0,
          terminal: succeeds
            ? { kind: "completed" }
            : { kind: "api_error", message: "Authentication requires attention", recovery: { kind: "none" } },
        }),
        send() {},
        end() {},
        abort() {},
      }
    }
    const resolveRoles = async (): Promise<ResolvedRoles> => new Map([
      ["chat", { roleId: "chat", model: "chat-model", effort: "medium" }],
      ["title-generation", {
        roleId: "title-generation",
        model,
        effort: "high",
        providerOptions: { openai: { service_tier: "priority" } },
      }],
    ])
    const titles: Array<{ label: string; shortLabel: string }> = []
    const session = await createChatSession(
      { onError: () => {}, onEnded: () => {} },
      createTestChatSessionDeps({
        sessionId: "chat-title-refresh",
        createAgent,
        resolveRoles,
        onSessionName: (title) => {
          titles.push(title)
          if (titles.length === 2) generatedTitle.resolve()
        },
        refreshEnvironment: async () => { await refresh.promise },
      }),
    )

    expect(session.deliverCommitted("name this chat")).toBe(true)
    await initialTitleAttemptsSettled.promise
    const refreshing = session.refreshDeps?.()
    await Promise.resolve()
    expect(titleAttempts).toBe(1)

    model = "recovered-title-model"
    refresh.resolve()
    await refreshing
    await generatedTitle.promise

    expect(titleModels).toEqual(["blocked-title-model", "recovered-title-model"])
    expect(titles).toEqual([
      { label: "name this chat", shortLabel: "Name This" },
      { label: "Refreshed Title", shortLabel: "Refreshed" },
    ])
    await session.dispose()
  })
})
