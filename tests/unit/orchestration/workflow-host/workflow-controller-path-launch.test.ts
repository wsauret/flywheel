import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveWorkflowAgentRole } from "../../../../src/orchestration/config/role-selection.js"
import { resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import { modelWorkflowLaunchOrigin, workflowLaunchTargets, type WorkflowLaunchTarget } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { canonicalWorkflowRecord } from "../../../../src/workflows/definition-records.js"
import { loadDefinitionLineageFromEvents, workflowLaunchOf } from "../../../../src/workflows/definition-provenance-projection.js"
import { fixtureDefinitions } from "../../../helpers/project-definitions.js"
import { cleanupProjectRoots, seedLaunchApproval, until, makeWorkflowDeps } from "./_workflow-controller-fixtures.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { testDirectories } from "../../../helpers/directories.js"
import { FILE, pathSetup } from "./_path-launch-fixtures.js"

/** FILE in the step grammar of the builds before phases. */
const STEP_FILE = `id: survey-routes
name: Survey routes
description: Survey the routes.
steps:
  survey:
    name: Survey
    instructions: List every route in src/routes and report each one.
flow:
  - step: survey
`
import { createLazyWorkflowController } from "../../../../src/orchestration/app-service/lazy-workflow-controller.js"
import { createWorkflowToolCore } from "../../../../src/orchestration/agent-runtime/tools/workflow-tool.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { agentRecords } from "../../../../src/workflows/workflow-schema.js"

const SKILL_POINTER = "Load the `workflow-authoring` skill if you have not, fix the file, and launch it again."

/** A file that runs a phase over up to 60 input files and declares no
 *  attempt limit, so a launch runs with its worst case: one agent for each
 *  real file, and the report. */
const WIDE = `id: read-files
name: Read files
description: Read each file and report.
input:
  fields:
    files: { type: list, max: 60, unique: path, description: The files., of: { type: object, fields: { path: { type: string, description: The path. } } } }
phases:
  - phase: reads
    over: input.files
    name: Read one file
    brief: Read the file in your item context.
  - phase: report
    name: Report
    brief: Report what the files hold.
`

/** A file that declares no attempt limit and whose worst case is past the
 *  ceiling: the dedupe join keeps up to 100 x 50 = 5000 findings, and the
 *  second phase over a list runs one check for each. */
const PAST_CEILING = `id: check-all
name: Check all
description: Review each file, then check each finding.
input:
  fields:
    files: { type: list, max: 100, unique: path, description: The files., of: { type: object, fields: { path: { type: string, description: The path. } } } }
phases:
  - phase: reviews
    over: input.files
    name: Review one file
    brief: Review the file in your item context.
    output:
      fields:
        findings: { type: list, max: 50, unique: id, description: The findings., of: { type: object, fields: { id: { type: string, description: The id. } } } }
    join: { reducer: dedupe, with: { items: findings, by: id } }
  - phase: checks
    over: reviews.kept
    name: Check one finding
    brief: Check the finding in your item context.
  - phase: report
    name: Report
    brief: Report the checks.
`

const files = (count: number) => ({ files: Array.from({ length: count }, (_, index) => ({ path: `src/${index}.ts` })) })

afterEach(cleanupProjectRoots)

describe("a model launch of a workflow file", () => {

  it("publishes the run with the file as session provenance, records its verifier result and worst case, and reports them", async () => {
    const setup = await pathSetup()
    const file = setup.write("survey.workflow.yaml", FILE)

    const result = await setup.launch("scratch/workflows/survey.workflow.yaml")

    if ("error" in result) throw new Error(result.error)
    await until(() => setup.starts.length > 0, "the workflow start")
    expect(setup.starts[0]?.workflow.id).toBe("survey-routes")
    expect(result.workflowFile).toMatchObject({ path: file, verification: expect.stringMatching(/^(proved|partially_proved)$/u), worstCaseAttempts: expect.any(Number) })
    expect(result.workflowFile?.verificationUncertainties).toContain("runtime_handoff_values")
    const lineage = loadDefinitionLineageFromEvents(setup.store.read({ aggregateId: `workflow:${result.workflowId}`, types: ["definition.loaded"] }))
    expect(lineage.definitions["workflow:survey-routes"]?.provenance).toEqual({ layer: "session", filePath: file, id: "survey-routes" })
    // The launch records what it reported, so the view and the card read it
    // from the run.
    const launch: unknown = workflowLaunchOf(loadDefinitionLineageFromEvents(setup.store.read({ aggregateId: `workflow:${result.workflowId}`, types: ["definition.loaded", "workflow.compiled"] })))
    expect(launch).toEqual({
      source: { kind: "file", path: "scratch/workflows/survey.workflow.yaml" },
      verification: result.workflowFile?.verification,
      worstCaseAttempts: result.workflowFile?.worstCaseAttempts,
    })
    expect(await setup.manager.read(result.workflowId)).toBeNull()
    expect(await workflowRunReader(asAsyncEventReadSurface(setup.store)).read(result.workflowId)).toMatchObject({ workflowDefinitionId: "survey-routes" })
  })

  it("starts a file with a retired key, answers each warning, and records them for the workflow card", async () => {
    const setup = await pathSetup()
    setup.write("retired.workflow.yaml", `development-only: true\n${FILE}`)

    const result = await setup.launch("scratch/workflows/retired.workflow.yaml")

    if ("error" in result) throw new Error(result.error)
    expect(result.workflowFile?.warnings).toEqual(["development-only: this key is retired and does nothing; remove it"])
    const launch = workflowLaunchOf(loadDefinitionLineageFromEvents(setup.store.read({ aggregateId: `workflow:${result.workflowId}`, types: ["definition.loaded", "workflow.compiled"] })))
    expect(launch?.warnings).toEqual(["development-only: this key is retired and does nothing; remove it"])
  })

  it("starts a new run with a new definition hash when an edited file launches again", async () => {
    const setup = await pathSetup()
    const file = setup.write("survey.workflow.yaml", FILE)
    const first = await setup.launch(file)
    writeFileSync(file, FILE.replace("report each one.", "report each one with its handler."))

    const second = await setup.launch(file)

    if ("error" in first || "error" in second) throw new Error("a launch was refused")
    expect(second.workflowId).not.toBe(first.workflowId)
    expect(second.workflowFile?.definitionSha256).not.toBe(first.workflowFile?.definitionSha256)
  })

  it("refuses a broken file with every problem located in it and the way to repair it, and starts nothing", async () => {
    const setup = await pathSetup()
    setup.write("survey.workflow.yaml", FILE.replace("id: survey-routes", "id: repair").concat("  - phase: publish\n    brief: Publish the survey.\n    reads: [summary]\n"))
    const positions = setup.store.read({}).length

    const result = await setup.launch("scratch/workflows/survey.workflow.yaml")

    if (!("error" in result)) throw new Error(`expected a refusal, got workflow ${result.workflowId}`)
    expect([result.error, ...(result.problems ?? []).map((problem) => `- ${problem}`)]).toEqual([
      "the workflow file scratch/workflows/survey.workflow.yaml is unavailable: the file is not valid.",
      '- scratch/workflows/survey.workflow.yaml: Phase "publish", phases.1.reads: reads names "summary", which is no phase or agent of this workflow',
    ])
    expect(result.recovery).toBe(SKILL_POINTER)
    expect(setup.store.read({}).length).toBe(positions)
    expect(setup.starts).toEqual([])
  })

  it("runs a file that declares no queue length with the worst case of its real input as its queue length", async () => {
    // The 60 items and the report exceed the configured attempt limit of 50,
    // but a file that declares no limit uses its own worst case.
    const setup = await pathSetup()
    setup.write("wide.workflow.yaml", WIDE)

    const result = await setup.launch("scratch/workflows/wide.workflow.yaml", undefined, files(60))

    if ("error" in result) throw new Error(result.error)
    expect(result.workflowFile?.worstCaseAttempts).toBe(61)
    const [initialized] = setup.store.read({ aggregateId: `workflow:${result.workflowId}`, types: ["workflow.control.initialized"] })
    expect(initialized?.payload).toMatchObject({ control: { guardrails: { maxAttempts: 61 } } })
  })

  it("refuses a file whose worst case is past the ceiling before it launches, with the way to repair it, and starts nothing", async () => {
    const setup = await pathSetup()
    setup.write("check-all.workflow.yaml", PAST_CEILING)
    const positions = setup.store.read({}).length

    const result = await setup.launch("scratch/workflows/check-all.workflow.yaml", undefined, files(2))

    if (!("error" in result)) throw new Error(`expected a refusal, got workflow ${result.workflowId}`)
    expect([result.error, ...(result.problems ?? []).map((problem) => `- ${problem}`)]).toEqual([
      "the workflow file scratch/workflows/check-all.workflow.yaml is unavailable: the file is not valid.",
      "- scratch/workflows/check-all.workflow.yaml: (root): Structural admission rejected the workflow: attempt_limit_overrun: The workflow needs 5003 attempts for its worst case, more than the ceiling of 4096. This count gives each list of the launch input 2 sample items; a launch counts its real items, up to the max of each list. Raise guardrails.max_attempts (at most 4096), remove phases, or declare a lower max on a list that a phase over a list, a repeat, or a join counts; a list of a workflow file that declares none counts as 100. A workflow file that declares none uses its worst case: every queued attempt, each declared retry, and each item that a reassessment can insert.",
    ])
    expect(result.recovery).toBe(SKILL_POINTER)
    expect(setup.store.read({}).length).toBe(positions)
    expect(setup.starts).toEqual([])
  })

  it("counts downstream maps from the real launch input rather than its declared maximum", async () => {
    const setup = await pathSetup()
    setup.write("check-all.workflow.yaml", PAST_CEILING.replace("max: 100", "max: 4").replace("max: 50", "max: 5"))

    const result = await setup.launch("scratch/workflows/check-all.workflow.yaml", undefined, files(2))

    if ("error" in result) throw new Error(result.error)
    expect(result.workflowFile?.worstCaseAttempts).toBe(13)
    const [initialized] = setup.store.read({ aggregateId: `workflow:${result.workflowId}`, types: ["workflow.control.initialized"] })
    expect(initialized?.payload).toMatchObject({ control: { guardrails: { maxAttempts: 13 } } })
  })

  it("refuses input that the file's input contract rejects, with the way to repair it", async () => {
    const setup = await pathSetup()
    setup.write("wide.workflow.yaml", WIDE)

    const result = await setup.launch("scratch/workflows/wide.workflow.yaml", undefined, { files: [{ name: "src/a.ts" }] })

    if (!("error" in result)) throw new Error(`expected a refusal, got workflow ${result.workflowId}`)
    expect(result.error).toContain("files")
    expect(result.recovery).toBe(SKILL_POINTER)
    expect(setup.starts).toEqual([])
  })

  it("resumes the run from its record after the file is deleted", async () => {
    const setup = await pathSetup()
    const file = setup.write("survey.workflow.yaml", FILE)
    const launched = await setup.launch(file)
    if ("error" in launched) throw new Error(launched.error)
    await until(() => setup.starts.length > 0, "the workflow start")
    const original = setup.starts[0]?.workflow
    if (!original) throw new Error("the launch started no runner")
    rmSync(file)
    // The run stops, as at a restart, so the Resume starts its runner again.
    setup.workflowHosts._runners.delete(launched.workflowId)

    const resumed = await setup.controller.resumeWorkflow(launched.workflowId)

    expect(resumed).toMatchObject({ kind: "resumed", sessionId: launched.workflowId })
    const restarted = setup.starts.at(-1)
    expect(restarted?.startMode).toBe("operator_resume")
    if (!restarted) throw new Error("the resume started no runner")
    expect(canonicalWorkflowRecord(restarted.workflow)).toEqual(canonicalWorkflowRecord(original))
    expect(restarted.workflow.provenance).toEqual({ layer: "session", filePath: file, id: "survey-routes" })
  })
})

describe("a model launch of the content of a workflow file", () => {
  /** What a run recorded about its definition and its launch. */
  function recorded(setup: Awaited<ReturnType<typeof pathSetup>>, sessionId: string) {
    const lineage = loadDefinitionLineageFromEvents(setup.store.read({ aggregateId: `workflow:${sessionId}`, types: ["definition.loaded", "workflow.compiled"] }))
    return { definitions: lineage.definitions, launch: workflowLaunchOf(lineage) }
  }

  it("saves the content under the workflow id and launches the saved file as a path launch of that file does", async () => {
    const setup = await pathSetup()

    const { result, launch } = await setup.launchContent(FILE)

    const file = join(setup.dir, "survey-routes.workflow.yaml")
    if (launch === undefined || "error" in launch) throw new Error(result.content)
    expect(result.outcome).toBe("ok")
    expect(readFileSync(file, "utf8")).toBe(FILE)
    expect(result.content).toContain(`It runs the workflow file ${file} with definition hash ${launch.workflowFile?.definitionSha256}.`)
    const byPath = await setup.launch(file)
    if ("error" in byPath) throw new Error(byPath.error)
    expect(launch.workflowFile).toEqual(byPath.workflowFile)
    expect(recorded(setup, launch.workflowId)).toEqual(recorded(setup, byPath.workflowId))
    expect(recorded(setup, launch.workflowId).launch?.source).toEqual({ kind: "file", path: "scratch/workflows/survey-routes.workflow.yaml" })
  })

  it("keeps the content of a refused launch saved and names the saved file, so the agent can fix it", async () => {
    const setup = await pathSetup()
    const invalid = FILE.replace("id: survey-routes", "id: repair").replace("    name: Survey\n", "    name: Survey\n    reads: [missing]\n")
    const unreadable = "id: [survey\n"

    const refused = await setup.launchContent(invalid)
    const broken = await setup.launchContent(unreadable)

    for (const [{ result }, name, content] of [[refused, "repair.workflow.yaml", invalid], [broken, "workflow.workflow.yaml", unreadable]] as const) {
      expect(result.outcome).toBe("error")
      expect(result.content).toContain(`Flywheel saved the file as ${join(setup.dir, name)}.`)
      expect(result.content).toContain(SKILL_POINTER)
      expect(readFileSync(join(setup.dir, name), "utf8")).toBe(content)
    }
    expect(refused.result.content).toContain('- scratch/workflows/repair.workflow.yaml: Phase "survey", phases.0.reads: reads names "missing", which is no phase or agent of this workflow')
    expect(setup.starts).toEqual([])
  })

  it("replaces the saved file when revised content launches again, starts a new run, and leaves the first run's recorded definition as it was", async () => {
    const setup = await pathSetup()
    const revised = FILE.replace("report each one.", "report each one with its handler.")
    const first = await setup.launchContent(FILE)
    if (first.launch === undefined || "error" in first.launch) throw new Error(first.result.content)
    const before = recorded(setup, first.launch.workflowId)

    const second = await setup.launchContent(revised)

    if (second.launch === undefined || "error" in second.launch) throw new Error(second.result.content)
    expect(readFileSync(join(setup.dir, "survey-routes.workflow.yaml"), "utf8")).toBe(revised)
    expect(second.launch.workflowId).not.toBe(first.launch.workflowId)
    expect(second.launch.workflowFile?.definitionSha256).not.toBe(first.launch.workflowFile?.definitionSha256)
    expect(recorded(setup, first.launch.workflowId)).toEqual(before)
  })

  it("launches each concurrent call's content when both calls replace the same file", async () => {
    const setup = await pathSetup()
    const revised = FILE.replace("report each one.", "report each one with its handler.")
    const controller = createLazyWorkflowController({ create: async () => setup.controller })
    const tool = createWorkflowToolCore({
      startWorkflow: ({ model, ...intent }) => controller.startWorkflow({ ...intent, origin: modelWorkflowLaunchOrigin(setup.chatSessionId, model) }),
      sessionDir: setup.sessionDir,
      executionCwd: setup.root,
      mode: "on",
      resolveLaunchTarget: workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir: setup.sessionDir, executionCwd: setup.root }),
      authority: fullAuthority(),
      askUserAvailable: true,
      onRenderEvent: () => {},
    })
    const results = await Promise.all([FILE, revised].map((content, index) => tool.execute(
      { source: { kind: "content", content }, description: `Survey ${index}` },
      { toolUseId: `toolu-concurrent-${index}`, conversationId: setup.conversationId },
    )))
    expect(results.map(({ outcome }) => outcome)).toEqual(["ok", "ok"])
    expect(setup.starts.map(({ workflow }) => agentRecords(workflow).get("survey")?.keys.brief).sort()).toEqual([
      "List every route in src/routes and report each one.",
      "List every route in src/routes and report each one with its handler.",
    ].sort())
    expect(readFileSync(join(setup.dir, "survey-routes.workflow.yaml"), "utf8")).toBe(revised)
  })
})

