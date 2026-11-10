import { beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { createSkillTool } from "../../../../../src/orchestration/agent-runtime/tools/skill.js"
import { createFinalizeChildGrant, type FinalizeGroups } from "../../../../../src/orchestration/modules/experiments/finalize-child-run.js"
import { shippedDefinitionBundles } from "../../../../../src/orchestration/modules.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { readSkillPackageFiles } from "../../../../../src/workflows/skill-context.js"
import type { SkillDefinition } from "../../../../../src/workflows/skill-schema.js"
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js"
import { BUNDLED_SKILL_DIR } from "../../../../../src/workflows/skill-source-inventory.js"
import { loadSkillDefinitions } from "../../../../../src/workflows/skills.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
// The experiment skills ship in the experiments module's definition bundle, beside Flywheel's own methods.
const SKILL_ROOTS = [
  { authority: "bundled" as const, dir: BUNDLED_SKILL_DIR, reach: "global" as const, sourceKind: "agent" as const },
  ...shippedDefinitionBundles().map(({ id, root }) => ({ authority: "bundled" as const, dir: join(root, "skills"), reach: "global" as const, sourceKind: "module" as const, bundle: id })),
]
const EXPERIMENT_SKILLS = join(REPO_ROOT, "src", "orchestration", "modules", "experiments", "definitions", "skills")
const load = loadSkillDefinitions({ roots: SKILL_ROOTS })
const revision = publishSkillRevision(1, load.skills, load.bundledCorpus)
const charter = load.skills.get("experiment-charter")!
const finalize = load.skills.get("experiment-finalize")!
const scriptSource = readFileSync(join(EXPERIMENT_SKILLS, "experiment-finalize", "finalize.sh"), "utf8")
const loopRules = readFileSync(join(EXPERIMENT_SKILLS, "experiment-charter", "references", "loop-rules.md"), "utf8")

const HASH_A = "a".repeat(40)
const HASH_B = "b".repeat(40)
const groups: FinalizeGroups = {
  base: HASH_A,
  trunk: "main",
  final_tree: HASH_B,
  goal: "speed",
  groups: [{ title: "Faster parse", body: "Metric: 10ms -> 5ms (-50%)", last_commit: HASH_B, slug: "parse" }],
}

function result(stdout: string, exitCode: OwnedCommandResult["exitCode"] = 0, timedOut = false): OwnedCommandResult {
  return { exitCode, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout), timedOut }
}

function manifestSourced(skill: SkillDefinition): SkillDefinition {
  if (skill.source.kind !== "filesystem") throw new Error("bundled dev skills load from the source tree")
  const files = readSkillPackageFiles(skill.source, "bundled")!
  return { ...skill, source: { kind: "manifest", authority: "bundled", reach: "global", packageKey: skill.id, files } }
}

