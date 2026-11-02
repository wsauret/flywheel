import { describe, expect, it } from "bun:test"
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { ToolActionSchema, type ToolAction } from "../../../../src/infra/workflow-types.js"
import {
  describeDefinitionRefusal,
  loadPathWorkflow,
  readPathWorkflow,
  saveWorkflowContent,
  sessionWorkflowsDir,
  stageWorkflowSource,
  verificationWarnings,
  type LaunchingSessionAuthority,
} from "../../../../src/orchestration/workflow-host/path-workflow.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { canonicalWorkflowRecord } from "../../../../src/workflows/definition-records.js"
import { WORKFLOW_FILE_MAX_BYTES } from "../../../../src/infra/workflow-yaml.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { decodeWorkflowFile, loadWorkflowFile } from "../../../../src/workflows/workflow-file.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { topNodeId, type WorkflowDefinition, type WorkflowPhase } from "../../../../src/workflows/workflow-schema.js"
import { buildDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { pathWorkflowFixtures, revision, write } from "./_path-workflow-fixtures.js"

const temporary = temporaryDirectories()
const { refusal, session } = pathWorkflowFixtures()

/** A self-contained workflow file with two inline briefs. */
const SURVEY = `id: survey-routes
name: Survey routes
description: Survey the routes and fix one.
phases:
  - phase: survey
    name: Survey
    brief: List every route in src/routes and report each one.
    output:
      summary: The routes found.
  - phase: fix
    name: Fix
    brief: Fix it.
`

/** SURVEY in the retired step grammar, which the loader converts. */
const STEP_SURVEY = `id: survey-routes
name: Survey routes
description: Survey the routes and fix one.
steps:
  survey:
    name: Survey
    instructions: List every route in src/routes and report each one.
    output:
      summary: The routes found.
  fix:
    name: Fix
    instructions: Fix it.
flow:
  - step: survey
  - step: fix
`

const authoredFixture = (name: string): string => readFileSync(join(import.meta.dir, "../../../fixtures/authored-workflows", name), "utf8")

/** A file with the mistakes that authors made in practice, each with one
 *  reading: a comma that splits a description in a flow mapping, a
 *  description on a list item, `summary` as a declared field, and a join
 *  that restates the default join. */
const AUTHORED = authoredFixture("phase-grammar/fix-and-review.workflow.yaml")

/** AUTHORED in the retired step grammar, which also states `reads` on a flow
 *  entry. */
const STEP_AUTHORED = authoredFixture("fix-and-review.workflow.yaml")

/** A file as an agent wrote it when every keyed field had to state a
 *  description. */
const DESCRIBED = authoredFixture("phase-grammar/described-review.workflow.yaml")

/** DESCRIBED in the retired step grammar, as a run launched it. */
const STEP_DESCRIBED = authoredFixture("described-review.workflow.yaml")

/** The output contract of a phase that the loaded definition holds. */
function phaseOutput(workflow: WorkflowDefinition, index: number): WorkflowPhase["output"] {
  const phase = workflow.phases[index]
  return phase !== undefined && "output" in phase ? phase.output : undefined
}

function authority(actions: readonly ToolAction[] = ToolActionSchema.literals, personas: readonly string[] = []): LaunchingSessionAuthority {
  return { toolActions: new Set(actions), personas: new Set(personas) }
}

describe("the path of a workflow file", () => {
  it("launches a file of the session directory by its relative or absolute path, with its hash and verifier report", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "survey.workflow.yaml", SURVEY)

    const relative = await loadPathWorkflow({ path: "scratch/workflows/survey.workflow.yaml", sessionDir, revision, authority: fullAuthority() })
    const absolute = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })

    if (!relative.ok || !absolute.ok) throw new Error("the file was refused")
    expect(relative.workflow.id).toBe("survey-routes")
    expect(relative.workflow.provenance).toMatchObject({ layer: "session", id: "survey-routes" })
    expect(relative.definitionSha256).toBe(hashDefinition(canonicalWorkflowRecord(relative.workflow)).sha256)
    expect(absolute.definitionSha256).toBe(relative.definitionSha256)
    expect(relative.file).toBe(file)
    expect(absolute.file).toBe(file)
    expect(relative.verification.result).not.toBe("invalid")
  })

  it("keeps the definition hash of a file without model keys, and records the keys outside the agent policy identity", async () => {
    const { sessionDir, dir } = session()
    const plain = await loadPathWorkflow({ path: write(dir, "plain.workflow.yaml", SURVEY), sessionDir, revision, authority: fullAuthority() })
    const keyed = await loadPathWorkflow({ path: write(dir, "keyed.workflow.yaml", SURVEY.replace("      summary: The routes found.\n", "      summary: The routes found.\n    model: mid\n    effort: low\n")), sessionDir, revision, authority: fullAuthority() })

    if (!plain.ok || !keyed.ok) throw new Error("a file was refused")
    expect(plain.definitionSha256).toBe("8c0b134695b1defbb6fd6fe59561ce9f7ed6eada44ea931a3bfae2953c25b4ef")
    expect(canonicalWorkflowRecord(keyed.workflow).phases[0]).toMatchObject({ phase: "survey", model: "mid", effort: "low" })
    expect(keyed.definitionSha256).not.toBe(plain.definitionSha256)
    const policy = (workflow: typeof plain.workflow) => buildDefinitionIdentity(workflow, resolveWorkflowAgents(workflow), { skills: revision.skills }).steps.find(({ stepId }) => stepId === "survey")?.policySha256
    expect(policy(keyed.workflow)).toBe(policy(plain.workflow))
  })

  it("keeps the hashes of a file whose fields state descriptions, and loads a file whose fields state none", async () => {
    const { sessionDir, dir } = session()
    const identity = (workflow: WorkflowDefinition) => hashDefinition(buildDefinitionIdentity(workflow, resolveWorkflowAgents(workflow), { skills: revision.skills })).sha256
    // The hashes come from the read that an Ask approval binds. Only the
    // launch runs the verifier, whose exploration of this list workflow
    // costs most of a second, so only the file that needs launch warnings launches.
    const described = await readPathWorkflow({ path: write(dir, "described.workflow.yaml", DESCRIBED), sessionDir, revision })
    const stepDescribed = await readPathWorkflow({ path: write(dir, "step-described.workflow.yaml", STEP_DESCRIBED), sessionDir, revision })
    const undescribed = await loadPathWorkflow({ path: write(dir, "undescribed.workflow.yaml", DESCRIBED.replace(/, description: [^}]*\}/gu, " }").replace(/^ *description: .*\n/gmu, "").replace("      fields:\n        findings:", "      fields:\n        summary: { type: string }\n        findings:")), sessionDir, revision, authority: fullAuthority() })

    if (!described.ok || !undescribed.ok || !stepDescribed.ok) throw new Error("a file was refused")
    expect(described.definitionSha256).toBe("a0c9d3485b74d48f218514d9ae7407690d167aa27dbfb7881e1f4ebf7011c287")
    // The identity names the advisor default since 2026-11-01; Resume adopts it through workflow-definition-identity-default-advisor-v1.
    expect(identity(described.workflow)).toBe("889798f5e43e9548765eb85d8e00757b7cec43976a73f727e90d3efc8122c396")
    // The stored step-grammar file converts to the same definition.
    expect(stepDescribed.definitionSha256).toBe(described.definitionSha256)
    expect(phaseOutput(undescribed.workflow, 1)).toEqual({ fields: { verdict: { type: "enum", values: ["confirmed", "refuted"] }, evidence: { type: "string" } } })
    expect(undescribed.warnings.map(({ keyPath, message }) => [keyPath, message])).toContainEqual(["phases.0.output.fields.summary", "summary is a key of the handoff envelope, which every handoff carries, so Flywheel dropped this field"])
  })

  it("converts a step-grammar file with a warning, and drops a retired kind and toolScoping with a warning at each key", async () => {
    const { sessionDir, dir } = session()
    const plain = await loadPathWorkflow({ path: write(dir, "plain.workflow.yaml", SURVEY), sessionDir, revision, authority: fullAuthority() })
    const steps = await loadPathWorkflow({ path: write(dir, "steps.workflow.yaml", STEP_SURVEY), sessionDir, revision, authority: fullAuthority() })
    const retired = await loadPathWorkflow({ path: write(dir, "retired.workflow.yaml", STEP_SURVEY.replace("    name: Survey\n", "    name: Survey\n    kind: check\n    toolScoping: { read: true }\n")), sessionDir, revision, authority: fullAuthority() })

    if (!plain.ok || !steps.ok || !retired.ok) throw new Error("a file was refused")
    const conversion = { file: "scratch/workflows/steps.workflow.yaml", keyPath: "(root)", message: "This file uses the retired step grammar, which Flywheel converted when it read it: steps and flow became phases. Rewrite it in the phase grammar; load the workflow-authoring skill." }
    expect(steps.warnings).toEqual([conversion])
    expect(retired.warnings.map(({ keyPath }) => keyPath)).toEqual(["(root)", "steps.survey.kind", "steps.survey.toolScoping"])
    expect(canonicalWorkflowRecord(retired.workflow).phases[0]).not.toHaveProperty("kind")
    expect([steps.definitionSha256, retired.definitionSha256]).toEqual([plain.definitionSha256, plain.definitionSha256])
  })

  // Remove after 2027-04-30 with the retired catalog-key conversion.
  it("launches a file with retired catalog keys and warns at each key", async () => {
    const { sessionDir, dir } = session()
    const content = `use_when: Investigate a problem.
confirmation_template: debug
requires_description: false
user-invocable: false
disable-model-invocation: true
${SURVEY}`
    const launched = await loadPathWorkflow({ path: write(dir, "retired-catalog.workflow.yaml", content), sessionDir, revision, authority: fullAuthority() })

    if (!launched.ok) throw new Error("the file was refused")
    expect(launched.warnings).toEqual(["use_when", "confirmation_template", "requires_description", "user-invocable", "disable-model-invocation"].map((keyPath) => ({
      file: "scratch/workflows/retired-catalog.workflow.yaml", keyPath,
      message: "this key is retired and does nothing; remove it",
    })))
    for (const { keyPath } of launched.warnings) expect(launched.workflow).not.toHaveProperty(keyPath)
  })

  it("refuses a name without the workflow extension, a file outside the session directory, and a missing file", async () => {
    const { sessionDir, dir } = session()
    write(dir, "survey.yaml", SURVEY)
    write(sessionDir, "outside.workflow.yaml", SURVEY)

    expect((await refusal({ path: join(dir, "survey.yaml"), sessionDir })).reason).toBe("its name must end in .workflow.yaml")
    // A path refusal names the workflow directory by its absolute path, which
    // the author passes to the write tool: that tool resolves a relative
    // path from the project directory, not from the session directory.
    expect((await refusal({ path: join(sessionDir, "outside.workflow.yaml"), sessionDir })).reason).toBe(`outside.workflow.yaml is not in this session's workflow directory ${dir}`)
    expect((await refusal({ path: "scratch/workflows/../../outside.workflow.yaml", sessionDir })).reason).toBe(`outside.workflow.yaml is not in this session's workflow directory ${dir}`)
    // A path outside the session directory has no relative name to show.
    expect((await refusal({ path: "scratch/workflows/../../../escape.workflow.yaml", sessionDir })).reason).toBe(`${join(sessionDir, "..", "escape.workflow.yaml")} is not in this session's workflow directory ${dir}`)
    expect((await refusal({ path: "scratch/workflows/absent.workflow.yaml", sessionDir })).reason).toBe(`no file exists at scratch/workflows/absent.workflow.yaml; write it in this session's workflow directory ${dir}`)
  })

  it("stages a project file as a saved copy, and launches a file of the workflow directory as it is", async () => {
    const { sessionDir, dir } = session()
    const project = realpathSync(temporary("path-workflow-project-"))
    write(project, "review.workflow.yaml", SURVEY)
    write(project, "review.yaml", SURVEY)
    const saved = write(dir, "survey-routes.workflow.yaml", SURVEY)

    const copied = stageWorkflowSource({ kind: "path", path: "review.workflow.yaml" }, sessionDir, project)
    expect(copied).toEqual({ path: join(realpathSync(dir), "survey-routes.workflow.yaml"), savedContent: SURVEY, copiedFrom: join(project, "review.workflow.yaml") })
    // A later edit of the original never changes the copy that runs.
    write(project, "review.workflow.yaml", SURVEY.replace("Survey routes", "Edited"))
    expect(readFileSync(join(dir, "survey-routes.workflow.yaml"), "utf8")).toBe(SURVEY)

    expect(stageWorkflowSource({ kind: "path", path: saved }, sessionDir, project)).toEqual({ path: saved })
    // A relative path that the working directory does not hold resolves from the session directory.
    expect(stageWorkflowSource({ kind: "path", path: "scratch/workflows/survey-routes.workflow.yaml" }, sessionDir, project)).toEqual({ path: join(sessionDir, "scratch", "workflows", "survey-routes.workflow.yaml") })
    expect(stageWorkflowSource({ kind: "path", path: "review.yaml" }, sessionDir, project)).toEqual({ error: `The workflow file ${join(project, "review.yaml")} cannot launch: its name must end in .workflow.yaml.` })
    expect(stageWorkflowSource({ kind: "path", path: "absent.workflow.yaml" }, sessionDir, project)).toEqual({ error: `No workflow file exists at ${join(sessionDir, "absent.workflow.yaml")}.` })
  })

  it("refuses a symbolic link that leaves the directory, a directory, and a file over the size limit", async () => {
    const { sessionDir, dir } = session()
    const outside = write(sessionDir, "target.workflow.yaml", SURVEY)
    symlinkSync(outside, join(dir, "linked.workflow.yaml"))
    mkdirSync(join(dir, "folder.workflow.yaml"))
    write(dir, "large.workflow.yaml", `${SURVEY}# ${"x".repeat(WORKFLOW_FILE_MAX_BYTES)}\n`)

    expect((await refusal({ path: "scratch/workflows/linked.workflow.yaml", sessionDir })).reason).toContain("which is outside this session's workflow directory")
    expect((await refusal({ path: "scratch/workflows/folder.workflow.yaml", sessionDir })).reason).toContain("is not a file")
    expect((await refusal({ path: "scratch/workflows/large.workflow.yaml", sessionDir })).reason).toContain(`more than the limit of ${WORKFLOW_FILE_MAX_BYTES}`)
  })

  it("launches a file whose name starts with two dots", async () => {
    const { sessionDir, dir } = session()
    write(dir, "..survey.workflow.yaml", SURVEY)

    const launched = await loadPathWorkflow({ path: "scratch/workflows/..survey.workflow.yaml", sessionDir, revision, authority: fullAuthority() })

    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    expect(launched.file).toBe(join(dir, "..survey.workflow.yaml"))
  })

  it("keeps nested workflow files, but follows no file link even within the directory", async () => {
    const { sessionDir, dir } = session()
    mkdirSync(join(dir, "nested"))
    const file = write(join(dir, "nested"), "survey.workflow.yaml", SURVEY)
    const launched = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })
    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    expect(launched.file).toBe(file)
    symlinkSync(file, join(dir, "linked.workflow.yaml"))
    expect((await refusal({ path: "scratch/workflows/linked.workflow.yaml", sessionDir })).reason).toContain(dir)
  })

  it("refuses a file of another session that a linked workflow or scratch directory reaches", async () => {
    const other = session()
    write(other.dir, "theirs.workflow.yaml", SURVEY)
    const linkedWorkflows = realpathSync(temporary("flywheel-path-workflow-"))
    mkdirSync(join(linkedWorkflows, "scratch"), { recursive: true })
    symlinkSync(other.dir, sessionWorkflowsDir(linkedWorkflows))
    const linkedScratch = realpathSync(temporary("flywheel-path-workflow-"))
    symlinkSync(join(other.sessionDir, "scratch"), join(linkedScratch, "scratch"))
    const linkedSession = join(temporary("flywheel-path-workflow-"), "session")
    symlinkSync(other.sessionDir, linkedSession, "dir")

    for (const sessionDir of [linkedWorkflows, linkedScratch, linkedSession]) {
      expect((await refusal({ path: "scratch/workflows/theirs.workflow.yaml", sessionDir })).reason).toContain("which is outside this session's workflow directory")
    }
  })
})

