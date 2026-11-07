import { afterEach, describe, it, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { collectModuleSkillPackageFiles } from "../../../../scripts/build-manifest.js";
import { shippedDefinitionBundles } from "../../../../src/orchestration/modules.js";
import { loadWorkflowFiles } from "../../../helpers/workflow-files.js";
import type { AssetLocation } from "../../../../src/workflows/definition-assets.js";
import { loadSkillDefinitions } from "../../../../src/workflows/skills.js";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";

const WORKFLOW_YAML = (id: string, phase: string) =>
  `id: ${id}\nname: ${id}\nphases:\n  - phase: ${phase}\n    name: Work\n    brief: Do the work.`;

const entry = (content: string) => ({ file: "bundled:default.yaml", location: { root: { kind: "core" }, path: "default.yaml" } satisfies AssetLocation, content });

describe("manifest-backed definition loading", () => {
  it("loads workflow definitions from in-memory entries", () => {
    const { results, errors } = loadWorkflowFiles([entry(WORKFLOW_YAML("default", "work"))]);

    expect(errors).toEqual([]);
    expect(results.get("default")?.phases).toEqual([{ phase: "work", name: "Work", brief: "Do the work." }]);
  });

  it("rejects a bundled workflow entry that carries a stray installer field", () => {
    const content = `base_default_hash: ${"a".repeat(64)}\n${WORKFLOW_YAML("default", "work")}`;
    const { results, errors } = loadWorkflowFiles([entry(content)], "bundled");

    expect(results.size).toBe(0);
    expect(errors).toHaveLength(1);
  });
});

const TMP = fileTemporaryDirectory("flywheel-manifest-loader-test-");
const BUNDLED_SKILL_MD = "---\ndescription: Compiled skill\n---\nBundled body.";

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("manifest-backed skill loading", () => {
  it("rejects a bundled skill entry that carries a stray installer field", () => {
    const content = `base_default_hash: ${"a".repeat(64)}\n${BUNDLED_SKILL_MD}`;

    expect(() => loadSkillDefinitions({ roots: [], bundledEntries: [["compiled/SKILL.md", content]] })).toThrow('Bundled skill "compiled"');
  });

  it("loads a shipped module bundle from the release manifest alone, with the identity and bundle of its source tree", async () => {
    const lanes = await collectModuleSkillPackageFiles();
    for (const { id, root } of shippedDefinitionBundles()) {
      const bundled = { authority: "bundled", reach: "global", sourceKind: "module", bundle: id } as const;
      const source = loadSkillDefinitions({ roots: [{ ...bundled, dir: join(root, "skills") }] });
      const release = loadSkillDefinitions({ roots: [{ ...bundled, dir: join(TMP, "absent", id), manifest: Object.entries(lanes[id] ?? {}) }] });

      expect([...release.skills.keys()].toSorted()).toEqual([...source.skills.keys()].toSorted());
      for (const [skillId, pkg] of source.bundledCorpus) expect(release.bundledCorpus.get(skillId)?.packageIdentity).toEqual(pkg.packageIdentity);
      for (const skill of release.skills.values()) expect(skill.source.bundle).toBe(id);
    }
    const shipped = new Set(Object.values(lanes).flatMap((files) => Object.keys(files).map((path) => path.slice(0, path.indexOf("/")))));
    expect([...shipped]).toEqual(expect.arrayContaining(["workflow-authoring", "experiment-charter", "experiment-finalize"]));
    expect(shipped.has("typescript-bun")).toBe(false);
  });

  it("rejects a manifest key that is not <package>/<path>", () => {
    expect(() =>
      loadSkillDefinitions({ roots: [], bundledEntries: [["SKILL.md", BUNDLED_SKILL_MD]] }),
    ).toThrow("<package>/<path>");
  });
});
