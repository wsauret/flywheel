import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isBareTypingKey } from "./composer-claim.js"

const key = (name: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: name, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...modifiers })

describe("composer key claim", () => {
  test("takes a bare printable key, including the slash that opens the command menu", () => {
    assert.equal(isBareTypingKey(key("/")), true)
    assert.equal(isBareTypingKey(key("h")), true)
    assert.equal(isBareTypingKey(key("?")), true)
  })

  test("leaves shortcuts, space, and composed input where they landed", () => {
    assert.equal(isBareTypingKey(key("k", { metaKey: true })), false)
    assert.equal(isBareTypingKey(key("k", { ctrlKey: true })), false)
    assert.equal(isBareTypingKey(key("k", { altKey: true })), false)
    assert.equal(isBareTypingKey(key(" ")), false)
    assert.equal(isBareTypingKey(key("a", { isComposing: true })), false)
  })

  test("leaves named keys alone", () => {
    for (const name of ["Enter", "Escape", "Tab", "ArrowUp", "Backspace", "Shift"]) assert.equal(isBareTypingKey(key(name)), false)
  })
})
