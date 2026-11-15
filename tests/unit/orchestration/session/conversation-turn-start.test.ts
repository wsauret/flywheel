import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import type { MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import { createTurnStartGate, withoutTurnStart } from "../../../../src/infra/output/turn-start"

let seq = 0
function entry(message: MessageEntry["message"]): MessageEntry {
  seq += 1
  return { id: `t${seq}`, parentId: seq === 1 ? null : `t${seq - 1}`, timestamp: "2026-07-02T10:00:00.000Z", kind: "message", message }
}

const tag = (block: { kind: string }) => `${block.kind}${"turnStart" in block && block.turnStart ? "*" : ""}`
const project = (entries: MessageEntry[]) => projectBlocksFromEntries(entries, { executionCwd: resolve("/scratch/project") })
const marks = (entries: MessageEntry[]) => project(entries).map(tag)

describe("history marks the turns that the runtime started", () => {
  it("marks the first row after a hidden notice that follows a finished turn, also when that row is a call", () => {
    const answer = entry({ kind: "assistant", content: [{ type: "text", text: "Started a chat." }] })
    const notice = entry({ kind: "user", content: "a chat asks a question", origin: "system" })
    const call = entry({ kind: "assistant", content: [{ type: "tool_use", id: "progress-1", name: "chat_progress", input: {} }] })
    expect(marks([entry({ kind: "user", content: "fix it" }), answer, notice, call])).toEqual(["userMessage", "text", "tool*"])
  })

  it("marks no turn start for a system message that arrives inside a turn, after a call's result", () => {
    const call = entry({ kind: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "a.ts" } }] })
    const result = entry({ kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "ok" }] })
    const notice = entry({ kind: "user", content: "a chat finished", origin: "system" })
    const answer = entry({ kind: "assistant", content: [{ type: "text", text: "Done." }] })
    expect(marks([entry({ kind: "user", content: "check it" }), call, result, notice, answer])).toEqual(["userMessage", "tool", "text"])
  })

  it("marks the reply to a message from another session that starts a turn, as the live output does", () => {
    const sender = { kind: "session" as const, sessionId: "c1", conversationId: "cc", toolUseId: "call-1", hop: 0, envelope: { name: "Parser fix", relation: "sibling" as const, waits: true } }
    const history = project([
      entry({ kind: "user", content: "fix it" }),
      entry({ kind: "assistant", content: [{ type: "text", text: "Done." }] }),
      entry({ kind: "user", content: "Which parser?", producer: sender }),
      entry({ kind: "assistant", content: [{ type: "text", text: "The new one." }] }),
    ])
    expect(history.map(tag)).toEqual(["userMessage", "text", "userMessage", "text*"])
    // The live output arms its gate when the message starts the turn, and admits the same rows.
    const gate = createTurnStartGate()
    const live = history.map((block, index) => {
      if (index === 2) gate.arm()
      return gate.admit(withoutTurnStart(block))
    })
    expect(live.map(tag)).toEqual(history.map(tag))
  })
})
