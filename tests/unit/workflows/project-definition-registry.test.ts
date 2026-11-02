import { afterEach, describe, expect, test } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../helpers/posix-failure-staging.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectDefinitionRegistry, definitionRoots } from "../../../src/workflows/definition-registry.js";
import { watchDefinitionRoots } from "../../../src/orchestration/app-service/definition-root-watcher.js";
import type { SkillStoreRoot } from "../../../src/workflows/skills.js";
import { testDirectories } from "../../helpers/directories.js";
import type { AgentDefinition } from "../../../src/infra/agent-definition.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-definition-registry-"));
  created.push(dir);
  return dir;
}

function writeSkill(root: string, id: string, description: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nBody of ${id}.\n`);
}

/** Write one project workflow with one inline step that composes `skillId`. */
function writeWorkflow(projectRoot: string, id: string, phaseId: string, skillId: string): void {
  const dir = join(projectRoot, ".flywheel", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.yaml`),
    `id: ${id}\nname: ${id}\nphases:\n  - phase: ${phaseId}\n    name: ${phaseId}\n    brief: Do the ${phaseId} work.\n    dependencies: [${skillId}]\n`,
  );
}

function projectRoots(dir: string): readonly SkillStoreRoot[] {
  return [{ dir, owned: true, reach: "project" }];
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writePersona(projectRoot: string, requiredSkill: string): void {
  const dir = join(projectRoot, ".flywheel", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "late.md"), `---\nname: late\ndescription: Late persona\nrole: Late persona.\nexcludeActions: []\nrequiredSkills:\n  - ${requiredSkill}\n---\nLate persona.`);
}

