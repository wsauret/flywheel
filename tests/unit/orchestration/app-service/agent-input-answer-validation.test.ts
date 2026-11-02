import { describe, expect, it } from "bun:test"

import { validAgentInputAnswers } from "../../../../src/orchestration/app-service/session-runtime-actor-helpers.js"
import type { AgentInputEntry } from "../../../../src/orchestration/session/agent-input-projection.js"
import type { AgentInputAnswers } from "../../../../src/protocol/question-protocol-types.js"

const entry: Extract<AgentInputEntry, { kind: "pending" }> = {
  kind: "pending",
  interactionId: "ask-1",
  conversationId: "conversation-1",
  toolUseId: "ask-1",
  openedAt: 1,
  request: [{
    question: "Changes?",
    choices: [
      { kind: "option", choiceId: "revise", label: "Revise", requiresText: true },
      { kind: "option", choiceId: "keep", label: "Keep" },
      { kind: "freeform", label: "Other" },
    ],
    multiSelect: true,
  }],
}

function choice(selections: Array<{ choiceId: string; text?: string }>, text = selections.map((selection) => selection.choiceId === "revise" ? `Revise: ${selection.text}` : "Keep").join(", ")): AgentInputAnswers {
  return { "Changes?": { kind: "choice", selections, text } }
}

describe("validAgentInputAnswers", () => {
  it("accepts valid separate named text selections and retained Other", () => {
    expect(validAgentInputAnswers(entry, choice([
      { choiceId: "revise", text: "smaller API" },
      { choiceId: "keep" },
    ]))).toBe(true)
    expect(validAgentInputAnswers(entry, { "Changes?": { kind: "freeform", text: "Another route" } })).toBe(true)
  })

  it("rejects malformed, duplicate, unknown, missing, and forbidden selection text", () => {
    const invalid: AgentInputAnswers[] = [
      {},
      choice([]),
      choice([{ choiceId: "unknown" }]),
      choice([{ choiceId: "keep" }, { choiceId: "keep" }]),
      choice([{ choiceId: "keep", text: "not allowed" }]),
      choice([{ choiceId: "revise" }]),
      choice([{ choiceId: "revise", text: "   " }]),
    ]
    for (const answer of invalid) expect(validAgentInputAnswers(entry, answer)).toBe(false)
  })

  it("rejects display text that contradicts valid selections", () => {
    expect(validAgentInputAnswers(entry, choice([{ choiceId: "keep" }], "Revise"))).toBe(false)
  })

  it("accepts the answers a skip kept and rejects a question the request does not ask", () => {
    const pair = { ...entry, request: [...entry.request, { question: "Name?", choices: [{ kind: "freeform" as const, label: "Other" }], multiSelect: false }] }
    expect(validAgentInputAnswers(pair, { "Name?": { kind: "freeform", text: "notes.md" } })).toBe(true)
    expect(validAgentInputAnswers(pair, { "Name?": { kind: "freeform", text: "notes.md" }, "Unasked?": { kind: "freeform", text: "x" } })).toBe(false)
  })

  it("enforces single-select cardinality", () => {
    const single = { ...entry, request: [{ ...entry.request[0]!, multiSelect: false }] }
    expect(validAgentInputAnswers(single, choice([{ choiceId: "keep" }, { choiceId: "revise", text: "change" }]))).toBe(false)
  })
})
