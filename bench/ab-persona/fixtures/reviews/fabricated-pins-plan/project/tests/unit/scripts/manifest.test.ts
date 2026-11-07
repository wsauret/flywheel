import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectSkillPackageFiles,
  collectSkillPackageManifest,
  collectWorkflowAssets,
  GENERATED_MANIFESTS,
  validateSkillReferenceManifest,
  writeAgentAssetsManifest,
  writeWorkflowManifest,
} from "../../../scripts/build-manifest.js";
import { BUNDLED_SKILL_SOURCES } from "../../../src/workflows/skill-source-inventory.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const VALID_MANIFEST_SKILL = "---\ndescription: Probe\n---\nProbe.";

function withTempManifest(run: (dest: string) => Promise<void> | void): Promise<void> | void {
  const tmp = mkdtempSync(join("/tmp", "flywheel-manifest-"));
  try {
    return run(join(tmp, "manifest.ts"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("binary manifest generation", () => {
  it("uses one immutable inventory for agent and workflow package and reference roots", () => {
    expect(BUNDLED_SKILL_SOURCES.map(({ kind }) => kind)).toEqual(["agent", "workflow"]);
    expect(BUNDLED_SKILL_SOURCES.every((source) => Object.isFrozen(source))).toBe(true);
    expect(Object.isFrozen(BUNDLED_SKILL_SOURCES)).toBe(true);
    expect(BUNDLED_SKILL_SOURCES.map(({ packageDir }) => packageDir)).toEqual([
      join(REPO_ROOT, "src", "agent-skills"),
      join(REPO_ROOT, "src", "workflows", "skills"),
    ]);
    expect(BUNDLED_SKILL_SOURCES.map(({ referenceDir }) => referenceDir)).toEqual([
      join(REPO_ROOT, "src", "agent-skills", "references"),
      join(REPO_ROOT, "src", "workflows", "references"),
    ]);
  });
  it("embeds built-in workflow definitions", async () => {
    await withTempManifest(async (dest) => {
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(generated).toContain("export const workflowDefinitions");
      expect(generated).toContain('"implement.yaml"');
      expect(generated).not.toContain("conventionsText");
      expect(generated).toContain("export const workflowAssets");
    });
  });

  it("embeds every persona definition under the agents export", async () => {
    await withTempManifest(async (dest) => {
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(generated).toContain("export const agents");
      expect(generated).toContain('"reviewer-code-quality.md"');
      expect(generated).toContain('"explorer.md"');
    });
  });

  it("embeds every bundled skill package and keeps it out of workflowAssets", async () => {
    await withTempManifest(async (dest) => {
      const assets = await collectWorkflowAssets();
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(generated).toContain("export const skillDefinitions");
      for (const id of ["code-review", "implementation", "flywheel-uat", "typescript-bun"]) {
        expect(generated).toContain(`"${id}/SKILL.md"`);
      }
      expect(Object.keys(assets).some((key) => key.startsWith("skills/"))).toBe(false);
      expect(generated).toContain("export const skillSourceKinds");
      expect(generated).toContain('"code-review": "agent"');
      expect(generated).toContain('"fly.implementation-spec": "workflow"');
    });
  });

  it("keeps agent references out of the package manifest", async () => {
    const tmp = mkdtempSync(join("/tmp", "flywheel-manifest-sources-"));
    try {
      const packageDir = join(tmp, "agent-skills");
      const referenceDir = join(packageDir, "references");
      mkdirSync(join(packageDir, "review"), { recursive: true });
      mkdirSync(referenceDir, { recursive: true });
      writeFileSync(join(packageDir, "review", "SKILL.md"), "---\ndescription: Review\n---\nReview.");
      writeFileSync(join(referenceDir, "shared.md"), "Shared reference.");

      const packages = await collectSkillPackageFiles([{ kind: "agent", packageDir, referenceDir }]);

      expect(packages).toEqual({ "review/SKILL.md": "---\ndescription: Review\n---\nReview." });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("records source kind separately from flat package paths", async () => {
    const tmp = mkdtempSync(join("/tmp", "flywheel-manifest-kinds-"));
    try {
      const agentDir = join(tmp, "agent");
      const workflowDir = join(tmp, "workflow");
      mkdirSync(join(agentDir, "same-bytes"), { recursive: true });
      mkdirSync(join(workflowDir, "workflow-only"), { recursive: true });
      writeFileSync(join(agentDir, "same-bytes", "SKILL.md"), VALID_MANIFEST_SKILL);
      writeFileSync(join(workflowDir, "workflow-only", "SKILL.md"), VALID_MANIFEST_SKILL);
      const result = await collectSkillPackageManifest([
        { kind: "agent", packageDir: agentDir, referenceDir: join(agentDir, "references") },
        { kind: "workflow", packageDir: workflowDir, referenceDir: join(workflowDir, "references") },
      ]);
      expect(result.kinds).toEqual({ "same-bytes": "agent", "workflow-only": "workflow" });
      expect(Object.keys(result.files).sort()).toEqual(["same-bytes/SKILL.md", "workflow-only/SKILL.md"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("embeds shared skill references in workflowAssets", async () => {
    await withTempManifest(async (dest) => {
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(generated).toContain('"references/reviewer-protocol.md"');
      expect(generated).toContain('"references/research-protocol.md"');
    });
  });

  it("leaves the runner-universal system prompt to the agent asset manifest", async () => {
    await withTempManifest(async (dest) => {
      await writeWorkflowManifest(dest);
      expect(readFileSync(dest, "utf-8")).not.toContain("systemPromptText");
    });
  });

  it("embeds the system prompt and engineering doctrine source files in the agent asset manifest", async () => {
    await withTempManifest(async (dest) => {
      await writeAgentAssetsManifest(dest);
      const generated = readFileSync(dest, "utf-8");
      const sourceText = readFileSync(join(REPO_ROOT, "src", "infra", "agent-assets", "system-prompt.md"), "utf-8");
      const doctrineText = readFileSync(join(REPO_ROOT, "src", "infra", "agent-assets", "engineering-doctrine.md"), "utf-8");

      expect(generated).toContain("export const systemPromptText");
      expect(generated).toContain(JSON.stringify(sourceText));
      expect(generated).toContain("export const engineeringDoctrineText");
      expect(generated).toContain(JSON.stringify(doctrineText));
      expect(generated).not.toContain("conventionsText");
    });
  });

  it("embeds every workflow asset under its preserved relative path", async () => {
    await withTempManifest(async (dest) => {
      const assets = await collectWorkflowAssets();
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(assets["agents/personas/reviewer-code-quality.md"]).toContain("reviewer-code-quality");
      expect(assets["references/reviewer-protocol.md"]).toContain("Reviewer Protocol");
      expect(assets["workflows/implement.yaml"]).toContain("id: implement");
      const configurationSource = readFileSync(join(REPO_ROOT, "src", "workflows", "docs", "configuration.md"));
      expect(Buffer.from(assets["docs/configuration.md"] ?? "")).toEqual(configurationSource);
      expect(generated).toContain(JSON.stringify(configurationSource.toString("utf-8")));
      for (const key of Object.keys(assets)) {
        expect(key.startsWith("/")).toBe(false);
        expect(key.includes("\\")).toBe(false);
        expect(generated).toContain(JSON.stringify(key));
      }
    });
  });

  // The restore sources are what build-binary.ts writes back after bundling, so
  // drift between them and the checked-in files would leave generated content
  // committed to the tree.
  it("keeps every manifest's restore source identical to its checked-in file", () => {
    for (const manifest of GENERATED_MANIFESTS) {
      expect(readFileSync(manifest.path, "utf-8")).toBe(manifest.emptySource);
    }
  });

  it("rejects skill definitions that reference unbundled skill references", () => {
    expect(() =>
      validateSkillReferenceManifest(
        { "broken/SKILL.md": "Before {{ref:missing-protocol}} after." },
        { "references/other-protocol.md": "Other protocol." },
      ),
    ).toThrow("missing-protocol.md");
  });
});
