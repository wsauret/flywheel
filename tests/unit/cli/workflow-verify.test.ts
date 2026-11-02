import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  renderWorkflowVerificationReport,
  resolveWorkflowVerifyInput,
  runWorkflowVerify,
} from "../../../src/orchestration/modules/workflows/cli/verify.js"
import type { WorkflowVerificationReport } from "../../../src/workflows/vm/verify-types.js"
import { fixtureDefinitions } from "../../helpers/project-definitions.js"
import { testDirectories } from "../../helpers/directories.js"
import { Database } from "bun:sqlite"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { WORKSPACE_STATE_EPOCH } from "../../../src/orchestration/workspace-state-retirement.js"
import { operationsDir } from "../../../src/orchestration/modules/learning/skill-operation-manifest.js"
import { userSkillStoreDir } from "../../../src/workflows/skills.js"
import { SqliteVmDriver } from "../workflows/vm/_sqlite-vm-driver.js"
import { DRY_FILES, DRY_LOOP, dryAnswer, dryRound, dryWorkflow, FINDINGS_FILES, findingsAnswer, findingsWorkflow, MAP_GROUP, PLAN, SURVEY_GROUP, TAIL, attemptOf, completePlan, items, mapSkills, mapWorkflow, runPrepared, stage, surveyAnswer, surveyWorkflow } from "../workflows/vm/_map-fixtures.js"
import { startNext, wideControl } from "../workflows/vm/_tree-fixtures.js"
import { verifyRecoveredWorkflow } from "../../../src/workflows/vm/verify.js"
import { buildWorkflowControlCommittedFact } from "../../../src/workflows/vm/session-facts.js"

const definitions = fixtureDefinitions()