describe("an Ask approval of a workflow file", () => {
  async function approved() {
    const setup = await pathSetup("ask")
    const file = setup.write("survey.workflow.yaml", FILE)
    const target = await workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir: setup.sessionDir, executionCwd: setup.root })({ kind: "path", path: file })
    if ("error" in target) throw new Error(target.error)
    seedLaunchApproval({ store: setup.store, chatSessionId: setup.chatSessionId, conversationId: setup.conversationId, confirmationId: "toolu-approval", target: target satisfies WorkflowLaunchTarget })
    return { setup, file }
  }

  it("names a broken file by its place in the session directory and tells the agent how to repair it", async () => {
    const setup = await pathSetup("ask")
    const file = setup.write("broken.workflow.yaml", FILE.replace("    name: Survey\n", "    name: Survey\n    reads: [missing]\n"))

    const target = await workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir: setup.sessionDir, executionCwd: setup.root })({ kind: "path", path: file })

    if (!("error" in target)) throw new Error("expected the question to be refused")
    expect([target.error, ...(target.problems ?? []).map((problem) => `- ${problem}`)]).toEqual([
      "The workflow file scratch/workflows/broken.workflow.yaml cannot be approved: the file is not valid.",
      '- scratch/workflows/broken.workflow.yaml: Phase "survey", phases.0.reads: reads names "missing", which is no phase or agent of this workflow',
    ])
    expect(target.recovery).toBe(SKILL_POINTER)
  })

  it("launches the file it approved", async () => {
    const { setup } = await approved()

    const result = await setup.launch("scratch/workflows/survey.workflow.yaml", "toolu-approval")

    if ("error" in result) throw new Error(result.error)
    expect(result.workflowFile?.path).toContain("survey.workflow.yaml")
  })

  it("saves content that it is asked to approve, and launches the same content that the person approved", async () => {
    const setup = await pathSetup("ask")
    const resolve = workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir: setup.sessionDir, executionCwd: setup.root })

    const target = await resolve({ kind: "content", content: FILE })

    if ("error" in target) throw new Error(target.error)
    const file = join(setup.dir, "survey-routes.workflow.yaml")
    expect(target.source).toMatchObject({ kind: "path", path: file })
    expect(existsSync(file)).toBe(true)
    seedLaunchApproval({ store: setup.store, chatSessionId: setup.chatSessionId, conversationId: setup.conversationId, confirmationId: "toolu-approval", target })
    const { result } = await setup.launchContent(FILE, "toolu-approval")
    expect(result.outcome).toBe("ok")
  })

  // An approval that a build before phases asked binds the hash of the
  // step-grammar record. The file still states that grammar, so the
  // approval admits it. Remove after 2027-04-30.
  it("launches a step-grammar file that a build before phases approved", async () => {
    const setup = await pathSetup("ask")
    const file = setup.write("survey.workflow.yaml", STEP_FILE)
    const target = await workflowLaunchTargets({ revision: () => fixtureDefinitions().captureRevision(), sessionDir: setup.sessionDir, executionCwd: setup.root })({ kind: "path", path: file })
    if ("error" in target || target.source.kind !== "path") throw new Error("expected a path target")
    // The hash that 301e51b8b recorded for this file in its question.
    const before = { ...target, source: { ...target.source, definitionSha256: "efda6257a276565779a583980e5c496b746f66c3a9e212c0f0fe2476dc269e52" } }
    expect(before.source.definitionSha256).not.toBe(target.source.definitionSha256)
    seedLaunchApproval({ store: setup.store, chatSessionId: setup.chatSessionId, conversationId: setup.conversationId, confirmationId: "toolu-approval", target: before })

    const result = await setup.launch(file, "toolu-approval")

    if ("error" in result) throw new Error(result.error)
    expect(result.workflowFile?.path).toBe(file)
  })

  it("does not cover the file after an edit, and creates nothing", async () => {
    const { setup, file } = await approved()
    writeFileSync(file, FILE.replace("report each one.", "report each one with its handler."))
    const positions = setup.store.read({}).length

    const result = await setup.launch(file, "toolu-approval")

    if (!("error" in result)) throw new Error(`expected a refusal, got workflow ${result.workflowId}`)
    expect(result.error).toContain(`approves the workflow file ${file} as it was when the question was asked, and the file changed after that`)
    expect(setup.store.read({}).length).toBe(positions)
    expect(setup.starts).toEqual([])
  })
})

