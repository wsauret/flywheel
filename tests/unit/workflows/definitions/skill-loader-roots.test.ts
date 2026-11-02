import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainedPathError, type ContainedDirectoryContract } from "../../../../src/infra/descriptor-directory.js";
import type { SkillDirectoryEntry } from "../../../../src/workflows/skill-context.js";
import { SKILL_LIMITS } from "../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions } from "../../../../src/workflows/skills.js";

const TMP = mkdtempSync(join(tmpdir(), "flywheel-skill-root-test-"));
const USER_ROOT = join(TMP, "installed-skills");
const SHARED_ROOT = join(TMP, "later-skills");
const VALID_SKILL = "---\ndescription: Process PDF files\n---\nRead the PDF.";

function writeSkill(root: string, dirName: string, md: string): void {
  mkdirSync(join(root, dirName), { recursive: true });
  writeFileSync(join(root, dirName, "SKILL.md"), md);
}

function external(...dirs: string[]) {
  return { roots: dirs.map((dir) => ({ authority: "external" as const, dir, reach: "project" as const })) };
}

function containedEntries(directory: ContainedDirectoryContract): SkillDirectoryEntry[] {
  const directories = new Set(directory.directoryEntryNames());
  return directory.entryNames().map((name) => {
    if (directories.has(name)) return { name, type: "directory" };
    try {
      directory.regularFileModifiedAt(name);
      return { name, type: "file" };
    } catch (error) {
      if (error instanceof ContainedPathError) return { name, type: "symlink" };
      throw error;
    }
  });
}

let packageLimitRoot: string | undefined;

/** Limit cases read the same real packages; only the traversal case adds one. */
function packageLimitFixture(): string {
  if (packageLimitRoot) return packageLimitRoot;
  packageLimitRoot = join(TMP, "package-limit");
  for (let index = 0; index <= SKILL_LIMITS.packages; index++) {
    writeSkill(packageLimitRoot, `pkg-${String(index).padStart(4, "0")}`, VALID_SKILL);
  }
  return packageLimitRoot;
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("skill root admission", () => {
  it("admits no more external packages than the limit", () => {
    const load = loadSkillDefinitions(external(packageLimitFixture()));

    expect(load.skills.size).toBe(SKILL_LIMITS.packages);
    expect(load.failedSelectionIds.size).toBe(1);
  });

  it("refuses the package over the limit without reading it, and never opens a later root", () => {
    const root = packageLimitFixture();
    writeSkill(SHARED_ROOT, "shared-extra", VALID_SKILL);
    chmodSync(SHARED_ROOT, 0o000);
    let scans = 0;
    const countScans = (directory: ContainedDirectoryContract): Iterable<SkillDirectoryEntry> => {
      scans++;
      return containedEntries(directory);
    };

    try {
      const load = loadSkillDefinitions({ ...external(root, SHARED_ROOT), entriesOf: countScans });

      // One listing of the root, one resource walk per admitted package, and
      // nothing at all for the package the limit refuses.
      expect(scans).toBe(SKILL_LIMITS.packages + 1);
      expect(load.skills.size).toBe(SKILL_LIMITS.packages);
      expect([...load.failedSelectionIds]).toEqual(["pkg-0256"]);
      // The limit is already spent, so the unreadable second root is never
      // opened and never reported: no package under it could be admitted.
      expect(load.unreadableRoots).toEqual([]);
    } finally {
      chmodSync(SHARED_ROOT, 0o755);
    }
  });

  it("refuses a root whose configured path is repointed while it is being listed", () => {
    writeSkill(USER_ROOT, "alpha", "---\ndescription: Installed copy\n---\nInstalled body.");
    const decoy = join(TMP, "decoy-root");
    writeSkill(decoy, "alpha", "---\ndescription: Decoy copy\n---\nDecoy body.");

    // The listing is read from the root descriptor, so it names the packages
    // that were installed; serving them as the contents of a path that now
    // points at another tree would publish neither install faithfully.
    let repointed = false;
    function* repointThenList(directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      if (!repointed) {
        repointed = true;
        renameSync(USER_ROOT, join(TMP, "moved-root"));
        symlinkSync(decoy, USER_ROOT);
      }
      yield* containedEntries(directory);
    }

    const load = loadSkillDefinitions({ ...external(USER_ROOT), entriesOf: repointThenList });

    expect(load.skills.size).toBe(0);
    expect(load.unreadableRoots).toEqual([USER_ROOT]);
  });

  it("stops listing a skill root at the package bound instead of examining every entry", () => {
    // One directory past the limit is enough to refuse the load; the rest of
    // the root is never examined, so a root of any size costs the same walk.
    const root = packageLimitFixture();
    const extra = `pkg-${String(SKILL_LIMITS.packages + 1).padStart(4, "0")}`;
    writeSkill(root, extra, VALID_SKILL);
    try {
      const load = loadSkillDefinitions(external(root));

      expect(load.skills.size).toBe(SKILL_LIMITS.packages);
      expect(load.failedSelectionIds.size).toBe(1);
    } finally {
      rmSync(join(root, extra), { recursive: true, force: true });
    }
  });

  it("refuses a skill root that spends the entry budget before it reaches the package bound", () => {
    // Reading a root the listing could not finish as "no skills installed"
    // would publish the removal of every package under it.
    const loose = join(TMP, "loose-root");
    mkdirSync(loose, { recursive: true });
    for (let index = 0; index <= SKILL_LIMITS.scanEntries; index++) {
      writeFileSync(join(loose, `note-${index}.md`), "x");
    }

    const load = loadSkillDefinitions(external(loose));

    expect(load.unreadableRoots).toEqual([loose]);
    expect(load.skills.size).toBe(0);
  });
});
