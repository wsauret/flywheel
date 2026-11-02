import { describe, expect, test } from "bun:test"
import type { ChatInputLike } from "../../../../src/infra/chat-input.js"
import { handleSessionSend, type SessionSendDeps } from "../../../../src/orchestration/app-service/session-send.js"
import { Schema } from "effect"
import { workflowsProtocol } from "../../../../src/protocol/modules/workflows.js"
import type { WorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import { fakeManager, fakeSessionStore, workflowController, workflowProtocol } from "./app-service-doubles.js"
import { EARLIER_AGENT_SESSION_REFUSAL, type WorkflowTargets } from "../../../../src/orchestration/workflow-host/workflow-addressing.js"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas.js"
import type { WorkflowMembership } from "../../../../src/infra/session-workflow-membership.js"
import { runtimeDispatchResultSchema } from "../../../../src/protocol/runtime-dispatch-result-schemas.js"

type SessionKind = "chat" | "subagent" | "workflow-agent"

interface Sent {
  readonly to: SessionKind | "workflow"
  readonly sessionId: string
  readonly input: ChatInputLike
}

/** One runtime with a session of each kind, which records where each message went. */
function runtime(kinds: { readonly [sessionId: string]: SessionKind }, overrides: {
  readonly workflow?: WorkflowController["sendWorkflow"]
  readonly child?: SessionSendDeps["modules"]["send"]
  readonly chat?: SessionSendDeps["supervisor"]["sendChat"]
} = {}) {
  const sent: Sent[] = []
  const deps: SessionSendDeps = {
    supervisor: {
      sessionKind: async (sessionId) => kinds[sessionId],
      sendChat: overrides.chat ?? (async (sessionId, input) => {
        sent.push({ to: "chat", sessionId, input })
        return { ok: true }
      }),
    },
    modules: {
      send: overrides.child ?? (async (kind, sessionId, input) => {
        sent.push({ to: kind, sessionId, input })
        return { ok: true }
      }),
    },
  }
  const modules = workflowProtocol({ controller: {
    ...workflowController(fakeSessionStore(new Map()), fakeManager()),
    sendWorkflow: overrides.workflow ?? (async (sessionId, input) => {
      sent.push({ to: "workflow", sessionId, input })
      return { kind: "delivered", sessionId }
    }),
  } })
  return { deps, sent, sendWorkflow: (input: string) => modules.mutate({ type: "workflow.send", workflowId: "flow", input }) }
}

describe("session.send", () => {
  test("one mutation reaches a chat, a subagent, and a workflow agent, each through the owner of its kind", async () => {
    const { deps, sent } = runtime({ chat: "chat", child: "subagent", flow: "workflow-agent" })

    expect(await handleSessionSend({ type: "session.send", sessionId: "chat", input: "hello" }, deps)).toEqual({ ok: true, sessionId: "chat" })
    expect(await handleSessionSend({ type: "session.send", sessionId: "child", input: "check the boundary" }, deps)).toEqual({ ok: true, sessionId: "child" })
    expect(await handleSessionSend({ type: "session.send", sessionId: "flow", input: { text: "next instruction", attachments: [{ marker: "[image:1]", mediaType: "image/png", data: "abc" }], submissionIds: ["local-1"] } }, deps)).toEqual({ ok: true, sessionId: "flow" })

    expect(sent).toEqual([
      { to: "chat", sessionId: "chat", input: "hello" },
      { to: "subagent", sessionId: "child", input: "check the boundary" },
      { to: "workflow-agent", sessionId: "flow", input: { text: "next instruction", attachments: [{ marker: "[image:1]", mediaType: "image/png", data: "abc" }], submissionIds: ["local-1"] } },
    ])
  })

  test("a chat message the conversation already holds crosses the wire as a receipt that the chat transcript retires", async () => {
    const { deps } = runtime({ chat: "chat" }, { chat: async (_sessionId, input) => ({ ok: true, confirmedSubmissionIds: typeof input === "string" ? [] : input.submissionIds ?? [] }) })
    const codec = runtimeDispatchResultSchema("session.send")
    const result = await handleSessionSend({ type: "session.send", sessionId: "chat", input: { text: "hello", submissionIds: ["local-1"] } }, deps)

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual({ ok: true, sessionId: "chat", confirmedSubmissionIds: ["local-1"], inTranscript: true })
  })

  test("a session this runtime cannot find is refused, and nothing is sent", async () => {
    const { deps, sent } = runtime({})

    expect(await handleSessionSend({ type: "session.send", sessionId: "gone", input: "hello" }, deps)).toEqual({ ok: false, error: "Session gone is no longer available" })
    expect(sent).toEqual([])
  })

  test("a child takes no empty message, and a subagent takes an image alone", async () => {
    const { deps, sent } = runtime({ flow: "workflow-agent", child: "subagent" })

    expect(await handleSessionSend({ type: "session.send", sessionId: "flow", input: "   " }, deps)).toEqual({ ok: false, error: "A message to a subagent needs text or an image" })
    expect(await handleSessionSend({ type: "session.send", sessionId: "child", input: "" }, deps)).toEqual({ ok: false, error: "A message to a subagent needs text or an image" })
    const image = { text: "", attachments: [{ marker: "[image:1]", mediaType: "image/png", data: "abc" }] }
    expect(await handleSessionSend({ type: "session.send", sessionId: "child", input: image }, deps)).toEqual({ ok: true, sessionId: "child" })
    expect(sent).toEqual([{ to: "subagent", sessionId: "child", input: image }])
  })

  // A delivery that confirms nothing reports its receipt as absent, which
  // the strict wire codec refuses unless the reply omits the key.
  test.each(["delivered", "retained"] as const)("a %s workflow message without a receipt crosses the wire without a claim that a step read it", async (kind) => {
    const { sendWorkflow } = runtime({}, { workflow: async (sessionId) => ({ kind, sessionId, confirmedSubmissionIds: undefined }) })
    const result = await sendWorkflow("continue")
    const codec = workflowsProtocol.mutations[0].result

    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual({ ok: true })
  })

  test.each(["delivered", "retained"] as const)("a %s workflow direction reports acceptance without claiming a member read it", async (kind) => {
    const { sendWorkflow } = runtime({}, { workflow: async (sessionId) => ({ kind, sessionId, confirmedSubmissionIds: ["local-1"] }) })
    const result = await sendWorkflow("continue")
    const codec = workflowsProtocol.mutations[0].result
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual({ ok: true })
  })

  test("a workflow that cannot start again answers in the controller's words, apart from a running workflow that refused the message", async () => {
    const failed = runtime({}, { workflow: async (sessionId) => ({ kind: "resume_failed", sessionId, message: "Workflow definition changed since the run started" }) })
    expect(await failed.sendWorkflow("please continue")).toEqual({ ok: false, error: "Workflow definition changed since the run started" })

    const refused = runtime({}, { workflow: async (sessionId) => ({ kind: "not_delivered", sessionId }) })
    expect(await refused.sendWorkflow("please continue")).toEqual({ ok: false, error: "The workflow did not accept this message." })
  })

  // PI-AGENT-027: an agent view's message is direction for that agent's
  // item or named agent, so the workflow resolves it from the session's
  // attempt, and a session that its agent no longer runs takes none.
  test.each(["delivered", "retained"] as const)("a person's %s message to a workflow agent keeps its address and delivery confirmation", async (kind) => {
    const sent: { readonly workflowId: string; readonly input: ChatInputLike; readonly targets: WorkflowTargets | undefined }[] = []
    const member = (workflowMembership: WorkflowMembership): ReplayedSession => ({
      kind: "workflow-agent", command: "workflow-agent", conversationId: "agent-conversation", label: "json", lifecycleState: "active",
      lastUpdated: "2026-10-18T00:00:00.000Z", launchedFrom: { parentSessionId: "chat", toolUseId: "launch" }, workflowMembership,
    })
    const sessions = new Map([
      ["current", member({ kind: "attempt", workflowId: "flow", attemptId: "phase:check:item:json:attempt:1" })],
      ["earlier", member({ kind: "historical-generation", workflowId: "flow", attemptId: "phase:check:item:json:attempt:1", generation: 0 })],
    ])
    const routes = workflowProtocol({
      manager: fakeManager({ read: async (sessionId) => sessions.get(sessionId) ?? null }),
      controller: {
        ...workflowController(fakeSessionStore(new Map()), fakeManager()),
        sendWorkflow: async (workflowId, input, targets) => {
          sent.push({ workflowId, input, targets })
          return { kind, sessionId: workflowId, ...(kind === "delivered" ? { confirmedSubmissionIds: ["local-1"] } : {}) }
        },
      },
    })

    const deps = runtime({ current: "workflow-agent" }, { child: routes.send }).deps
    const result = await handleSessionSend({ type: "session.send", sessionId: "current", input: { text: "Keep the old flag names.", submissionIds: ["local-1"] } }, deps)
    expect(result).toEqual({ ok: true, sessionId: "current", ...(kind === "delivered" ? { confirmedSubmissionIds: ["local-1"] } : {}) })
    const codec = runtimeDispatchResultSchema("session.send")
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual(result)
    expect(await routes.send("workflow-agent", "earlier", "Keep the old flag names.")).toEqual({ ok: false, error: EARLIER_AGENT_SESSION_REFUSAL })
    expect(sent).toEqual([{ workflowId: "flow", input: { text: "Keep the old flag names.", submissionIds: ["local-1"] }, targets: { attemptId: "phase:check:item:json:attempt:1" } }])
  })

  test("a subagent's refusal reaches the person in its owner's words", async () => {
    const { deps } = runtime({ child: "subagent" }, { child: async () => ({ ok: false, error: "This subagent has ended, so it reads no more messages." }) })

    expect(await handleSessionSend({ type: "session.send", sessionId: "child", input: "one more thing" }, deps)).toEqual({ ok: false, error: "This subagent has ended, so it reads no more messages." })
  })
})
