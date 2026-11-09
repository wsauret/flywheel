/** The config file's watch seam, and the one consumer that depends on it.
 *
 *  Integration tier: the pass condition is real filesystem event delivery,
 *  whose latency exceeds any useful deadline when the parallel unit shards
 *  saturate the CPU. Run serially here instead.
 *
 *  The update policy is account-global, so a settings write by another process
 *  or a hand edit of `flywheel.toml` must reach this runtime's published view
 *  without waiting for the next release check (PI-UPDATES-017, ARCH-RUNTIME-058). */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigFile } from "../../../src/orchestration/config/config-file.js";
import { startModulePolicy } from "../../../src/orchestration/config/module-policy.js";
import { createModuleProjection } from "../../../src/orchestration/app-service/module-projection.js";
import { persistentProcessPolicy } from "../../../src/orchestration/config/persistent-process-policy.js";
import { createRuntimeConfigOwner } from "../../../src/orchestration/config/runtime-config-owner.js";
import type { RuntimeModulesView } from "../../../src/protocol/module-protocol-types.js";
import { createUpdatePolicyStore } from "../../../src/orchestration/update/update-policy.js";
import { createUpdateService } from "../../../src/orchestration/update/update-service.js";
import type { UpdateStatusView } from "../../../src/protocol/update-protocol-types.js";

const DEBOUNCE_MS = 5;

let userDataRoot = "";
let caseDir = "";
let watch: { dispose: () => void } | undefined;

beforeEach(() => {
  caseDir = mkdtempSync(join(tmpdir(), "flywheel-config-watch-"));
  userDataRoot = join(caseDir, ".flywheel");
  mkdirSync(userDataRoot, { recursive: true });
});

afterEach(() => {
  watch?.dispose();
  watch = undefined;
  rmSync(caseDir, { recursive: true, force: true });
});

// Watching real files means the notification lands a few event loop turns
// later; poll instead of sleeping a fixed guess so the test is neither slow nor
// flaky.
async function waitFor(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
  }
}

function writeAutoInstall(value: boolean): void {
  writeFileSync(join(userDataRoot, "flywheel.toml"), `[updates]\nauto_install = ${value}\n`);
}

describe("watchConfigFile", () => {
  it("reports a replacement of the config file", async () => {
    let changes = 0;
    watch = watchConfigFile({ userDataRoot }, () => { changes += 1 }, { debounceMs: DEBOUNCE_MS });

    writeAutoInstall(false);

    await waitFor("the config change", () => changes > 0);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("recovers an unreadable snapshot after a permission-only repair", async () => {
    const configPath = join(userDataRoot, "flywheel.toml");
    writeFileSync(configPath, "show_thinking = true\n");
    chmodSync(configPath, 0o000);
    const owner = await createRuntimeConfigOwner({ configPath });
    try {
      expect(owner.snapshot().status.kind).toBe("malformed");
      chmodSync(configPath, 0o600);
      await waitFor("the repaired snapshot", () => owner.snapshot().status.kind === "valid");
      expect(owner.snapshot().config.show_thinking).toBe(true);
    } finally {
      chmodSync(configPath, 0o600);
      await owner.dispose();
    }
  });

  it("stops reporting after dispose", async () => {
    let changes = 0;
    watch = watchConfigFile({ userDataRoot }, () => { changes += 1 }, { debounceMs: DEBOUNCE_MS });
    writeAutoInstall(false);
    await waitFor("the config change", () => changes > 0);
    const before = changes;

    watch.dispose();
    writeAutoInstall(true);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 10));

    expect(changes).toBe(before);
  });

  it("reports a replacement the directory watch could not be armed for", async () => {
    // The account data directory is created by the first root that needs it, so
    // a watch armed before it exists has nothing to bind to. Freshness may not
    // depend on that ordering.
    const laterRoot = join(caseDir, "later", ".flywheel");
    let changes = 0;
    watch = watchConfigFile({ userDataRoot: laterRoot }, () => { changes += 1 }, { debounceMs: DEBOUNCE_MS, revalidateMs: DEBOUNCE_MS });

    mkdirSync(laterRoot, { recursive: true });
    writeFileSync(join(laterRoot, "flywheel.toml"), "[updates]\nauto_install = false\n");

    await waitFor("the config change", () => changes > 0);
  });

  it("reports a replacement after the directory watch failed mid-session", async () => {
    let failWatch: (() => void) | undefined;
    let changes = 0;
    watch = watchConfigFile({ userDataRoot }, () => { changes += 1 }, {
      debounceMs: DEBOUNCE_MS,
      revalidateMs: DEBOUNCE_MS,
      watchDirectory: (_directory, _onChanged, onFailed) => {
        failWatch = () => { onFailed("the platform watch died") };
        return { close: () => {} };
      },
    });
    if (failWatch === undefined) throw new Error("the watch seam was not used");

    failWatch();
    writeAutoInstall(false);

    await waitFor("the config change", () => changes > 0);
  });

  it("publishes an update policy another process disabled, with no check running", async () => {
    const published: UpdateStatusView[] = [];
    const service = createUpdateService({
      currentVersion: "1.2.3",
      platformArch: "darwin-arm64",
      repository: "acme/flywheel",
      policy: createUpdatePolicyStore(userDataRoot),
      openAuthority: () => { throw new Error("this case runs no check") },
      scheduler: { nowMs: () => 0, setTimer: () => () => {} },
      publish: (view) => { published.push(view) },
    });
    expect(service.status().autoInstall.effective).toBe(true);
    watch = watchConfigFile({ userDataRoot }, () => { service.refreshPolicy() }, { debounceMs: DEBOUNCE_MS });

    writeAutoInstall(false);

    await waitFor("the published policy", () => service.status().autoInstall.effective === false);
    expect(published.at(-1)?.status).toEqual({ kind: "idle" });
  });

  it("publishes a capability selection another writer stated, with no restart", async () => {
    // The runtime composition wires exactly this: one watch notification
    // refreshes the process policy and republishes the capability view every
    // client renders its Settings rows from.
    const started = await startModulePolicy({ userDataRoot });
    const views: RuntimeModulesView[] = [];
    const processes = await persistentProcessPolicy({ userDataRoot, forcedByCli: false });
    const projection = await createModuleProjection({
      location: { userDataRoot },
      capabilities: started.policy,
      persistentProcesses: processes,
      settlePublication: async () => {},
      publish: (patch) => { if (patch.payload.kind === "modules.changed") views.push(patch.payload.capabilities) },
    });
    watch = watchConfigFile({ userDataRoot }, () => { projection.refresh() }, { debounceMs: DEBOUNCE_MS });

    try {
      writeFileSync(join(userDataRoot, "flywheel.toml"), 'features = ["skills", "subagents"]\n');

      await waitFor("the published capability view", () => views.length > 0);
      const published = views.at(-1);
      for (const id of ["ask-user", "bash", "discovery", "file-tools", "recall", "skills", "subagents"] as const) expect(published?.capabilities).toContain(id);
      for (const id of ["background-commands", "learning", "workflows"]) expect(published?.capabilities).not.toContain(id);
      expect(published?.workflowsMode).toBe("off");
      expect(readFileSync(join(userDataRoot, "flywheel.toml"), "utf8")).not.toContain("features =");
    } finally {
      projection.dispose();
    }
  });
});
