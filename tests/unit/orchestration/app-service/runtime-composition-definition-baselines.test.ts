import { expect, test } from "bun:test"

test("runtime composition registers output before status and derives the status anchor from the output cursor", async () => {
  const source = await Bun.file("src/orchestration/app-service/frontend-projections.ts").text()
  const outputConstruction = source.indexOf('scope.own("output-projection"')
  const statusConstruction = source.indexOf('scope.own("status-projection"')

  expect(outputConstruction).toBeGreaterThan(-1)
  expect(statusConstruction).toBeGreaterThan(outputConstruction)
  expect(source).toContain("flushOutput: outputProjection.flush")
  expect(source).toContain('outputPosition: (sessionId) => bus.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) })')
})
