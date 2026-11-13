import { describe, expect, test } from "bun:test"
import { chatInputContent, type ChatInput } from "../../../../../src/infra/chat-input.js"
import type { StoredTailEntry } from "../../../../../src/orchestration/session/chat-session-run-evidence.js"
import { isPersonEntry, personEntryInput, personEntrySelection } from "../../../../../src/orchestration/session/conversation/person-entries.js"

const timestamp = "2026-11-11T00:00:00.000Z"

function person(id: string, input: ChatInput | string): StoredTailEntry {
  return { kind: "message", id, parentId: null, timestamp, message: { kind: "user", content: chatInputContent(input), origin: "human" } }
}

function system(id: string): StoredTailEntry {
  return { kind: "message", id, parentId: null, timestamp, message: { kind: "user", content: "A chat asked a question.", origin: "system" } }
}

function answer(id: string): StoredTailEntry {
  return { kind: "message", id, parentId: null, timestamp, message: { kind: "assistant", content: [{ type: "text", text: "Done." }] } }
}

function toolCall(id: string): StoredTailEntry {
  return { kind: "message", id, parentId: null, timestamp, message: { kind: "assistant", content: [{ type: "tool_use", id: `${id}-call`, name: "read", input: {} }] } }
}

function toolResult(id: string): StoredTailEntry {
  return { kind: "message", id, parentId: null, timestamp, message: { kind: "toolResult", toolUseId: `${id}-call`, content: [{ type: "text", text: "file" }] } }
}

function compaction(id: string): StoredTailEntry {
  return { kind: "compaction", id, parentId: null, timestamp, sourceLeafId: "a", tokensBefore: 10, tokensAfter: 1, summary: "Earlier work.", retainedMessages: [] }
}

/** Feeds the entries as one batch each, newest batch first, as the tail read does, and reads the selection. */
function select(entries: readonly StoredTailEntry[], earlierTurns: number) {
  const selection = personEntrySelection(earlierTurns)
  for (const entry of entries.toReversed()) if (selection.feed([entry])) break
  return selection.refs()
}

describe("personEntryInput", () => {
  test("is the inverse of chatInputContent for text, an image, and a text file", () => {
    const original: ChatInput = {
      text: "Look at [Image #1] and [File #2 notes.md]\nthen fix it",
      attachments: [
        { marker: "[Image #1]", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
        { marker: "[File #2 notes.md]", mediaType: "text/markdown", name: "notes.md", data: Buffer.from("# Notes\nline two ü\n", "utf8").toString("base64") },
      ],
    }
    const entry = person("a", original)
    if (!isPersonEntry(entry)) throw new Error("expected a person entry")
    const input = personEntryInput(entry)
    expect(JSON.stringify(chatInputContent(input))).toBe(JSON.stringify(entry.message.content))
    expect(input).toEqual({ text: original.text, attachments: original.attachments })
  })

  test("gives a string content as its text with no attachment", () => {
    const entry = person("a", "Plain request")
    if (!isPersonEntry(entry)) throw new Error("expected a person entry")
    expect(personEntryInput(entry)).toEqual({ text: "Plain request" })
  })

  test("names an attachment past the text's markers with the next free number of its kind", () => {
    const entry = person("a", { text: "See [Image #3]", attachments: [
      { marker: "[Image #3]", mediaType: "image/png", data: "AAAA" },
      { marker: "lost", mediaType: "text/plain", name: "log.txt", data: Buffer.from("x").toString("base64") },
    ] })
    if (!isPersonEntry(entry)) throw new Error("expected a person entry")
    const input = personEntryInput(entry)
    expect(input.attachments?.map((attachment) => attachment.marker)).toEqual(["[Image #3]", "[File #4 log.txt]"])
    expect(JSON.stringify(chatInputContent(input))).toBe(JSON.stringify(entry.message.content))
  })

  test("keeps a text file whose name holds a newline, as the web client stores it", () => {
    const original: ChatInput = { text: "Read [File #1 notes\n2026.md]", attachments: [
      { marker: "[File #1 notes\n2026.md]", mediaType: "text/markdown", name: "notes\n2026.md", data: Buffer.from("body", "utf8").toString("base64") },
    ] }
    const entry = person("a", original)
    if (!isPersonEntry(entry)) throw new Error("expected a person entry")
    const input = personEntryInput(entry)
    expect(JSON.stringify(chatInputContent(input))).toBe(JSON.stringify(entry.message.content))
    expect(input).toEqual({ text: original.text, attachments: original.attachments })
  })
})

describe("personEntrySelection", () => {
  const branch = [person("A", "first"), answer("r1"), person("B", "second\nmore"), system("n"), person("C", "third"), toolCall("t"), toolResult("t")]

  test("answers the person's entries of the newest turn, oldest first, and leaves out a system-origin entry", () => {
    expect(select(branch, 0)).toEqual([
      { entryId: "B", firstLine: "second", turnsBack: 0 },
      { entryId: "C", firstLine: "third", turnsBack: 0 },
    ])
  })

  test("adds the person's entries of earlier turns", () => {
    expect(select(branch, 1)).toEqual([
      { entryId: "A", firstLine: "first", turnsBack: 1 },
      { entryId: "B", firstLine: "second", turnsBack: 0 },
      { entryId: "C", firstLine: "third", turnsBack: 0 },
    ])
  })

  test("a compaction hides no earlier turn", () => {
    expect(select([person("A", "first"), answer("r1"), compaction("k"), person("B", "second")], 1).map((ref) => ref.entryId)).toEqual(["A", "B"])
  })

  test("a chat that ends with a reply answers that turn as the newest", () => {
    const ended = [person("A", "first"), answer("r1"), person("B", "second"), answer("r2")]
    expect(select(ended, 0)).toEqual([{ entryId: "B", firstLine: "second", turnsBack: 0 }])
    expect(select(ended, 1)).toEqual([
      { entryId: "A", firstLine: "first", turnsBack: 1 },
      { entryId: "B", firstLine: "second", turnsBack: 0 },
    ])
  })

  test("a newest turn that a notice started holds no entry of the person and is not counted", () => {
    expect(select([person("A", "first"), answer("r1"), system("n"), answer("r2")], 0)).toEqual([{ entryId: "A", firstLine: "first", turnsBack: 0 }])
  })

  test("an earlier turn with no entry of the person is not counted", () => {
    const entries = [person("A", "first"), answer("r1"), system("n"), answer("r2"), person("B", "second")]
    expect(select(entries, 1)).toEqual([
      { entryId: "A", firstLine: "first", turnsBack: 1 },
      { entryId: "B", firstLine: "second", turnsBack: 0 },
    ])
  })

  test("closes once the turns asked are complete, so no older batch is read", () => {
    const selection = personEntrySelection(0)
    expect(selection.feed([person("B", "second")])).toBe(false)
    expect(selection.feed([person("A", "first"), answer("r1")])).toBe(true)
    expect(selection.refs().map((ref) => ref.entryId)).toEqual(["B"])
  })
})
