import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import type { GenerationMeasurement } from "../../../../src/orchestration/session/provider-request-audit-types.js"
import { sessionSummaryFact } from "../../../fixtures/session-summary-history.js"

type HistoricalRow = StoredFact | CorruptEventRowError

const directories: string[] = []

/** Removes the index directories of the case that just ran. Each test file
 *  that imports this module registers it with its own `afterEach`, because a
 *  hook registered here at module load would bind only to the first file that
 *  loaded the module. */
export function removeIndexDirectories(): void {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
}

export function sourceFor(initialFacts: readonly HistoricalRow[], pageSize = 2) {
  const facts = [...initialFacts]
  const source: AsyncEventReadSurface = {
    capturePosition: async () => facts.at(-1)?.position ?? 0,
    latestPosition: async (type) => {
      for (let index = facts.length - 1; index >= 0; index--) {
        const fact = facts[index]
        if (fact && (fact instanceof CorruptEventRowError ? fact.row.type : fact.type) === type) return fact.position
      }
      return 0
    },
    readPage: async (query, upper, after) => {
      const ceiling = upper ?? facts.at(-1)?.position ?? 0
      const available = facts.filter((fact) =>
        fact.position > after
        && fact.position <= ceiling
        && (query.types === undefined || query.types.includes(fact instanceof CorruptEventRowError ? fact.row.type : fact.type)))
      const page = available.slice(0, pageSize)
      return {
        facts: page,
        upperPosition: ceiling,
        continuationPosition: available.length > page.length ? page.at(-1)?.position ?? after : null,
        toolContent: { resolve: () => null },
      }
    },
  }
  return { source, append: (...next: HistoricalRow[]) => facts.push(...next) }
}

export function dbFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-summary-index-"))
  directories.push(directory)
  return path.join(directory, "session-summary.sqlite")
}

export async function readyBudget(file: string, facts: readonly HistoricalRow[], sessionId: string) {
  const index = acquireSessionSummaryIndex(file, sourceFor(facts).source)
  try {
    await index.replay()
    return (await index.readImmediate([sessionId])).summaries.get(sessionId)
  } finally {
    await index.dispose()
  }
}

/** A retirement of session `sessionId`'s representation at `position`. */
export const retired = (position: number, sessionId: string): StoredFact =>
  sessionSummaryFact(position, sessionId, "session.representation.retired", 1, { migrationId: "workflow-agent-session-ownership", aggregateId: `workflow:${sessionId}`, recovery: [] })

/** A recorded generation measurement. */
export const recorded = (outputTokens: number, durationMs: number): GenerationMeasurement => ({
  kind: "recorded", basis: "O200kBase", outputTokens, durationMs, measuredBlocks: 1, excludedBlocks: 0,
})

/** The stored summary of one provider stream that measured `generation`. */
export function streamSummaryFact(position: number, sessionId: string, generation: GenerationMeasurement): StoredFact {
  return { ...sessionSummaryFact(position, sessionId, "model.stream.summary.recorded", 3, {
    requestId: `request-${position}`, identity: { providerSessionKey: sessionId }, turn: 1, rawEventCount: 2, countsBySource: {}, countsByKind: {},
    interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
    watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 }, bigGapTransitions: [], generation,
  }), actor: "flywheel" }
}
