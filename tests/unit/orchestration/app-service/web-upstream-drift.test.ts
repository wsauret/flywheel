import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

interface UpstreamLedger {
  upstream: {
    repository: string
    revision: string
  }
  copies: ReadonlyArray<{
    source: string
    target: string
    startMarker: string
    endMarker: string
    sourceSha256: string
    substitutions: ReadonlyArray<{ from: string; to: string }>
  }>
}

const repositoryRoot = resolve(import.meta.dir, "../../../..")
const ledgerPath = resolve(
  repositoryRoot,
  "src/orchestration/app-service/web-serving/upstream-ledger.json",
)
const fixturePath = resolve(repositoryRoot, "tests/fixtures/upstream/web/upstream-slices.json")
const UpstreamFixtureSchema = Schema.Struct({
  revision: Schema.String,
  slices: Schema.Record(Schema.String, Schema.String),
})

// The ledger is repository-owned JSON, so its shape is trusted here.
const readLedger = (): Promise<UpstreamLedger> => Bun.file(ledgerPath).json()

// Audit the synced checkout separately with bun run scripts/check-web-upstream-drift.ts.
describe("local browser upstream ledger", () => {
  test("pins each reviewed source slice and its adapted target", async () => {
    const ledger = await readLedger()
    const fixture = Schema.decodeUnknownSync(UpstreamFixtureSchema)(await Bun.file(fixturePath).json())
    expect(ledger.upstream.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(fixture.revision).toBe(ledger.upstream.revision)
    expect(ledger.upstream.repository).toBe("https://github.com/openclaw/openclaw")
    expect(ledger.copies.length).toBeGreaterThan(0)

    for (const copy of ledger.copies) {
      const source = fixture.slices[copy.sourceSha256]
      expect(source, `${copy.source} pinned fixture`).toBeDefined()
      if (source === undefined) throw new Error(`missing pinned slice for ${copy.source}`)
      const start = source.indexOf(copy.startMarker)
      const end = source.indexOf(copy.endMarker, start)
      expect(start, `${copy.source} start marker`).toBeGreaterThanOrEqual(0)
      expect(end, `${copy.source} end marker`).toBeGreaterThan(start)
      const slice = source.slice(start, end + copy.endMarker.length)
      expect(createHash("sha256").update(slice).digest("hex"), `${copy.source} reviewed slice`).toBe(copy.sourceSha256)
      expect(await Bun.file(resolve(repositoryRoot, copy.target)).exists(), `${copy.target} exists`).toBe(true)
      expect(copy.substitutions.length, `${copy.target} records its adaptation`).toBeGreaterThan(0)
    }
  })
})
