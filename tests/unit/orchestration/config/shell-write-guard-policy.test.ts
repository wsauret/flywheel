import { beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBashDefinition } from "../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { shellWriteGuardObserver } from "../../../../src/orchestration/config/shell-write-guard-policy.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { makeContext } from "../agent-runtime/tools/_fixtures.js";

const temporaryDirectory = temporaryDirectories();

beforeAll(async () => {
  await loadBashParser();
});

describe("shell write guard policy", () => {
  test("the shell enforces the guard saved on disk after it was built, and only an authored false turns it off", async () => {
    const configPath = join(temporaryDirectory("flywheel-shell-write-guard-"), "flywheel.toml");
    await writeFile(configPath, "shell_write_guard = true\n");
    const owner = await createRuntimeConfigOwner({ configPath, watch: false });
    try {
      const bash = createBashDefinition({ writeGuard: true, enforcedWriteGuard: shellWriteGuardObserver(owner) });
      const context = makeContext({ executionCwd: "/proj", projectRoot: "/proj", scratchDir: "/proj/.flywheel/scratch" });
      const refusesOutsideWrite = async () => await bash.executionPolicy?.({ command: "cat > /elsewhere/probe.ts <<'EOF'\nx\nEOF" }, context) !== undefined;
      expect(await refusesOutsideWrite()).toBe(true);
      for (const [source, refused] of [["shell_write_guard = false\n", false], ["shell_write_guard = \n", true], ["shell_write_guard = \"no\"\n", true], ["", true]] as const) {
        await writeFile(configPath, source);
        expect(await refusesOutsideWrite()).toBe(refused);
      }
    } finally {
      await owner.dispose();
    }
  });
});
