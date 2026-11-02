import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import * as yaml from "js-yaml"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { WORKFLOW_FILE_MAX_BYTES } from "../../../src/infra/workflow-yaml.js"
import { readPathWorkflow, sessionWorkflowsDir } from "../../../src/orchestration/workflow-host/path-workflow.js"
import { JOIN_EXPANSION_CAP_BYTES } from "../../../src/workflows/context-bundle/context.js"
import { envelopeKeys } from "../../../src/workflows/output-contract/grammar.js"
import { COMPLETION_AGENT_RESULTS_CAP_BYTES } from "../../../src/workflows/output-contract/workflow-completion.js"
import { REGISTERED_REDUCERS } from "../../../src/workflows/reducers/registry.js"
import { decodeWorkflowFile } from "../../../src/workflows/workflow-file.js"
import {
  MAX_ATTEMPTS_CEILING, WorkflowDefinitionSchema, agentRecords,
  type AgentRecordKeys, type PhaseOrRepeatByKind, type PhaseOrRepeatKind, type RepeatLoop,
} from "../../../src/workflows/workflow-schema.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { repoDefinitions } from "../../helpers/project-definitions.js"

const temporary = temporaryDirectories()
const SKILL_DIR = join(import.meta.dir, "..", "..", "..", "src", "agent-skills", "workflow-authoring")
const read = (path: string): string => readFileSync(join(SKILL_DIR, path), "utf8")

/** The rows of the first table after `heading`, each as its trimmed cells. */
function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.slice(markdown.indexOf(heading)).split("\n")
  const start = lines.findIndex((line) => line.startsWith("|"))
  const rows: string[][] = []
  for (let index = start + 2; lines[index]?.startsWith("|") === true; index++) {
    rows.push((lines[index] ?? "").split("|").slice(1, -1).map((cell) => cell.trim()))
  }
  return rows
}

