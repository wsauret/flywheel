import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSkillPackageFiles,
  collectWorkflowAssets,
  GENERATED_MANIFESTS,
  manifestRestoreSource,
  validateSkillReferenceManifest,
  writeAgentAssetsManifest,
  writeWorkflowManifest,
} from "../../../scripts/build-manifest.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const temporaryDirectory = temporaryDirectories();

function withTempManifest(run: (dest: string) => Promise<void> | void): Promise<void> | void {
  return run(join(temporaryDirectory("flywheel-manifest-"), "manifest.ts"));
}

describe("binary manifest generation", () => {
  it("embeds every bundled skill package and keeps it out of workflowAssets", async () => {
    await withTempManifest(async (dest) => {
      const assets = await collectWorkflowAssets();
      await writeWorkflowManifest(dest);
      const generated = readFileSync(dest, "utf-8");

      expect(generated).toContain("export const skillDefinitions");
      for (const id of ["code-review", "implementation", "experiment-charter", "experiment-finalize"]) {
        expect(generated).toContain(`"${id}/SKILL.md"`);
      }
      // The development module's bundle is not a bundled source: a release
      // manifest carries none of its packages or workflows.
      for (const id of ["flywheel-uat", "typescript-bun"]) {
        expect(generated).not.toContain(`"${id}/SKILL.md"`);
      }
      expect(generated).not.toContain('"bench-plan.yaml"');
      // The finalizer script is a package resource, so the binary carries its exact text.
      expect(generated).toContain('"experiment-finalize/finalize.sh"');
      expect(Object.keys(assets).some((key) => key.startsWith("skills/"))).toBe(false);
    });
  });

  it("keeps agent references out of the package manifest", async () => {
    const tmp = temporaryDirectory("flywheel-manifest-sources-");
    const packageDir = join(tmp, "agent-skills");
    mkdirSync(join(packageDir, "review"), { recursive: true });
    mkdirSync(join(packageDir, "references"), { recursive: true });
    writeFileSync(join(packageDir, "review", "SKILL.md"), "---\ndescription: Review\n---\nReview.");
    writeFileSync(join(packageDir, "references", "shared.md"), "Shared reference.");

    const packages = await collectSkillPackageFiles(packageDir);

    expect(packages).toEqual({ "review/SKILL.md": "---\ndescription: Review\n---\nReview." });
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
      expect(Object.keys(assets).filter((path) => /^workflows\/[^/]+\.ya?ml$/.test(path))).toEqual([]);
      expect(assets["workflows/contracts/implementation-plan.json"]).toBeDefined();
      expect(assets["workflows/implement.yaml"]).toBeUndefined();
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

  it("restores a populated manifest to its checked-in empty default", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "flywheel-manifest-restore-"));
    try {
      for (const [index, manifest] of GENERATED_MANIFESTS.entries()) {
        const generatedPath = join(tmp, `generated-${index}.ts`);
        await manifest.write(generatedPath);
        const generated = readFileSync(generatedPath, "utf-8");

        expect(generated).not.toBe(manifest.emptySource);
        expect(manifestRestoreSource(manifest, generated)).toBe(manifest.emptySource);
        expect(manifestRestoreSource(manifest, manifest.emptySource)).toBe(manifest.emptySource);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
