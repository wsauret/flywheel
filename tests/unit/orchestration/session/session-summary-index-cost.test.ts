import { afterEach, describe, expect, test } from "bun:test"
import { acquireSessionSummaryIndex, sessionSummaryFactTypes } from "../../../../src/orchestration/session/metadata/catalog/session-summary-index.js"
import type { StoredFact } from "../../../../src/infra/store/event-store-types.js"
import { usageV4Fact } from "../../../fixtures/session-summary-history.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { dbFile, recorded, retired, removeIndexDirectories, sourceFor, streamSummaryFact } from "./_summary-index-fixtures.js"

afterEach(removeIndexDirectories)

describe("session summary index read cost", () => {
  test("one new stream summary costs one fact read, whatever the session count and history length", async () => {
    async function costOfOneSummary(sessionCount: number) {
      const facts: StoredFact[] = []
      for (let round = 0; round < 20; round++) {
        for (let session = 0; session < sessionCount; session++) facts.push(streamSummaryFact(facts.length + 1, `s${session}`, recorded(100, 1000)))
      }
      const history = sourceFor(facts, 10_000)
      const counter = countStateRequests(history.source)
      const index = acquireSessionSummaryIndex(dbFile(), counter.reader)
      try {
        await index.replay()
        counter.take()
        history.append(streamSummaryFact(facts.length + 1, "s0", recorded(100, 3000)))
        await index.replay()
        const requests = counter.take()
        expect((await index.readImmediate(["s0"])).summaries.get("s0")?.averageGenerationTokensPerSecond).toBe(2100 * 1000 / 23_000)
        return { requests: requests.length, facts: factsRead(requests) }
      } finally {
        await index.dispose()
      }
    }
    const few = await costOfOneSummary(3)
    expect(few.facts).toBe(1)
    expect(await costOfOneSummary(100)).toEqual(few)
  })

  test("a current index reads no retired representations and probes each summary fact type once per replay, whatever the retirement count", async () => {
    async function costOfCurrentReplays(retirements: number) {
      const facts = Array.from({ length: retirements }, (_, index) => retired(index + 1, `retired-${index}`))
      facts.push(usageV4Fact(retirements + 1, "a", "one"))
      const history = sourceFor(facts, 10_000)
      const counter = countStateRequests(history.source)
      const index = acquireSessionSummaryIndex(dbFile(), counter.reader, { shared: false })
      try {
        await index.replay()
        counter.take()
        for (let refresh = 0; refresh < 3; refresh++) await index.replay()
        const requests = counter.take()
        expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
        const methods = new Map<string, number>()
        for (const request of requests) methods.set(request.method, (methods.get(request.method) ?? 0) + 1)
        return { methods, facts: factsRead(requests) }
      } finally {
        await index.dispose()
      }
    }
    const none = await costOfCurrentReplays(0)
    expect(none).toEqual({ methods: new Map([["capturePosition", 3], ["latestPosition", 3 * sessionSummaryFactTypes().length]]), facts: 0 })
    expect(await costOfCurrentReplays(10_000)).toEqual(none)
  })

  test("a retirement after the watermark rebuilds the index once under the residual aggregate", async () => {
    const history = sourceFor([usageV4Fact(1, "run", "one")], 10)
    const counter = countStateRequests(history.source)
    const index = acquireSessionSummaryIndex(dbFile(), counter.reader, { shared: false })
    try {
      await index.replay()
      expect((await index.readImmediate(["run"])).summaries.get("run")?.budget?.totalCost).toBe(2)
      history.append(retired(2, "run"))
      counter.take()
      await index.replay()
      // The rebuild folds the usage again from position 0.
      expect(counter.take().filter((request) => request.method === "readPage" && request.args[2] === 0 && request.query?.types?.includes("model.usage.measured"))).toHaveLength(1)
      await index.replay()
      expect(counter.take().filter((request) => request.method === "readPage")).toEqual([])
      const read = await index.readImmediate(["run", "workflow:run"])
      expect(read.throughPosition).toBe(2)
      expect(read.summaries.get("run")?.budget?.totalCost).toBe(0)
      expect(read.summaries.get("workflow:run")?.budget?.totalCost).toBe(2)
    } finally {
      await index.dispose()
    }
  })
})
