import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { applyPatch, parsePatch } from "diff"
import { Schema } from "effect"
import * as yaml from "js-yaml"
import { loadWorkflowFile } from "../../../src/workflows/workflow-file.js"
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js"
import { verifyAuthoredWorkflow } from "../../../src/workflows/vm/verify.js"
import { allPhases } from "../../../src/workflows/workflow-schema.js"
import { repoDefinitions } from "../../helpers/project-definitions.js"

const root = resolve(import.meta.dir, "../../..")
const fixtures = resolve(root, "bench/chat-ab/workflow-authorship")
const retained = resolve(root, "tests/fixtures/retired-workflows/retained-project")
const read = (path: string): string => readFileSync(path, "utf8")

type Replacement = { from: string; to: string }
type BriefEntry = { workflow: string; phase: string; source: string; replacements: Replacement[]; appendSources: string[] }
type Ledger = { briefs: BriefEntry[]; entries: { original: string; replacement: string; reason: string }[] }
const ledger = (): Ledger => {
  const parsed: Ledger = JSON.parse(read(resolve(fixtures, "ledger.json")))
  return parsed
}
const RetainedCatalog = Schema.Struct({ name: Schema.String, description: Schema.String, use_when: Schema.String })

function body(path: string): string {
  const text = read(path)
  const end = text.indexOf("\n---\n", 4)
  if (!text.startsWith("---\n") || end < 0) throw new Error(`Missing frontmatter: ${path}`)
  return text.slice(end + 5)
}

function load(id: string) {
  const file = resolve(fixtures, "handcrafted", `${id}.workflow.yaml`)
  const loaded = loadWorkflowFile({
    file,
    content: read(file),
    location: { root: { kind: "directory", dir: dirname(file) }, path: basename(file) },
    provenance: { layer: "session", filePath: file },
    skills: repoDefinitions().captureRevision().skills,
  })
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics))
  return loaded.workflow
}

