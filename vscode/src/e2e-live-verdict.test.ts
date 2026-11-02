import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { liveTransportVerdict, observeLiveBlocks, type LiveTransportBlock } from "../scripts/e2e-live-verdict.js"

const user = { kind: "userMessage", id: "user-1", content: "probe" } satisfies LiveTransportBlock
const text = { kind: "text", id: "text-1", content: "complete" } satisfies LiveTransportBlock
const thinking = { kind: "thinking", id: "thinking-1", content: "working" } satisfies LiveTransportBlock
const tool = { kind: "tool", id: "tool-1" } satisfies LiveTransportBlock
const error = { kind: "system", id: "error-1", level: "error", message: "provider unavailable" } satisfies LiveTransportBlock
const info = { kind: "system", id: "info-1", level: "info", message: "connected" } satisfies LiveTransportBlock

describe("live transport verdict", () => {
  test("passes on terminal assistant text after the session returns idle", () => {
    assert.deepEqual(liveTransportVerdict([user, text], "idle", "connected"), {
      kind: "passed",
      terminal: "assistant_text",
    })
  })

  test("passes on a rendered terminal error after the failed session becomes absent", () => {
    assert.deepEqual(liveTransportVerdict([user, error], "absent", "connected"), {
      kind: "passed",
      terminal: "system_error",
    })
  })

  test("keeps waiting while assistant text is still active", () => {
    assert.equal(liveTransportVerdict([user, text], "generating", "connected").kind, "pending")
  })

  test("does not accept thinking or tool output as terminal", () => {
    assert.equal(liveTransportVerdict([user, thinking], "idle", "connected").kind, "pending")
    assert.equal(liveTransportVerdict([user, tool], "idle", "connected").kind, "pending")
  })

  test("does not accept an informational system message as terminal", () => {
    assert.equal(liveTransportVerdict([user, info], "idle", "connected").kind, "pending")
  })

  test("waits while the connection recovers, even with terminal transcript evidence retained", () => {
    assert.equal(liveTransportVerdict([user, text], "idle", "recovering").kind, "pending")
  })

  test("fails when the runtime connection closes", () => {
    assert.deepEqual(liveTransportVerdict([user], "idle", "closed"), {
      kind: "failed",
      reason: "runtime connection closed",
    })
  })

  test("replaces an early empty text snapshot with its completed delta", () => {
    const seen = new Map<string, LiveTransportBlock>()
    observeLiveBlocks(seen, [{ kind: "text", id: "reply-1", content: "" }])
    observeLiveBlocks(seen, [{ kind: "text", id: "reply-1", content: "complete" }])

    assert.deepEqual(liveTransportVerdict([...seen.values()], "idle", "connected"), {
      kind: "passed",
      terminal: "assistant_text",
    })
  })

  test("replaces a provisional tool with its canonical question block", () => {
    const seen = new Map<string, LiveTransportBlock>()
    observeLiveBlocks(seen, [{ kind: "tool", id: "call-1" }])
    observeLiveBlocks(seen, [{ kind: "question", toolUseId: "call-1" }])

    assert.equal(seen.size, 1)
    assert.equal(seen.get("tool:call-1")?.kind, "question")
  })
})