async function rejection(pending: Promise<unknown>): Promise<string> {
  try {
    await pending
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("Expected the verification to reject")
}

const proved: WorkflowVerificationReport = {
  result: "proved",
  findings: [{
    name: "terminal_reachable",
    target: "completed",
    message: "The workflow completes.",
    witness: ["INITIALIZE", "START"],
    noPathReason: null,
  }],
  uncertainties: [],
}

const partial: WorkflowVerificationReport = {
  result: "partially_proved",
  findings: [{
    name: "array_bounded_for",
    target: "workflow:node:2",
    message: "The loop uses its runtime array.",
    witness: [],
    noPathReason: null,
  }],
  uncertainties: [{
    name: "runtime_for_array_size",
    target: "workflow:node:2",
    detail: "The runtime array length is dynamic.",
  }],
}

const invalid: WorkflowVerificationReport = {
  result: "invalid",
  findings: [{
    name: "schema_invalid",
    target: "control",
    message: "The control does not match the schema.",
    witness: null,
    noPathReason: "Strict decoding failed before initialization.",
  }],
  uncertainties: [],
}

describe("workflow verification report rendering", () => {
  it("renders a proved report and its event witness", () => {
    expect(renderWorkflowVerificationReport(proved)).toBe([
      "Result: proved",
      "",
      "Findings:",
      "- terminal_reachable [completed]: The workflow completes.",
      "  Event witness: INITIALIZE -> START",
      "",
      "Uncertainties: none",
    ].join("\n"))
  })

  it("renders a partial report and every named uncertainty", () => {
    const output = renderWorkflowVerificationReport(partial)
    expect(output).toContain("Result: partially_proved")
    expect(output).toContain("Event witness: (initial state)")
    expect(output).toContain("runtime_for_array_size [workflow:node:2]: The runtime array length is dynamic.")
  })

  it("renders an invalid report and its no-path reason", () => {
    const output = renderWorkflowVerificationReport(invalid)
    expect(output).toContain("Result: invalid")
    expect(output).toContain("schema_invalid [control]: The control does not match the schema.")
    expect(output).toContain("No path: Strict decoding failed before initialization.")
  })
})

describe("workflow verification input resolution", () => {
  it("refuses a named workflow and asks for a file path", async () => {
    await expect(resolveWorkflowVerifyInput("debug", {
      skills: definitions.skills(),
      readText: async () => { throw new Error("no file is read for an id") },
    })).rejects.toThrow('Named workflow verification is no longer supported: debug. Pass a workflow file path (.yaml, .yml, or .json).')
  })

  it("loads YAML with the production loader and the injected skill registry", async () => {
    const skillId = definitions.skills().skills.keys().next().value
    if (!skillId) throw new Error("The project registry has no skill packages")
    const report = await resolveWorkflowVerifyInput("scratch/workflow.yml", {
      skills: definitions.skills(),
      readText: async () => `id: cli-test\nname: CLI test\nphases:\n  - phase: work\n    name: Work\n    brief: Do the work.\n    dependencies: [${skillId}]\n`,
    })
    expect(["proved", "partially_proved"]).toContain(report.result)
  })

  it.each([
    ["skill:fixture.root", "a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [fixture.root]"],
    ["missing", 'runs brief "missing", which this file does not hold; write the brief inline'],
  ])("refuses runs %s with an inline-brief alternative", async (runs, message) => {
    const refusal = await rejection(resolveWorkflowVerifyInput("drafts/refused.yaml", {
      skills: definitions.skills(),
      readText: async () => `id: refused\nname: Refused\nphases:\n  - phase: work\n    runs: ${runs}\n`,
    }))
    expect(refusal).toContain('Phase "work", phases.0.runs')
    expect(refusal).toContain(message)
  })

  it("refuses a retired module brief by name", async () => {
    const refusal = await rejection(resolveWorkflowVerifyInput("drafts/audit.workflow.yaml", {
      skills: definitions.skills(),
      readText: async () => "id: audit\nname: Audit\nphases:\n  - phase: audit\n    runs: fly.raindrop-audit\n",
    }))
    expect(refusal).toContain('runs brief "fly.raindrop-audit", which Flywheel no longer ships')
  })

  it("judges a draft outside every definition root as a path launch does, so the skill's canonical example verifies", async () => {
    const example = path.join(import.meta.dir, "../../../src/agent-skills/workflow-authoring/examples/review-changes.workflow.yaml")
    const report = await resolveWorkflowVerifyInput(example, {
      skills: definitions.skills(),
      readText: async (file) => fs.readFileSync(file, "utf8"),
    })
    expect(report.result).not.toBe("invalid")
  })

  it("accepts an agent's model and effort in files inside and outside former definition roots", async () => {
    const keyed = "id: keyed\nname: Keyed\nphases:\n  - phase: work\n    name: Work\n    brief: Do the work.\n    model: mid\n    effort: low\n"
    const dependencies = {
      skills: definitions.skills(),
      readText: async () => keyed,
    }
    const draft = await resolveWorkflowVerifyInput("drafts/keyed.workflow.yaml", dependencies)
    expect(draft.result).not.toBe("invalid")

    const project = await resolveWorkflowVerifyInput(".flywheel/workflows/keyed.yaml", dependencies)
    expect(project.result).not.toBe("invalid")
  })

  it("reports every schema and semantic error without assigning a former definition layer", async () => {
    const fixture = fs.readFileSync(path.join(import.meta.dir, "../../fixtures/workflow-project/workflows/repair.yaml"), "utf8")
    const dependencies = (file: string) => ({
      skills: definitions.skills(),
      readText: async () => file,
    })
    const unknownField = fixture.replace("id: repair", "id: repair-bad")
      .replace("while: verify.defects", "while: verify.nonexistent")

    expect(await rejection(resolveWorkflowVerifyInput("drafts/repair-bad.yaml", dependencies(unknownField)))).toBe([
      "Workflow definition errors:",
      'drafts/repair-bad.yaml (repair-bad): Repeat 3, phases.2.repeat.while: while "verify.nonexistent" names undeclared output field "nonexistent" of "verify"',
    ].join("\n"))

    expect(await rejection(resolveWorkflowVerifyInput(".flywheel/workflows/repair-bad.yaml", dependencies(unknownField))))
      .toStartWith("Workflow definition errors:\n.flywheel/workflows/repair-bad.yaml (repair-bad): Repeat 3")

    const twoSchemaErrors = unknownField.replace("id: repair-bad", "id: 7").replace(/    brief: [^\n]+/, "    runs: [broken]")
    const schemaErrors = await rejection(resolveWorkflowVerifyInput("drafts/repair-bad.yaml", dependencies(twoSchemaErrors)))
    // Each schema issue names its key path, so the author fixes the key it names.
    expect(schemaErrors).toContain("drafts/repair-bad.yaml: id: ")
    expect(schemaErrors).toContain(`drafts/repair-bad.yaml: Phase "investigate", phases.0.runs: `)
  })

  it("names a missing file plainly", async () => {
    await expect(resolveWorkflowVerifyInput("wf/missing.yaml", {
      skills: definitions.skills(),
      readText: (file) => Bun.file(path.join(os.tmpdir(), "flywheel-absent", file)).text(),
    })).rejects.toThrow(/^File not found: wf\/missing\.yaml$/u)
  })

  it("passes JSON to strict instantiated verification", async () => {
    const report = await resolveWorkflowVerifyInput("scratch/plan.json", {
      skills: definitions.skills(),
      readText: async () => "{}",
    })
    expect(report.result).toBe("invalid")
    expect(report.findings[0]?.name).toBe("schema_invalid")
  })
})

describe("workflow verification CLI errors", () => {
  const originalError = console.error
  let errorLines: string[] = []

  beforeEach(() => {
    errorLines = []
    console.error = (...args: unknown[]) => errorLines.push(args.map(String).join(" "))
  })

  afterEach(() => {
    console.error = originalError
  })

  it("uses exit code 2 for a named workflow and asks for a file path", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-workflow-verify-"))
    try {
      expect(await runWorkflowVerify(["not-a-workflow"], testDirectories(projectRoot))).toBe(2)
      expect(errorLines.join("\n")).toContain("Named workflow verification is no longer supported: not-a-workflow. Pass a workflow file path")
      expect(errorLines.join("\n")).toContain("Usage: flywheel workflow verify <workflow.yaml|workflow.json>")
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("refuses invalid workspace state before migrating legacy definitions", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-workflow-verify-"))
    const dbFile = resolveEventStoreDbFile(projectRoot)
    const legacyStep = path.join(projectRoot, ".flywheel", "steps", "flywheel", "plan-create.md")
    fs.mkdirSync(path.dirname(legacyStep), { recursive: true })
    fs.writeFileSync(legacyStep, "---\nname: Create Plan\ndescription: Legacy.\n---\nBody.")
    const db = new Database(dbFile, { create: true })
    db.exec(`PRAGMA user_version = ${WORKSPACE_STATE_EPOCH + 1}`)
    db.close()

    try {
      expect(await runWorkflowVerify(["not-a-workflow"], testDirectories(projectRoot))).toBe(2)
      expect(fs.readFileSync(legacyStep, "utf8")).toContain("name: Create Plan")
      expect(fs.existsSync(path.join(projectRoot, ".flywheel", "skills"))).toBe(false)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

/** Verification is read-only inspection: it admits no optional capability and
 *  performs no managed-learning mutation, whatever the selection says. */
describe("workflow verification and optional capabilities", () => {
  it("reconciles no global skill store while Learning is off", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-workflow-verify-"))
    const accountHome = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-workflow-verify-account-"))
    prepareWorkspaceState({ projectRoot, accountHome, userDataRoot: path.join(accountHome, ".flywheel") }).generation.release()
    fs.cpSync(path.join(import.meta.dir, "../../fixtures/workflow-project"), path.join(projectRoot, ".flywheel"), { recursive: true })
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), 'features = ["skills"]\n')
    // Reconciliation quarantines this undecodable operation record, so its
    // survival is the observable of a command that reconciled nothing.
    const operations = operationsDir(userSkillStoreDir(userDataRoot))
    fs.mkdirSync(operations, { recursive: true })
    const staleRecord = path.join(operations, `${"a".repeat(64)}.json`)
    fs.writeFileSync(staleRecord, "{}\n")
    const originalLog = console.log
    console.log = () => {}

    try {
      const directories = { ...testDirectories(projectRoot), accountHome, userDataRoot }

      expect(await runWorkflowVerify([path.join(projectRoot, ".flywheel/workflows/repair.yaml")], directories)).toBe(0)
      expect(fs.existsSync(staleRecord)).toBe(true)
    } finally {
      console.log = originalLog
      fs.rmSync(projectRoot, { recursive: true, force: true })
      fs.rmSync(accountHome, { recursive: true, force: true })
    }
  })
})

describe("workflow verification of a stored session", () => {
  const originalLog = console.log
  const originalError = console.error
  let out: string[] = []

  beforeEach(() => {
    out = []
    console.log = (...args: unknown[]) => out.push(args.map(String).join(" "))
    console.error = (...args: unknown[]) => out.push(args.map(String).join(" "))
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
  })

  it("replays a map run read-only and prints its findings, its tree, and its context exclusions", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills })
    try {
      await completePlan(vm, items("a", "b"))
      while (vm.committed.status !== "failed" && vm.committed.status !== "completed") {
        const prepared = await vm.drive({ type: "START" })
        if (prepared.command.kind !== "prepare_attempt") break
        const { attemptId } = prepared.command.attempt
        if (attemptId !== attemptOf(stage(2, 1))) {
          await runPrepared(vm, prepared, { summary: "done" })
          continue
        }
        await vm.drive({ type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation-${attemptId}` })
        await vm.failHandoff()
      }
      const rows = vm.store.read({}).length
      const files = fs.readdirSync(path.join(vm.root, ".flywheel")).toSorted()

      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(0)
      const report = out.join("\n")
      expect(report).toContain(`Workflow: ${vm.sessionId}\nWorkflow: mapped\nControl: replays, status failed`)
      expect(report).toContain("Result: ")
      expect(report).toContain([
        "Tree:",
        `  Plan [phase ${PLAN}:phase]: completed`,
        `    Plan [agent ${PLAN}]: completed`,
        `  Implement [phase ${MAP_GROUP}:phase:1]: completed`,
        `    Implement · Item a [agent ${stage(1, 1)}]: completed`,
        `    Implement · Item b [agent ${stage(2, 1)}]: failed. summary is required`,
        `  Review [phase ${MAP_GROUP}:phase:2]: completed`,
        "    Join collect@1: settled, 2 items: 1 completed, 1 failed, 0 not finished",
        `    Review · Item a [agent ${stage(1, 2)}]: completed`,
        `    Review · Item b [agent ${stage(2, 2)}]: skipped. A required dependency cannot complete`,
        `  Tail [phase ${TAIL}:phase]: completed`,
        `    Tail [agent ${TAIL}]: completed`,
      ].join("\n"))
      expect(report).toContain(`Context exclusions:\n- entry ${attemptOf(stage(1, 1))}: item_evidence`)
      expect(report).toContain(`- entry ${attemptOf(stage(1, 2))}: folded_into_join`)
      // It wrote nothing: no fact, no log, no new file.
      expect(vm.store.read({}).length).toBe(rows)
      expect(fs.readdirSync(path.join(vm.root, ".flywheel")).toSorted()).toEqual(files)
    } finally {
      vm.close()
    }
  })

  it("prints the coverage of a coverage join with each tier's counts and the keys it did not reach", async () => {
    const targets = [
      { id: "a", priority: "required", report: "surveyed" },
      { id: "b", priority: "required", report: "fail" },
      { id: "c", priority: "supporting", report: "inaccessible" },
    ] as const
    const answer = surveyAnswer(targets, ["x"])
    const vm = new SqliteVmDriver({ workflow: surveyWorkflow, skills: mapSkills })
    try {
      await vm.initialize()
      while (vm.committed.status !== "failed" && vm.committed.status !== "completed") {
        const prepared = await vm.drive({ type: "START" })
        if (prepared.command.kind !== "prepare_attempt") break
        const { attemptId } = prepared.command.attempt
        const outcome = answer(attemptId)
        if ("handoff" in outcome) {
          await runPrepared(vm, prepared, { ...outcome.handoff })
          continue
        }
        await vm.drive({ type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation-${attemptId}` })
        await vm.failHandoff()
      }
      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(0)
      expect(out.join("\n")).toContain([
        `  Verify [phase ${SURVEY_GROUP}:phase:2]: completed`,
        "    Join coverage@1: settled, 3 items: 2 completed, 1 failed, 0 not finished",
        "    Coverage: partial, required 1 of 2, 1 unsurveyed",
        "      Required: 1 of 2 surveyed; unsurveyed: b",
        "      Supporting: 0 of 1 surveyed; unsurveyed: c",
        "      Inaccessible: c",
        "      Excluded: x",
        "      Failed: b",
      ].join("\n"))
    } finally {
      vm.close()
    }
  })

  it("prints what each selecting join kept and dropped, with each reason, from the recorded output", async () => {
    const vm = new SqliteVmDriver({ workflow: findingsWorkflow, skills: mapSkills, input: { files: FINDINGS_FILES } })
    try {
      await vm.initialize()
      while (vm.committed.status !== "failed" && vm.committed.status !== "completed") {
        const prepared = await vm.drive({ type: "START" })
        if (prepared.command.kind !== "prepare_attempt") break
        const { attemptId } = prepared.command.attempt
        const outcome = findingsAnswer(attemptId)
        if ("handoff" in outcome) {
          await runPrepared(vm, prepared, { ...outcome.handoff })
          continue
        }
        await vm.drive({ type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation-${attemptId}` })
        await vm.failHandoff()
      }
      expect(vm.committed.status).toBe("failed")
      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(0)
      const report = out.join("\n")
      expect(report).toContain([
        "    Join dedupe@2: settled, 3 items: 2 completed, 1 failed, 0 not finished",
        "    Selection: kept 2, dropped 1",
        "      Kept:",
        "        F1 from a.ts",
        "        F2 from a.ts",
        "      Dropped:",
        "        F1 from b.ts: duplicate of a.ts",
        "      Failed: c.ts",
      ].join("\n"))
      expect(report).toContain([
        "    Join quorum@1: settled, 2 items: 2 completed, 0 failed, 0 not finished",
        "    Selection: passed 1 of 2",
        "      Passed:",
        "        core: 1 valid, at least 1; 0 refuted, at most 0",
        "      Rejected:",
        "        ui: 0 valid, fewer than 1; 1 refuted, more than 0",
        "      Failed: none",
      ].join("\n"))
    } finally {
      vm.close()
    }
  })

  it("prints a loop over a map with each round, and labels each round's join with where the loop went", async () => {
    const vm = new SqliteVmDriver({ workflow: dryWorkflow(3), skills: mapSkills, input: { files: DRY_FILES } })
    try {
      await vm.initialize()
      while (vm.committed.status !== "completed") {
        const prepared = await vm.drive({ type: "START" })
        if (prepared.command.kind !== "prepare_attempt") break
        await runPrepared(vm, prepared, { ...dryAnswer(prepared.command.attempt.attemptId).handoff })
      }
      expect(vm.committed.status).toBe("completed")
      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(0)
      const report = out.join("\n")
      expect(report).toContain(`  Hunt [repeat ${DRY_LOOP}]: completed`)
      expect(report).toContain("Loop: round 3 of at most 3, dry")
      expect(report).toContain([
        `    Hunt [phase ${dryRound(2)}:phase:1]: completed`,
        "      Join dedupe@2 of round 2 → round 3: settled, 2 items: 2 completed, 0 failed, 0 not finished",
        "      Selection: kept 1, dropped 2",
      ].join("\n"))
      expect(report).toContain([
        `    Hunt [phase ${dryRound(3)}:phase:1]: completed`,
        "      Join dedupe@2 of round 3 → dry: settled, 2 items: 2 completed, 0 failed, 0 not finished",
        "      Selection: kept 0, dropped 2",
        "        Kept: none",
        "        Dropped:",
        "          F1 from a.ts: seen in round 1",
        "          F3 from b.ts: seen in round 2",
      ].join("\n"))
    } finally {
      vm.close()
    }
  })

  it("explores a wide list's replayed state through its sampled items instead of every order of outcomes", () => {
    // Every order of outcomes of 12 unfinished branches is more than the
    // exploration bound holds, so a person would wait minutes for a report
    // that proves nothing more.
    const control = startNext(wideControl(12))
    const report = verifyRecoveredWorkflow(control)
    const list = control.graph.nodes.find(({ kind }) => kind === "list")!

    expect(report.findings.map(({ name }) => name)).not.toContain("exploration_limit")
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ name: "terminal_reachable", target: "completed" })]))
    expect(report.uncertainties).toContainEqual({
      name: "sampled_branch_outcomes",
      target: list.id,
      detail: "The verifier explores every outcome of the last unfinished item of this list, success or failure of the item before it, and only success for the other items; every item runs the same phases.",
    })
  })

  it("prints a flat run's execution tree, and reports a session with no workflow facts as unsound", async () => {
    const vm = new SqliteVmDriver()
    try {
      await vm.initialize()
      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(0)
      expect(out.join("\n")).toContain("Tree:\n  Work [phase sqlite-acceptance:node:1:phase]: pending\n    Work [agent sqlite-acceptance:node:1]: pending, current\n  Review [phase sqlite-acceptance:node:2:phase]: pending")
      vm.store.append({ aggregateId: vm.aggregateId, sessionId: vm.sessionId, timestamp: Date.now(), ...buildWorkflowControlCommittedFact("wrong-proposal", { type: "START" }) })
      out = []
      expect(await runWorkflowVerify(["--workflow", vm.sessionId], testDirectories(vm.root))).toBe(1)
      expect(out.join("\n")).toContain("Control: cannot be replayed")
      expect(out.join("\n")).toContain("Tree:\n  Work [phase sqlite-acceptance:node:1:phase]: pending\n    Work [agent sqlite-acceptance:node:1]: pending")
      out = []
      expect(await runWorkflowVerify(["--workflow", "no-such-workflow"], testDirectories(vm.root))).toBe(1)
      expect(out.join("\n")).toBe("Workflow: no-such-workflow\nNo facts are stored for this workflow.")
      out = []
      expect(await runWorkflowVerify(["--workflow"], testDirectories(vm.root))).toBe(2)
      expect(out.join("\n")).toContain("Usage: flywheel workflow verify <workflow.yaml|workflow.json> | flywheel workflow verify --workflow <workflow-id>")
    } finally {
      vm.close()
    }
  })
})
