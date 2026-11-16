import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import type { ConversationEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"

const CWD = resolve("/scratch/project")
const T0 = "2026-07-02T10:00:00.000Z"

let seq = 0
function entry(message: MessageEntry["message"], overrides: Partial<MessageEntry> = {}): MessageEntry {
  seq += 1
  return { id: `e${seq}`, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp: T0, kind: "message", message, ...overrides }
}

function project(entries: ConversationEntry[]) {
  return projectBlocksFromEntries(entries, { executionCwd: CWD })
}

describe("user rows in the transcript", () => {
  it("renders a message from another session as a row that names its sender and the words of the person", () => {
    const envelope = { name: "Parser fix", relation: "child" as const, waits: false, personWords: "use the old one" }
    const message = entry({ kind: "user", content: "Which parser?", producer: { kind: "session", sessionId: "child-1", conversationId: "child-conversation", toolUseId: "call-1", hop: 0, envelope } })
    expect(project([message])).toEqual([{
      kind: "userMessage", id: message.id, content: "Which parser?", timestamp: Date.parse(T0), pending: false, injected: false,
      from: { sessionId: "child-1", name: "Parser fix", relation: "child", personWords: "use the old one" },
    }])
  })

  it("renders the assignment that launched a subagent as a row from its parent, not from the person", () => {
    const message = entry({ kind: "user", content: "Inspect the parser", producer: { kind: "launch", sessionId: "parent-1", toolUseId: "call-launch", name: "Root" } })
    expect(project([message])).toMatchObject([{ kind: "userMessage", content: "Inspect the parser", from: { sessionId: "parent-1", name: "Root", relation: "parent" } }])
  })

  it("renders an invocation user entry as a step boundary plus the raw args, hiding the expanded prompt", () => {
    const invocation = entry({ kind: "user", content: "Step \"Adapt\" is now active.\n<step ...>expanded body</step>", invocation: { label: "Adapt", args: "please adapt this box" }, submissionIds: ["adapt-1"] })
    const assistant = entry({ kind: "assistant", content: "done" })
    const blocks = project([invocation, assistant])

    expect(blocks).toEqual([
      { kind: "divider", id: `${invocation.id}:boundary`, label: "Adapt", timestamp: Date.parse(T0) },
      { kind: "userMessage", id: invocation.id, content: "please adapt this box", timestamp: Date.parse(T0), pending: false, injected: false, submissionIds: ["adapt-1"] },
      { kind: "text", id: assistant.id, content: "done", timestamp: Date.parse(T0) },
    ])
  })

  it("renders an argument-less invocation as only its step boundary", () => {
    const invocation = entry({ kind: "user", content: "expanded body", invocation: { label: "Code Review" } })
    const blocks = project([invocation])

    expect(blocks).toEqual([
      { kind: "divider", id: `${invocation.id}:boundary`, label: "Code Review", timestamp: Date.parse(T0) },
    ])
  })

  it("keeps user attachment markers and ordered image bodies separate from the words", () => {
    const user = entry({
      kind: "user",
      content: [
        { type: "text", text: "look at this [Image #1] [File #2 rows.csv]" },
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "<attachment name=\"rows.csv\" type=\"text/csv\">\na,b\n</attachment>" },
        { type: "image", mediaType: "image/jpeg", data: "Ynll" },
      ],
    })
    const blocks = project([user])

    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "look at this [Image #1] [File #2 rows.csv]", timestamp: Date.parse(T0), pending: false, injected: false,
        images: [{ mediaType: "image/png", data: "aGk=" }, { mediaType: "image/jpeg", data: "Ynll" }] },
    ])
  })

  it("flattens user content of another shape with one placeholder per part", () => {
    const user = entry({
      kind: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "aGk=" },
        { type: "text", text: "after" },
      ],
    })
    const blocks = project([user])

    expect(blocks).toEqual([
      { kind: "userMessage", id: user.id, content: "[image: image/png]\nafter", timestamp: Date.parse(T0), pending: false, injected: false,
        images: [{ mediaType: "image/png", data: "aGk=" }] },
    ])
  })

  it("retains image-only user messages", () => {
    const user = entry({ kind: "user", content: [{ type: "image", mediaType: "image/png", data: "aGk=" }] })
    expect(project([user])).toEqual([{
      kind: "userMessage", id: user.id, content: "[image: image/png]", timestamp: Date.parse(T0), pending: false, injected: false,
      images: [{ mediaType: "image/png", data: "aGk=" }],
    }])
  })
})
