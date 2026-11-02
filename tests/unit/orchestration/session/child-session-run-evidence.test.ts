import { describe, expect, test } from "bun:test"
import { subagentSessionActions } from "../../../../src/orchestration/session/child-session-run-evidence.js"

describe("child session admission from run evidence", () => {
  test("a running child admits a message, Interrupt, and Stop", () => {
    expect(subagentSessionActions("active", { run: { status: "created" }, continuationAuthorized: false }))
      .toEqual(["session.send", "subagent.interrupt", "background.terminate", "session.delete"])
  })

  test("an interrupted or crash-interrupted child admits a message, Resume, and Stop: its parent's call still waits on it, and a message resumes it", () => {
    expect(subagentSessionActions("inactive", { run: { status: "paused" }, continuationAuthorized: false })).toEqual(["session.send", "subagent.resume", "background.terminate", "session.delete"])
    expect(subagentSessionActions("inactive", { run: { status: "interrupted", interruptionReason: "runtime_restarted" }, continuationAuthorized: false })).toEqual(["session.send", "subagent.resume", "background.terminate", "session.delete"])
    expect(subagentSessionActions("inactive", { run: { status: "paused" }, continuationAuthorized: false }, true)).toEqual(["subagent.interrupt", "session.send", "subagent.resume", "background.terminate", "session.delete"])
    expect(subagentSessionActions("active", { run: { status: "paused" }, continuationAuthorized: false })).toEqual(["session.send", "subagent.resume", "background.terminate", "session.delete"])
  })

  test("a continuation-authorized child admits a message and Resume; its successor owns the run, so it admits no Stop", () => {
    expect(subagentSessionActions("inactive", { run: { status: "created" }, continuationAuthorized: true })).toEqual(["session.send", "subagent.resume", "session.delete"])
  })

  test("every inactive non-completed child admits explicit Resume", () => {
    for (const status of ["partial", "failed", "stopped", "cancelled", "interrupted", "created"] as const) {
      expect(subagentSessionActions("inactive", { run: { status }, continuationAuthorized: false }))
        .toEqual(["subagent.resume", "session.delete"])
    }
  })

  test("a completed child and a row without evidence admit deletion only", () => {
    expect(subagentSessionActions("inactive", { run: { status: "completed" }, continuationAuthorized: false })).toEqual(["session.delete"])
    expect(subagentSessionActions("active")).toEqual(["session.delete"])
  })
})