describe("the content of a workflow file", () => {
  it("refuses a linked workflow directory before writing content outside the session", () => {
    const sessionDir = realpathSync(temporary("flywheel-path-workflow-"))
    const outside = realpathSync(temporary("flywheel-path-workflow-outside-"))
    mkdirSync(join(sessionDir, "scratch"))
    symlinkSync(outside, sessionWorkflowsDir(sessionDir), "dir")
    expect(() => saveWorkflowContent(sessionDir, SURVEY)).toThrow()
    expect(readdirSync(outside)).toEqual([])
    const linkedSession = join(temporary("flywheel-path-workflow-"), "session")
    symlinkSync(outside, linkedSession, "dir")
    expect(() => saveWorkflowContent(linkedSession, SURVEY)).toThrow()
    expect(readdirSync(outside)).toEqual([])
  })

  it("replaces an oversized old file with the submitted content", () => {
    const { sessionDir, dir } = session()
    const file = join(dir, "survey-routes.workflow.yaml")
    const fd = openSync(file, "w")
    try { ftruncateSync(fd, 64 * 1024 * 1024) } finally { closeSync(fd) }
    expect(saveWorkflowContent(sessionDir, SURVEY)).toBe(file)
    expect(readFileSync(file, "utf8")).toBe(SURVEY)
    expect(readdirSync(dir)).toEqual(["survey-routes.workflow.yaml"])
  })

  it("refuses oversized content before creating the workflow directory or replacing a file", () => {
    const sessionDir = realpathSync(temporary("flywheel-path-workflow-"))
    const dir = sessionWorkflowsDir(sessionDir)
    const oversized = `${SURVEY}# ${"é".repeat(WORKFLOW_FILE_MAX_BYTES)}\n`
    expect(() => saveWorkflowContent(sessionDir, oversized)).toThrow(`more than the limit of ${WORKFLOW_FILE_MAX_BYTES}`)
    expect(existsSync(dir)).toBe(false)
    const file = saveWorkflowContent(sessionDir, SURVEY)
    expect(() => saveWorkflowContent(sessionDir, oversized)).toThrow()
    expect(readFileSync(file, "utf8")).toBe(SURVEY)
    expect(readdirSync(dir)).toEqual(["survey-routes.workflow.yaml"])
  })

  it.each([false, true])("decodes strictly and judges later stages only when excess keys are the sole shape defects (%s)", async (malformed) => {
    const { sessionDir, dir } = session()
    const content = SURVEY.replace("  - phase: survey\n", "  - phase: survey\n    retries: 3\n")
      .replace("name: Survey routes", malformed ? "name: 12" : "name: Survey routes")
      .concat("  - phase: summarize\n")
    const file = write(dir, "survey.workflow.yaml", content)
    const decoded = decodeWorkflowFile({ file, content, skills: revision.skills })
    if (decoded.ok) throw new Error("excess keys decoded")
    expect(decoded.recovered !== undefined).toBe(!malformed)
    if (decoded.recovered) expect(decoded.recovered.definition.phases[0]).not.toHaveProperty("retries")

    const refused = await refusal({ path: file, sessionDir })

    expect(refused.reason).toBe("the file is not valid")
    expect(refused.diagnostics).toContainEqual(expect.objectContaining({ file: "scratch/workflows/survey.workflow.yaml", keyPath: "phases.0.retries" }))
    expect(refused.diagnostics?.some(({ keyPath }) => keyPath === "phases.2.runs")).toBe(!malformed)
    if (malformed) expect(refused.diagnostics).toContainEqual(expect.objectContaining({ keyPath: "name", message: "Expected string, got 12" }))

    // An element with the keys of both kinds is the kind that its
    // discriminating key names; inside a repeat, every element is a phase.
    for (const nested of [false, true]) {
      const scan = malformed ? "{ phase: scan, over: 12 }" : `{ phase: scan, over: input.files, brief: Scan the file., join: { reducer: merge-all }${nested ? ", repeat: { each: input.files }" : ""} }`
      const entry = nested ? `{ repeat: { each: input.files }, phases: [${scan}] }` : malformed ? scan : `{ repeat: { each: input.files }, phase: scan, phases: [${scan}] }`
      const competing = SURVEY.replace(/phases:\n[\s\S]*$/u, `input:\n  fields:\n    files: { type: list, max: 3, unique: path, of: { type: object, fields: { path: { type: string } } } }\nphases:\n  - ${entry}\n`)
      const competingFile = write(dir, "competing.workflow.yaml", competing)
      const competingDecoded = decodeWorkflowFile({ file: competingFile, content: competing, skills: revision.skills })
      if (competingDecoded.ok) throw new Error("competing keys decoded")
      expect(competingDecoded.recovered !== undefined).toBe(!malformed)
      if (competingDecoded.recovered) {
        const repeat = competingDecoded.recovered.definition.phases[0]
        expect(repeat).toMatchObject({ repeat: { each: "input.files" }, phases: [{ phase: "scan", over: "input.files" }] })
        expect(repeat).not.toHaveProperty("phase")
        expect(repeat && "phases" in repeat ? repeat.phases[0] : undefined).not.toHaveProperty("repeat")
      }
      const competingRefusal = await refusal({ path: competingFile, sessionDir })
      const keyPath = nested || !malformed ? "phases.0.phases.0" : "phases.0"
      expect(competingRefusal.diagnostics).toContainEqual(expect.objectContaining({
        keyPath: malformed ? `${keyPath}.over` : `${keyPath}.join`,
        message: malformed ? "Expected string, got 12" : "join names unknown reducer \"merge-all\"",
      }))
      expect(competingRefusal.diagnostics?.some(({ message }) => message.includes("brief"))).toBe(false)
    }
  })

  it("refuses the retired bindings form, which a run cannot rebuild from its record", async () => {
    const { sessionDir, dir } = session()
    const retired = readFileSync(join(import.meta.dir, "../../../fixtures/retired-workflows/implement.yaml"), "utf8")
    for (const content of [
      retired,
      "id: retained\nname: Retained\nbindings:\n  fix: { skill: debug.fix }\nsteps:\n  - step: fix",
      "id: custom\nname: Custom\nbindings:\n  work: { skill: acme.missing }\nsteps:\n  - step: work",
    ]) {
      const file = write(dir, "retired.workflow.yaml", content)
      expect((await refusal({ path: file, sessionDir })).diagnostics).toEqual([{ file: "scratch/workflows/retired.workflow.yaml", keyPath: "(root)", message: "the file uses the retired bindings form; write it in the phase grammar" }])
    }
  })

  it("launches a file with retired keys and warns at each key path", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "retired-keys.workflow.yaml", `development-only: true\n${SURVEY}`)
    const steps = write(dir, "retired-step-keys.workflow.yaml", `development-only: true\n${STEP_SURVEY
      .replace("  survey:\n", "  survey:\n    selfReview: true\n    toolScoping: { read: true, ask_user: true }\n")}`)

    const launched = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })
    const stepLaunched = await loadPathWorkflow({ path: steps, sessionDir, revision, authority: fullAuthority() })

    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    if (!stepLaunched.ok) throw new Error(Object.values(describeDefinitionRefusal("", stepLaunched)).flat().join("\n"))
    expect(launched.warnings).toEqual([{ file: "scratch/workflows/retired-keys.workflow.yaml", keyPath: "development-only", message: "this key is retired and does nothing; remove it" }])
    expect(stepLaunched.warnings.map(({ keyPath }) => keyPath)).toEqual(["(root)", "development-only", "steps.survey.selfReview", "steps.survey.toolScoping"])
  })

  it("launches a file whose author's intent is unambiguous, normalizes it once, and warns at each repaired key", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "repaired.workflow.yaml", AUTHORED)
    const steps = write(dir, "repaired-steps.workflow.yaml", STEP_AUTHORED)

    const launched = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })
    const stepLaunched = await loadPathWorkflow({ path: steps, sessionDir, revision, authority: fullAuthority() })

    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    if (!stepLaunched.ok) throw new Error(Object.values(describeDefinitionRefusal("", stepLaunched)).flat().join("\n"))
    const repaired = launched.warnings.filter(({ message }) => message.includes("so Flywheel "))
    expect(repaired.map(({ keyPath }) => keyPath)).toEqual([
      "phases.0.output.fields.changed_files.of.description",
      "phases.0.output.fields.summary",
      "phases.1.join",
      "phases.1.output.fields.findings.of.fields.description.description",
      "phases.2.output.fields.findings.of.fields.change.description",
    ])
    expect(repaired[2]?.message).toBe("a phase of named agents and the last phase of a stream join with collect by default, so Flywheel dropped this join; remove join")
    expect(repaired[4]?.message).toBe("an unquoted comma split this text in a YAML flow mapping, so Flywheel rejoined it as \"What you changed, or why you changed nothing.\"; quote a text value that holds a comma")
    expect(phaseOutput(launched.workflow, 0)).toEqual({ summary: "The fix and the test.", fields: { changed_files: { type: "list", description: "A repository-relative path.", of: { type: "string" } } } })
    expect(launched.workflow.phases.slice(1).map((phase) => "reads" in phase ? phase.reads : undefined)).toEqual([["implement"], ["review"]])
    // The step-grammar copy repairs at its own key paths, also the reads of
    // its flow entries, and converts to the same definition.
    const stepRepaired = stepLaunched.warnings.filter(({ message }) => message.includes("so Flywheel "))
    expect(stepRepaired.map(({ keyPath }) => keyPath)).toEqual([
      "steps.implement.output.fields.changed_files.of.description",
      "steps.implement.output.fields.summary",
      "steps.review.output.fields.findings.of.fields.description.description",
      "steps.fix.output.fields.findings.of.fields.change.description",
      "flow.1.reads",
      "flow.2.reads",
    ])
    expect(stepRepaired[4]?.message).toBe("reads is a key of the step record in the retired step grammar, so Flywheel moved it to steps.review.reads; rewrite the file in the phase grammar")
    expect(stepLaunched.definitionSha256).toBe(launched.definitionSha256)
    const named = await loadPathWorkflow({ path: write(dir, "named.workflow.yaml", SURVEY.replace("  - phase: fix\n", "  - phase: fix\n    agents: [left, right]\n    join: { reducer: collect }\n")), sessionDir, revision, authority: fullAuthority() })
    if (!named.ok) throw new Error(Object.values(describeDefinitionRefusal("", named)).flat().join("\n"))
    expect(named.warnings.map(({ keyPath }) => keyPath)).toContain("phases.1.join")
  })

  it("refuses what it cannot read as one intent, and names the remedy and the line", async () => {
    const { sessionDir, dir } = session()
    const chain = write(dir, "chain.workflow.yaml", STEP_AUTHORED.replace("do: review, reads: [implement]", "do: [review, fix], reads: [implement]").replace("  - step: fix\n    reads: [reviews]\n", ""))
    const colon = write(dir, "colon.workflow.yaml", AUTHORED.replace("description: The site. }", "description: The site: one line. }"))
    // A join on a phase that a stream phase follows stands in the wrong place.
    const misplacedJoin = write(dir, "misplaced-join.workflow.yaml", AUTHORED.replace("    brief: Address each finding.\n    reads: [review]\n", "    over: review\n    brief: Address each finding.\n"))

    // A step-grammar file that the step grammar refused stays refused, at the
    // root of the file, with each decode problem.
    const chained = (await refusal({ path: chain, sessionDir })).diagnostics
    expect(chained?.map(({ keyPath }) => keyPath)).toEqual(["(root)"])
    expect(chained?.[0]?.message).toContain('at ["flow"][1]["reads"]')
    expect((await refusal({ path: colon, sessionDir })).diagnostics?.[0]?.message).toBe("The file is not valid YAML at line 53, column 58: missed comma between flow collection entries; quote a text value in a { } flow mapping that holds a comma or a colon")
    expect((await refusal({ path: misplacedJoin, sessionDir })).diagnostics?.map(({ keyPath, message }) => [keyPath, message])).toContainEqual(["phases.1.join", "join stands on a phase that a stream phase follows; put the join on the last phase of the stream"])
  })

  it("reports the contract problems of every agent and of the input in one refusal", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "contracts.workflow.yaml", AUTHORED
      .replace("of: { type: object, fields: { name:", "of: { type: object, optional: true, fields: { name:")
      .replace("          of:\n            type: object\n            fields:\n              site: { type: string, description: Exactly", "          of:\n            type: object\n            optional: true\n            fields:\n              site: { type: string, description: Exactly")
      .replace("              site: { type: string, description: The site. }", "              commands_run: { type: string, description: The commands. }"))

    expect((await refusal({ path: file, sessionDir })).diagnostics?.map(({ keyPath }) => keyPath)).toEqual(["input", "phases.1", "phases.2"])
  })

  it("refuses an id that is not a slug but accepts an id used by a past named workflow", async () => {
    const { sessionDir, dir } = session()
    const dotted = write(dir, "dotted.workflow.yaml", SURVEY.replace("id: survey-routes", "id: survey.routes"))
    const taken = write(dir, "taken.workflow.yaml", SURVEY.replace("id: survey-routes", "id: repair"))

    expect((await refusal({ path: dotted, sessionDir })).diagnostics).toContainEqual(expect.objectContaining({ keyPath: "id" }))
    expect((await loadPathWorkflow({ path: taken, sessionDir, revision, authority: fullAuthority() })).ok).toBe(true)
  })

  it("names every refused reads id at its phase and admits an empty reads list", async () => {
    const { sessionDir, dir } = session()
    const reads = (survey: string, fix: string) => SURVEY.replace("  - phase: survey\n", `  - phase: survey\n    reads: ${survey}\n`).replace("  - phase: fix\n", `  - phase: fix\n    reads: ${fix}\n`)
    const file = write(dir, "reads.workflow.yaml", reads("[fix]", "[missing]"))

    expect((await refusal({ path: file, sessionDir })).diagnostics).toEqual([
      { file: "scratch/workflows/reads.workflow.yaml", entry: 'Phase "survey"', keyPath: "phases.0.reads", message: 'reads names "fix", which does not finish before this phase starts; phases run in order, so name an earlier phase or agent' },
      { file: "scratch/workflows/reads.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1.reads", message: 'reads names "missing", which is no phase or agent of this workflow' },
    ])
    const empty = write(dir, "empty.workflow.yaml", reads("[]", "[survey]"))
    const launched = await loadPathWorkflow({ path: empty, sessionDir, revision, authority: fullAuthority() })
    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    expect(launched.workflow.phases.map((phase) => "reads" in phase ? phase.reads : undefined)).toEqual([[], ["survey"]])
  })

  it("allows command words as local phases and workflow ids", async () => {
    const { sessionDir, dir } = session()
    const local = SURVEY.replace("  - phase: survey\n", "  - phase: status\n")
    const file = write(dir, "local.workflow.yaml", local)
    const launched = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })
    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    expect(launched.workflow.phases[0]).toMatchObject({ phase: "status" })

    const named = write(dir, "command-word-id.workflow.yaml", local.replace("id: survey-routes", "id: help"))
    const commandWordId = await loadPathWorkflow({ path: named, sessionDir, revision, authority: fullAuthority() })
    if (!commandWordId.ok) throw new Error(Object.values(describeDefinitionRefusal("", commandWordId)).flat().join("\n"))
    expect(commandWordId.workflow.id).toBe("help")
  })

  it("refuses a brief, an output contract file, or a skill from outside the file, and names each key", async () => {
    const { sessionDir, dir } = session()
    const contract = write(dir, "relative.workflow.yaml", SURVEY.replace("    brief: Fix it.\n", "    brief: Fix it.\n    output: contracts/fix.json\n"))
    const brief = write(dir, "local-brief.workflow.yaml", SURVEY.replace("    brief: Fix it.\n", "    runs: fix-local\n"))
    const skill = write(dir, "skill.workflow.yaml", SURVEY.replace("    brief: Fix it.\n", "    runs: skill:fly.spec-create\n    output: { summary: The spec. }\n"))

    expect((await refusal({ path: contract, sessionDir })).diagnostics).toEqual([
      { file: "scratch/workflows/relative.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1.output", message: '"contracts/fix.json" names a contract file; write the output contract inline' },
    ])
    expect((await refusal({ path: brief, sessionDir })).diagnostics).toEqual([
      { file: "scratch/workflows/local-brief.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1.runs", message: 'runs brief "fix-local", which this file does not hold; write the brief inline, or run a brief that another phase of this file states' },
    ])
    expect((await refusal({ path: skill, sessionDir })).diagnostics).toEqual([
      { file: "scratch/workflows/skill.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1.runs", message: 'runs "skill:fly.spec-create"; a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [fly.spec-create]' },
    ])
  })

  it("refuses an output contract that names a shipped file, because only a brief may name one", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "bundled-output.workflow.yaml", SURVEY.replace("    brief: Fix it.\n", "    brief: Fix it.\n    output: bundled:contracts/fix.json\n"))

    expect((await refusal({ path: file, sessionDir })).diagnostics?.map(({ keyPath }) => keyPath)).toEqual(["phases.1.output"])
  })

  it("gives the same definition, hash, and compiled control as the file loader", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "survey.workflow.yaml", SURVEY)
    const loaded = loadWorkflowFile({ file, content: SURVEY, location: undefined, provenance: { layer: "session", filePath: file }, skills: revision.skills })
    if (!loaded.ok) throw new Error("the file did not load")
    const installed = loaded.workflow

    const launched = await loadPathWorkflow({ path: file, sessionDir, revision, authority: fullAuthority() })

    if (!launched.ok) throw new Error(Object.values(describeDefinitionRefusal("", launched)).flat().join("\n"))
    expect(canonicalWorkflowRecord(launched.workflow)).toEqual(canonicalWorkflowRecord(installed))
    expect(launched.definitionSha256).toBe(hashDefinition(canonicalWorkflowRecord(installed)).sha256)
    const compile = (workflow: typeof installed, skills: typeof revision.skills) => compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills })
    expect(compile(launched.workflow, revision.skills)).toEqual(compile(installed, revision.skills))
  })
})

