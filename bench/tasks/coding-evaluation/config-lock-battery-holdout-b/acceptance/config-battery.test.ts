import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../src/infra/descriptor-directory.js";
import { acquireLockSyncIn, releaseLockIn } from "../src/infra/ownership-file-lock.js";
import { withConfigOwnership, withConfigOwnershipBlocking } from "../src/orchestration/config/config-file.js";

for (const kind of ["asynchronous", "synchronous"] as const) {
  test(`${kind} ownership stays on its admitted directory after a path replacement`, async () => {
    const root = mkdtempSync(join(tmpdir(), "config-battery-"));
    const directory = join(root, "account");
    const moved = join(root, "admitted");
    mkdirSync(directory, { mode: 0o700 });
    const location = { configPath: join(directory, "flywheel.toml") };
    withConfigOwnershipBlocking(location, config => config.write("value = 1\n"));
    let read: unknown;
    let write: unknown;
    try {
      const edit = (config: Parameters<typeof withConfigOwnershipBlocking>[1] extends (config: infer C) => unknown ? C : never) => {
        renameSync(directory, moved);
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(location.configPath, "value = 900\n", { mode: 0o600 });
        read = config.readText();
        write = config.write("value = 2\n");
        return 31;
      };
      const result = kind === "asynchronous"
        ? await withConfigOwnership(location, edit)
        : withConfigOwnershipBlocking(location, edit);
      expect(read).toBe("value = 1\n");
      expect(write).toBeUndefined();
      expect(result).toBe(31);
      expect(readFileSync(join(moved, "flywheel.toml"), "utf8")).toBe("value = 2\n");
      expect(readFileSync(location.configPath, "utf8")).toBe("value = 900\n");
      expect(readdirSync(moved)).toEqual(["flywheel.toml"]);
      expect(readdirSync(directory)).toEqual(["flywheel.toml"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
