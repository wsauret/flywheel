/**
 * Production-shaped coverage for the runner-universal system prompt.
 *
 * A compiled binary has no source tree: `src/infra/agent-assets/system-prompt.md`
 * is absent and the generated manifest is the only layer left. These tests run
 * the real resolver in a separate process against an isolated cwd and HOME, so
 * both the compiled shape and the dev shape are exercised as they ship.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentAssetsManifest } from "../../../scripts/build-manifest.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ASSETS_SRC = join(REPO_ROOT, "src", "infra", "agent-assets");
/** Both runner-universal prompt assets share one overlay and manifest lane. */
const PROMPT_ASSETS = [
  { file: "system-prompt.md", loader: "loadSystemPrompt" },
  { file: "engineering-doctrine.md", loader: "loadEngineeringDoctrine" },
] as const;

let tmp: string;
let assetsDir: string;
let projectRoot: string;
let userDataRoot: string;

/** Stage a copy of the resolver next to a manifest of the caller's choosing.
 *  The copy has no `system-prompt.md`, which is the compiled-binary shape. The
 *  staged tree mirrors the source layout, so the resolver's own imports resolve
 *  from the copy instead of from the repository. */
function stageResolver(): void {
  for (const file of ["loader.ts", "system-prompt.ts"]) {
    copyFileSync(join(ASSETS_SRC, file), join(assetsDir, file));
  }
}

/** Run the real resolver in its own process with the directory authorities
 *  injected, which is how every production caller reaches it: no HOME or cwd
 *  rediscovery happens downstream, so this process leaves both inherited. */
async function resolveAsset(loader: string): Promise<string> {
  const probe = join(tmp, `print-${loader}.ts`);
  writeFileSync(
    probe,
    `import { ${loader} } from ${JSON.stringify(join(assetsDir, "system-prompt.ts"))};\n`
      + `process.stdout.write(${loader}(${JSON.stringify({ projectRoot, userDataRoot })}));\n`,
  );

  const proc = Bun.spawn(["bun", probe], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`prompt probe failed (${exitCode}): ${stderr}`);
  return stdout;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "flywheel-compiled-assets-"));
  cpSync(join(REPO_ROOT, "src", "infra"), tmp, { recursive: true });
  rmSync(join(tmp, "agent-assets"), { recursive: true, force: true });
  assetsDir = join(tmp, "agent-assets");
  projectRoot = join(tmp, "project");
  userDataRoot = join(tmp, "home", ".flywheel");
  for (const dir of [assetsDir, projectRoot, userDataRoot]) mkdirSync(dir, { recursive: true });
  const isolatedNodeModules = join(tmp, "node_modules");
  mkdirSync(isolatedNodeModules);
  symlinkSync(join(REPO_ROOT, "node_modules", "effect"), join(isolatedNodeModules, "effect"), process.platform === "win32" ? "junction" : "dir");
  stageResolver();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function describePromptAsset(asset: (typeof PROMPT_ASSETS)[number]): void {
  const { file, loader } = asset;
  const sourceText = readFileSync(join(ASSETS_SRC, file), "utf-8");

  describe(`${file} in a compiled artifact`, () => {
    it("falls back to the generated manifest when the source file is unavailable", async () => {
      await writeAgentAssetsManifest(join(assetsDir, "manifest.ts"));

      expect(await resolveAsset(loader)).toBe(sourceText);
    });

    it("lets a project overlay shadow the generated manifest", async () => {
      await writeAgentAssetsManifest(join(assetsDir, "manifest.ts"));
      mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
      writeFileSync(join(projectRoot, ".flywheel", file), "project prompt");

      expect(await resolveAsset(loader)).toBe("project prompt");
    });

    it("lets a user overlay shadow the generated manifest", async () => {
      await writeAgentAssetsManifest(join(assetsDir, "manifest.ts"));
      writeFileSync(join(userDataRoot, file), "user prompt");

      expect(await resolveAsset(loader)).toBe("user prompt");
    });

    it("reads the source file in dev mode, where the manifest is empty", async () => {
      copyFileSync(join(ASSETS_SRC, "manifest.ts"), join(assetsDir, "manifest.ts"));
      copyFileSync(join(ASSETS_SRC, file), join(assetsDir, file));

      expect(await resolveAsset(loader)).toBe(sourceText);
    });
  });
}

for (const asset of PROMPT_ASSETS) describePromptAsset(asset);