describe("the authority of a workflow file", () => {
  it("refuses a file when the launching session lacks a tool that every agent gets, and needs no subagent tool", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "survey.workflow.yaml", SURVEY)

    const refused = await refusal({ path: file, sessionDir, authority: authority(["file_read", "search", "list", "shell_exec"]) })

    expect(refused.reason).toBe("its agents ask for more than the launching session holds")
    expect(refused.diagnostics).toEqual([{ file: "scratch/workflows/survey.workflow.yaml", keyPath: "(root)", message: "every agent gets the tools file_write, file_edit, which the launching session does not have" }])
    expect((await loadPathWorkflow({ path: file, sessionDir, revision, authority: authority(ToolActionSchema.literals.filter((action) => action !== "task_subagent")) })).ok).toBe(true)
  })

  it("refuses an agent that names a subagent the launching session cannot dispatch", async () => {
    const { sessionDir, dir } = session()
    const persona = [...revision.personas.keys()][0]
    if (!persona) throw new Error("the repository installs no persona")
    const file = write(dir, "survey.workflow.yaml", SURVEY.replace("    brief: List", `    subagents: [${persona}]\n    brief: List`))

    expect((await refusal({ path: file, sessionDir, authority: authority() })).diagnostics).toEqual([
      { file: "scratch/workflows/survey.workflow.yaml", entry: 'Phase "survey"', keyPath: "phases.0.subagents", message: `names ${persona}, which the launching session cannot dispatch` },
    ])
    expect((await loadPathWorkflow({ path: file, sessionDir, revision, authority: authority(ToolActionSchema.literals, [persona]) })).ok).toBe(true)
  })
})

