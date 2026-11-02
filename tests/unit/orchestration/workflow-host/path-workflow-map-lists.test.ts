import { describe, expect, it } from "bun:test"
import { describeDefinitionRefusal, loadPathWorkflow } from "../../../../src/orchestration/workflow-host/path-workflow.js"
import { canonicalWorkflowRecord } from "../../../../src/workflows/definition-records.js"
import { definitionAssets } from "../../../../src/workflows/definition-assets.js"
import { withLoadedContent } from "../../../../src/workflows/loader.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { authoredGuardrailLimits, compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { DEFAULT_COUNTED_LIST_MAX } from "../../../../src/workflows/workflow-schema.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { pathWorkflowFixtures, revision, write } from "./_path-workflow-fixtures.js"

const { refusal, session } = pathWorkflowFixtures()

describe("a list that a phase runs over without max or unique", () => {
  /** A phase over the launch input, whose list declares neither key. */
  const INPUT_MAP = `id: lens-sweep
name: Lens sweep
description: Review the change once through each lens.
input:
  fields:
    lenses: { type: list, description: The lenses., of: { type: string } }
phases:
  - phase: reviews
    over: input.lenses
    name: Review
    brief: Review the change through the lens in your item context.
`

  /** A scout lists modules without max or unique, a phase over the list
   *  audits each one and dedupes the findings, and a later phase checks each
   *  kept finding. */
  const STEP_MAP = `id: module-audit
name: Module audit
description: Audit each module that the scout lists and check each finding.
phases:
  - phase: scout
    name: Scout
    brief: List the modules.
    output:
      fields:
        modules: { type: list, description: The modules., of: { type: string } }
  - phase: audits
    over: scout.modules
    name: Audit one module
    brief: Audit the module in your item context.
    output:
      fields:
        findings:
          type: list
          max: 3
          description: The findings.
          of: { type: object, fields: { site: { type: string, description: "Exactly <path>:<line>." } } }
    join: { reducer: dedupe, with: { items: findings, by: site } }
  - phase: checks
    over: audits.kept
    name: Check one finding
    brief: Check the finding in your item context.
  - phase: report
    name: Report
    brief: Report the checked findings.
`

  async function launched(name: string, content: string) {
    const { sessionDir, dir } = session()
    const result = await loadPathWorkflow({ path: write(dir, name, content), sessionDir, revision, authority: fullAuthority() })
    if (!result.ok) throw new Error(Object.values(describeDefinitionRefusal("", result)).flat().join("\n"))
    return result
  }

  const compileFor = (workflow: Awaited<ReturnType<typeof launched>>["workflow"], input: Parameters<typeof compileWorkflowControl>[4]) =>
    compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: revision.skills }, authoredGuardrailLimits(workflow), input)

  it("launches a phase over an input list without max or unique, as wide as the launch input, each item known by its position", async () => {
    const file = await launched("lenses.workflow.yaml", INPUT_MAP)
    const lenses = Array.from({ length: 12 }, (_, index) => `lens ${index + 1}`)

    const control = compileFor(file.workflow, { lenses })

    expect(file.warnings).toEqual([])
    expect(control.graph.nodes.find(({ kind }) => kind === "list")).toMatchObject({ width: 12 })
    const branches = control.graph.nodes.flatMap((node) => node.kind === "item" ? [{ key: node.key, label: node.label }] : [])
    expect(branches.slice(0, 2)).toEqual([{ key: "01", label: "lens 1" }, { key: "02", label: "lens 2" }])
    expect(branches.map(({ key }) => key)).toEqual(branches.map(({ key }) => key).toSorted())
    expect(control.guardrails.maxAttempts).toBe(12)
  })

  it("holds an agent's list without max to the default max, warns at the list, and counts a bounded worst case through a later phase over a list", async () => {
    const file = await launched("audit.workflow.yaml", STEP_MAP)

    const scout = resolveWorkflowAgents(file.workflow).get("scout")
    const control = compileFor(file.workflow, null)

    expect(file.warnings).toEqual([{
      file: "scratch/workflows/audit.workflow.yaml",
      entry: 'Phase "scout"',
      keyPath: "phases.0.output.fields.modules",
      message: `a phase over a list, a repeat, or a join counts the list "modules", which declares no max, so the agent may report at most ${DEFAULT_COUNTED_LIST_MAX} items; declare max to change it`,
    }])
    expect(scout?.output.fields.find(({ key }) => key === "modules")).toMatchObject({ max: DEFAULT_COUNTED_LIST_MAX })
    // A run rebuilds the file from its record, which holds the list as the
    // author wrote it, and the load holds the step to the same default.
    const rebuilt = withLoadedContent(canonicalWorkflowRecord(file.workflow), { location: undefined, reader: definitionAssets, provenance: file.workflow.provenance! })
    expect(resolveWorkflowAgents(rebuilt).get("scout")?.output.sha256).toBe(scout?.output.sha256)
    expect(control.graph.nodes.find((node) => node.kind === "list" && node.outputId === "audits")).toMatchObject({ width: DEFAULT_COUNTED_LIST_MAX })
    // The scout, one audit for each module, one check for each kept finding
    // (each module reports at most 3), and the report.
    expect(control.guardrails.maxAttempts).toBe(1 + DEFAULT_COUNTED_LIST_MAX + DEFAULT_COUNTED_LIST_MAX * 3 + 1)
  })

  it("holds an agent's list that a repeat runs each item of to the default max, and warns at the list", async () => {
    const file = await launched("modules.workflow.yaml", `id: module-drain
name: Module drain
description: Change each module that the scout lists, one after another.
phases:
  - phase: scout
    name: Scout
    brief: List the modules.
    output:
      fields:
        modules: { type: list, description: The modules., of: { type: object, fields: { id: { type: string, description: The module. } } } }
  - repeat: { each: scout.modules }
    phases:
      - phase: change
        name: Change
        brief: Change the module in your item context.
`)

    expect(file.warnings.map(({ keyPath, message }) => [keyPath, message])).toEqual([[
      "phases.0.output.fields.modules",
      `a phase over a list, a repeat, or a join counts the list "modules", which declares no max, so the agent may report at most ${DEFAULT_COUNTED_LIST_MAX} items; declare max to change it`,
    ]])
    const control = compileFor(file.workflow, null)
    expect(control.graph.nodes.find(({ kind }) => kind === "repeat")).toMatchObject({ loop: { _tag: "each", width: DEFAULT_COUNTED_LIST_MAX } })
    expect(control.guardrails.maxAttempts).toBe(1 + DEFAULT_COUNTED_LIST_MAX)
  })

  it("holds the items list of a dedupe join without max to the default max, and bounds the kept list by it", async () => {
    const file = await launched("files.workflow.yaml", INPUT_MAP
      .replace("lenses: { type: list, description: The lenses., of: { type: string } }", "files: { type: list, description: The files., of: { type: string } }")
      .replace("    brief: Review the change through the lens in your item context.\n", `    brief: Review the change through the lens in your item context.
    output:
      fields:
        findings:
          type: list
          description: The findings.
          of: { type: object, fields: { site: { type: string, description: "Exactly <path>:<line>." } } }
`)
      .replace("    over: input.lenses", "    over: input.files")
      .concat("    join: { reducer: dedupe, with: { items: findings, by: site } }\n"))

    const reviews = compileFor(file.workflow, { files: ["a.ts", "b.ts", "c.ts"] }).graph.nodes.find((node) => node.kind === "list")

    expect(file.warnings.map(({ keyPath, message }) => ({ keyPath, message }))).toEqual([{
      keyPath: "phases.0.output.fields.findings",
      message: `a phase over a list, a repeat, or a join counts the list "findings", which declares no max, so the agent may report at most ${DEFAULT_COUNTED_LIST_MAX} items; declare max to change it`,
    }])
    expect(reviews?.kind === "list" ? reviews.reducer.contract["kept"] : undefined).toMatchObject({ max: 3 * DEFAULT_COUNTED_LIST_MAX, unique: "site" })
  })

  it("refuses a file whose defaulted lists give a worst case above the ceiling, and names the count", async () => {
    const { sessionDir, dir } = session()
    const refused = await refusal({ path: write(dir, "unbounded.workflow.yaml", STEP_MAP.replace("          max: 3\n", "")), sessionDir })

    expect(describeDefinitionRefusal("", refused).problems.join("\n")).toContain("4096")
  })

  it("keeps the declared max and unique key of a list that declares them", async () => {
    const file = await launched("declared.workflow.yaml", STEP_MAP.replace(
      "modules: { type: list, description: The modules., of: { type: string } }",
      "modules: { type: list, max: 4, unique: path, description: The modules., of: { type: object, fields: { path: { type: string, description: The path. } } } }",
    ))

    expect(file.warnings).toEqual([])
    expect(compileFor(file.workflow, null).graph.nodes.find((node) => node.kind === "list" && node.outputId === "audits")).toMatchObject({ width: 4, key: "path" })
  })
})
