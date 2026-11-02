import { describe, expect, test } from "bun:test"

import { fileChangeDetail, removedDirectoryGroups } from "../../../../src/protocol/client/file-change-body.js"
import type { MutationEvidence } from "../../../../src/infra/mutation-evidence.js"

describe("fileChangeDetail", () => {
  test("names a bounded sample and exact remainder without reading a many-file manifest", () => {
    const mutationEvidence: MutationEvidence = {
      version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 1000000, entries: 5000 },
      applied: 4999, retainedFiles: 4999, notApplied: 1, omissions: 0, added: 4999, modified: 0, removed: 0,
      addedLines: 4999, removedLines: 0, conflictMarkers: 0,
      samples: [{ kind: "applied", path: "a.ts" }, { kind: "not_applied", path: "b.ts", reason: "changed" }],
    }
    expect(fileChangeDetail({ kind: "actual", mutationEvidence })).toBe("a.ts, b.ts, and 4998 more files (expand this result)")
  })
  test("names every file an actual change touched, in the change's order", () => {
    const detail = fileChangeDetail({
      kind: "actual",
      mutationEvidence: {
        version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 1000, entries: 3 },
        applied: 3, retainedFiles: 3, notApplied: 0, omissions: 0, added: 1, modified: 1, removed: 1,
        addedLines: 0, removedLines: 0, conflictMarkers: 0,
        samples: [
          { kind: "applied", path: "src/a.ts" },
          { kind: "applied", path: "src/b.ts" },
          { kind: "applied", path: "docs/c.md" },
        ],
      },
    })
    expect(detail).toBe("src/a.ts, src/b.ts, docs/c.md")
  })

  test("names a removed directory once in place of the files it held", () => {
    const detail = fileChangeDetail({
      kind: "actual",
      mutationEvidence: {
        version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 1000, entries: 457 },
        applied: 455, retainedFiles: 300, notApplied: 0, omissions: 155, added: 0, modified: 1, removed: 454,
        addedLines: 0, removedLines: 900, conflictMarkers: 0, removedDirectories: 1, filesInRemovedDirectories: 454,
        samples: [{ kind: "removed_directory", path: "scratch/dl", files: 454, bytes: 12_000_000 }, { kind: "applied", path: "notes.md" }],
      },
    })
    expect(detail).toBe("scratch/dl/ (454 files), notes.md")
  })

  test("names the files of a proposed change as they arrive, skipping one whose path has not", () => {
    const detail = fileChangeDetail({
      kind: "proposed",
      proposedDiff: { files: [
        { id: "f1", path: "src/a.ts", action: "update", hunks: [] },
        { id: "f2", action: "add", hunks: [] },
      ] },
    })
    expect(detail).toBe("src/a.ts")
  })

  test("has nothing to say for an advisory or an unavailable body", () => {
    expect(fileChangeDetail({ kind: "advisory", message: "not applicable" })).toBeUndefined()
    expect(fileChangeDetail({ kind: "unavailable" })).toBeUndefined()
  })
})

describe("removedDirectoryGroups", () => {
  test.each([
    ["is the removed directory", ".", [["/work/d/a.txt", "a.txt"], ["/work/d/sub/b.txt", "sub/b.txt"], ["/work/e.txt", "../e.txt"]]],
    ["is inside the removed directory", "..", [["/work/d/sub/a.txt", "a.txt"], ["/work/d/b.txt", "../b.txt"], ["/work/e.txt", "../../e.txt"]]],
  ] as const)("groups a removed directory's files when the execution directory %s", (_case, displayPath, files) => {
    const directory = { kind: "removed_directory" as const, path: "/work/d", displayPath, files: 2, bytes: 4 }
    const groups = removedDirectoryGroups([directory], files.map(([path, shown]) => ({ path, displayPath: shown })))
    expect(groups.directories.map(group => group.members)).toEqual([[0, 1]])
    expect(groups.ungrouped).toEqual([2])
  })
})
