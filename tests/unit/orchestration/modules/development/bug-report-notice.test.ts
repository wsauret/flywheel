import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../../../../src/infra/log.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { createBugReportNotice } from "../../../../../src/orchestration/modules/development/bug-report-notice.js"

function result(stdout: string, overrides: Partial<OwnedCommandResult> = {}): OwnedCommandResult {
  return { stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", exitCode: 0, timedOut: false, ...overrides }
}

const log = Log.create({ service: "development-bug-reports" })
afterEach(() => mock.restore())

describe("development bug report notice", () => {
  test.each([
    { count: 201, text: "201 bug reports wait for triage. Run /bug-report-triage." },
    { count: 1, text: "1 bug report waits for triage. Run /bug-report-triage." },
    { count: 0, text: undefined },
  ])("checks once after startup and reports the exact untriaged count: $count", async ({ count, text }) => {
    const runCommand = mock<OwnedCommandRunner>(async () => result(`${count}\n`))
    const episodes: NotificationEpisodeInput[] = []
    const info = spyOn(log, "info")
    const debug = spyOn(log, "debug")
    const notice = createBugReportNotice({ runCommand, notify: async (episode) => { episodes.push(episode) }, enabled: () => true, executionCwd: "/repo" })
    try {
      expect(runCommand).not.toHaveBeenCalled()
      notice.start?.()
      notice.start?.()
      expect(runCommand).not.toHaveBeenCalled()
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(runCommand).toHaveBeenCalledTimes(1)
      expect(runCommand.mock.calls[0]).toEqual([
        ["gh", "api", "-X", "GET", "search/issues", "-f", "q=repo:wsauret/flywheel-reports is:issue is:open -label:triage:needs-evidence -label:triage:confirmed", "--jq", ".total_count"],
        expect.objectContaining({ cwd: "/repo", timeoutMs: 10_000, signal: expect.any(AbortSignal) }),
      ])
      expect(episodes).toEqual(text ? [{ type: "raise", occurrence: {
        sourceId: "development:bug-report-triage", title: "Bug reports need triage", message: text, severity: "warning",
      } }] : [{ type: "resolve", sourceId: "development:bug-report-triage" }])
      expect(info).toHaveBeenCalledTimes(1)
      expect(info.mock.calls[0]?.[1]).toEqual({ count, durationMs: expect.any(Number) })
      expect(debug).not.toHaveBeenCalled()
    } finally { await notice.dispose() }
  })

  test.each([
    { kind: "launch", run: async () => { throw new Error("missing gh with secret diagnostic") } },
    { kind: "exit", run: async () => result("", { exitCode: 4, stderr: "not authenticated with secret diagnostic" }) },
    { kind: "timeout", run: async () => result("", { timedOut: true, exitCode: 1 }) },
    ...["", "not a count", "-1", "1.5", "2 issues", "1e3", "Infinity", "9007199254740993"].map((stdout) => ({ kind: "response", run: async () => result(stdout) })),
  ])("contains $kind failures without a notice or diagnostic content", async ({ kind, run }) => {
    const notify = mock(async (_episode: NotificationEpisodeInput) => {})
    const info = spyOn(log, "info")
    const debug = spyOn(log, "debug")
    const notice = createBugReportNotice({ runCommand: run, notify, enabled: () => true, executionCwd: "/repo" })
    try {
      notice.start?.()
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(notify).not.toHaveBeenCalled()
      expect(debug).toHaveBeenCalledTimes(1)
      expect(debug.mock.calls[0]?.[1]).toEqual({ kind })
      expect(info).toHaveBeenCalledTimes(1)
      expect(info.mock.calls[0]?.[1]).toEqual({ count: "unknown", durationMs: expect.any(Number) })
    } finally { await notice.dispose() }
  })

  test("raises, resolves, and raises the same source across startup checks", async () => {
    const episodes: NotificationEpisodeInput[] = []
    for (const count of [1, 0, 2]) {
      const notice = createBugReportNotice({
        runCommand: async () => result(`${count}\n`),
        notify: async (episode) => { episodes.push(episode) },
        enabled: () => true,
        executionCwd: "/repo",
      })
      try {
        notice.start?.()
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      } finally { await notice.dispose() }
    }
    expect(episodes).toMatchObject([
      { type: "raise", occurrence: { sourceId: "development:bug-report-triage" } },
      { type: "resolve", sourceId: "development:bug-report-triage" },
      { type: "raise", occurrence: { sourceId: "development:bug-report-triage" } },
    ])
  })

  test.each([
    { condition: "disabled", count: 1 },
    { condition: "closing", count: 1 },
    { condition: "disabled", count: 0 },
    { condition: "closing", count: 0 },
  ])("does not publish count $count while $condition", async ({ condition, count }) => {
    let enabled = true
    const response = Promise.withResolvers<OwnedCommandResult>()
    const runCommand = mock<OwnedCommandRunner>(async () => response.promise)
    const notify = mock(async (_episode: NotificationEpisodeInput) => {})
    const notice = createBugReportNotice({ runCommand, notify, enabled: () => enabled, executionCwd: "/repo" })
    try {
      notice.start?.()
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (condition === "disabled") enabled = false
      else {
        notice.closeAdmission?.()
        expect(runCommand.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      }
      response.resolve(result(`${count}\n`))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(notify).not.toHaveBeenCalled()
    } finally {
      response.resolve(result("0\n"))
      await notice.dispose()
    }
  })
})
