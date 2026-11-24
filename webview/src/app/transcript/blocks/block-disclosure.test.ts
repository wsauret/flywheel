import assert from "node:assert/strict"
import { test } from "node:test"

import { createBlockDisclosure } from "./block-disclosure.js"

test("the choices of a session are the rows and files the reader opened or closed there, and restore as they were", () => {
  const disclosure = createBlockDisclosure()
  disclosure.setOpen("chat-1", "tool-30", true)
  disclosure.setOpen("chat-1", "tool-31", true)
  disclosure.setOpen("chat-1", "tool-31", false)
  disclosure.setFileExpanded("chat-1", "tool-32", { id: "file-0", path: "src/a.ts" }, true)
  disclosure.setOpen("chat-2", "tool-40", true)
  const saved = disclosure.choices("chat-1")
  assert.deepEqual([...saved.open].sort(), ["tool-30", "tool-32#diff:path:src/a.ts"])
  assert.deepEqual(saved.closed, ["tool-31"])
  assert.deepEqual(disclosure.state("chat-1", "tool-33")(), { open: false, chosen: false }, "a row nobody touched holds no choice")

  const reloaded = createBlockDisclosure()
  for (const key of saved.open) reloaded.setOpen("chat-1", key, true)
  for (const key of saved.closed) reloaded.setOpen("chat-1", key, false)
  assert.equal(reloaded.state("chat-1", "tool-30")().open, true)
  assert.deepEqual(reloaded.state("chat-1", "tool-31")(), { open: false, chosen: true }, "a close restores as a choice")
  assert.equal(reloaded.fileExpanded("chat-1", "tool-32", { id: "file-0", path: "src/a.ts" }), true)
  assert.equal(reloaded.state("chat-2", "tool-40")().open, false)
})
