import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findFactRetentionViolations, type FactRetentionRegistry } from "../../../scripts/check-fact-retention.js"

function withSource(source: string | undefined, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "fact-retention-"))
  try {
    mkdirSync(join(root, "src"), { recursive: true })
    if (source !== undefined) writeFileSync(join(root, "src", "facts.ts"), source)
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function registry(options: { policy: "history" | "retired"; prunable: readonly string[] }): FactRetentionRegistry {
  return {
    retention: (type) => type === "cache.retired" ? { policy: options.policy } : undefined,
    owner: () => "kernel",
    declaredTypes: () => ["cache.retired"],
    retiredTypes: () => options.policy === "retired" ? ["cache.retired"] : [],
    prunable: options.prunable,
    prefixes: () => undefined,
  }
}

describe("fact retention schema requirements", () => {
  test("allows a retired prunable declaration without an active schema", () => {
    withSource(undefined, (root) => {
      expect(findFactRetentionViolations(root, registry({ policy: "retired", prunable: ["cache.retired"] })).failures).toEqual([])
    })
  })

  test("still requires a schema for a non-retired declaration", () => {
    withSource(undefined, (root) => {
      expect(findFactRetentionViolations(root, registry({ policy: "history", prunable: [] })).failures).toEqual([
        'stale declaration: "cache.retired" is classified in src/infra/fact-retention-registry.ts but no defineFact/defineRuntimeFact schema defines it',
      ])
    })
  })

  test("requires retired declarations and prune membership to agree in both directions", () => {
    withSource('defineFact({ type: "cache.retired" })', (root) => {
      expect(findFactRetentionViolations(root, registry({ policy: "retired", prunable: [] })).failures).toContain(
        '"cache.retired" is declared retired but is missing from RETIRED_FACT_TYPES (src/orchestration/session/event-store-maintenance.ts)',
      )
      expect(findFactRetentionViolations(root, registry({ policy: "history", prunable: ["cache.retired"] })).failures).toContain(
        '"cache.retired" is in RETIRED_FACT_TYPES but the registry declares it "history"',
      )
      expect(findFactRetentionViolations(root, {
        ...registry({ policy: "retired", prunable: ["cache.retired"] }),
        retention: () => undefined,
        declaredTypes: () => [],
        retiredTypes: () => [],
      }).failures).toContain('"cache.retired" is in RETIRED_FACT_TYPES but has no retention declaration')
    })
  })
})