function writePersonaFile(dir: string, name: string, role: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\nrole: ${role}\nexcludeActions: []\n---\n${name}.`);
}

function personaRole(definition: AgentDefinition | undefined): string | undefined {
  return definition?.kind === "persona" ? definition.role : undefined;
}
describe("createProjectDefinitionRegistry", () => {
  test("captures one deeply immutable project revision in constant time", () => {
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(tempDir()), skillRoots: projectRoots(tempDir()) });
    const revision = registry.captureRevision();

    expect(registry.captureRevision()).toBe(revision);
    expect(revision.skills).toBe(registry.skills());
    expect(revision.personas).toBe(revision.personaRevision.personas);
    expect(Object.isFrozen(revision)).toBe(true);
    expect("clear" in revision.personas).toBe(false);
  });

  test("two owners keep their own project definitions and share the global packages", () => {
    const one = tempDir();
    const other = tempDir();
    writePersonaFile(join(one, ".flywheel", "agents"), "only-here", "reviewer");

    const first = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(one), skillRoots: projectRoots(tempDir()) });
    const second = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(other), skillRoots: projectRoots(tempDir()) });

    expect(first.personas().has("only-here")).toBe(true);
    expect(second.personas().has("only-here")).toBe(false);
    expect(second.skills().skills.has("implementation")).toBe(true);
    expect(first.skills().skills.has("implementation")).toBe(true);
  });

  test("workflow files in the project's folder stay unchanged and do not enter the catalog", () => {
    const projectRoot = tempDir();
    writeWorkflow(projectRoot, "needs-skill-flow", "needs-skill", "never-installed");
    const kept = join(projectRoot, ".flywheel", "workflows", "needs-skill-flow.yaml");
    const before = readFileSync(kept);
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(projectRoot), skillRoots: projectRoots(tempDir()) });
    registry.reload();
    expect(registry.resolutions().some(({ selected }) => selected?.source.path === kept)).toBe(false);
    expect(readFileSync(kept)).toEqual(before);
  });

  test("a reload publishes the next revision for its owner only", () => {
    const skillRoot = tempDir();
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(tempDir()), skillRoots: projectRoots(skillRoot) });
    const other = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(tempDir()), skillRoots: projectRoots(tempDir()) });
    const before = registry.skills();
    expect(before.skills.has("late-arrival")).toBe(false);

    writeSkill(skillRoot, "late-arrival", "Installed after the owner was created.");
    registry.reload();

    expect(registry.skills().revision).toBe(before.revision + 1);
    expect(registry.skills().skills.has("late-arrival")).toBe(true);
    expect(before.skills.has("late-arrival")).toBe(false);
    expect(other.skills().skills.has("late-arrival")).toBe(false);
    expect(other.skills().revision).toBe(1);
  });

  test("the definition watch observes persona and skill roots but not workflow folders", async () => {
    const projectRoot = tempDir();
    const skillRoot = tempDir();
    writeSkill(skillRoot, "late-step", "Installed before the workflow that binds it.");
    const directories = { ...testDirectories(projectRoot), userDataRoot: tempDir() };
    const registry = createProjectDefinitionRegistry({ bundles: [], ...directories, skillRoots: projectRoots(skillRoot) });
    const roots = definitionRoots(directories, projectRoots(skillRoot));
    expect(roots.map(({ dir }) => dir)).toEqual([
      skillRoot,
      join(directories.projectRoot, ".flywheel", "agents"),
      join(directories.userDataRoot, "agents"),
    ]);
    const listeners = new Map<string, () => void>();
    const watch = watchDefinitionRoots({
      roots,
      debounceMs: 5,
      watchDirectory: (dir, listener) => {
        listeners.set(dir, listener);
        return { on: () => {}, unref: () => {}, close: () => {} };
      },
    });
    watch.bind({ reload: registry.reload });
    // The runtime composition extends a copy of the owner; the copy must read
    // the revision published after the reload, not the one it was made from.
    const composed = { ...registry };

    writePersonaFile(join(projectRoot, ".flywheel", "agents"), "late-persona", "reviewer");
    listeners.get(join(directories.projectRoot, ".flywheel", "agents"))?.();
    await Bun.sleep(15);

    expect(composed.personas().has("late-persona")).toBe(true);
    await watch.dispose();
  });

  test("a reload keeps a published persona whose file breaks, and skips a broken file that was never published", () => {
    const projectRoot = tempDir();
    const skillRoot = tempDir();
    writeSkill(skillRoot, "step", "Bound by the project workflow.");
    const personaDir = join(projectRoot, ".flywheel", "agents");
    writePersonaFile(personaDir, "own-reviewer", "reviewer-design");
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(projectRoot), skillRoots: projectRoots(skillRoot) });
    const published = registry.captureRevision();
    writeSkill(skillRoot, "late-arrival", "Saved beside the broken edit.");
    writeFileSync(join(personaDir, "own-reviewer.md"), "---\nname: own-reviewer\n");
    registry.reload();
    expect(registry.captureRevision()).toBe(published);

    writePersonaFile(personaDir, "own-reviewer", "reviewer-design");
    writeFileSync(join(personaDir, "never-loaded.md"), "---\nname: never-loaded\n");
    registry.reload();
    expect(registry.skills().skills.has("late-arrival")).toBe(true);
    expect(personaRole(registry.captureRevision().personas.get("own-reviewer"))).toBe("reviewer-design");
  });

  test("a reload pins built-in personas while publishing user and project personas", () => {
    const projectRoot = tempDir();
    const userDataRoot = tempDir();
    const bundledPersonaDir = tempDir();
    writePersonaFile(bundledPersonaDir, "reviewer-code-data-integrity", "reviewer");
    const registry = createProjectDefinitionRegistry({ bundles: [],
      ...testDirectories(projectRoot),
      userDataRoot,
      skillRoots: projectRoots(tempDir()),
      bundledPersonaDir,
    });

    expect(personaRole(registry.captureRevision().personas.get("reviewer-code-data-integrity"))).toBe("reviewer");

    writePersonaFile(bundledPersonaDir, "reviewer-code-data-integrity", "reviewer-data-integrity");
    writePersonaFile(join(userDataRoot, "agents"), "user-reviewer", "reviewer-quality");
    writePersonaFile(join(userDataRoot, "agents"), "layered-reviewer", "reviewer-security");
    writePersonaFile(join(projectRoot, ".flywheel", "agents"), "layered-reviewer", "reviewer-design");
    registry.reload();

    expect(personaRole(registry.captureRevision().personas.get("reviewer-code-data-integrity"))).toBe("reviewer");
    expect(personaRole(registry.captureRevision().personas.get("user-reviewer"))).toBe("reviewer-quality");
    expect(personaRole(registry.captureRevision().personas.get("layered-reviewer"))).toBe("reviewer-design");
  });

  test("a late candidate failure retains the exact published project revision", () => {
    const projectRoot = tempDir();
    const skillRoot = tempDir();
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(projectRoot), skillRoots: projectRoots(skillRoot) });
    const published = registry.captureRevision();
    writeSkill(skillRoot, "late-arrival", "Installed after publication.");
    writePersona(projectRoot, "missing-persona-skill");

    registry.reload();

    expect(registry.captureRevision()).toBe(published);
    expect(registry.skills().skills.has("late-arrival")).toBe(false);
  });

  test.skipIf(!POSIX_FAILURE_STAGING)("a reload that cannot read a root keeps the last complete revision", () => {
    const skillRoot = tempDir();
    writeSkill(skillRoot, "present", "Installed before the root became unreadable.");
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(tempDir()), skillRoots: projectRoots(skillRoot) });
    const published = registry.skills();

    chmodSync(skillRoot, 0o000);
    try {
      registry.reload();
    } finally {
      chmodSync(skillRoot, 0o755);
    }

    expect(registry.skills()).toBe(published);
    expect(registry.skills().skills.has("present")).toBe(true);
  });

  test("a skill named in a retained workflow file does not prevent skill removal", () => {
    const projectRoot = tempDir();
    const skillRoot = tempDir();
    writeSkill(skillRoot, "project-only", "Bound by the project workflow.");
    writeWorkflow(projectRoot, "needs-skill-flow", "needs-skill", "project-only");
    const registry = createProjectDefinitionRegistry({ bundles: [], ...testDirectories(projectRoot), skillRoots: projectRoots(skillRoot) });

    rmSync(join(skillRoot, "project-only"), { recursive: true, force: true });
    registry.reload();

    expect(registry.skills().skills.has("project-only")).toBe(false);
  });
});
