import { describe, expect, test } from "bun:test"

import { handleChatMutation } from "../../../../src/orchestration/app-service/chat-mutations.js"
import { runtimeSupervisor } from "./app-service-doubles.js"

describe("chat.open", () => {
  test.each([true, false])("reports initial delivery acceptance (%s) without resending or changing lifecycle", async (accepted) => {
    const calls: string[] = []
    const input = { text: "first message" }
    const deps = { supervisor: runtimeSupervisor({
      openSessionRuntime: async () => { calls.push("open"); return "created" },
      sendChat: async (sessionId, sent) => {
        calls.push(`send:${sessionId}`)
        expect(sent).toEqual(input)
        return accepted ? { ok: true } : { ok: false, reason: "Chat message could not be saved: write failed" }
      },
      closeChat: async () => { calls.push("close"); return true },
      deleteSession: async () => { calls.push("delete"); return true },
      releaseSession: async () => { calls.push("release") },
    }) }

    expect(await handleChatMutation({ type: "chat.open", initialMessage: input }, deps)).toEqual(accepted
      ? { ok: true, sessionId: "created" }
      : { ok: false, error: "Chat message could not be saved: write failed" })
    expect(calls).toEqual(["open", "send:created"])
  })
})

describe("chat.interrupt", () => {
  test("answers ok when a running turn was interrupted", async () => {
    const interrupted: string[] = []
    const activated: string[] = []
    const deps = { supervisor: runtimeSupervisor({ interruptSession: async (sessionId) => { interrupted.push(sessionId); return true }, activateSession: async (sessionId) => { activated.push(sessionId); return true } }) }

    expect(await handleChatMutation({ type: "chat.interrupt", sessionId: "chat-1" }, deps)).toEqual({ ok: true, sessionId: "chat-1" })
    expect(interrupted).toEqual(["chat-1"])
    expect(activated).toEqual([])
  })

  test("reattaches a session whose runner was lost instead of telling the person", async () => {
    const activated: string[] = []
    const deps = { supervisor: runtimeSupervisor({ interruptSession: async () => false, activateSession: async (sessionId) => { activated.push(sessionId); return true } }) }

    expect(await handleChatMutation({ type: "chat.interrupt", sessionId: "chat-1" }, deps)).toEqual({ ok: true, sessionId: "chat-1" })
    expect(activated).toEqual(["chat-1"])
  })
})

describe("chat.resume", () => {
  test("answers the supervisor's outcome in its own words", async () => {
    const resumed: string[] = []
    const deps = { supervisor: runtimeSupervisor({ resumeChat: async (sessionId) => { resumed.push(sessionId); return { ok: true } } }) }

    expect(await handleChatMutation({ type: "chat.resume", sessionId: "chat-1" }, deps)).toEqual({ ok: true, sessionId: "chat-1" })
    expect(resumed).toEqual(["chat-1"])
    expect(await handleChatMutation({ type: "chat.resume", sessionId: "chat-1" }, { supervisor: runtimeSupervisor({ resumeChat: async () => ({ ok: false, reason: "Nothing to resume" }) }) })).toEqual({ ok: false, error: "Nothing to resume" })
  })
})

describe("question settlement", () => {
  test("a refused skip says why in words a client shows", async () => {
    const deps = { supervisor: runtimeSupervisor({ cancelQuestion: async () => ({ ok: false, refusal: "already_answered" }) }) }

    expect(await handleChatMutation({ type: "question.cancel", sessionId: "chat-1", toolUseId: "ask-1" }, deps)).toEqual({ ok: false, error: "This question was already answered." })
  })
})

describe("session.activate", () => {
  test("answers an error when the session takes no runner", async () => {
    const deps = { supervisor: runtimeSupervisor({ activateSession: async () => false }) }

    expect(await handleChatMutation({ type: "session.activate", sessionId: "wf-1" }, deps)).toEqual({ ok: false, error: "Unable to activate chat session wf-1" })
  })
})
