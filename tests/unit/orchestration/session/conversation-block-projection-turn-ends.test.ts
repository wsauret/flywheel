import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import type { ConversationEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import { contextResetRecordId, interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"

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

describe("turn-end records in the transcript", () => {
  const crashRecord = () => entry({ kind: "user", content: "The process running this turn exited before the turn finished. Its reply was lost.", origin: "system" }, { id: turnEndEntryId({ reason: "crash" }, `c${seq}`) })
  const pausedRecord = (pausedBy: "person" | "runtime") => entry({ kind: "user", content: interruptedTurnMessage(pausedBy, true), origin: "system" }, { id: turnEndEntryId({ reason: "paused", pausedBy }, `p${seq}`) })

  it("shows who interrupted a turn, in the words the live session used", () => {
    const blocks = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person")])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted"])
    const runtime = project([entry({ kind: "user", content: "fix it" }), pausedRecord("runtime")])
    expect(runtime.at(-1)).toMatchObject({ kind: "system", message: "Interrupted by the runtime" })
  })

  it("a Resume's continuation stays hidden and the reply that follows it reads as Resumed", () => {
    const blocks = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person"), entry({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" }), entry({ kind: "assistant", content: "Continuing." })])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted", "Resumed", "text"])
  })

  it("hides a planned replacement's cut and the Resume that continues it", () => {
    const plannedRecord = entry({ kind: "user", content: interruptedTurnMessage("runtime", true), origin: "system" }, { id: turnEndEntryId(interruptedTurnEnd("replacement"), `r${seq}`) })
    const blocks = project([entry({ kind: "user", content: "fix it" }), plannedRecord, entry({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" }), entry({ kind: "assistant", content: "Continuing." })])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "text"])
  })

  it("reads a Resume that was interrupted again before it replied as Interrupted, Resumed, Interrupted", () => {
    const resume = () => entry({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" })
    const blocks = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person"), resume(), pausedRecord("person"), resume(), entry({ kind: "assistant", content: "Continuing." })])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted", "Resumed", "Interrupted", "Resumed", "text"])
  })

  it("names an unexpected exit and the continuation that follows a record", () => {
    const blocks = project([entry({ kind: "user", content: "fix it" }), crashRecord(), entry({ kind: "assistant", content: "Continuing." })])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted by an unexpected exit", "Resumed", "text"])
  })

  it("a new message after a record starts a new turn: no Resumed row", () => {
    const blocks = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person"), entry({ kind: "user", content: "try again" }), entry({ kind: "assistant", content: "Sure." })])
    expect(blocks.map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted", "userMessage", "text"])
  })

  it("shows a settled record as its own exchange: the runtime's notice as a system row, a person's command as their message, and an older interrupt keeps its Resume", () => {
    const settled = (origin: "human" | "system", content: string) => entry({ kind: "user", content, origin }, { id: turnEndEntryId({ reason: "settled" }, `op${seq}`) })
    const label = (blocks: ReturnType<typeof project>) => blocks.map((block) => block.kind === "system" ? block.message : block.kind)
    const refusal = project([entry({ kind: "user", content: "fix it" }), entry({ kind: "assistant", content: "Done." }), settled("system", "The qa workflow could not start: required skills are missing")])
    expect(label(refusal)).toEqual(["userMessage", "text", "The qa workflow could not start: required skills are missing"])
    const command = project([entry({ kind: "user", content: "fix it" }), entry({ kind: "assistant", content: "Done." }), settled("human", "Launched the qa workflow: verify release")])
    expect(command.at(-1)).toMatchObject({ kind: "userMessage", content: "Launched the qa workflow: verify release" })
    const resumed = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person"), settled("human", "Launched the qa workflow: verify release"), entry({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" }), entry({ kind: "assistant", content: "Continuing." })])
    expect(label(resumed)).toEqual(["userMessage", "Interrupted", "userMessage", "Resumed", "text"])
    // The recovery text that opens a parked reset's fresh context is model-facing prose.
    const reset = project([entry({ kind: "user", content: "fix it" }), pausedRecord("person"), { kind: "compaction", id: `c${seq}`, parentId: `e${seq}`, timestamp: T0, mode: "reset", sourceLeafId: `e${seq}`, tokensBefore: 10, tokensAfter: 1 }, entry({ kind: "user", content: "A fresh context window has started.", origin: "system", checkpoint: true }, { id: contextResetRecordId() }), entry({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" }), entry({ kind: "assistant", content: "Continuing." })])
    expect(label(reset)).toEqual(["userMessage", "Interrupted", "Context compacted: 10 → 1 tokens", "Resumed", "text"])
  })

  it("reads an Escape marker written before interrupt became resumable as a person's interrupt, and hides a discarded turn's record", () => {
    // Remove with the conversion after 2027-03-22.
    const escaped = entry({ kind: "system", content: "Interrupted by user." }, { id: "itb-user-u1", displayOnly: true })
    const discarded = entry({ kind: "user", content: "The user ended the session before this turn finished, and its unfinished reply was discarded.", origin: "system" }, { id: turnEndEntryId({ reason: "discarded" }, "d1") })
    expect(project([entry({ kind: "user", content: "fix it" }), escaped]).map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage", "Interrupted"])
    expect(project([entry({ kind: "user", content: "fix it" }), discarded]).map((block) => block.kind === "system" ? block.message : block.kind)).toEqual(["userMessage"])
  })
})
