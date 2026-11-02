import { describe, expect, test } from "bun:test"

import { createTimeline } from "../../release/lib/timeline.js"

describe("release suite timeline", () => {
  test("records nested labels on one clock and prints each step as it ends", async () => {
    const printed: string[] = []
    const timeline = createTimeline((line) => printed.push(line))
    const result = await timeline.time("candidate", async () => {
      const rep = timeline.scope("candidate").scope("startup-empty").scope("rep1")
      await rep.time("ready", () => 1)
      return rep.time("dispose", () => "done")
    })

    expect(result).toBe("done")
    expect(timeline.entries().map((entry) => entry.label)).toEqual([
      "candidate/startup-empty/rep1/ready",
      "candidate/startup-empty/rep1/dispose",
      "candidate",
    ])
    expect(printed.map((line) => line.split(" ")[1])).toEqual([
      "candidate/startup-empty/rep1/ready",
      "candidate/startup-empty/rep1/dispose",
      "candidate",
    ])
    // A scoped timeline shares the root clock, so the parent that started
    // first sorts first in the summary even though it finished last.
    const [ready, dispose, candidate] = timeline.entries()
    expect(candidate!.startedAtMs).toBeLessThanOrEqual(ready!.startedAtMs)
    expect(ready!.startedAtMs).toBeLessThanOrEqual(dispose!.startedAtMs)
    expect(timeline.summary().split("\n").map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "candidate",
      "candidate/startup-empty/rep1/ready",
      "candidate/startup-empty/rep1/dispose",
    ])
  })

  test("keeps the duration of a step that throws", async () => {
    const timeline = createTimeline(() => {})
    await expect(timeline.time("fails", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(timeline.entries().map((entry) => entry.label)).toEqual(["fails"])
  })
})
