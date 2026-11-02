import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { dismissFirstRunModals, selectExecutorPlateau, selectRetainedHeap, submitDraftAfterDeferredModals } from "../../release/scenarios/scenario-context"
import type { ReleaseMemoryEvidence } from "../../../src/infra/startup-trace.js"

describe("active executor memory evidence", () => {
  const owner: ReleaseMemoryEvidence = {
    runId: "run", role: "project-executor", pid: 17, cadenceMs: 100,
    samples: [1, 2, 3, 4].map((timestampMs) => ({ timestampMs, heapUsed: timestampMs * 1024 * 1024, rss: 10 * 1024 * 1024 })),
  }
  test("selects the serving executor within the shared plateau bounds", () => {
    expect(selectExecutorPlateau([owner], { runId: "run", pid: 17, startedAt: 2, endedAt: 3 })).toEqual({
      rssMb: 10, count: 2, firstTimestampMs: 2, lastTimestampMs: 3,
    })
  })
  test("rejects absent, mismatched, replaced, empty, or nonfinite owner evidence", () => {
    const plateau = { runId: "run", pid: 17, startedAt: 2, endedAt: 3 }
    for (const records of [
      [], [{ ...owner, pid: 18 }], [{ ...owner, role: "account" }],
      [{ ...owner, runId: "other" }], [owner, { ...owner, pid: 18 }],
      [{ ...owner, samples: [] }],
      [{ ...owner, samples: [{ timestampMs: 2, heapUsed: Number.NaN, rss: 1 }] }],
    ]) expect(() => selectExecutorPlateau(records, plateau)).toThrow()
  })
  test("uses one post-GC heap sample and records its offset from the true plateau midpoint", () => {
    expect(selectRetainedHeap({
      pid: 17, gcStartedAtMs: 22_500, timestampMs: 22_600, heapUsed: 2 * 1024 ** 2, rss: 10 * 1024 ** 2,
    }, { pid: 17, startedAt: 100, endedAt: 45_100 })).toEqual({
      heapMb: 2, count: 1, midpointOffsetMs: -100,
    })
  })
  test("rejects a GC or post-GC sample outside the plateau, a different executor, or nonfinite memory", () => {
    const sample = { pid: 17, gcStartedAtMs: 2, timestampMs: 3, heapUsed: 1024, rss: 2048 }
    for (const invalid of [
      { ...sample, gcStartedAtMs: 0 }, { ...sample, timestampMs: 5 }, { ...sample, pid: 18 },
      { ...sample, heapUsed: Number.NaN }, { ...sample, timestampMs: Number.NaN },
    ]) expect(() => selectRetainedHeap(invalid, { pid: 17, startedAt: 1, endedAt: 4 })).toThrow()
  })
})

const AUTH_LIST = "Settings › Auth\nenter connect\n← back  esc close"
const sleep = spyOn(Bun, "sleep")

afterAll(() => sleep.mockRestore())

afterEach(() => {
  sleep.mockReset()
})

describe("release benchmark startup settlement", () => {
  test.each(["baseline", "candidate"] as const)("settles the ordinary Auth list for %s", async (role) => {
    sleep.mockResolvedValue(undefined)
    const panes = [AUTH_LIST, "", "", "", ""]
    const keys: string[] = []
    let captures = 0
    await dismissFirstRunModals({
      capture: () => panes[captures++] ?? "",
      sendKeys: (...sent) => { keys.push(...sent) },
    }, role)
    expect(keys).toEqual(role === "baseline" ? ["Escape"] : [])
    expect(captures).toBe(role === "baseline" ? 5 : 4)
    expect(sleep.mock.calls.every(([milliseconds]) => milliseconds === 500)).toBe(true)
  })

  test.each([
    "Settings › Auth\nAllow paid API usage?\nenter confirm\n← back  esc close",
    "Settings › Models\nenter connect\n← back  esc close",
    "Settings › Auth\nSign in to continue\n← back  esc close",
  ])("does not dismiss another Settings or paid-use page: %s", async (pane) => {
    sleep.mockResolvedValue(undefined)
    const keys: string[] = []
    await dismissFirstRunModals({
      capture: () => pane,
      sendKeys: (...sent) => { keys.push(...sent) },
    }, "baseline")
    expect(keys).toEqual([])
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  test("restarts the existing quiet window after Auth and Usage recovery", async () => {
    sleep.mockResolvedValue(undefined)
    const panes = ["", "", AUTH_LIST, "", "", "Usage", "", "", "", ""]
    const keys: string[] = []
    let captures = 0
    await dismissFirstRunModals({
      capture: () => panes[captures++] ?? "",
      sendKeys: (...sent) => { keys.push(...sent) },
    }, "baseline")
    expect(keys).toEqual(["Escape", "Escape"])
    expect(captures).toBe(10)
    expect(sleep).toHaveBeenCalledTimes(9)
  })

  test("closes the baseline Auth list before submitting the visible draft", async () => {
    sleep.mockResolvedValue(undefined)
    const panes = [`${AUTH_LIST}\n> benchmark draft`, "> benchmark draft", ""]
    const keys: string[] = []
    let captures = 0
    await submitDraftAfterDeferredModals({
      capture: () => panes[captures++] ?? "",
      sendKeys: (...sent) => { keys.push(...sent) },
    }, "benchmark draft", "baseline")
    expect(keys).toEqual(["Escape", "Enter"])
    expect(captures).toBe(3)
    expect(sleep.mock.calls).toEqual([[50], [50]])
  })
})
