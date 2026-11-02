import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { connectPersistentProcessBridge, servePersistentProcessBridge } from "../../../../src/infra/persistent-process-bridge.js";
import { createPersistentProcessManager } from "../../../../src/infra/persistent-process-manager.js";
import type { PersistentSubprocess } from "../../../../src/infra/persistent-subprocess.js";
import { persistentProcessPolicy } from "../../../../src/orchestration/config/persistent-process-policy.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { updateAllowPersistentProcesses } from "../../../../src/orchestration/config/writer.js";

async function withConfig(source: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-persistent-process-policy-"));
  try {
    const path = join(dir, "flywheel.toml");
    await writeFile(path, source);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runningProcess(command: readonly string[]): PersistentSubprocess {
  return {
    pid: 4_242,
    command,
    spool: { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" },
    exited: new Promise(() => {}),
    metadata: () => ({ startedAtMs: 1, status: "running", stdoutBytes: 0, stderrBytes: 0 }),
    read: () => ({ data: new Uint8Array(), nextOffset: 0, eof: true }),
    stop: async () => "terminated",
    release() {},
  };
}

describe("persistent process policy", () => {
  test.each([
    { persisted: false, forcedByCli: false, effective: false },
    { persisted: true, forcedByCli: false, effective: true },
    { persisted: false, forcedByCli: true, effective: true },
    { persisted: true, forcedByCli: true, effective: true },
  ])("derives effective permission from persisted intent and immutable CLI override", async ({ persisted, forcedByCli, effective }) => {
    await withConfig(`allow_persistent_processes = ${persisted}\n`, async (configPath) => {
      await expect(persistentProcessPolicy({ configPath, forcedByCli })).resolves.toEqual({ persisted, forcedByCli, effective });
    });
  });

  test.each([
    { name: "an invalid persisted value", setup: (configPath: string) => writeFile(configPath, 'allow_persistent_processes = "yes"\n') },
    { name: "unparseable text", setup: (configPath: string) => writeFile(configPath, "allow_persistent_processes = true\ntheme = \n") },
    { name: "a symlinked file", setup: async (configPath: string) => {
      await writeFile(`${configPath}.real`, "allow_persistent_processes = true\n");
      await rm(configPath);
      await symlink(`${configPath}.real`, configPath);
    } },
  ])("fails closed for $name", async ({ setup }) => {
    await withConfig("", async (configPath) => {
      await setup(configPath);
      await expect(persistentProcessPolicy({ configPath, forcedByCli: false })).resolves.toEqual({
        persisted: false,
        forcedByCli: false,
        effective: false,
      });
    });
  });

  test("admits bridged launches from the live persisted intent and the immutable CLI override", async () => {
    await withConfig("allow_persistent_processes = false\n", async (configPath) => {
      const owner = await createRuntimeConfigOwner({ configPath, watch: false });
      const manager = createPersistentProcessManager({ launch: async (command) => runningProcess(command) });
      const serve = (forcedByCli: boolean) => {
        const channel = new MessageChannel();
        const close = servePersistentProcessBridge({
          manager, port: channel.port1,
          allowLaunch: async () => (await persistentProcessPolicy({ configPath, forcedByCli, owner })).effective,
        });
        return { client: connectPersistentProcessBridge(channel.port2), close };
      };
      const bridged = serve(false);
      const forced = serve(true);
      try {
        await expect(bridged.client.launch(["off"])).rejects.toThrow("persistent process launch is not authorized");
        expect(updateAllowPersistentProcesses(true, { configPath }).ok).toBe(true);
        await expect(bridged.client.launch(["on"])).resolves.toMatchObject({ command: ["on"] });
        expect(updateAllowPersistentProcesses(false, { configPath }).ok).toBe(true);
        await expect(bridged.client.launch(["off-again"])).rejects.toThrow("persistent process launch is not authorized");
        await expect(forced.client.launch(["forced"])).resolves.toMatchObject({ command: ["forced"] });
      } finally {
        for (const { client, close } of [bridged, forced]) {
          client.close();
          await close();
        }
        await owner.dispose();
      }
    });
  });

  test.each([
    { source: "allow_persistent_processes = false\n", valid: true },
    { source: 'allow_persistent_processes = false\ndisabled_modules = ["nope"]\n', valid: false },
  ])("writes only a valid document through config ownership: $valid", async ({ source, valid }) => {
    await withConfig(source, async (configPath) => {
      const write = updateAllowPersistentProcesses(true, { configPath });
      expect(write.ok).toBe(valid);
      if (!valid) expect(await readFile(configPath, "utf8")).toBe(source);
      await expect(persistentProcessPolicy({ configPath, forcedByCli: false })).resolves.toEqual({
        persisted: valid,
        forcedByCli: false,
        effective: valid,
      });
    });
  });
});
