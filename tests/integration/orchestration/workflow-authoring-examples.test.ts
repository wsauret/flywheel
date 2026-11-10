import { afterEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { renderCapabilityText } from "../../../src/infra/capability-text.js"
import { join } from "node:path"
import { ToolActionSchema } from "../../../src/infra/workflow-types.js"
import { CANONICAL_WORKFLOW_FILE } from "../../../src/orchestration/agent-runtime/tools/workflow.js"
import {
  describeDefinitionRefusal,
  loadPathWorkflow,
  sessionWorkflowsDir,
  type PathWorkflowLaunch,
} from "../../../src/orchestration/workflow-host/path-workflow.js"
import type { WorkflowInputValue } from "../../../src/workflows/output-contract/compile.js"
import type { AccumulatedContext } from "../../../src/workflows/context-bundle/context.js"
import { attemptContextRecipient } from "../../../src/workflows/vm/attempt-runner.js"
import { runDefinition } from "../../../src/orchestration/workflow-host/definition-source.js"
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js"
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js"
import { authoredGuardrailLimits, compileWorkflowControl } from "../../../src/workflows/vm/compile.js"
import { SAMPLED_LAUNCH, sampleItems } from "../../../src/workflows/vm/list-expansion.js"
import type { ListNode } from "../../../src/workflows/vm/graph-types.js"
import { worstCaseAttempts } from "../../../src/workflows/vm/structural-admission.js"
import type { WorkflowVmHostDeps } from "../../../src/workflows/vm/host-types.js"
import { FieldMapSchema, type Field, type FieldMap } from "../../../src/workflows/output-contract/grammar.js"
import {
  MAX_ATTEMPTS_CEILING,
  WORKFLOW_INPUT_SOURCE_ID,
  agentRecords,
  allPhases,
  namedAgents,
  streamOf,
  type WorkflowDefinition,
} from "../../../src/workflows/workflow-schema.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { repoDefinitions } from "../../helpers/project-definitions.js"
import { mapHost, SqliteVmDriver } from "../../unit/workflows/vm/_sqlite-vm-driver.js"

const temporary = temporaryDirectories()
const revision = repoDefinitions().captureRevision()
const SKILL_DIR = join(import.meta.dir, "..", "..", "..", "src", "orchestration", "modules", "workflows", "definitions", "skills", "workflow-authoring")
const EXAMPLES_DIR = join(SKILL_DIR, "examples")
/** A file of the skill as an agent with every capability reads it: its capability markers rendered. */
const read = (path: string): string => renderCapabilityText(readFileSync(join(SKILL_DIR, path), "utf8"), () => true)

/** A chat that holds every tool but `subagent` and can dispatch every
 *  installed persona, as most chats can. Every agent gets the same tools, so
 *  each example launches here. */
const CHAT_AUTHORITY = { toolActions: new Set(ToolActionSchema.literals.filter((action) => action !== "task_subagent")), personas: new Set(revision.personas.keys()), unavailable: new Map<string, string>() }

/** Launch one file through the path pipeline, as an agent's file launches. */
async function launch(name: string, content: string): Promise<PathWorkflowLaunch> {
  const sessionDir = realpathSync(temporary("flywheel-workflow-authoring-"))
  mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true })
  writeFileSync(join(sessionWorkflowsDir(sessionDir), name), content)
  const launched = await loadPathWorkflow({ path: `scratch/workflows/${name}`, sessionDir, revision, authority: CHAT_AUTHORITY })
  if (!launched.ok) throw new Error(`${name} was refused: ${Object.values(describeDefinitionRefusal("", launched)).flat().join("\n")}`)
  return launched
}

const exampleLaunches = new Map<string, Promise<PathWorkflowLaunch>>()

/** Launch one example file once for the whole file. A launch verifies the
 *  workflow, which takes most of a second for a loop, so each case that
 *  needs an example reuses its one launch. */
function launchExample(name: string): Promise<PathWorkflowLaunch> {
  const known = exampleLaunches.get(name)
  if (known !== undefined) return known
  const launched = launch(name, read(`examples/${name}`))
  exampleLaunches.set(name, launched)
  return launched
}

