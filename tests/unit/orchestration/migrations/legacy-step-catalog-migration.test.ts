import { describe, expect, test } from "bun:test"
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { migrateLegacyStepCatalog, type MigrationStage } from "../../../../src/orchestration/modules/workflows/migrations/legacy-step-catalog-filesystem.js"
import { tryWithPackageLocksSync } from "../../../../src/infra/package-directory-lock.js"
import { loadSkillDefinitions } from "../../../../src/workflows/skills.js"
import type { SkillDefinition } from "../../../../src/workflows/skill-schema.js"
import type { ProjectDirectories } from "../../../../src/infra/directory-authorities.js"

const STEP_ID = "flywheel.plan-create"
const STEP_BODY = "Write the spec.\n\n## Method\n\nRead the code first.\n"

interface Workspace {
  readonly base: string
  /** The directory authorities startup publishes for this workspace. */
  readonly directories: ProjectDirectories
  /** Legacy overlay root under the account data root. */
  readonly userRoot: string
  /** Legacy overlay root under the project. */
  readonly projectRoot: string
}

const temporaryDirectory = temporaryDirectories()

function newWorkspace(): Workspace {
  const base = temporaryDirectory("legacy-step-catalog-")
  const home = join(base, "home")
  const project = join(base, "project")
  const userRoot = join(home, ".flywheel")
  const projectRoot = join(project, ".flywheel")
  mkdirSync(userRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  return { base, directories: { projectRoot: project, accountHome: home, userDataRoot: userRoot }, userRoot, projectRoot }
}

function legacyStepFile(name = "Create Plan"): string {
  return [
    "---",
    `name: ${name}`,
    "description: Turn a settled design into a spec.",
    "handoff: plan-handoff",
    "handoffFilename: plan.md",
    "writes:",
    "  - id: plan",
    "    lifetime: durable",
    "    supersedes: []",
    "settings:",
    "  selfReview: false",
    "  toolScoping:",
    "    read: true",
    "    bash: false",
    "requiredSkills:",
    "  - planning",
    "agents:",
    "  - explorer",
    "inline-output: Write the spec to docs/plans/<name>.md.",
    "disable-model-invocation: true",
    "---",
    STEP_BODY,
  ].join("\n")
}

function writeStep(root: string, id: string, content = legacyStepFile(), mode = 0o644): string {
  const [group, name] = id.split(".")
  const dir = join(root, "steps", group ?? "")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.md`)
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

function legacyWorkflow(stepRefs: readonly string[] = [STEP_ID]): string {
  return [
    "id: overlay-flow",
    "name: Overlay Flow",
    "description: One overlay workflow.",
    "steps:",
    ...stepRefs.map((ref) => `  - step: ${ref}`),
  ].join("\n") + "\n"
}

function writeWorkflow(root: string, content = legacyWorkflow(), file = "overlay-flow.yaml", mode = 0o644): string {
  const dir = join(root, "workflows")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

function installPackage(root: string, id: string, description: string): void {
  mkdirSync(join(root, "skills", id), { recursive: true })
  writeFileSync(join(root, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nInstalled body.\n`)
}

function migrate(workspace: Workspace, onStage?: (stage: MigrationStage) => void): ReturnType<typeof migrateLegacyStepCatalog> {
  return migrateLegacyStepCatalog(workspace.directories, onStage ? { onStage } : {})
}

function readSkill(root: string, id: string): string {
  return readFileSync(join(root, "skills", id, "SKILL.md"), "utf8")
}

function selectSkill(roots: readonly string[], bundled: string, id: string): SkillDefinition | undefined {
  installPackage(bundled, "planning", "Planning dependency")
  return loadSkillDefinitions({
    roots: [
      ...roots.map((dir) => ({ authority: "external" as const, dir: join(dir, "skills"), reach: "project" as const })),
      { authority: "bundled" as const, dir: join(bundled, "skills"), reach: "global" as const, sourceKind: "agent" as const },
    ],
  }).skills.get(id)
}

