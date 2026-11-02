import { describe, expect, it } from "bun:test"
import { coalesceRepeats, type Repeats } from "../../../src/infra/repeat-coalescer.js"

interface Report {
  readonly kind: "first" | "repeated"
  readonly key: string
  readonly detail: unknown
}

function recording(windowMs: number) {
  const reports: Report[] = []
  const coalescer = coalesceRepeats<number>({
    windowMs,
    first: (key, event) => { reports.push({ kind: "first", key, detail: event }) },
    repeated: (key, repeats: Repeats<number>) => { reports.push({ kind: "repeated", key, detail: { count: repeats.count, events: repeats.events } }) },
  })
  return { reports, coalescer }
}

describe("repeat coalescer", () => {
  it("records the first occurrence in full and counts the repeats of its window once", async () => {
    const { reports, coalescer } = recording(10)

    coalescer.observe("socket closed", 1)
    coalescer.observe("socket closed", 2)
    coalescer.observe("socket closed", 3)
    expect(reports).toEqual([{ kind: "first", key: "socket closed", detail: 1 }])

    await Bun.sleep(25)
    expect(reports).toEqual([
      { kind: "first", key: "socket closed", detail: 1 },
      { kind: "repeated", key: "socket closed", detail: { count: 2, events: [2, 3] } },
    ])
    coalescer.end()
  })

  it("closes a window with no repeats silently, so the next occurrence records in full again", async () => {
    const { reports, coalescer } = recording(5)

    coalescer.observe("stall", 1)
    await Bun.sleep(25)
    coalescer.observe("stall", 2)

    expect(reports).toEqual([
      { kind: "first", key: "stall", detail: 1 },
      { kind: "first", key: "stall", detail: 2 },
    ])
    coalescer.end()
  })

  it("keeps each condition apart", () => {
    const { reports, coalescer } = recording(60_000)

    coalescer.observe("a", 1)
    coalescer.observe("b", 2)
    coalescer.observe("a", 3)

    expect(reports.map((report) => [report.kind, report.key])).toEqual([["first", "a"], ["first", "b"]])
    coalescer.end()
  })

  it("reports the repeats at once when the condition ends, and records the next occurrence in full", () => {
    const { reports, coalescer } = recording(60_000)

    coalescer.observe("socket closed", 1)
    coalescer.observe("socket closed", 2)
    coalescer.end()
    coalescer.observe("socket closed", 3)

    expect(reports).toEqual([
      { kind: "first", key: "socket closed", detail: 1 },
      { kind: "repeated", key: "socket closed", detail: { count: 1, events: [2] } },
      { kind: "first", key: "socket closed", detail: 3 },
    ])
    coalescer.end()
  })

  it("ends one condition without touching another", () => {
    const { reports, coalescer } = recording(60_000)

    coalescer.observe("a", 1)
    coalescer.observe("a", 2)
    coalescer.observe("b", 3)
    coalescer.observe("b", 4)
    coalescer.end("a")

    expect(reports.map((report) => [report.kind, report.key])).toEqual([["first", "a"], ["first", "b"], ["repeated", "a"]])
    coalescer.end()
    expect(reports.map((report) => [report.kind, report.key]).at(-1)).toEqual(["repeated", "b"])
  })

  it("counts every repeat but keeps a bounded sample of them", () => {
    const { reports, coalescer } = recording(60_000)

    for (let event = 0; event <= 5_000; event += 1) coalescer.observe("flood", event)
    coalescer.end()

    const repeated = reports.at(-1)?.detail
    expect(repeated).toMatchObject({ count: 5_000 })
    if (typeof repeated !== "object" || repeated === null || !("events" in repeated) || !Array.isArray(repeated.events)) throw new Error("no sample")
    expect(repeated.events.length).toBeLessThan(5_000)
    expect(repeated.events[0]).toBe(1)
  })
})
