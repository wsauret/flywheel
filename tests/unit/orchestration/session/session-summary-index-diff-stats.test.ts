import { afterEach, describe, expect, test } from "bun:test"
import { dbFile, sourceFor, removeIndexDirectories } from "./_summary-index-fixtures.js"
import { CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import type { MutationFileEvidence } from "../../../../src/infra/mutation-evidence.js"
import type { DiffStatSummary } from "../../../../src/orchestration/session/metadata/catalog/diff-stat-summary.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/metadata/catalog/session-summary-index.js"
import { sessionSummaryFact } from "../../../fixtures/session-summary-history.js"

afterEach(removeIndexDirectories)

const SHA = "a".repeat(64)

/** A `file.changed` of mutation `mutation-<position>`. */
function changedFact(position: number, changeKind: "created" | "modified" | "deleted", extra: { readonly lineStats?: DiffStatSummary } = {}): StoredFact {
  return sessionSummaryFact(position, "a", "file.changed", 2, {
    mutationId: `mutation-${position}`, path: `/repo/file-${position}.ts`, displayPath: `file-${position}.ts`, changeKind,
    before: changeKind === "created" ? null : { bytes: 1, sha256: SHA, preview: "" },
    after: changeKind === "deleted" ? null : { bytes: 1, sha256: SHA, preview: "" },
    toolUseId: "tool", ...extra,
  })
}

/** One applied edit as its writer records it: the change, then its v4 artifact. */
function mutationFacts(
  position: number,
  changeKind: "created" | "modified" | "deleted",
  addedLines: number,
  removedLines: number,
  patch: MutationFileEvidence["patch"] = { kind: "omitted", reason: "target_over_bound" },
): StoredFact[] {
  const mutationId = `mutation-${position}`
  const path = `/repo/file-${position}.ts`
  return [changedFact(position, changeKind), sessionSummaryFact(position + 1, "a", "file.artifact.recorded", 4, {
    mutationId, artifactId: `mutation:${mutationId}`, ownerKind: "tool_call", ownerId: "tool", artifactKind: "mutation_diff", path,
    evidence: {
      version: 1, mutationId, path, displayPath: `file-${position}.ts`,
      change: changeKind === "created" ? "added" : changeKind === "deleted" ? "removed" : "modified",
      before: changeKind === "created" ? null : { bytes: 1, sha256: SHA },
      after: changeKind === "deleted" ? null : { bytes: 1, sha256: SHA },
      retainedLines: 0, renderedLines: 0, omittedLines: 0, addedLines, removedLines, patch, conflictMarkers: false,
    },
  })]
}

async function diffStatsOf(facts: readonly StoredFact[]) {
  const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
  try {
    await index.replay()
    const summary = (await index.readImmediate(["a"])).summaries.get("a")
    expect(summary?.errors).toEqual({})
    return summary?.diffStats
  } finally {
    await index.dispose()
  }
}

describe("session summary index diff stats", () => {
  test("a session that creates a 10-line file, edits 3 lines of another, and deletes a 5-line file shows +10 ~3 -5", async () => {
    expect(await diffStatsOf([
      ...mutationFacts(1, "created", 10, 0),
      ...mutationFacts(3, "modified", 3, 3),
      ...mutationFacts(5, "deleted", 0, 5),
    ])).toEqual({ added: 10, modified: 3, removed: 5 })
  })

  test("a binary edit counts 0 and 0", async () => {
    expect(await diffStatsOf(mutationFacts(1, "modified", 0, 0, { kind: "unavailable" }))).toEqual({ added: 0, modified: 0, removed: 0 })
  })

  test("a session recorded with v3 artifacts and file.changed lineStats for one created file shows the same counts as before the change", async () => {
    expect(await diffStatsOf([
      changedFact(1, "created", { lineStats: { added: 4, modified: 0, removed: 0 } }),
      sessionSummaryFact(2, "a", "file.artifact.recorded", 3, {
        mutationId: "mutation-1", artifactId: "mutation:mutation-1", ownerKind: "runtime", ownerId: "operation",
        artifactKind: "mutation_diff", path: "/repo/file-1.ts", mutation: { version: 1, files: [], omissions: [] },
      }),
      changedFact(3, "modified"),
    ])).toEqual({ added: 4, modified: 0, removed: 0 })
  })

  test("a created file recorded with both lineStats and v4 evidence counts once", async () => {
    const [, artifact] = mutationFacts(1, "created", 10, 0)
    expect(await diffStatsOf([
      changedFact(1, "created", { lineStats: { added: 10, modified: 0, removed: 0 } }),
      artifact!,
      ...mutationFacts(3, "created", 2, 0),
    ])).toEqual({ added: 12, modified: 0, removed: 0 })
  })

  test("an unreadable artifact row hides the diff stat only when its version carries line counts", async () => {
    const corruptArtifact = (version: number) => new CorruptEventRowError({
      aggregateId: "session:a", seq: 3, type: "file.artifact.recorded", version, timestamp: 3,
      actor: "flywheel", sessionId: "a", eventId: `corrupt-v${version}`, position: 3, rawPayload: "{",
    }, "invalid JSON")
    const summaryOf = async (version: number) => {
      const index = acquireSessionSummaryIndex(dbFile(), sourceFor([changedFact(1, "created", { lineStats: { added: 4, modified: 0, removed: 0 } }), corruptArtifact(version)]).source)
      try {
        await index.replay()
        return (await index.readImmediate(["a"])).summaries.get("a")
      } finally {
        await index.dispose()
      }
    }

    const historical = await summaryOf(3)
    expect(historical?.errors).toEqual({})
    expect(historical?.diffStats).toEqual({ added: 4, modified: 0, removed: 0 })
    expect((await summaryOf(4))?.errors.diffStats).toContain("invalid JSON")
  })
})