describe("what a refusal tells the author", () => {
  const SKILL_POINTER = "Load the `workflow-authoring` skill if you have not, fix the file, and launch it again."

  it("ends every refusal of the path pipeline with the pointer to the workflow-authoring skill", async () => {
    const { sessionDir, dir } = session()
    write(dir, "survey.workflow.yaml", SURVEY)
    write(dir, "unknown-key.workflow.yaml", SURVEY.replace("  - phase: survey\n", "  - phase: survey\n    retries: 3\n"))

    const refusals = [
      await refusal({ path: join(dir, "survey.yaml"), sessionDir }),
      await refusal({ path: "scratch/workflows/absent.workflow.yaml", sessionDir }),
      await refusal({ path: "scratch/workflows/unknown-key.workflow.yaml", sessionDir }),
      await refusal({ path: "scratch/workflows/survey.workflow.yaml", sessionDir, authority: authority(["file_read"]) }),
    ]

    expect(refusals.map(({ recovery }) => recovery)).toEqual(refusals.map(() => SKILL_POINTER))
  })

  it("reports an id problem, a phase problem, and an escalation of one file together, each at its key, and no warning", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "several.workflow.yaml", `development-only: true\n${SURVEY
      .replace("id: survey-routes", "id: survey.routes")
      .replace("  - phase: survey\n", "  - phase: survey\n    reads: [absent]\n    writes: [{ id: evidence, lifetime: durable, supersedes: [absent] }]\n")
      .concat("  - phase: publish\n    brief: Publish.\n    if: absent\n")}`)

    const refused = await refusal({ path: file, sessionDir, authority: authority(["file_read", "search", "list"]) })

    expect(refused.reason).toBe("the file is not valid, and its agents ask for more than the launching session holds")
    expect(refused.diagnostics).toEqual([
      expect.objectContaining({ file: "scratch/workflows/several.workflow.yaml", keyPath: "id" }),
      expect.objectContaining({ keyPath: "phases.0.reads", message: expect.stringContaining('reads names "absent"') }),
      expect.objectContaining({ entry: 'Phase "publish"', keyPath: "phases.2.if", message: 'if names "absent", which is no phase or agent of this workflow' }),
      expect.objectContaining({ keyPath: "phases.0.writes.0.supersedes", message: expect.stringContaining("remove the target or declare the intended durable artifact") }),
      expect.objectContaining({ keyPath: "(root)", message: expect.stringContaining("every agent gets the tools") }),
    ])
  })

  it("reports an escalation beside an id problem of a file that is otherwise valid", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "taken.workflow.yaml", SURVEY.replace("id: survey-routes", "id: survey.routes"))

    expect((await refusal({ path: file, sessionDir, authority: authority(["file_read", "search", "list"]) })).diagnostics?.map(({ keyPath }) => keyPath))
      .toEqual(["id", "(root)"])
  })

  it("states only what the kind of a phases element needs", async () => {
    const { sessionDir, dir } = session()
    const file = write(dir, "kinds.workflow.yaml", `id: kinds
name: Kinds
input:
  fields:
    files: { type: list, max: 3, unique: path, description: The files., of: { type: object, fields: { path: { type: string, description: The path. } } } }
phases:
  - repeat: { each: input.files }
  - phase: again
    brief: Read the file.
    colour: red
`)

    expect((await refusal({ path: file, sessionDir })).diagnostics).toEqual([
      { file: "scratch/workflows/kinds.workflow.yaml", keyPath: "phases.0.phases", message: "Missing key" },
      { file: "scratch/workflows/kinds.workflow.yaml", entry: 'Phase "again"', keyPath: "phases.1.colour", message: "Unexpected key with value \"red\"" },
    ])
  })

  it.each([false, true])("reports an unknown reducer beside every independent decode and phase problem (%s)", async (several) => {
    const { sessionDir, dir } = session()
    const content = `${several ? "colour: red\n" : ""}id: join-check
name: Join check
input:
  fields:
    files: { type: list, max: 3, unique: path, description: The files., of: { type: object, fields: { path: { type: string, description: The path. } } } }
phases:
  - phase: reads
    over: input.files
    name: Read one file
    brief: Read the file.
    output:
      fields:
        findings: { type: list, max: 3, of: { type: string } }
    join: { reducer: merge-all }
${several ? "  - phase: summarize\n    brief: Summarize.\n    writes: [{ id: notes, lifetime: transient }, { id: kept, lifetime: durable, supersedes: [] }]\n" : ""}
`
    const file = write(dir, "join.workflow.yaml", content)

    const diagnostics = [
      ...(several ? [expect.objectContaining({ keyPath: "colour", message: "Unexpected key with value \"red\"" })] : []),
      ...(several ? [expect.objectContaining({ entry: 'Phase "summarize"', keyPath: "phases.1", message: "mixes transient and durable write lifetimes" })] : []),
      { file: "scratch/workflows/join.workflow.yaml", entry: 'Phase "reads"', keyPath: "phases.0.join", message: "join names unknown reducer \"merge-all\"" },
    ]
    expect((await refusal({ path: file, sessionDir })).diagnostics).toEqual(diagnostics)
    const loaded = loadWorkflowFile({
      file: "scratch/workflows/join.workflow.yaml", content, location: undefined,
      provenance: { layer: "session", filePath: file }, skills: revision.skills,
    })
    if (loaded.ok) throw new Error("invalid workflow loaded")
    expect(loaded.diagnostics).toEqual(diagnostics)
  })

  it.each([false, true])("reports each independent list defect once and skips phases whose list failed (%s)", async (semantic) => {
    const { sessionDir, dir } = session()
    const content = `id: maps-check
name: Maps check
input:
  fields:
    files: { type: list, max: 3, unique: path, of: { type: object, fields: { path: { type: string } } } }
phases:
  - phase: first
    over: input.missing
    brief: Review the file.
  - phase: dependent
    over: first.items
    brief: Review the file.
  - phase: second
    over: input.files
    label: missing
    brief: Review the file.
`
    const file = write(dir, "maps.workflow.yaml", semantic ? content
      .replace("over: input.missing", "over: input.files\n    label: missing")
      .replace("    over: first.items\n", "    over: first\n")
      .replace("    label: missing\n    brief: Review the file.\n$", "    brief: Review the file.\n    join: { reducer: merge-all }\n")
      .replace(/    label: missing\n    brief: Review the file\.\n$/u, "    brief: Review the file.\n    join: { reducer: merge-all }\n") : content)

    expect((await refusal({ path: file, sessionDir })).diagnostics).toEqual(semantic ? [
      expect.objectContaining({ entry: 'Phase "first"', keyPath: "phases.0.label", message: "label \"missing\" is not a string field of the items of \"input.files\"" }),
      expect.objectContaining({ entry: 'Phase "second"', keyPath: "phases.2.join", message: "join names unknown reducer \"merge-all\"" }),
    ] : [
      expect.objectContaining({ entry: 'Phase "first"', keyPath: "phases.0.over", message: "over reads \"input.missing\", which is not a declared list field of the input contract" }),
      expect.objectContaining({ entry: 'Phase "second"', keyPath: "phases.2.label", message: "label \"missing\" is not a string field of the items of \"input.files\"" }),
    ])
  })
})

