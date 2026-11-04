import { describe, expect, test } from "bun:test"

import { createProjectFiles } from "../../../../src/orchestration/app-service/project-files"

const walk = (entries: string[]) => {
  const calls: number[] = []
  let now = 0
  const service = createProjectFiles({
    projectRoot: "/work/project",
    now: () => now,
    listFiles: async ({ offset, limit }) => {
      calls.push(now)
      const page = entries.slice(offset, offset + limit)
      return { entries: page, truncated: offset + limit < entries.length, nextOffset: offset + limit, limit, traversalIssues: 0, entryLimitReached: false }
    },
  })
  return { service, calls, advance: (ms: number) => { now += ms } }
}

describe("project files for mentions", () => {
  test("lists project-relative paths, ranked by fuzzy match, never Flywheel's own state", async () => {
    const { service } = walk([
      "/work/project/src/app/composer.tsx",
      "/work/project/src/app/copy.ts",
      "/work/project/.flywheel/flywheel.sqlite",
      "/work/project/.git/HEAD",
      "/work/project/.github/workflows/ci.yml",
      "/work/project/README.md",
    ])
    // A bare query is the top level, folders first; nothing under .git or .flywheel.
    const top = await service.search({ query: "", limit: 10 })
    expect(top.entries).toEqual([{ path: ".github", directory: true }, { path: "src", directory: true }, { path: "README.md", directory: false }])
    expect(top.total).toBe(3)
    const ranked = await service.search({ query: "compo", limit: 10 })
    expect(ranked.entries[0]).toEqual({ path: "src/app/composer.tsx", directory: false })
    expect(ranked.entries.map((entry) => entry.path)).not.toContain("README.md")
    // A folder on a file's path is offered too, so a mention can name it.
    expect((await service.search({ query: "app", limit: 10 })).entries[0]).toEqual({ path: "src/app", directory: true })
    // A loose abbreviation that only the path matches is a weak match, and still offered.
    expect((await service.search({ query: "apcr", limit: 10 })).entries.map((entry) => entry.path)).toContain("src/app/composer.tsx")
    expect((await service.search({ query: "zzz", limit: 10 })).entries).toEqual([])
  })

  test("walks once for a burst of keystrokes and again once the listing is old", async () => {
    const { service, calls, advance } = walk(["/work/project/a.ts"])
    await Promise.all([service.search({ query: "a", limit: 5 }), service.search({ query: "b", limit: 5 })])
    await service.search({ query: "c", limit: 5 })
    expect(calls).toEqual([0])
    advance(6_000)
    await service.search({ query: "a", limit: 5 })
    expect(calls).toEqual([0, 6_000])
  })

  test("reads a large project in pages and joins them", async () => {
    const many = Array.from({ length: 2_500 }, (_, i) => `/work/project/f${String(i).padStart(4, "0")}.ts`)
    const { service, calls } = walk(many)
    const all = await service.search({ query: "", limit: 5 })
    expect(all.total).toBe(2_500)
    expect(all.entries.map((entry) => entry.path)).toEqual(["f0000.ts", "f0001.ts", "f0002.ts", "f0003.ts", "f0004.ts"])
    expect(calls.length).toBe(3)
  })
})
