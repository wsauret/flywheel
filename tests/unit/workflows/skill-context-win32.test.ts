import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setContainedDirectoryBackendForTests } from "../../../src/infra/descriptor-directory.js";
import { win32ContainedDirectoryBackend } from "../../../src/infra/descriptor-directory-win32.js";
import { readSkillResource, withSkillRoot } from "../../../src/workflows/skill-context.js";
import { loadSkillDefinitions } from "../../../src/workflows/skills.js";
import { testSkill } from "../../helpers/skill-fixtures.js";

let workspace: string;
let root: string;
let packageDir: string;

beforeEach(() => {
  setContainedDirectoryBackendForTests(win32ContainedDirectoryBackend);
  workspace = mkdtempSync(join(tmpdir(), "flywheel skill context win32-"));
  root = join(workspace, "skills");
  packageDir = join(root, "package");
  mkdirSync(join(packageDir, "references"), { recursive: true });
  writeFileSync(join(packageDir, "SKILL.md"), "---\ndescription: package\n---\nBody");
  writeFileSync(join(packageDir, "references", "api.md"), "contained");
});

afterEach(() => {
  setContainedDirectoryBackendForTests(undefined);
  rmSync(workspace, { recursive: true, force: true });
});

describe("skill containment on the Windows backend", () => {
  it("lists a link as a candidate and binds it to its target", () => {
    const linked = join(workspace, "linked");
    mkdirSync(linked);
    symlinkSync(linked, join(root, "linked"));

    expect(withSkillRoot(root, (directory) => directory.listPackageDirs(10))).toEqual(["linked", "package"]);
    expect(withSkillRoot(root, (directory) => directory.bindPackage("linked"))).toMatchObject({ canonicalDir: realpathSync(linked), linked: true });
  });

  it("refuses a resource that becomes a link outside its package", () => {
    const skill = loadSkillDefinitions({ roots: [{ authority: "external", dir: root, reach: "project" }] }).skills.get("package");
    if (!skill) throw new Error("fixture skill failed to load");
    const outside = join(workspace, "outside.md");
    writeFileSync(outside, "outside");
    unlinkSync(join(packageDir, "references", "api.md"));
    symlinkSync(outside, join(packageDir, "references", "api.md"));

    expect(() => readSkillResource(skill, "references/api.md", 0, 64)).toThrow("escapes its package");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("refuses a package path replaced after it was bound", () => {
    const binding = withSkillRoot(root, (directory) => {
      const result = directory.bindPackage("package");
      if (!result) throw new Error("fixture package failed to bind");
      return result;
    });
    const moved = join(workspace, "moved");
    rmSync(packageDir, { recursive: true, force: true });
    mkdirSync(join(packageDir, "references"), { recursive: true });
    writeFileSync(join(packageDir, "SKILL.md"), "---\ndescription: decoy\n---\nDecoy");
    writeFileSync(join(packageDir, "references", "api.md"), "decoy");
    renameSync(packageDir, moved);
    mkdirSync(packageDir);

    expect(() => readSkillResource(testSkill("package", {
      body: "Body",
      resources: [{ path: "references/api.md", bytes: 9 }],
      source: { kind: "filesystem", authority: "external", reach: "project", packageDir, ...binding },
    }), "references/api.md", 0, 64)).toThrow("escapes its package");
  });
});
