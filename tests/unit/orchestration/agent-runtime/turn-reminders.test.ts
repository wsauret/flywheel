import { describe, expect, it } from "bun:test"
import { turnReminders, type TurnReminderState } from "../../../../src/orchestration/agent-runtime/turn-reminders.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"

const mode = (holds: boolean, wording = "Mode"): TurnReminderState => ({
  id: "probe-mode", on: `${wording} is on.`, still: `${wording} is still on.`, off: `${wording} is off.`, every: 2, holds,
  retired: { "<system-reminder>\nOld mode is on.\n</system-reminder>": "on" },
})
const reminder = (state: "on" | "still" | "off", body: string): ConversationMessage =>
  ({ kind: "user", origin: "system", content: `<system-reminder mode="probe-mode" state="${state}">\n${body}\n</system-reminder>` })
const person = (text: string): ConversationMessage => ({ kind: "user", content: text, origin: "human" })
const reply: ConversationMessage = { kind: "assistant", content: [{ type: "text", text: "done" }] }
const said = (messages: readonly ConversationMessage[], holds: boolean, wording?: string) =>
  turnReminders(messages, [mode(holds, wording)]).map((message) => message.content)

describe("turnReminders", () => {
  it("states a mode on the first person turn while it holds, and again only after its interval", () => {
    expect(said([person("audit this")], true)).toEqual([reminder("on", "Mode is on.").content])
    const stated = [person("audit this"), reminder("on", "Mode is on."), reply]
    expect(said([...stated, person("next")], true)).toEqual([])
    expect(said([...stated, person("next"), reply, person("again")], true)).toEqual([])
    expect(said([...stated, person("next"), reply, person("again"), reply, person("third")], true)).toEqual([reminder("still", "Mode is still on.").content])
  })

  it("adds nothing after a tool round or a system message, so a retry does not repeat a reminder", () => {
    const toolRound: ConversationMessage = { kind: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "ok" }] }
    expect(said([person("audit this"), reminder("on", "Mode is on."), toolRound], true)).toEqual([])
    expect(said([person("audit this"), reminder("on", "Mode is on.")], true)).toEqual([])
  })

  it("states off once on the next person turn after the mode stops holding, and on again when it returns", () => {
    const stated = [person("audit this"), reminder("on", "Mode is on."), reply, person("turn it off")]
    expect(said(stated, false)).toEqual([reminder("off", "Mode is off.").content])
    const ended = [...stated, reminder("off", "Mode is off."), reply, person("next")]
    expect(said(ended, false)).toEqual([])
    expect(said(ended, true)).toEqual([reminder("on", "Mode is on.").content])
    expect(said([person("hello")], false)).toEqual([])
  })

  it("recognizes its earlier statements after the wording changes, including the unmarked shape", () => {
    const marked = [person("audit this"), reminder("on", "Mode is on."), reply, person("next")]
    expect(said(marked, true, "Reworded mode")).toEqual([])
    expect(said(marked, false, "Reworded mode")).toEqual([reminder("off", "Reworded mode is off.").content])
    const unmarked: ConversationMessage[] = [person("audit this"), { kind: "user", origin: "system", content: "<system-reminder>\nOld mode is on.\n</system-reminder>" }, reply, person("next")]
    expect(said(unmarked, true)).toEqual([])
    expect(said(unmarked, false)).toEqual([reminder("off", "Mode is off.").content])
  })
})
