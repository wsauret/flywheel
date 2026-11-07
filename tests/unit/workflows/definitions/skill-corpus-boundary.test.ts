import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js";
import { DEVELOPMENT_MODULES } from "../../../../src/orchestration/development-modules.js";
import { bashModule } from "../../../../src/orchestration/modules/bash/module.js";
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js";
import {
  bundledCorpusIdentity,
  skillPackageManifestIdentity,
  publishSkillRevision,
  type BundledSkillPackage,
} from "../../../../src/workflows/skill-schema.js";
import { testDirectories, fileTemporaryDirectory } from "../../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-skill-corpus-boundary-test-");
const USER_ROOT = join(TMP, "skills");
const PROJECT_ROOT = join(TMP, "project");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(USER_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function bundled(id: string, sourceKind: "agent" | "module", sha256: string, bytes: number): BundledSkillPackage {
  return {
    id,
    sourceKind,
    authority: "bundled",
    files: [],
    packageIdentity: { sha256, bytes },
  };
}

describe("production core skill boundary", () => {
  it("identifies bundled packages in canonical id order", () => {
    const left = bundled("zeta", "module", "b".repeat(64), 12);
    const right = bundled("alpha", "agent", "a".repeat(64), 7);

    const first = bundledCorpusIdentity(new Map([[left.id, left], [right.id, right]]));
    const reordered = bundledCorpusIdentity(new Map([[right.id, right], [left.id, left]]));
    const changed = bundledCorpusIdentity(new Map([
      [right.id, { ...right, packageIdentity: { ...right.packageIdentity, bytes: 8 } }],
      [left.id, left],
    ]));

    expect(first).toEqual(reordered);
    expect(first).toEqual({ version: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 19 });
    expect(publishSkillRevision(1, new Map(), new Map([[left.id, left], [right.id, right]])).bundledCorpusIdentity).toEqual(first);
    expect(skillPackageManifestIdentity([
      { id: right.id, packageIdentity: right.packageIdentity },
      { id: left.id, packageIdentity: left.packageIdentity },
    ])).toEqual(first);
    expect(changed.sha256).not.toBe(first.sha256);
  });

  it("derives an immutable production core map from bundled ownership", () => {
    const revision = createProjectDefinitionRegistry({ bundles: [],
      ...testDirectories(PROJECT_ROOT),
      skillRoots: [{ dir: USER_ROOT, owned: true, reach: "global" }],
    }).skills();

    expect([...revision.corePackages.keys()].sort()).toEqual([
      "code-review", "code-review-method", "data-integrity-review-principles", "design", "elegance-review-principles",
      "implementation", "implementation-planning", "interface-design", "mechanism-verification", "performance-review-principles", "plan-review",
      "research", "root-cause-analysis", "security-review-principles", "ship", "surface-mapping",
      "systematic-debugging", "test-driven-development", "uat", "verification",
    ]);
    expect(revision.coreManifest.map(({ id }) => id)).toEqual([...revision.corePackages.keys()].sort());
    expect(revision.coreManifest.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(Object.isFrozen(revision.coreManifest)).toBe(true);
    expect("set" in revision.corePackages).toBe(false);
  });

  it("keeps a module bundle's packages in the bundled corpus and out of the core", () => {
    const revision = createProjectDefinitionRegistry({
      ...testDirectories(PROJECT_ROOT),
      skillRoots: [{ dir: USER_ROOT, owned: true, reach: "global" }],
      bundles: installedDefinitionBundles([bashModule, ...DEVELOPMENT_MODULES]),
    }).skills();

    for (const [id, bundle] of [["effect-lifecycle", "development"], ["worktree-lifecycle", "bash"]] as const) {
      const skill = revision.skills.get(id);
      expect(skill?.source.kind === "filesystem" ? skill.source.bundle : undefined).toBe(bundle);
      expect(revision.bundledCorpus.get(id)?.sourceKind).toBe("module");
      expect(revision.corePackages.has(id)).toBe(false);
    }
    expect(revision.corePackages.has("design")).toBe(true);
  });

  it("keeps source kind out of package and core identity", () => {
    const identity = { sha256: "a".repeat(64), bytes: 7 };
    const agent = bundled("core", "agent", identity.sha256, identity.bytes);
    const moduleOwned = { ...agent, id: "bundle", sourceKind: "module" as const };
    const first = publishSkillRevision(1, new Map(), new Map([[agent.id, agent], [moduleOwned.id, moduleOwned]]));
    const moduleChanged = publishSkillRevision(2, new Map(), new Map([
      [agent.id, agent],
      [moduleOwned.id, { ...moduleOwned, packageIdentity: { sha256: "b".repeat(64), bytes: 8 } }],
    ]));
    const coreChanged = publishSkillRevision(3, new Map(), new Map([
      [agent.id, { ...agent, packageIdentity: { sha256: "c".repeat(64), bytes: 9 } }],
    ]));

    expect(agent.packageIdentity).toEqual({ ...moduleOwned.packageIdentity, sha256: identity.sha256, bytes: identity.bytes });
    expect(moduleChanged.coreIdentity).toEqual(first.coreIdentity);
    expect(coreChanged.coreIdentity.sha256).not.toBe(first.coreIdentity.sha256);
  });
});