describe("experiment skill packages", () => {
  test("the charter skill is a section-by-section approval conversation that ends in one three-file commit", () => {
    for (const section of ["Objective", "Metrics", "Hard gates", "Anti-gaming rules", "Files in scope", "Protected paths", "Sealed paths", "Commands", "Baseline", "Search strategy"]) {
      expect(charter.body).toContain(`### ${section}`)
    }
    for (const key of ["name", "metric_name", "metric_unit", "direction", "measure_command", "checks_command", "work_dir", "max_iterations", "protected_paths", "sealed_paths"]) {
      expect(charter.body).toMatch(new RegExp(`^${key} = `, "m"))
    }
    expect(charter.body).toContain("approved by the person before the next section starts")
    expect(charter.body).toContain("Never write a file before the complete draft is approved")
    expect(charter.body).toContain("Run `./.experiment/measure.sh` once on the unchanged tree")
    expect(charter.body).toContain("`METRIC <metric_name>=<finite number>`")
    expect(charter.body).toContain("git add .experiment/charter.md .experiment/measure.sh .experiment/checks.sh")
    expect(charter.body).toContain("one commit holds exactly the three `.experiment` files on a clean tree")
    expect(charter.body).toContain("`checkpoint_replace`")
    expect(charter.body).toContain("/experiment dashboard")
    expect(charter.body).not.toMatch(/\.auto\b|log\.jsonl|ideas\.md|prompt\.md|config\.json/)
    expect(charter.body).not.toContain("init_experiment` →")
  })

  test("the experiment loop resolves metrics by explicit precedence without changing its lifetime", () => {
    expect(loopRules).toContain("Hard gates take precedence")
    expect(loopRules).toContain("charter's explicit tradeoffs")
    expect(loopRules).toContain("meaningful beyond measurement noise")
    expect(loopRules).toContain("equal primary-metric performance")
    expect(loopRules).toContain("LOOP FOREVER")
    expect(loopRules).toContain("NEVER STOP")
    expect(loopRules).not.toContain("Worse or equal means `discard`")
  })

  test("the finalize skill reads complete position-ordered store facts and freezes the groups before approval", () => {
    expect(finalize.resources.map(({ path }) => path)).toEqual(["finalize.sh", "references/groups-json.md"])
    expect(finalize.body).toContain("flywheel events search --type experiment.run.recorded --json --limit 0 --session <sessionId>")
    expect(finalize.body).toContain("Keep only rows whose `source` is `store`")
    expect(finalize.body).toContain("Sort the rows by `position` ascending; timestamps are not the order")
    expect(finalize.body).toContain("freeze")
    expect(finalize.body).toContain("run exactly the frozen JSON; do not recompute it")
    expect(finalize.body).toContain('`action:"child-run"`, `skill_id:"experiment-finalize"`, `script:"finalize.sh"`')
    expect(finalize.body).not.toMatch(/\.auto\b|jsonl|SKILL_DIR|\/tmp/)
  })

  test("the finalizer script excludes only the .experiment folder and names experiment branches", () => {
    expect(scriptSource).toContain("*/.experiment/*) return 0;;")
    expect(scriptSource).not.toContain(".auto")
    expect(scriptSource).toMatch(/branch_name="experiment\/\$\{GOAL\}\/\$\{group_number\}-\$\{slug\}"/)
    expect(scriptSource).toContain('rm -r .experiment')
  })

  test("no shipped experiment skill file carries the upstream attribution word", () => {
    const files = [
      charter.body,
      finalize.body,
      scriptSource,
      readFileSync(join(REPO_ROOT, "src", "orchestration", "modules", "experiments", "finalize-child-run.ts"), "utf8"),
    ]
    // Spelled in two halves so this test file itself passes the ledger word check.
    const word = ["auto", "research"].join("")
    for (const text of files) expect(text.toLowerCase()).not.toContain(word)
  })
})

