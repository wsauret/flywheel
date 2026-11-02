/** The effective update policy the whole update surface reads (ARCH-DISTRIBUTION-022).
 *
 *  Auto-install is the one setting that replaces a binary without asking, so
 *  the interesting cases here are the ones where the answer is not simply what
 *  the file says: an environment override, and a file that cannot be read. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUpdatePolicyStore } from "../../../../src/orchestration/update/update-policy.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { harness, blockingInstaller } from "./_update-service-harness.js";

const temporaryDirectory = temporaryDirectories();
let userDataRoot = "";
const originalDisable = process.env.FLYWHEEL_DISABLE_AUTOUPDATE;

beforeEach(() => {
  userDataRoot = join(temporaryDirectory("flywheel-update-policy-"), ".flywheel");
  mkdirSync(userDataRoot, { recursive: true });
  delete process.env.FLYWHEEL_DISABLE_AUTOUPDATE;
});

afterEach(() => {
  if (originalDisable === undefined) delete process.env.FLYWHEEL_DISABLE_AUTOUPDATE;
  else process.env.FLYWHEEL_DISABLE_AUTOUPDATE = originalDisable;
});

function writeConfig(text: string): void {
  writeFileSync(join(userDataRoot, "flywheel.toml"), text);
}

function readPolicy(): boolean {
  return createUpdatePolicyStore(userDataRoot).read().effective;
}

function readAutoInstall() {
  return createUpdatePolicyStore(userDataRoot).read();
}

describe("the effective update policy", () => {
  test("an account with no config file keeps the documented default", () => {
    expect(readPolicy()).toBe(true);
  });

  test("the durable setting is what the file says", () => {
    writeConfig("[updates]\nauto_install = false\n");
    expect(readPolicy()).toBe(false);

    writeConfig("[updates]\nauto_install = true\n");
    expect(readPolicy()).toBe(true);
  });

  test("an override reports the durable value it is holding off, not just the answer", () => {
    writeConfig("[updates]\nauto_install = true\n");
    process.env.FLYWHEEL_DISABLE_AUTOUPDATE = "true";

    expect(readAutoInstall()).toEqual({ persisted: true, forcedOff: true, effective: false });
  });

  test("an override is reported even when the durable setting is already off", () => {
    writeConfig("[updates]\nauto_install = false\n");
    process.env.FLYWHEEL_DISABLE_AUTOUPDATE = "true";

    expect(readAutoInstall()).toEqual({ persisted: false, forcedOff: true, effective: false });
  });

  test("the override only ever disables, so it cannot re-enable what the file turned off", () => {
    writeConfig("[updates]\nauto_install = false\n");
    process.env.FLYWHEEL_DISABLE_AUTOUPDATE = "0";

    expect(readPolicy()).toBe(false);
  });

  test("a config file that cannot be parsed fails closed", async () => {
    writeConfig("[updates\nauto_install = true\n");

    expect(readPolicy()).toBe(false);
    const policy = createUpdatePolicyStore(userDataRoot);
    try {
      expect(await policy.revalidate((current) => current.effective)).toBe(false);
    } finally {
      await policy.dispose();
    }
  });

  test("a config file that does not validate fails closed", () => {
    writeConfig("[updates]\nauto_install = \"yes\"\n");

    expect(readPolicy()).toBe(false);
  });

  test("an invalid environment override fails closed rather than defaulting on", () => {
    writeConfig("[updates]\nauto_install = true\n");
    process.env.FLYWHEEL_DISABLE_AUTOUPDATE = "sometimes";

    expect(readPolicy()).toBe(false);
  });

  test("use-time revalidation decodes only automatic installation", async () => {
    writeConfig('allow_persistent_processes = "unrelated-invalid-value"\n\n[updates]\nauto_install = true\n');

    const policy = createUpdatePolicyStore(userDataRoot);
    expect(await policy.revalidate((current) => current.effective)).toBe(true);
  });

  test("disposes the one-shot owner it allocates", async () => {
    const policy = createUpdatePolicyStore(userDataRoot);

    await policy.dispose();
    await expect(policy.revalidate((current) => current.effective)).rejects.toThrow("disposed");
  });

  test("a write persists the durable value the next read answers", async () => {
    await expect(createUpdatePolicyStore(userDataRoot).write(true, false)).resolves.toEqual({ ok: true });

    expect(readPolicy()).toBe(false);
  });

  test("a stale write is refused without changing the durable value", async () => {
    writeConfig("[updates]\nauto_install = false\n");

    const result = await createUpdatePolicyStore(userDataRoot).write(true, true);

    expect(result.ok).toBe(false);
    expect(readPolicy()).toBe(false);
  });

  test("writes every semantic TOML form without creating a second authority", async () => {
    for (const source of [
      "[updates]\nauto_install = true\n",
      "updates.auto_install = true\n",
      "\"updates\".\"auto_install\" = true\n",
      "updates = { auto_install = true }\n",
    ]) {
      writeConfig(source);
      await expect(createUpdatePolicyStore(userDataRoot).write(true, false)).resolves.toEqual({ ok: true });
      expect(readPolicy()).toBe(false);
      expect(readFileSync(join(userDataRoot, "flywheel.toml"), "utf8").match(/auto_install/g)).toHaveLength(1);
    }
  });
});

describe("update policy setting", () => {
  test("persists the durable value before it publishes the live policy", async () => {
    const { service, published, policy } = harness();

    await expect(service.setAutoInstall(true, false)).resolves.toEqual({ ok: true });

    expect(policy.writes).toEqual([false]);
    expect(published).toEqual([{ revision: 1, autoInstall: { persisted: false, forcedOff: false, effective: false }, status: { kind: "idle" } }]);
    expect(service.status()).toEqual({ revision: 1, autoInstall: { persisted: false, forcedOff: false, effective: false }, status: { kind: "idle" } });
  });

  test("a failed write changes neither the published policy nor the durable one", async () => {
    const { service, published, policy } = harness();
    policy.failWrite = true;

    const result = await service.setAutoInstall(true, false);

    expect(result.ok).toBe(false);
    expect(published).toEqual([]);
    expect(service.status().autoInstall).toEqual({ persisted: true, forcedOff: false, effective: true });
  });

  test("a successful disable revokes the activation in flight", async () => {
    const blocked = blockingInstaller();
    const { service, published } = harness({ installer: blocked.installer });

    const run = service.run();
    const signal = await blocked.started;
    await expect(service.setAutoInstall(true, false)).resolves.toEqual({ ok: true });
    expect(signal.aborted).toBe(true);
    blocked.release("revoked");

    expect(await run).toEqual({ kind: "cancelled" });
    // The reason follows the policy that revoked the attempt, so the notice
    // names the setting instead of a command that would now refuse.
    expect(published.at(-1)).toEqual({
      revision: 4,
      autoInstall: { persisted: false, forcedOff: false, effective: false },
      status: { kind: "available", version: "1.3.0", blocking: "auto-install-off" },
    });
  });

  test("a durable enable the environment holds off is still published, so a row can explain itself", async () => {
    // What an environment override does: the file accepts `true` and the
    // effective policy stays off. Publishing nothing here is what let a
    // settings toggle report success and change nothing a user could see.
    const { service, published, policy } = harness({ autoInstall: false, forcedOff: true });

    await expect(service.setAutoInstall(false, true)).resolves.toEqual({ ok: true });

    expect(policy.writes).toEqual([true]);
    expect(published).toEqual([{
      revision: 1,
      autoInstall: { persisted: true, forcedOff: true, effective: false },
      status: { kind: "idle" },
    }]);
  });

  test("a config change observed outside a check publishes the new policy", async () => {
    const { service, published, policy } = harness({ autoInstall: false });
    expect(service.status().autoInstall.effective).toBe(false);

    policy.value = true;
    service.refreshPolicy();

    expect(published).toEqual([{ revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } }]);
    // Latest-collapsible: an unchanged policy is not republished.
    service.refreshPolicy();
    expect(published).toHaveLength(1);
  });

  test("a disable made by another process revokes the activation in flight", async () => {
    const blocked = blockingInstaller();
    const { service, published, policy } = harness({ installer: blocked.installer });

    const run = service.run();
    const signal = await blocked.started;
    policy.value = false;
    service.refreshPolicy();
    expect(signal.aborted).toBe(true);
    blocked.release("revoked");

    expect(await run).toEqual({ kind: "cancelled" });
    expect(published.at(-1)).toEqual({
      revision: 4,
      autoInstall: { persisted: false, forcedOff: false, effective: false },
      status: { kind: "available", version: "1.3.0", blocking: "auto-install-off" },
    });
  });
});
