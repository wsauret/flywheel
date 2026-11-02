import { expect, spyOn, test } from "bun:test"
import type { SessionToolSummaryReader, SessionToolSummarySnapshot, ToolHistorySummary } from "../../../../src/orchestration/module-seams.js"
import { createModuleToolHistoryReader } from "../../../../src/orchestration/session/module-tool-history.js"

function summary(toolUseId: string, totalToolCount = 0): ToolHistorySummary {
  return { toolUseId, totalToolCount, status: "interrupted", ownsSettlement: true }
}
async function unmeasured(run: ToolHistorySummary): Promise<ToolHistorySummary> {
  return run
}
function snapshot(position: number, entries: readonly ToolHistorySummary[], changed: readonly string[] = [], measure = unmeasured): SessionToolSummarySnapshot {
  return { position, summaries: new Map(entries.map((entry) => [entry.toolUseId, entry])), changedToolUseIds: new Set(changed), measure }
}

test("unchanged retained reads do not traverse history and advancing reads inspect only changed ids", async () => {
  const rows = new Map(Array.from({ length: 1_000 }, (_, index) => [`tool-${index}`, summary(`tool-${index}`)]))
  let state: SessionToolSummarySnapshot = { position: 10, summaries: rows, changedToolUseIds: new Set(), measure: unmeasured }
  const reader = createModuleToolHistoryReader([{ replay: async () => state }])
  const first = await reader.replay()
  const probes = [spyOn(rows, "keys"), spyOn(rows, "values"), spyOn(rows, "entries"), spyOn(rows, "forEach"), spyOn(rows, Symbol.iterator)]
  const reads = spyOn(rows, "get")
  const unchanged = await reader.replay()
  expect(unchanged.summaries).toBe(first.summaries)
  expect(unchanged.position).toBe(10)
  expect(unchanged.changedToolUseIds.size).toBe(0)
  expect(reads).not.toHaveBeenCalled()
  const changed = summary("tool-17", 2)
  rows.set("tool-17", changed)
  state = { position: 11, summaries: rows, changedToolUseIds: new Set(["tool-17"]), measure: unmeasured }
  const next = await reader.replay()
  expect(next.position).toBe(11)
  expect(next.summaries.get("tool-17")).toBe(changed)
  expect([...next.changedToolUseIds]).toEqual(["tool-17"])
  expect(reads.mock.calls).toEqual([["tool-17"]])
  for (const probe of probes) expect(probe).not.toHaveBeenCalled()
})

test.each([false, true])("ownership transfers are independent of catalog order (reverse=%s)", async (reverse) => {
  let left = snapshot(2, [summary("transfer")])
  let right = snapshot(5, [])
  const sources = [{ replay: async () => left }, { replay: async () => right }]
  const reader = createModuleToolHistoryReader(reverse ? sources.toReversed() : sources)
  expect((await reader.replay()).position).toBe(7)
  left = snapshot(3, [], ["transfer"])
  const transferred = summary("transfer", 9)
  right = snapshot(6, [transferred], ["transfer"])
  const next = await reader.replay()
  expect(next.position).toBe(9)
  expect(next.summaries.get("transfer")).toBe(transferred)
  expect([...next.changedToolUseIds]).toEqual(["transfer"])
})

test("a merged snapshot measures each summary through the owner that published it", async () => {
  const counted = summary("counted")
  const plain = summary("plain")
  const reader = createModuleToolHistoryReader([
    { replay: async () => snapshot(1, [counted], [], async (run) => ({ ...run, totalToolCount: 4 })) },
    { replay: async () => snapshot(1, [plain]) },
  ])
  const merged = await reader.replay()
  expect(await merged.measure(counted)).toEqual({ ...counted, totalToolCount: 4 })
  expect(await merged.measure(plain)).toBe(plain)
  const unowned = summary("unowned")
  expect(await merged.measure(unowned)).toBe(unowned)
})

test("a collision cannot publish partial history or disappear on a repeated replay", async () => {
  const original = summary("owned")
  let left = snapshot(1, [original])
  let right = snapshot(2, [])
  const reader = createModuleToolHistoryReader([{ replay: async () => left }, { replay: async () => right }])
  const published = await reader.replay()
  left = snapshot(2, [summary("owned", 3)], ["owned"])
  right = snapshot(3, [summary("owned", 7)], ["owned"])
  await expect(reader.replay()).rejects.toThrow("More than one module owns tool history owned")
  expect(published.summaries.get("owned")).toBe(original)
  expect(published.position).toBe(3)
  left = { ...left, changedToolUseIds: new Set() }
  right = { ...right, changedToolUseIds: new Set() }
  await expect(reader.replay()).rejects.toThrow("More than one module owns tool history owned")
  expect(published.summaries.get("owned")).toBe(original)
  right = snapshot(4, [], ["owned"])
  const recovered = await reader.replay()
  expect(recovered.position).toBe(6)
  expect(recovered.summaries.get("owned")?.totalToolCount).toBe(3)
})

test("a later source failure preserves consumed deltas until the whole replay can publish", async () => {
  const original = summary("first")
  let left = snapshot(1, [original])
  let fail = false
  const second: SessionToolSummaryReader = { async replay() {
    if (fail) throw new Error("source unavailable")
    return snapshot(3, [summary("second")])
  } }
  const reader = createModuleToolHistoryReader([{ replay: async () => left }, second])
  const published = await reader.replay()
  const changed = summary("first", 5)
  left = snapshot(2, [changed], ["first"])
  fail = true
  await expect(reader.replay()).rejects.toThrow("source unavailable")
  expect(published.summaries.get("first")).toBe(original)
  left = { ...left, changedToolUseIds: new Set() }
  fail = false
  const next = await reader.replay()
  expect(next.position).toBe(5)
  expect(next.summaries.get("first")).toBe(changed)
  expect([...next.changedToolUseIds]).toEqual(["first"])
})

test("a backwards source cursor leaves published summaries intact", async () => {
  const original = summary("kept")
  let state = snapshot(5, [original])
  const reader = createModuleToolHistoryReader([{ replay: async () => state }])
  const published = await reader.replay()
  state = snapshot(4, [summary("kept", 8)], ["kept"])
  await expect(reader.replay()).rejects.toThrow("position moved backwards")
  expect(published.summaries.get("kept")).toBe(original)
  state = snapshot(6, [summary("kept", 9)], ["kept"])
  expect((await reader.replay()).position).toBe(6)
})
