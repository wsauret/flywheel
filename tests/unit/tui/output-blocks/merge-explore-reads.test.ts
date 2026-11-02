import { describe, expect, it } from "bun:test"
import type { ToolEntry } from "@infra/output-blocks"
import { getToolDisplay, resolveToolPresentation } from "@infra/tools/tool-display-registry.js"
import { mergeExploreReadRuns } from "@tui/output-blocks/tool-entry-helpers.js"

const CWD = "/workspace"
const READ_ERROR = "No such file or directory"

/** Every fixture goes through the shared resolver, so a merge test can never
 *  assert on a presentation the production path would not produce. */
interface ToolInput {
  readonly [key: string]: unknown
}

/** Merge fixtures never need a blocked row, whose status carries its own message. */
type FixtureStatus = Exclude<ToolEntry["status"], "blocked">

function entry(
  name: string,
  input: ToolInput,
  status: FixtureStatus = "completed",
  extra: { linkUri?: string } = {},
): ToolEntry {
  const base = {
    kind: "tool" as const,
    id: `${name}-${JSON.stringify(input)}`,
    name,
    presentation: resolveToolPresentation(name, input, CWD),
    action: getToolDisplay(name).action,
    timestamp: 0,
    ...extra,
  }
  if (status === "error") return { ...base, status, errorMessage: READ_ERROR }
  return { ...base, status }
}

const read = (path: string, status: FixtureStatus = "completed"): ToolEntry =>
  entry("read", { path: `${CWD}/${path}` }, status, { linkUri: `file://${CWD}/${path}` })
const list = (path: string): ToolEntry => entry("list", { path: `${CWD}/${path}` })
const search = (pattern: string): ToolEntry => entry("search", { pattern })
const loadSkill = (skillId: string, status: FixtureStatus = "completed"): ToolEntry =>
  entry("skill", { action: "load", skill_id: skillId }, status)

const rows = (entries: readonly ToolEntry[]): string[] =>
  entries.map((row) => `${row.presentation.name}|${row.presentation.detail}`)

describe("mergeExploreReadRuns", () => {
  it("merges a run of consecutive reads while preserving every basename and range", () => {
    const out = mergeExploreReadRuns([
      read("src/tui/components/composer.tsx:261-380"),
      read("src/tui/components/composer.tsx:381-410"),
      read("src/a.ts"),
    ])

    expect(out).toHaveLength(1)
    expect(out[0]?.name).toBe("read")
    expect(rows(out)).toEqual(["Read|composer.tsx:261-380, composer.tsx:381-410, a.ts"])
    expect(out[0]?.detailSegments?.map((segment) => segment.text).join("")).toBe("composer.tsx:261-380, composer.tsx:381-410, a.ts")
  })

  it("leaves a lone read untouched so it keeps its path and range", () => {
    const out = mergeExploreReadRuns([read("deep/a.ts:1-20")])

    expect(out).toHaveLength(1)
    expect(rows(out)).toEqual(["Read|deep/a.ts:1-20"])
  })

  it("does not merge across list/search boundaries and preserves order", () => {
    const out = mergeExploreReadRuns([
      read("a.ts"),
      read("b.ts"),
      list("src"),
      read("c.ts"),
      search("x"),
    ])

    expect(rows(out)).toEqual([
      "Read|a.ts, b.ts",
      "List|src",
      "Read|c.ts",
      'Search|"x"',
    ])
  })

  it("keeps source reads and skill loads in separate comma-separated rows", () => {
    const out = mergeExploreReadRuns([
      loadSkill("implementation"),
      loadSkill("typescript-bun"),
      read("a.ts"),
      read("b.ts"),
      loadSkill("flywheel-uat"),
    ])

    expect(rows(out)).toEqual([
      "Load Skill|implementation, typescript-bun",
      "Read|a.ts, b.ts",
      "Load Skill|flywheel-uat",
    ])
  })

  it("merges consecutive load rows across every non-error outcome and keeps one name", () => {
    const out = mergeExploreReadRuns([
      loadSkill("alpha", "pending"),
      loadSkill("beta", "completed"),
      loadSkill("gamma", "interrupted"),
    ])

    expect(rows(out)).toEqual(["Load Skill|alpha, beta, gamma"])
    // A member still running keeps the run live, the shared read-run rule.
    expect(out[0]?.status).toBe("streaming")
    expect(out[0]?.rawCount).toBe(3)
  })

  it("folds an errored read into the run with a concise failure tag", () => {
    const out = mergeExploreReadRuns([
      read("a.ts"),
      read("b.ts", "error"),
      read("c.ts"),
    ])

    expect(out).toHaveLength(1)
    expect(rows(out)).toEqual([`Read|a.ts, b.ts ${READ_ERROR}, c.ts`])
    expect(out[0]?.status).toBe("error")
    expect(out[0]?.status === "error" ? out[0].errorMessage : undefined).toBe(READ_ERROR)
    expect(out[0]?.rawCount).toBe(3)
    expect(out[0]?.detailSegments).toEqual([
      { text: "a.ts" },
      { text: ", " },
      { text: "b.ts" },
      { text: " " },
      { text: READ_ERROR, tone: "error" },
      { text: ", " },
      { text: "c.ts" },
    ])
  })

  it("folds a trailing in-flight read into the run instead of rendering it separately", () => {
    // Reproduces the flicker: a streaming read used to stay its own row until it
    // completed, then collapse into the run a frame later. It must fold immediately.
    const out = mergeExploreReadRuns([
      read("a.ts"),
      read("b.ts"),
      read("c.ts", "streaming"),
    ])

    expect(out).toHaveLength(1)
    expect(rows(out)).toEqual(["Read|a.ts, b.ts, c.ts"])
    expect(out[0]?.status).toBe("streaming")
  })

  it("folds an eager read before its filename arrives", () => {
    const out = mergeExploreReadRuns([
      read("a.ts"),
      read("b.ts"),
      entry("read", {}, "streaming"),
    ])

    expect(out).toHaveLength(1)
    expect(rows(out)).toEqual(["Read|a.ts, b.ts, "])
  })

  it("renders a lone errored read concisely instead of its raw error", () => {
    const out = mergeExploreReadRuns([read("deep/a.ts:1-20", "error")])

    expect(out).toHaveLength(1)
    expect(rows(out)).toEqual([`Read|a.ts:1-20 ${READ_ERROR}`])
    expect(out[0]?.status).toBe("error")
    expect(out[0]?.detailSegments).toEqual([
      { text: "a.ts:1-20" },
      { text: " " },
      { text: READ_ERROR, tone: "error" },
    ])
  })
})