describe("legacy step catalog migration", () => {
  test.each(["userRoot", "projectRoot"] as const)("migrates a step in %s while leaving its workflow bytes unchanged", (layer) => {
    const workspace = newWorkspace()
    const root = workspace[layer]
    const source = writeStep(root, STEP_ID)
    const workflowPath = writeWorkflow(root, `# Keep formatting and comments.\r\n${legacyWorkflow()}`)
    const workflowBytes = readFileSync(workflowPath)

    const report = migrate(workspace)

    expect(report.conflicts).toEqual([])
    expect(report.published).toEqual([`${layer === "userRoot" ? "user" : "project"}:${STEP_ID}`])
    expect(existsSync(source)).toBe(false)

    const skillFile = readSkill(root, STEP_ID)
    expect(skillFile).toContain("name: Create Plan")
    expect(skillFile).toContain("description: Turn a settled design into a spec.")
    expect(skillFile).toContain("direct-output: Write the spec to docs/plans/<name>.md.")
    expect(skillFile).toContain("disable-model-invocation: true")
    expect(skillFile).toContain("- planning")
    expect(skillFile).toContain("- explorer")
    expect(skillFile).not.toContain("handoff")
    expect(skillFile).not.toContain("selfReview")
    expect(skillFile.endsWith(STEP_BODY)).toBe(true)

    expect(readFileSync(workflowPath)).toEqual(workflowBytes)
  })

  test("preserves the loaded skill contract of the migrated package", () => {
    const workspace = newWorkspace()
    writeStep(workspace.userRoot, STEP_ID)
    migrate(workspace)

    const skill = selectSkill([workspace.userRoot], workspace.projectRoot, STEP_ID)
    expect(skill?.name).toBe("Create Plan")
    expect(skill?.directOutput).toBe("Write the spec to docs/plans/<name>.md.")
    expect(skill?.dependencies).toEqual(["planning"])
    expect(skill?.agents).toEqual(["explorer"])
    expect(skill?.modelInvocable).toBe(false)
    expect(skill?.body).toBe(STEP_BODY)
  })

  test("migrates a project step beside a bundled package of the same id", () => {
    const workspace = newWorkspace()
    const bundled = join(workspace.base, "bundled")
    installPackage(bundled, STEP_ID, "The bundled definition.")
    writeStep(workspace.projectRoot, STEP_ID)

    expect(migrate(workspace).published).toEqual([`project:${STEP_ID}`])

    const selected = selectSkill([workspace.projectRoot], bundled, STEP_ID)
    expect(selected?.name).toBe("Create Plan")
    expect(selected?.shadowed?.source.authority).toBe("bundled")
  })

  test("migrates one id in every layer and keeps project over user over bundled", () => {
    const workspace = newWorkspace()
    const bundled = join(workspace.base, "bundled")
    installPackage(bundled, STEP_ID, "The bundled definition.")
    writeStep(workspace.userRoot, STEP_ID, legacyStepFile("User Plan"))
    writeStep(workspace.projectRoot, STEP_ID, legacyStepFile("Project Plan"))

    const report = migrate(workspace)
    expect(report.published).toEqual([`user:${STEP_ID}`, `project:${STEP_ID}`])
    expect(readSkill(workspace.userRoot, STEP_ID)).toContain("name: User Plan")
    expect(readSkill(workspace.projectRoot, STEP_ID)).toContain("name: Project Plan")

    const selected = selectSkill([workspace.projectRoot, workspace.userRoot], bundled, STEP_ID)
    expect(selected?.name).toBe("Project Plan")
    expect(selected?.shadowed?.source.kind).toBe("filesystem")
  })

  test("migrates a step whose id a lower layer already installs as a package", () => {
    const workspace = newWorkspace()
    installPackage(workspace.projectRoot, STEP_ID, "The project shadow.")
    writeStep(workspace.userRoot, STEP_ID)

    const report = migrate(workspace)
    expect(report.conflicts).toEqual([])
    expect(report.published).toEqual([`user:${STEP_ID}`])
    expect(readSkill(workspace.projectRoot, STEP_ID)).toContain("The project shadow.")
  })

  test("blocks the root when the exact destination holds a different package", () => {
    const workspace = newWorkspace()
    installPackage(workspace.userRoot, STEP_ID, "Another package of this id.")
    const source = writeStep(workspace.userRoot, STEP_ID)
    writeWorkflow(workspace.userRoot)

    const report = migrate(workspace)
    expect(report.published).toEqual([])
    expect(report.conflicts.join(" ")).toContain("already holds a different package")
    expect(existsSync(source)).toBe(true)
    expect(readSkill(workspace.userRoot, STEP_ID)).toContain("Another package of this id.")
    expect(readFileSync(join(workspace.userRoot, "workflows", "overlay-flow.yaml"), "utf8")).toBe(legacyWorkflow())
  })

  test("resumes idempotently when the destination already holds the exact target", () => {
    const workspace = newWorkspace()
    writeStep(workspace.userRoot, STEP_ID)
    writeWorkflow(workspace.userRoot)
    migrate(workspace)
    const published = readSkill(workspace.userRoot, STEP_ID)
    const workflow = readFileSync(join(workspace.userRoot, "workflows", "overlay-flow.yaml"), "utf8")

    const second = migrate(workspace)
    expect(second.published).toEqual([])
    expect(second.conflicts).toEqual([])
    expect(readSkill(workspace.userRoot, STEP_ID)).toBe(published)
    expect(readFileSync(join(workspace.userRoot, "workflows", "overlay-flow.yaml"), "utf8")).toBe(workflow)
  })

  test("blocks the root when a legacy file name is not a qualified id segment", () => {
    const workspace = newWorkspace()
    mkdirSync(join(workspace.userRoot, "steps", "flywheel"), { recursive: true })
    writeFileSync(join(workspace.userRoot, "steps", "flywheel", "..md"), legacyStepFile())

    const report = migrate(workspace)
    expect(report.published).toEqual([])
    expect(report.conflicts.join(" ")).toContain("not a legacy step file name")
  })

  test("fails closed on a symlinked legacy source directory", () => {
    const workspace = newWorkspace()
    const elsewhere = join(workspace.base, "elsewhere")
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, "plan-create.md"), legacyStepFile())
    mkdirSync(join(workspace.userRoot, "steps"), { recursive: true })
    symlinkSync(elsewhere, join(workspace.userRoot, "steps", "flywheel"))

    const report = migrate(workspace)
    expect(report.published).toEqual([])
    expect(report.conflicts.join(" ")).toContain("is a symlink")
  })

  test("fails closed on a symlinked destination package directory", () => {
    const workspace = newWorkspace()
    const elsewhere = join(workspace.base, "elsewhere")
    installPackage(elsewhere, STEP_ID, "Outside the store.")
    mkdirSync(join(workspace.userRoot, "skills"), { recursive: true })
    symlinkSync(join(elsewhere, "skills", STEP_ID), join(workspace.userRoot, "skills", STEP_ID))
    const source = writeStep(workspace.userRoot, STEP_ID)

    const report = migrate(workspace)
    expect(report.published).toEqual([])
    expect(report.conflicts.join(" ")).toContain("holds a different package")
    expect(existsSync(source)).toBe(true)
  })

  test("rebuilds incomplete staging instead of publishing it", () => {
    const workspace = newWorkspace()
    writeStep(workspace.userRoot, STEP_ID)
    const staged = join(workspace.userRoot, ".legacy-step-migration", "skills", STEP_ID)
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, "SKILL.md"), "---\nname: torn\n")

    expect(migrate(workspace).published).toEqual([`user:${STEP_ID}`])
    expect(readSkill(workspace.userRoot, STEP_ID)).toContain("name: Create Plan")
    expect(existsSync(join(workspace.userRoot, ".legacy-step-migration"))).toBe(false)
  })

  // umask and mode bits belong to POSIX. Windows keeps neither, so this case
  // would assert Node's emulation instead of what the migration preserves.
  test.skipIf(process.platform === "win32").each([0o000, 0o077])("preserves the source file mode under umask %s", (mask) => {
    const workspace = newWorkspace()
    writeStep(workspace.userRoot, STEP_ID, legacyStepFile(), 0o640)
    const previous = process.umask(mask)
    try {
      expect(migrate(workspace).published).toEqual([`user:${STEP_ID}`])
    } finally {
      process.umask(previous)
    }
    if (POSIX_FILE_MODES) expect(lstatSync(join(workspace.userRoot, "skills", STEP_ID, "SKILL.md")).mode & 0o777).toBe(0o640)
    if (POSIX_FILE_MODES) expect(lstatSync(join(workspace.userRoot, "skills", STEP_ID)).mode & 0o777).toBe(0o700)
  })

  test("leaves a root another owner holds", () => {
    const workspace = newWorkspace()
    const source = writeStep(workspace.userRoot, STEP_ID)

    let report: ReturnType<typeof migrateLegacyStepCatalog> | undefined
    const ran = tryWithPackageLocksSync([join(workspace.userRoot, "skills", STEP_ID)], () => {
      report = migrate(workspace)
    })

    expect(ran).toBe(true)
    expect(report?.deferred).toEqual([workspace.userRoot])
    expect(report?.published).toEqual([])
    expect(existsSync(source)).toBe(true)
  })

  const boundaries: MigrationStage["kind"][] = ["staged", "package-published", "verified", "retired"]

  test.each(boundaries)("restarts to one complete result after an interruption at %s", (kind) => {
    const workspace = newWorkspace()
    const source = writeStep(workspace.userRoot, STEP_ID)
    writeWorkflow(workspace.userRoot)

    expect(() => migrate(workspace, (stage) => {
      if (stage.kind === kind) throw new Error(`interrupted at ${kind}`)
    })).toThrow(`interrupted at ${kind}`)
    // Nothing is retired before every target is verified, so an interruption
    // before the retirement boundary must leave the legacy source in place.
    if (kind !== "retired") expect(existsSync(source)).toBe(true)

    const report = migrate(workspace)
    expect(report.conflicts).toEqual([])
    expect(existsSync(source)).toBe(false)
    // One package, published once: the lock area beside it is not a package.
    expect(readdirSync(join(workspace.userRoot, "skills")).filter((entry) => entry !== ".locks")).toEqual([STEP_ID])
    expect(readSkill(workspace.userRoot, STEP_ID)).toContain("name: Create Plan")
    expect(readFileSync(join(workspace.userRoot, "workflows", "overlay-flow.yaml"), "utf8")).toBe(legacyWorkflow())
    expect(existsSync(join(workspace.userRoot, ".legacy-step-migration"))).toBe(false)
  })

  test("converts the skill even when a retained workflow would not decode", () => {
    const workspace = newWorkspace()
    const source = writeStep(workspace.userRoot, STEP_ID)
    const workflow = [
      "id: overlay-flow",
      "name: Overlay Flow",
      "confirmation_template: plan-and-implement",
      "steps:",
      `  - step: ${STEP_ID}`,
    ].join("\n") + "\n"
    const workflowPath = writeWorkflow(workspace.userRoot, workflow)

    const report = migrate(workspace)
    expect(report.published).toEqual([`user:${STEP_ID}`])
    expect(report.conflicts).toEqual([])
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(workflowPath, "utf8")).toBe(workflow)
  })
})
