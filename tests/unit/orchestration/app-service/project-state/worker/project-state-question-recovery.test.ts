import { afterEach, describe, expect, test } from "bun:test"
import { recoverProject } from "../../../../../helpers/project-recovery.js"
import { tryOpenConversationTree } from "../../../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { removeOwnerPid } from "../../../../../../src/orchestration/session/pid-lock.js"
import { holdQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { closeFixtures, fixture } from "./_project-state-recovery-fixture.js"

afterEach(closeFixtures)

describe("project recovery of a chat whose question waits", () => {
  // ARCH-SESSIONS-050: a notice that arrived while the question waited at
  // rest waits in its cell, so the ask stays the last exchange.
  test("records no crash over a question that waits with a notice held behind it, and leaves the notice held", async () => {
    const { store, reader, writer, manager, directories } = fixture()
    const sessionId = await manager.createChat({ name: "waiting question", initialState: "active" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("expected chat session")
    const { conversationId } = session
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: reader, writer })
    if (!tree) throw new Error("expected conversation tree")
    const appended = await tree.appendMessages([
      { kind: "user", content: "Ask me", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
    ])
    tree.dispose()
    if (appended.kind !== "committed") throw appended.cause
    store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
      payload: { interactionId: "ask-1", conversationId, toolUseId: "ask-1", request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }] },
    })
    await holdQueuedBackgroundNotification(writer, sessionId, conversationId, "<background-command id=\"cmd-1\">finished</background-command>", "command:cmd-1")
    removeOwnerPid(sessionId, directories.projectRoot)

    const recovery = await recoverProject({ directories, reader, writer }, "ownerless")

    expect(recovery.sessionIds).toEqual([sessionId])
    expect(recovery.degraded).toEqual([])
    const recovered = await tryOpenConversationTree({ conversationId, sessionId, store: reader, writer })
    if (!recovered) throw new Error("expected conversation tree")
    try {
      const branch = await recovered.getBranch()
      expect(branch.some((entry) => entry.id.startsWith("itb-"))).toBe(false)
      expect(recovered.awaitsAnswer()).toBe(true)
    } finally { recovered.dispose() }
    expect(store.readInFlight(sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map(({ key }) => key)).toEqual(["command:cmd-1"])
  })

})
