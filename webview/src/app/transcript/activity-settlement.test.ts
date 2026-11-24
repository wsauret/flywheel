import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { mountActivityStatus } from "./render-ownership-loader-fixture.js"

describe("mounted activity settlement", () => {
  test("the runtime start survives a mid-status mount and each new status restarts its count and reassurance", () => {
    const frame = { sessionId: "session-a", activity: "thinking", activityStartedAt: 1000, now: 26000, transcriptAvailable: true, atTail: true, settledOutputPosition: null, appliedOutputPosition: 1, transcriptText: "" } as const
    const mounted = mountActivityStatus(frame)
    try {
      assert.equal(mounted.statusText(), "Thinking…25sbear with me")
      mounted.setFrame({ ...frame, activity: "generating", activityStartedAt: 26000 })
      assert.equal(mounted.statusText(), "Generating…0s")
      mounted.setFrame({ ...frame, activity: "generating", activityStartedAt: 26010 })
      assert.equal(mounted.statusText(), "Generating…0s")
      mounted.setFrame({ ...frame, activity: "executing_tools", activityStartedAt: 26000, now: 30000 })
      assert.equal(mounted.statusText(), "Executing…4s")
      mounted.setFrame({ ...frame, activityStartedAt: 30000, now: 31000 })
      assert.equal(mounted.statusText(), "Thinking…1s")
      mounted.setFrame({ ...frame, activity: "idle", waitingOn: "Waiting on parent", activityStartedAt: 12000 })
      assert.equal(mounted.statusText(), "Waiting on parent14s")
      mounted.setFrame({ ...frame, activity: "waiting", activityStartedAt: null })
      assert.equal(mounted.statusText(), "Waiting…")
    } finally {
      mounted.dispose()
    }
  })

  test("initial idle never invents an activity row", () => {
    const mounted = mountActivityStatus({
      sessionId: "session-a",
      activity: "idle",
      transcriptAvailable: true,
      atTail: true,
      settledOutputPosition: 1,
      appliedOutputPosition: 1,
      transcriptText: "Transcript",
    })
    try {
      assert.equal(mounted.text(), "Transcript")
      assert.equal(mounted.statusExiting(), true)
      assert.equal(mounted.pendingFrames(), 0)
    } finally {
      mounted.dispose()
    }
  })

  test("a session parked on a reply shows what it waits on, and the row exits when the wait ends", () => {
    const parked = { sessionId: "session-a", activity: "idle", transcriptAvailable: true, atTail: true, settledOutputPosition: 1, appliedOutputPosition: 1, transcriptText: "" } as const
    const mounted = mountActivityStatus({ ...parked, waitingOn: "Waiting on parent" })
    try {
      assert.equal(mounted.statusHidden(), false)
      assert.equal(mounted.text(), "Waiting on parent")
      mounted.setFrame(parked)
      mounted.flushFrame()
      mounted.flushFrame()
      assert.equal(mounted.statusExiting(), true)
    } finally {
      mounted.dispose()
    }
  })

  test("settled idle holds until the transcript applies its causal anchor, then exits once", () => {
    const mounted = mountActivityStatus()
    try {
      assert.equal(mounted.text(), "Generating…")
      mounted.setFrame({
        sessionId: "session-a",
        activity: "idle",
        transcriptAvailable: true,
        atTail: true,
        settledOutputPosition: 4,
        appliedOutputPosition: 3,
        transcriptText: "Final answer",
      })
      assert.equal(mounted.statusHidden(), false)
      assert.equal(mounted.text(), "Final answerGenerating…")
      assert.equal(mounted.pendingFrames(), 0)

      mounted.setFrame({
        sessionId: "session-a",
        activity: "idle",
        transcriptAvailable: true,
        atTail: true,
        settledOutputPosition: 4,
        appliedOutputPosition: 4,
        transcriptText: "Final answer",
      })
      assert.equal(mounted.statusHidden(), false)
      assert.equal(mounted.text(), "Final answerGenerating…")
      assert.equal(mounted.pendingFrames(), 1)

      mounted.publish()
      assert.equal(mounted.pendingFrames(), 1)
      mounted.flushFrame()
      assert.equal(mounted.statusExiting(), false)
      assert.equal(mounted.pendingFrames(), 1)

      mounted.publish()
      assert.equal(mounted.pendingFrames(), 1)
      mounted.flushFrame()
      assert.equal(mounted.statusExiting(), true)
      assert.equal(mounted.statusText(), "Generating…")

      mounted.setFrame({
        sessionId: "session-a",
        activity: "idle",
        transcriptAvailable: true,
        atTail: true,
        settledOutputPosition: 5,
        appliedOutputPosition: 4,
        transcriptText: "Later output",
      })
      assert.equal(mounted.text(), "Later output")
      assert.equal(mounted.statusExiting(), true)
      assert.equal(mounted.pendingFrames(), 0)
    } finally {
      mounted.dispose()
    }
  })

  test("keyed session replacement and removal cancel pending exit without carrying a verb", () => {
    const mounted = mountActivityStatus()
    try {
      mounted.setFrame({
        sessionId: "session-a",
        activity: "idle",
        transcriptAvailable: false,
        atTail: true,
        settledOutputPosition: 1,
        appliedOutputPosition: 1,
        transcriptText: "",
      })
      assert.equal(mounted.pendingFrames(), 1)
      mounted.setFrame({
        sessionId: "session-b",
        activity: "idle",
        transcriptAvailable: true,
        atTail: true,
        settledOutputPosition: 2,
        appliedOutputPosition: 1,
        transcriptText: "",
      })
      assert.equal(mounted.text(), "")
      assert.equal(mounted.statusExiting(), true)
      assert.equal(mounted.pendingFrames(), 0)

      mounted.setFrame({
        sessionId: "session-b",
        activity: "thinking",
        transcriptAvailable: false,
        atTail: false,
        settledOutputPosition: null,
        appliedOutputPosition: null,
        transcriptText: "",
      })
      assert.equal(mounted.text(), "Thinking…")
      mounted.setFrame({
        sessionId: "session-b",
        activity: "idle",
        transcriptAvailable: false,
        atTail: true,
        settledOutputPosition: 2,
        appliedOutputPosition: 2,
        transcriptText: "",
      })
      assert.equal(mounted.pendingFrames(), 1)
      mounted.setFrame({
        sessionId: undefined,
        activity: "idle",
        transcriptAvailable: true,
        atTail: true,
        settledOutputPosition: 3,
        appliedOutputPosition: 2,
        transcriptText: "",
      })
      assert.equal(mounted.text(), "")
      assert.equal(mounted.pendingFrames(), 0)
    } finally {
      mounted.dispose()
    }
  })
})
