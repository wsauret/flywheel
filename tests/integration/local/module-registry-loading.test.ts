/** The module registry loader, run in a fresh process with no test preload.
 *
 *  No kernel file imports a module registry, so every composing process entry
 *  loads both registries through `importComposing` before it reads the module
 *  catalog. The unit suite cannot see a loader that publishes only one half,
 *  because the test preload installs the whole catalog in every test process.
 *  This process starts without that preload. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CREDENTIAL_PROVIDER_MODULES } from "../../../src/orchestration/credential-provider-modules.js";
import { SHIPPED_OTHER_MODULES } from "../../../src/orchestration/modules.js";
import { headlessModuleIds } from "../../../src/orchestration/module-contract/module-catalog.js";

const FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "module-registry-load.ts");

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flywheel-module-registry-load-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the module registry loader in a fresh process", () => {
  it("publishes both halves of the shipped catalog before the loaded code reads it", async () => {
    const proc = Bun.spawn(["bun", FIXTURE], {
      cwd: home,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({
      headless: headlessModuleIds([...CREDENTIAL_PROVIDER_MODULES, ...SHIPPED_OTHER_MODULES]),
      credentialProviders: CREDENTIAL_PROVIDER_MODULES.map((module) => module.id),
      others: SHIPPED_OTHER_MODULES.map((module) => module.id),
    });
  });
});
