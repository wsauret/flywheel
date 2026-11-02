import { describe, expect, it, spyOn } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import type { DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { WAITING_RECALL } from "../../../../src/protocol/client/chat-submissions.js"
import { createTerminalChatSubmissions } from "../../../../src/tui/hooks/create-chat-submissions.js"

/** A resident window that reaches the session's first block. */
const WHOLE = { startBlockIndex: 0 }

/** A connection whose lanes never open again. */
const NO_LANES = { onLane: () => () => {} }

describe("terminal chat submissions", () => {
  it("compiles one metadata-only report for slow delivery and stays silent for healthy submissions", async () => {
    let clock = 0
    const report = spyOn(DebugLog, "record").mockImplementation(() => {})
    const request = Promise.withResolvers<{ ok: true }>()
    const submissions = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: () => request.promise, report: () => {}, now: () => clock })
    try {
      const sending = submissions.send("s", { text: "private message", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "private bytes" }] })
      const id = submissions.pending("s")[0]!.id
      clock = 20
      submissions.frame()
      clock = 1_500
      request.resolve({ ok: true })
      await sending
      submissions.observe("s", [{ kind: "userMessage", id: "canonical", content: "private message", timestamp: 1, pending: false, injected: false, submissionIds: [id] }], WHOLE)
      submissions.frame()
      submissions.frame()
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0]![0]).toMatchObject({
        type: "chat.submission.feedback",
        sessionId: "s",
        payload: { submissionId: id, outcome: "adopted", slow: true, failed: false, dispatchMs: 1_500, adoptedMs: 1_500, firstFrameMs: 20 },
      })
      const serialized = JSON.stringify(report.mock.calls)
      expect(serialized).not.toContain("private message")
      expect(serialized).not.toContain("private bytes")

      const healthy = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => ({ ok: true }), report: () => {}, now: () => clock })
      await healthy.send("s", { text: "healthy" })
      healthy.frame()
      healthy.observe("s", [{ kind: "userMessage", id: "healthy", content: "healthy", timestamp: 2, pending: false, injected: false, submissionIds: [healthy.pending("s")[0]!.id] }], WHOLE)
      healthy.frame()
      healthy.dispose()
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      report.mockRestore()
    }
  })

  it("reports a delayed client frame separately from immediate runtime adoption", async () => {
    let clock = 0
    const report = spyOn(DebugLog, "record").mockImplementation(() => {})
    const submissions = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => ({ ok: true }), report: () => {}, now: () => clock })
    try {
      await submissions.send("s", { text: "message" })
      const id = submissions.pending("s")[0]!.id
      await submissions.send("s", { text: "second" })
      clock = 10
      const canonical = { kind: "userMessage" as const, id: "canonical", content: "message", timestamp: 1, pending: false, injected: false, submissionIds: [id] }
      submissions.observe("s", [canonical], WHOLE)
      clock = 500
      submissions.observe("s", [canonical], WHOLE)
      expect(report).not.toHaveBeenCalled()
      clock = 4_000
      submissions.frame()
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0]![0]).toMatchObject({ payload: { dispatchMs: 0, adoptedMs: 10, firstFrameMs: 4_000, slow: true } })
    } finally {
      report.mockRestore()
    }
  })

  it("passes abnormal reports through the default-level sink while healthy and idle frames write nothing", async () => {
    const records: DebugLogRecordInput[] = []
    DebugLog.setVerbose(false)
    await DebugLog.forward((record) => records.push(record))
    try {
      const submissions = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => ({ ok: false, error: "not logged" }), report: () => {} })
      await submissions.send("s", { text: "not logged" })
      submissions.frame()
      for (let frame = 0; frame < 100; frame++) submissions.frame()
      submissions.dispose()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ type: "chat.submission.feedback", notable: true })
      expect(JSON.stringify(records)).not.toContain("not logged")
    } finally {
      await DebugLog.close()
    }
  })

  it("reports failures and unfinished delivery once without recording error content", async () => {
    const report = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const failed = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => { throw new Error("private error") }, report: () => {}, now: () => 0 })
      await failed.send("s", { text: "private text" })
      failed.frame()
      failed.frame()
      failed.dispose()
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0]![0]).toMatchObject({ payload: { outcome: "failed", failed: true, slow: false } })
      const unfinished = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => ({ ok: true }), report: () => {}, now: () => 0 })
      await unfinished.send("other", { text: "unconfirmed" })
      unfinished.dispose()
      unfinished.dispose()
      expect(report).toHaveBeenCalledTimes(2)
      expect(report.mock.calls[1]![0]).toMatchObject({ sessionId: "other", payload: { outcome: "incomplete", failed: true } })
      expect(JSON.stringify(report.mock.calls)).not.toContain("private")
    } finally {
      report.mockRestore()
    }
  })

  it("shows a failed send once as a toast and updates reactive readers of the session's entries", async () => {
    const errors: string[] = []
    const report = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const submissions = createTerminalChatSubmissions({ lanes: NO_LANES, dispatch: async () => ({ ok: false, error: "Disconnected" }), report: (error) => errors.push(error) })
      await createRoot(async (dispose) => {
        const errorsShown = createMemo(() => submissions.pending("s").map((entry) => entry.delivery.kind === "failed" ? entry.delivery.error : undefined))
        const sending = submissions.send("s", { text: "hello" })
        expect(errorsShown()).toEqual([undefined])
        await sending
        expect(errorsShown()).toEqual(["Disconnected"])
        expect(errors).toEqual(["Disconnected"])
        submissions.recallLocal("s")
        expect(errorsShown()).toEqual([])
        dispose()
      })
    } finally {
      report.mockRestore()
    }
  })

  it("shows no toast for a message lost with the connection, says why Up keeps it queued, and sends it again on the next lane", async () => {
    const errors: string[] = []
    const report = spyOn(DebugLog, "record").mockImplementation(() => {})
    const listeners = new Set<(lane: number) => void>()
    const sent: (readonly string[] | undefined)[] = []
    let lost = true
    try {
      const submissions = createTerminalChatSubmissions({
        lanes: { onLane: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
        dispatch: async (_sessionId, input) => {
          sent.push(input.submissionIds)
          if (lost) throw new RuntimeLaneLost(new Error("the lane the call ran on ended"))
          return { ok: true }
        },
        report: (message, variant) => errors.push(`${variant}: ${message}`),
      })
      await submissions.send("s", { text: "hello" })
      expect(errors).toEqual([])
      expect(submissions.pending("s").map((entry) => entry.delivery)).toEqual([{ kind: "waiting" }])
      // Up keeps the waiting message queued and says why.
      expect(submissions.recallLocal("s")).toEqual({ kind: "waiting", notice: WAITING_RECALL })
      expect(errors).toEqual([`info: ${WAITING_RECALL}`])
      lost = false
      for (const listener of listeners) listener(1)
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      expect(sent).toHaveLength(2)
      expect(sent[1]).toEqual(sent[0])
      expect(submissions.pending("s").map((entry) => entry.delivery.kind)).toEqual(["accepted"])
      submissions.dispose()
    } finally {
      report.mockRestore()
    }
  })
})
