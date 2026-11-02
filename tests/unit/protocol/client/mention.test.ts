import { describe, expect, test } from "bun:test"

import { insertMention, mentionAt, mentionPath } from "../../../../src/protocol/client/mention.js"

describe("composer file mentions", () => {
  test("finds the @ token the caret is in, at the start or after whitespace only", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(mentionAt("look at @src/ap", 15)).toEqual({ start: 8, end: 15, query: "src/ap" })
    expect(mentionAt("look at @src/ap and", 15)).toEqual({ start: 8, end: 15, query: "src/ap" })
    expect(mentionAt("mail me@example.com", 19)).toBeUndefined()
    expect(mentionAt("look at @src/app.ts ", 20)).toBeUndefined()
    expect(mentionAt("nothing here", 5)).toBeUndefined()
  })

  test("replaces the token with the path and a trailing space, caret after it", () => {
    const token = mentionAt("read @src and tell", 9)
    expect(token).toBeDefined()
    if (!token) return
    expect(insertMention("read @src and tell", token, "src/app.ts")).toEqual({ text: "read @src/app.ts and tell", caret: 16 })
    const atEnd = mentionAt("read @src", 9)
    if (!atEnd) return
    expect(insertMention("read @src", atEnd, "src/app.ts")).toEqual({ text: "read @src/app.ts ", caret: 17 })
  })

  test("a directory completes to a slash and no space so the picker keeps going; spaces are quoted", () => {
    const token = mentionAt("see @sr", 7)
    if (!token) return
    expect(insertMention("see @sr", token, "src", true)).toEqual({ text: "see @src/", caret: 9 })
    expect(mentionAt("see @src/", 9)).toEqual({ start: 4, end: 9, query: "src/" })
    expect(mentionPath("docs/my notes.md")).toBe("\"docs/my notes.md\"")
    expect(insertMention("see @doc", { start: 4, end: 8, query: "doc" }, "docs/my notes.md")).toEqual({ text: "see @\"docs/my notes.md\" ", caret: 24 })
  })
})
