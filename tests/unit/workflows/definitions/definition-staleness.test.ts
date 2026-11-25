import { describe, expect, test } from "bun:test"
import { deriveDefinitionStalenessReport } from "../../../../src/workflows/definitions/override-staleness.js"
import { resolveDefinitionCandidates } from "../../../../src/infra/definitions/definition-resolution.js"

describe("definition override staleness", () => {
  test("derives every status from base and current default identities", () => {
    const status = (base: string | undefined, current: string) => deriveDefinitionStalenessReport([resolveDefinitionCandidates("persona", "reviewer", "agents/reviewer.md", [
      { kind: "valid", source: { path: "/project/.flywheel/agents/reviewer.md", layer: "project", identity: "mine" }, value: "mine" },
    ])], {
      files: { "agents/reviewer.md": { content: "bundled", overlayTarget: "agents/reviewer.md", sourceHash: current, baseDefaultHash: current } },
    }, base === undefined ? {} : { "/project/.flywheel/agents/reviewer.md": { acknowledged_default_hash: base } }).overrides.map((override) => override.status)

    expect(status("same", "same")).toEqual(["current"])
    expect(status("old", "new")).toEqual(["upstream-changed"])
    expect(status(undefined, "new")).toEqual(["upstream-changed"])
  })


  test("derives overrides and rejected diagnostics only from supplied resolutions", () => {
    const resolution = resolveDefinitionCandidates("persona", "reviewer", "agents/reviewer.md", [
      { kind: "rejected", source: { path: "/project/.flywheel/agents/reviewer.md", layer: "project" }, reason: "invalid tools" },
      { kind: "valid", source: { path: "/bundle/agents/reviewer.md", layer: "bundled", identity: "new" }, value: "bundled" },
    ])
    const report = deriveDefinitionStalenessReport([resolution], {
      files: { "agents/reviewer.md": { content: "bundled", overlayTarget: "agents/reviewer.md", sourceHash: "new", baseDefaultHash: "new" } },
    }, { "/project/.flywheel/agents/reviewer.md": { acknowledged_default_hash: "old" } })

    expect(report.overrides.map(({ family, id, path, status, valid }) => ({ family, id, path, status, valid }))).toEqual([
      { family: "persona", id: "reviewer", path: "/project/.flywheel/agents/reviewer.md", status: "upstream-changed", valid: false },
    ])
    expect(report.diagnostics).toEqual([{ path: "/project/.flywheel/agents/reviewer.md", layer: "project", message: "invalid tools" }])
  })

  test("a definition with no bundled counterpart is never an override", () => {
    const authored = resolveDefinitionCandidates("skill", "my-skill", "skills/my-skill/SKILL.md", [
      { kind: "valid", source: { path: "/home/.agents/skills/my-skill/SKILL.md", layer: "user", identity: "mine" }, value: "mine" },
    ])
    const report = deriveDefinitionStalenessReport([authored], { files: {} }, {
      "/home/.agents/skills/my-skill/SKILL.md": { acknowledged_default_hash: "stale" },
    })

    expect(report.overrides).toEqual([])
  })

  test("a name-matching override without a baseline reports upstream-changed", () => {
    const resolution = resolveDefinitionCandidates("persona", "reviewer", "agents/reviewer.md", [
      { kind: "valid", source: { path: "/project/.flywheel/agents/reviewer.md", layer: "project", identity: "mine" }, value: "mine" },
      { kind: "valid", source: { path: "/bundle/agents/reviewer.md", layer: "bundled", identity: "new" }, value: "bundled" },
    ])
    const report = deriveDefinitionStalenessReport([resolution], {
      files: { "agents/reviewer.md": { content: "bundled", overlayTarget: "agents/reviewer.md", sourceHash: "new", baseDefaultHash: "new" } },
    })

    expect(report.overrides.map(({ id, status, currentDefaultHash }) => ({ id, status, currentDefaultHash }))).toEqual([
      { id: "reviewer", status: "upstream-changed", currentDefaultHash: "new" },
    ])
  })

  test("a rejected standalone definition keeps its diagnostic but is not an override", () => {
    const resolution = resolveDefinitionCandidates("persona", "reviewer", "agents/reviewer.md", [
      { kind: "rejected", source: { path: "/project/.flywheel/agents/reviewer.md", layer: "project" }, reason: "invalid tools" },
    ])
    const report = deriveDefinitionStalenessReport([resolution], { files: {} })

    expect(report.overrides).toEqual([])
    expect(report.diagnostics).toEqual([{ path: "/project/.flywheel/agents/reviewer.md", layer: "project", message: "invalid tools" }])
  })
})