describe("the model and effort of the steps of a launched file", () => {
  it("keeps a file's authored effort while resolving its model again on resume", async () => {
    let capture = roleCapture(["gpt-6.1-sol"])
    const captureProviderConnection = async () => capture
    const setup = await pathSetup("on", { ...makeWorkflowDeps(), captureProviderConnection })
    await setup.manager.captureRolesIfAbsent(setup.chatSessionId, { chat: { model: "gpt-5.5", effort: "medium" } })
    await setup.manager.updateRoleAssignment(setup.chatSessionId, "chat", { model: "gpt-5.4", effort: "high" })
    const file = setup.write("survey.workflow.yaml", FILE.replace("    brief: List", "    effort: low\n    brief: List"))

    const launched = await setup.launch(file)

    if ("error" in launched) throw new Error(launched.error)
    expect(launched.stepModels.pairs).toEqual([{ model: "gpt-6.1-sol", effort: "low", definitionIds: ["survey"] }])
    const runs = workflowRunReader(asAsyncEventReadSurface(setup.store))
    expect((await runs.read(launched.workflowId))?.roleAssignments).toEqual({ defaults: { "brief.survey-routes.survey.at.survey.effort": { effort: "low" } }, overrides: {} })
    const roles = async () => {
      const run = await runs.read(launched.workflowId)
      if (!run) throw new Error("Missing launched workflow")
      return resolveSessionRoles(run.roleAssignments, await captureProviderConnection(), testDirectories(setup.root).userDataRoot)
    }
    const surveyPair = async () => {
      const role = resolveWorkflowAgentRole({ briefId: "survey-routes.survey", definitionId: "survey" }, await roles())
      return { model: role?.model, effort: role?.effort }
    }
    expect(await surveyPair()).toEqual({ model: "gpt-6.1-sol", effort: "low" })
    // A step without keys runs on the shipped Step Agent default, not on the chat.
    expect(resolveWorkflowAgentRole({ briefId: "survey-routes.other", definitionId: "other" }, await roles())).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
    await until(() => setup.starts.length > 0, "the workflow start")
    const original = setup.starts[0]?.workflow
    if (!original) throw new Error("the launch started no runner")
    await setup.manager.updateRoleAssignment(setup.chatSessionId, "chat", { model: "gpt-5.5", effort: "low" })
    // The run stops, as at a restart, so the Resume starts its runner again.
    setup.workflowHosts._runners.delete(launched.workflowId)
    capture = roleCapture(["claude-opus-5.5"])

    const resumed = await setup.controller.resumeWorkflow(launched.workflowId)

    expect(resumed).toMatchObject({ kind: "resumed", sessionId: launched.workflowId })
    const restarted = setup.starts.at(-1)
    if (!restarted) throw new Error("the resume started no runner")
    await restarted.onDefinitionAccepted?.()
    expect(agentRecords(restarted.workflow).get("survey")?.keys.effort).toBe("low")
    expect(canonicalWorkflowRecord(restarted.workflow)).toEqual(canonicalWorkflowRecord(original))
    expect(await surveyPair()).toEqual({ model: "claude-opus-5.5", effort: "low" })
  })

  it("launches an unsupported effort and normalizes it instead of refusing the file", async () => {
    const setup = await pathSetup("on", { ...makeWorkflowDeps(), captureProviderConnection: async () => roleCapture(["gpt-6.1-sol"]) })
    setup.write("survey.workflow.yaml", FILE.replace("    brief: List", "    effort: max\n    brief: List"))

    const result = await setup.launch("scratch/workflows/survey.workflow.yaml")

    if ("error" in result) throw new Error(result.error)
    expect(result.stepModels.pairs).toEqual([{ model: "gpt-6.1-sol", effort: "high", definitionIds: ["survey"] }])
    expect((await workflowRunReader(asAsyncEventReadSurface(setup.store)).read(result.workflowId))?.roleAssignments).toEqual({ defaults: { "brief.survey-routes.survey.at.survey.effort": { effort: "max" } }, overrides: {} })
  })
})