describe("frozen workflow authorship benchmark arms", () => {
  for (const id of ["implement", "qa", "debug"]) {
    it(`loads and verifies the self-contained ${id} workflow`, () => {
      const workflow = load(id)
      expect(workflow.retiredStepGrammar).toBeUndefined()
      const report = verifyAuthoredWorkflow(workflow, resolveWorkflowAgents(workflow), { skills: repoDefinitions().captureRevision().skills })
      expect(report.result).not.toBe("invalid")
      expect(report.findings).toContainEqual(expect.objectContaining({ name: "terminal_reachable", target: "completed" }))
    })
  }

  it("keeps retained brief bytes except the ledger replacements", () => {
    const workflows = new Map(["implement", "qa", "debug"].map((id) => [id, load(id)]))
    for (const entry of ledger().briefs) {
      let expected = body(resolve(retained, entry.source))
      for (const replacement of entry.replacements) {
        expect(expected.split(replacement.from).length, `${entry.source}: replacement must be unique`).toBe(2)
        expected = expected.replace(replacement.from, replacement.to)
      }
      for (const source of entry.appendSources) expected += `\n${body(resolve(retained, source))}`
      const workflow = workflows.get(entry.workflow)
      if (!workflow) throw new Error(`Unknown workflow ${entry.workflow}`)
      const phase = allPhases(workflow).find(({ phase: candidate }) => candidate.phase === entry.phase)?.phase
      expect(phase?.brief, `${entry.workflow}.${entry.phase}`).toBe(expected)
    }
    for (const [id, workflow] of workflows) {
      const mapped = ledger().briefs.filter((entry) => entry.workflow === id).map((entry) => entry.phase).sort()
      expect(mapped).toEqual(allPhases(workflow).filter(({ phase }) => phase.brief !== undefined).map(({ phase }) => phase.phase).sort())
    }
  })

  it("renders the human replacement ledger from the machine-readable entries", () => {
    const entries = ledger().entries.map((entry, index) => `## ${index + 1}\n\nOriginal: ${entry.original}\n\nReplacement: ${entry.replacement}\n\nReason: ${entry.reason}\n`).join("\n")
    expect(read(resolve(fixtures, "LEDGER.md"))).toBe(`# Frozen workflow replacement ledger\n\nThe machine-readable ledger.json owns these replacements. The fixture drift test checks this rendering and every inline brief.\n\n${entries}`)
  })

  for (const name of ["handcrafted", "handcrafted-forced", "authored-forced", "root-workflow-only", "no-learning-review"]) {
    it(`applies ${name} without source drift`, () => {
      const patch = read(resolve(fixtures, "patches", `${name}.patch`))
      const files = parsePatch(patch)
      const sourcePaths = name === "root-workflow-only"
        ? ["src/orchestration/agent-runtime/tools/tool-exposure-planner.ts"]
        : name === "no-learning-review"
          ? ["src/orchestration/modules/learning/config.ts"]
          : ["src/orchestration/modules/workflows/orchestration.ts", "src/orchestration/agent-runtime/tools/workflow.ts"].slice(0, name === "authored-forced" ? 1 : 2)
      expect(files.map((file) => file.oldFileName).sort()).toEqual(sourcePaths.map((path) => `a/${path}`).sort())
      for (const sourcePath of sourcePaths) {
        const source = read(resolve(root, sourcePath))
        const file = files.find((candidate) => candidate.oldFileName === `a/${sourcePath}`)
        if (!file) continue
        expect(file.newFileName).toBe(`b/${sourcePath}`)
        for (const hunk of file.hunks) {
          const expected = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1))
          expect(source.split("\n").slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.oldLines)).toEqual(expected)
        }
        const patched = applyPatch(source, file)
        expect(patched).not.toBe(false)
        if (typeof patched !== "string") throw new Error(`Cannot apply ${name} to ${sourcePath}`)
        if (sourcePath === "src/orchestration/modules/workflows/orchestration.ts") {
          // Both forced arms add one identical forcing sentence to the On reminder; otherwise every arm keeps HEAD's reminders.
          const reminders = "export const ORCHESTRATION_REMINDER"
          const forcing = name.endsWith("-forced") ? " You must launch a workflow for the task, even when the task looks small." : ""
          if (forcing) expect(patched.split(forcing)).toHaveLength(2)
          expect(patched.slice(patched.indexOf(reminders)).replace(forcing, "")).toBe(source.slice(source.indexOf(reminders)))
        }
      }
    })
  }

  for (const arm of ["handcrafted-forced", "authored-forced"]) {
    it(`applies the shared root restriction with ${arm} in either order`, () => {
      const restriction = parsePatch(read(resolve(fixtures, "patches/root-workflow-only.patch")))
      const forcing = parsePatch(read(resolve(fixtures, "patches", `${arm}.patch`)))
      const apply = (patches: ReturnType<typeof parsePatch>[]) => {
        const sources = new Map<string, string>()
        for (const patch of patches.flat()) {
          const path = patch.oldFileName!.slice(2)
          const source = sources.get(path) ?? read(resolve(root, path))
          const result = applyPatch(source, patch)
          if (result === false) throw new Error(`Cannot apply ${arm} with root restriction to ${path}`)
          sources.set(path, result)
        }
        return [...sources].sort(([left], [right]) => left.localeCompare(right))
      }
      expect(apply([restriction, forcing])).toEqual(apply([forcing, restriction]))
    })
  }

  it("copies the retained catalog wording into the frozen definitions and arm A patches", () => {
    for (const id of ["implement", "qa", "debug"]) {
      const original = Schema.decodeUnknownSync(RetainedCatalog)(yaml.load(read(resolve(retained, "workflows", `${id}.yaml`))))
      const workflow = load(id)
      expect(workflow.name).toBe(original.name)
      expect(workflow.description).toBe(original.description)
      const text = read(resolve(fixtures, "handcrafted", `${id}.workflow.yaml`))
      const useWhen = text.split("\n").filter((line) => line.startsWith("# ")).map((line) => line.slice(2)).join("\n")
      expect(useWhen).toBe(original.use_when.trimEnd())
      for (const name of ["handcrafted", "handcrafted-forced"]) {
        const patch = parsePatch(read(resolve(fixtures, "patches", `${name}.patch`))).find((file) => file.oldFileName === "a/src/orchestration/modules/workflows/orchestration.ts")
        if (!patch) throw new Error(`Missing orchestration patch in ${name}`)
        const patched = applyPatch(read(resolve(root, "src/orchestration/modules/workflows/orchestration.ts")), patch)
        expect(patched).not.toBe(false)
        expect(patched).toContain(original.description)
        expect(patched).toContain(original.use_when.trimEnd())
      }
    }
  })
})