describe("what the verifier leaves unproved", () => {
  it("warns at the phase of each defect and at the phases for each uncertainty that the values of a run do not decide", async () => {
    const { sessionDir, dir } = session()
    const file = await loadPathWorkflow({ path: write(dir, "survey.workflow.yaml", SURVEY), sessionDir, revision, authority: fullAuthority() })
    if (!file.ok) throw new Error(Object.values(describeDefinitionRefusal("", file)).flat().join("\n"))
    const fix = topNodeId("survey-routes", 1)

    expect(verificationWarnings(file.shown, file.workflow, {
      result: "invalid",
      findings: [
        { name: "unreachable_work", target: fix, message: `Logical node "${fix}" cannot reach execution through the production machine.`, witness: [], noPathReason: null },
        { name: "terminal_reachable", target: "completed", message: "The production machine reaches completed.", witness: [], noPathReason: null },
      ],
      uncertainties: [
        { name: "runtime_handoff_values", target: null, detail: "Synthetic handoffs cover empty and positive values, not every runtime value." },
        { name: "bounded_graph_exploration", target: null, detail: "States beyond the 20000-state exploration bound were not proved." },
      ],
    })).toEqual([
      { file: "scratch/workflows/survey.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1", message: `unreachable_work: Logical node "${fix}" cannot reach execution through the production machine.` },
      { file: "scratch/workflows/survey.workflow.yaml", keyPath: "phases", message: "bounded_graph_exploration: States beyond the 20000-state exploration bound were not proved." },
    ])
  })
})

describe("refusal text", () => {
  it("states the reason and each located problem apart", () => {
    expect(describeDefinitionRefusal("The workflow file f.workflow.yaml cannot launch: ", {
      ok: false,
      reason: "the file is not valid",
      diagnostics: [{ file: "/s/f.workflow.yaml", entry: 'Phase "fix"', keyPath: "phases.1.reads", message: 'reads names "missing", which is no phase or agent of this workflow' }],
    })).toEqual({ error: "The workflow file f.workflow.yaml cannot launch: the file is not valid.", problems: ['/s/f.workflow.yaml: Phase "fix", phases.1.reads: reads names "missing", which is no phase or agent of this workflow'] })
  })
})