describe("createFinalizeChildGrant", () => {
  const temporaryDirectory = temporaryDirectories()
  let scratchDir: string
  beforeEach(() => {
    scratchDir = temporaryDirectory("experiment-finalize-")
  })

  function grantWith(skill: SkillDefinition | undefined, run: OwnedCommandRunner) {
    return createFinalizeChildGrant({ resolveSkill: (id) => (id === "experiment-finalize" ? skill : undefined), scratchDir, workDir: "/work/tree", runOwnedCommand: run })
  }

  async function expectMaterializedRun(skill: SkillDefinition) {
    const calls: Array<{ command: readonly string[]; options: Parameters<OwnedCommandRunner>[1] }> = []
    const grant = grantWith(skill, async (command, options) => {
      calls.push({ command, options })
      return result("═══ Summary ═══\n")
    })
    expect(grant.skillIds).toEqual(["experiment-finalize"])

    const output = await grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: groups })

    const scriptPath = join(scratchDir, "experiment-finalize", "finalize.sh")
    const groupsPath = join(scratchDir, "experiment-finalize", "groups.json")
    expect(calls).toEqual([{ command: ["bash", scriptPath, groupsPath], options: { cwd: "/work/tree", timeoutMs: 600_000 } }])
    expect(readFileSync(scriptPath, "utf8")).toBe(scriptSource)
    expect(JSON.parse(readFileSync(groupsPath, "utf8"))).toEqual(groups)
    expect(output).toEqual({ skillId: "experiment-finalize", output: { exitCode: 0, stdout: "═══ Summary ═══\n", stderr: "" } })
  }

  test("materializes the exact source-tree script bytes and approved groups, then runs bash through the owned runner", async () => {
    await expectMaterializedRun(finalize)
  })

  test("materializes the exact embedded-manifest script bytes the same way", async () => {
    await expectMaterializedRun(manifestSourced(finalize))
  })

  test("refuses another skill, another script, or an unapproved groups shape before writing anything", async () => {
    let launched = 0
    const grant = grantWith(finalize, async () => {
      launched++
      return result("")
    })
    await expect(grant.run({ skillId: "ship", script: "finalize.sh", input: groups })).rejects.toThrow('Child skill "ship" is not granted')
    await expect(grant.run({ skillId: "experiment-finalize", script: "SKILL.md", input: groups })).rejects.toThrow('grants only "finalize.sh"')
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: { ...groups, extra: 1 } })).rejects.toThrow()
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: { ...groups, base: "abc1234" } })).rejects.toThrow()
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: { ...groups, goal: "Bad Slug" } })).rejects.toThrow()
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: { ...groups, groups: [] } })).rejects.toThrow()
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: "groups" })).rejects.toThrow()
    expect(launched).toBe(0)
    expect(() => readFileSync(join(scratchDir, "experiment-finalize", "finalize.sh"))).toThrow()
  })

  test("refuses a package whose bytes no longer match the admitted identity", async () => {
    const tampered: SkillDefinition = { ...finalize, packageIdentity: { sha256: "0".repeat(64), bytes: finalize.packageIdentity.bytes } }
    const grant = grantWith(tampered, async () => result(""))
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: groups })).rejects.toThrow("changed after admission")
  })

  test("refuses when the bundled package is absent", async () => {
    const grant = grantWith(undefined, async () => result(""))
    await expect(grant.run({ skillId: "experiment-finalize", script: "finalize.sh", input: groups })).rejects.toThrow("is not installed")
  })

  test("reports a failed or timed out script with its own output", async () => {
    const failing = grantWith(finalize, async () => ({ ...result("preflight", 1), stderr: "ERROR: Detached HEAD" }))
    await expect(failing.run({ skillId: "experiment-finalize", script: "finalize.sh", input: groups })).rejects.toThrow("finalize.sh exited with code 1.\npreflight\nERROR: Detached HEAD")
    const slow = grantWith(finalize, async () => result("stuck", null, true))
    await expect(slow.run({ skillId: "experiment-finalize", script: "finalize.sh", input: groups })).rejects.toThrow("finalize.sh timed out.\nstuck")
  })

  test("the skill tool routes child-run through the grant and refuses ungranted ids by name", async () => {
    const seen: string[] = []
    const grant = grantWith(finalize, async (command) => {
      seen.push(command[0]!)
      return result("done")
    })
    const tool = createSkillTool({ treeCapabilities: () => true, availability: { skills: new Map(), availablePersonas: repoDefinitions().personas() }, revision, childGrant: grant })

    const context = makeContext()
    const refused = await tool.execute({ action: "child-run", skill_id: "ship", script: "finalize.sh", input: groups }, context)
    expect(refused.outcome).toBe("error")
    expect(refused.content).toContain('Child skill "ship" is not granted. Granted child skills: experiment-finalize')
    const unnamed = await tool.execute({ action: "child-run", script: "finalize.sh", input: groups }, context)
    expect(unnamed.outcome).toBe("error")

    const ok = await tool.execute({ action: "child-run", skill_id: "experiment-finalize", script: "finalize.sh", input: groups }, context)
    expect(ok.outcome).toBe("ok")
    expect(JSON.parse(String(ok.content))).toEqual({ skillId: "experiment-finalize", output: { exitCode: 0, stdout: "done", stderr: "" } })
    expect(seen).toEqual(["bash"])
  })
})