/** A launch input that fills each list that a phase reads to its declared
 *  `max`, so the compiled control counts the worst case of a real launch. A
 *  list without `max` gets the items of a sampled launch. */
function fullLaunchInput(workflow: WorkflowDefinition, limits: ReturnType<typeof authoredGuardrailLimits>): WorkflowInputValue {
  const agents = resolveWorkflowAgents(workflow)
  const sampled = compileWorkflowControl(workflow, agents, { skills: revision.skills, personas: revision.personas }, limits, SAMPLED_LAUNCH)
  const lists = sampled.graph.nodes.filter((node): node is ListNode => node.kind === "list" && node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID)
  return Object.fromEntries(lists.map((list) => [list.source.field, sampleItems(list, list.width)]))
}

/** The code spans of one table cell. */
const codeSpans = (cell: string | undefined): string[] => [...(cell ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? "")

const drivers: SqliteVmDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

/** One value of a declared field. Each string names the agent record, the
 *  item, and the field, so a reader's context shows whose output reached
 *  it. A list key names only the record and the item index, so the agents
 *  of one phase over a list report the same keys, and a dedupe join keeps
 *  the first and drops the rest. */
type Synthetic = string | number | boolean | null | readonly Synthetic[] | { readonly [field: string]: Synthetic }

function syntheticValue(field: Field, marker: string, key?: string): Synthetic {
  switch (field.type) {
    case "string": return marker
    case "path": return marker
    case "number": return 1
    case "boolean": return true
    case "enum": return field.values?.[0] ?? null
    case "object": return syntheticFields(field.fields ?? {}, marker, key)
    case "list": return Array.from({ length: Math.min(field.max ?? 2, 2) }, (_, index) => field.of === undefined ? null : syntheticValue(field.of, `${marker}|${index}`, field.unique))
    default: throw new Error(`no synthetic value for a ${field.type} field`)
  }
}

function syntheticFields(fields: FieldMap, marker: string, key?: string): { readonly [field: string]: Synthetic } {
  const index = marker.split("|").at(-1)
  const step = marker.split("|")[0]
  return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, name === key ? `${step}|${index}` : syntheticValue(field, `${marker}|${name}`)]))
}

/** The keyed fields of an inline contract: the `input` or a record's `output`. */
function contractFields(contract: WorkflowDefinition["input"]): FieldMap {
  return Schema.decodeUnknownSync(FieldMapSchema)(typeof contract === "object" ? contract.fields ?? {} : {})
}

/** Each field name that a field map declares, at any depth. */
function fieldNames(fields: FieldMap): string[] {
  return Object.entries(fields).flatMap(([name, field]) => [name, ...fieldNames(field.fields ?? {}), ...fieldNames(field.of?.fields ?? {})])
}

/** The declared output fields of one agent record. */
function recordFields(workflow: WorkflowDefinition, definitionId: string): FieldMap {
  return contractFields(agentRecords(workflow).get(definitionId)?.keys.output)
}

/** A handoff that fills each declared output field of one agent record. */
function syntheticHandoff(workflow: WorkflowDefinition, definitionId: string, item: string) {
  return { summary: `${definitionId}|${item}|summary`, ...syntheticFields(recordFields(workflow, definitionId), `${definitionId}|${item}`) }
}

const EXAMPLES = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".workflow.yaml")).sort()