const codeSpans = (cell: string | undefined): string[] => [...(cell ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "")

/** These tables fail type checking when the grammar gains a key. */
const ELEMENT_KEYS = {
  phase: { phase: true, if: true, over: true, label: true, votes: true, join: true, agents: true },
  repeat: { repeat: true, phases: true },
} as const satisfies { readonly [K in PhaseOrRepeatKind]: { readonly [Key in Exclude<keyof Required<PhaseOrRepeatByKind[K]>, keyof AgentRecordKeys>]: true } }
const RECORD_KEYS = {
  name: true, runs: true, brief: true, persona: true, output: true, dependencies: true, subagents: true, writes: true, reads: true, retry: true, model: true, effort: true,
} as const satisfies { readonly [Key in keyof Required<AgentRecordKeys>]: true }
const LOOP_KEYS = { while: true, max: true, stuck: true, each: true, reassess: true } as const satisfies { readonly [Key in keyof Required<Extract<RepeatLoop, { readonly while: string }>> | keyof Required<Extract<RepeatLoop, { readonly each: string }>>]: true }

describe("the workflow-authoring reference", () => {
  it("routes brief authors to conditional resources without expanding them into every prompt", () => {
    const grammar = read("SKILL.md")
    for (const name of ["implement", "spec", "review"]) {
      expect(grammar).toContain(`references/${name}-briefs.md`)
      expect(grammar).not.toContain(`{{ref:${name}-briefs}}`)
    }
  })

  it("lists every shipped element kind with exactly its keys, and lists the plan element as gated", () => {
    const rows = tableRows(read("SKILL.md"), "### Phase and repeat keys")
    const shipped = rows.filter(([, status]) => status === "shipped")
    const gated = rows.filter(([, status]) => status !== "shipped")
    expect(Object.fromEntries(shipped.map(([element, , keys]) => [codeSpans(element)[0], codeSpans(keys).sort()])))
      .toEqual(Object.fromEntries(Object.entries(ELEMENT_KEYS).map(([kind, keys]) => [kind, Object.keys(keys).sort()])))
    expect(gated.map(([element, status]) => [codeSpans(element)[0], status])).toEqual([["plan", "gated by Gate A"]])
    const planned = decodeWorkflowFile({ file: "plan.workflow.yaml", content: "id: planned\nname: Planned\nphases:\n  - plan: next\n" })
    expect(planned.ok).toBe(false)
  })

  it("lists every record key and every repeat key", () => {
    const grammar = read("SKILL.md")
    expect(tableRows(grammar, "### Record keys").flatMap(([key]) => codeSpans(key)).filter((key) => key !== "output.submit").sort()).toEqual(Object.keys(RECORD_KEYS).sort())
    expect(tableRows(grammar, "### Repeats").flatMap(([key]) => codeSpans(key)).map((key) => key.replace(/^repeat\./u, "")).sort()).toEqual(Object.keys(LOOP_KEYS).sort())
  })

  it("lists every registered reducer with exactly its parameters, and the body names each one", () => {
    const rows = tableRows(read("references/reducers.md"), "| Reducer |")
    const parameters = (cell: string | undefined) => (cell === "none" ? [] : (cell ?? "").split(",").map((part) => ({ name: codeSpans(part)[0], optional: part.includes("(optional)") })))
    expect(rows.map(([reducer, cell]) => ({ reducer: codeSpans(reducer)[0], parameters: parameters(cell) })))
      .toEqual(REGISTERED_REDUCERS.map(({ id, version, parameters: declared }) => ({ reducer: `${id}@${version}`, parameters: declared.map(({ name, optional }) => ({ name, optional })) })))
    for (const { id } of REGISTERED_REDUCERS) expect(read("SKILL.md")).toContain(`\`${id}\``)
  })

  it("loads command words and underscores as local names, but refuses them as workflow ids", async () => {
    const revision = repoDefinitions().captureRevision()
    const load = async (content: string) => {
      const sessionDir = realpathSync(temporary("flywheel-local-names-"))
      mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true })
      const result = await readPathWorkflow({ path: "scratch/workflows/names.workflow.yaml", savedContent: content, sessionDir, revision })
      if (!result.ok) throw new Error(JSON.stringify(result))
      return result
    }
    for (const name of ["help", "work_one", "1work"]) {
      const document = {
        id: "local-names",
        name: "Local names",
        input: { fields: { items: { type: "list", max: 1, of: { type: "string" } } } },
        phases: [{ phase: name, over: "input.items", name: "Work", brief: "Work." }],
      }
      const loaded = await load(yaml.dump(document))
      expect([...agentRecords(loaded.workflow).keys()]).toEqual([name])
      expect<unknown>(loaded.workflow.phases).toEqual(document.phases)
      if (name === "work_one") await expect(load(yaml.dump({ ...document, id: name }))).rejects.toThrow("dot-free lowercase slug")
    }
  })

  it("lists the envelope keys that a field cannot take", () => {
    const grammar = read("SKILL.md")
    for (const key of envelopeKeys) expect(grammar).toContain(`\`${key}\``)
  })

  it("shows each pattern of section 3 as a phases list that decodes", () => {
    const patterns = tableRows(read("SKILL.md"), "## 3. One workflow, one shape")
    expect(patterns.length).toBeGreaterThan(0)
    for (const [pattern, skeleton] of patterns) {
      const phases = codeSpans(skeleton).map((entry) => yaml.load(entry.replace(/^- /u, "")))
      const document = { id: "pattern", name: "Pattern", phases }
      expect({ pattern, decodes: Schema.decodeUnknownResult(WorkflowDefinitionSchema, { onExcessProperty: "error" })(document)._tag }).toEqual({ pattern, decodes: "Success" })
    }
  })

  it("states each limit as the code enforces it", () => {
    const limits = new Map(tableRows(read("SKILL.md"), "## 9. Limits, in numbers").map(([limit, value]) => [limit, value]))
    const decodes = (document: unknown): boolean => Schema.decodeUnknownResult(WorkflowDefinitionSchema)(document)._tag === "Success"
    const withEntry = <Entry,>(entry: Entry) => ({ id: "limits", name: "Limits", phases: [entry] })
    const range = <Entry,>(label: string, entry: (iterations: number) => Entry) => {
      const [low, high] = (limits.get(label) ?? "").split(" to ").map(Number)
      if (low === undefined || high === undefined) throw new Error(`no range for ${label}`)
      return [decodes(withEntry(entry(low - 1))), decodes(withEntry(entry(low))), decodes(withEntry(entry(high))), decodes(withEntry(entry(high + 1)))]
    }
    expect(limits.get("Worst case ceiling")).toBe(String(MAX_ATTEMPTS_CEILING))
    expect(range("`repeat` `max`", (rounds) => ({ repeat: { while: "work.next", max: rounds }, phases: [{ phase: "work", brief: "Work." }] }))).toEqual([false, true, true, false])
    expect(range("`retry` `max`", (attempts) => ({ phase: "work", brief: "Work.", retry: { max: attempts } }))).toEqual([false, true, true, false])
    expect(limits.get("Workflow file size")).toBe(`${WORKFLOW_FILE_MAX_BYTES} bytes`)
    expect(limits.get("Item handoff content after a join")).toBe(`${JOIN_EXPANSION_CAP_BYTES} bytes`)
    expect(limits.get("Agent results in your completion message")).toBe(`${COMPLETION_AGENT_RESULTS_CAP_BYTES} bytes`)
  })
})