describe("the workflow-authoring examples", () => {
  it("ships the canonical example and each shape that the skill teaches", () => {
    expect(EXAMPLES).toEqual([
      "adversarial-quorum.workflow.yaml",
      "build-review-loop.workflow.yaml",
      "curated-variants.workflow.yaml",
      "dedupe-before-verify.workflow.yaml",
      "judge-panel.workflow.yaml",
      "lens-review.workflow.yaml",
      "loop-until-dry.workflow.yaml",
      "review-changes.workflow.yaml",
      "scout-and-survey.workflow.yaml",
    ])
    for (const name of EXAMPLES) expect(read("SKILL.md")).toContain(`examples/${name}`)
  })

  // Authors copy the skeleton of a conditional reference into their own file,
  // so a skeleton that the grammar no longer accepts teaches a refused launch.
  // A skeleton that shows only `phases` gets an id and a name to launch.
  it("launches the skeleton of each conditional reference", async () => {
    const references = readdirSync(join(SKILL_DIR, "references")).sort()
    const skeletons = references.flatMap((name) => [...read(`references/${name}`).matchAll(/```yaml\n([\s\S]*?)```/g)].map((match, index) => ({ name, index, text: match[1] ?? "" })))
    expect(skeletons.map(({ name }) => name)).toEqual(["implement-briefs.md", "review-briefs.md", "spec-briefs.md"])
    for (const { name, index, text } of skeletons) {
      const content = text.startsWith("id:") ? text : `id: skeleton-${index}\nname: Skeleton\n${text}`
      const launched = await launch(`${name.replace(".md", "")}-${index}.workflow.yaml`, content)
      expect(launched.verification.result).not.toBe("invalid")
    }
  }, 15_000)

  // Full state-machine exploration belongs to the integration lane.
  const LAUNCH_TIMEOUT_MS = 15_000
  // Authors copy the shipped examples, so an example that the launch must
  // repair or warn about teaches the repaired form.
  for (const name of EXAMPLES) {
    it(`launches ${name} as an agent's file with no warning that declares no attempt limit, and a full launch runs with its worst case`, async () => {
      const launched = await launchExample(name)
      const { workflow } = launched
      const limits = authoredGuardrailLimits(workflow)
      const control = compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: revision.skills, personas: revision.personas }, limits, fullLaunchInput(workflow, limits))

      expect(launched.verification.result).not.toBe("invalid")
      expect(launched.warnings).toEqual([])
      expect(workflow.guardrails).toBeUndefined()
      expect(control.guardrails.maxAttempts).toBe(worstCaseAttempts(control))
      expect(control.guardrails.maxAttempts).toBeLessThanOrEqual(MAX_ATTEMPTS_CEILING)
    }, LAUNCH_TIMEOUT_MS)
  }

  // Each later brief names data that an earlier agent wrote. An agent reads
  // only what its context holds: the output of the phase before it; in a
  // stream, its item and the agent that it follows; and each output that it
  // names in `reads`. So the run must put that data in front of the agent
  // that names it, and a structural check cannot prove it. Each row names
  // the records whose output each reader must see, `dropped` marks a reader
  // that must also see what a dedupe join dropped, and `seen in round` one
  // that must see what a later round of a repeat dropped as seen.
  const SEES = {
    "adversarial-quorum.workflow.yaml": {},
    "build-review-loop.workflow.yaml": { triage: ["quality", "elegance", "checks"], verify: ["build", "triage"], refix: ["verify"] },
    "curated-variants.workflow.yaml": { compare: ["variants"] },
    "dedupe-before-verify.workflow.yaml": { report: ["finders", "judge", "dropped"] },
    "judge-panel.workflow.yaml": { judges: ["drafts"], synthesize: ["drafts", "judges"] },
    "lens-review.workflow.yaml": { merge: ["security", "perf", "elegance"] },
    "loop-until-dry.workflow.yaml": { report: ["finds", "judge", "seen in round"] },
    "review-changes.workflow.yaml": { report: ["reviews", "checks"] },
    "scout-and-survey.workflow.yaml": { summarize: ["scout", "modules"] },
  } as const

  /** Run one example to completion with synthetic handoffs, and record the
   *  context of each attempt as the attempt runner builds it. */
  async function runExample(name: string) {
    const { workflow } = await launchExample(name)
    const agents = resolveWorkflowAgents(workflow)
    const vm = new SqliteVmDriver({ workflow, skills: revision.skills, input: fullLaunchInput(workflow, authoredGuardrailLimits(workflow)) })
    drivers.push(vm)
    await vm.initialize()
    const contexts = new Map<string, AccumulatedContext[]>()
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      const agent = agents.get(input.definitionId)
      if (agent === undefined) throw new Error(`no agent ${input.definitionId}`)
      const context = await vm.workflowStores().contextStore.getContext(attemptContextRecipient(input, agent))
      contexts.set(input.definitionId, [...contexts.get(input.definitionId) ?? [], context])
      const item = input.scope._tag === "item" ? input.scope.key : "phase"
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: syntheticHandoff(workflow, input.definitionId, item), reassessment: null }
    }
    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("completed")
    return { workflow, contexts }
  }

  // A dedupe or quorum join compares its keys as exact strings. A key that an
  // agent phrases, such as a slug or an invented id, differs between agents
  // and rounds, so duplicates survive and a repeat over a join never runs
  // dry. So each key field states an exact format, and each placeholder of
  // that format names a field that the file declares: a fact, not words.
  it("keys each dedupe and quorum join on a field whose description states an exact format of declared fields", async () => {
    const keys: { example: string; key: string; placeholders: string[]; undeclared: string[] }[] = []
    for (const name of EXAMPLES) {
      const { workflow } = await launchExample(name)
      const outputs = new Map([...agentRecords(workflow).keys()].map((id) => [id, recordFields(workflow, id)]))
      const declared = new Set([...fieldNames(contractFields(workflow.input)), ...[...outputs.values()].flatMap(fieldNames)])
      const listItem = (fields: FieldMap | undefined, list: unknown) => fields?.[String(list)]?.of?.fields
      for (const { phase } of allPhases(workflow)) {
        const phaseJoin = phase.join
        const params = phaseJoin?.with ?? {}
        if (phaseJoin === undefined || !(phaseJoin.reducer === "dedupe" || (phaseJoin.reducer === "quorum" && params.group_by !== undefined))) continue
        // A dedupe keys the items of a list of the phase that it joins: its
        // own output, or its first named agent's. A quorum groups the item of
        // each agent: an item of the list that the head of its stream reads.
        const joined = phase.agents === undefined ? phase.phase : namedAgents(phase)[0]?.agent ?? ""
        const over = streamOf(workflow, phase.phase)[0]?.over ?? ""
        const [source = "", list] = over.split(".")
        if (phaseJoin.reducer === "quorum" && source !== WORKFLOW_INPUT_SOURCE_ID && !outputs.has(source)) throw new Error(`${name}: no item contract for the quorum source ${over}`)
        const [fields, key] = phaseJoin.reducer === "dedupe"
          ? [listItem(outputs.get(joined), params.items), String(params.by)]
          : [listItem(source === WORKFLOW_INPUT_SOURCE_ID ? contractFields(workflow.input) : outputs.get(source), list), String(params.group_by)]
        const placeholders = codeSpans(fields?.[key]?.description).flatMap((span) => [...span.matchAll(/<([^>]+)>/gu)].map((match) => match[1] ?? ""))
        keys.push({ example: name, key, placeholders, undeclared: placeholders.filter((placeholder) => !declared.has(placeholder)) })
      }
    }

    expect(keys.length).toBeGreaterThan(0)
    for (const { example, key, placeholders, undeclared } of keys) {
      expect({ example, key, statesFormat: placeholders.length > 0, undeclared }).toEqual({ example, key, statesFormat: true, undeclared: [] })
    }
  })

  it("names what each example's readers must see", () => {
    expect(Object.keys(SEES)).toEqual(EXAMPLES)
  })

  for (const [name, sees] of Object.entries(SEES)) {
    it(`puts the output that each agent of ${name} names in front of that agent, and each read output only in front of its reader`, async () => {
      const { workflow, contexts } = await runExample(name)

      for (const [reader, sources] of Object.entries<readonly string[]>(sees)) {
        const seen = (contexts.get(reader) ?? []).map((context) => JSON.stringify(context))
        expect(seen.length).toBeGreaterThan(0)
        for (const context of seen) {
          for (const source of sources) {
            const marker = source === "dropped" ? "duplicate of" : source === "seen in round" ? source : `${source}|`
            expect({ reader, source, sees: context.includes(marker) }).toEqual({ reader, source, sees: true })
          }
          if (name === "review-changes.workflow.yaml" && reader === "report") {
            expect(context).toMatch(/reviews\|[^|]+\|findings\|0\|claim/u)
            expect(context).toContain("\"verdict\":\"confirmed\"")
          }
          // The dedupe join keeps only findings. A finding that it dropped at
          // a shared site, and the deviations that each reviewer classifies
          // in its summary, reach triage only in the whole reviewer handoffs.
          if (name === "build-review-loop.workflow.yaml" && reader === "triage") {
            for (const reviewer of ["quality", "elegance"]) expect(context).toContain(`"${reviewer}|phase|summary"`)
          }
        }
      }
      // Each repair updates the latest repair record: the verify of round 1
      // receives the fix, each later verify the refix before it, and each
      // refix the record that its verify copies forward.
      if (name === "build-review-loop.workflow.yaml") {
        const verify = (contexts.get("verify") ?? []).map((context) => JSON.stringify(context.priorHandoff))
        const [first, ...later] = verify
        expect(later.length).toBeGreaterThan(0)
        expect(first).toContain("\"fix|phase|summary\"")
        for (const prior of later) expect(prior).toContain("\"refix|phase|summary\"")
        const refix = (contexts.get("refix") ?? []).map((context) => JSON.stringify(context.priorHandoff))
        expect(refix.length).toBe(verify.length - 1)
        for (const prior of refix) expect(prior).toContain("\"verify|phase|files|0\"")
      }
      // Context is lean: each attempt receives exactly the outputs that its
      // record names, and an agent that names none, a sibling, or an item of
      // another phase receives none.
      for (const [definitionId, received] of contexts) {
        for (const context of received) {
          expect({ definitionId, reads: context.reads.map(({ id }) => id) }).toEqual({ definitionId, reads: [...agentRecords(workflow).get(definitionId)?.keys.reads ?? []] })
        }
      }
    })
  }

  it("resumes a paused reader with the context that it had before the pause", async () => {
    const { workflow } = await launchExample("judge-panel.workflow.yaml")
    const vm = new SqliteVmDriver({ workflow, skills: revision.skills, input: fullLaunchInput(workflow, authoredGuardrailLimits(workflow)) })
    drivers.push(vm)
    await vm.initialize()
    // Each host resolves the reader's agent from the definition that it runs:
    // the launch from the file, and the resume from the run's record.
    const answering = (definition: WorkflowDefinition, synthesize: AccumulatedContext[], pause: boolean): WorkflowVmHostDeps["attemptRunner"]["run"] => async (input, active) => {
      const agent = resolveWorkflowAgents(definition).get(input.definitionId)
      if (agent === undefined) throw new Error(`no agent ${input.definitionId}`)
      if (input.definitionId === "synthesize") {
        synthesize.push(await vm.workflowStores().contextStore.getContext(attemptContextRecipient(input, agent)))
        if (pause) {
          // A person's Stop pauses the run while the reader runs.
          queueMicrotask(() => { void launched.abort("Runtime shutdown") })
          await new Promise<void>((resolve) => { active.signal.addEventListener("abort", () => resolve(), { once: true }) })
          throw active.signal.reason
        }
      }
      const item = input.scope._tag === "item" ? input.scope.key : "phase"
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: syntheticHandoff(workflow, input.definitionId, item), reassessment: null }
    }
    const before: AccumulatedContext[] = []
    const launched = mapHost(vm, "launch", answering(workflow, before, true))
    expect((await launched.run()).kind).toBe("paused")

    const recorded = await runDefinition({ reader: asAsyncEventReadSurface(vm.store), sessionId: vm.sessionId, workflowDefinitionId: workflow.id })(vm.definitionRevision)
    if (!recorded.ok) throw new Error(recorded.reason)
    const after: AccumulatedContext[] = []
    expect((await mapHost(vm, "operator_resume", answering(recorded.workflow, after, false)).run()).kind).toBe("completed")

    expect(before[0]?.reads.map(({ id }) => id)).toEqual(["drafts"])
    expect(after.map(({ reads, priorHandoff }) => ({ reads, priorHandoff }))).toEqual(before.map(({ reads, priorHandoff }) => ({ reads, priorHandoff })))
  })

  it("is the definition that the workflow tool prompt shows as its canonical file", async () => {
    const example = await launchExample("review-changes.workflow.yaml")
    const prompt = await launch("prompt.workflow.yaml", CANONICAL_WORKFLOW_FILE)

    expect(prompt.definitionSha256).toBe(example.definitionSha256)
    expect(prompt.warnings).toEqual([])
  })
})

