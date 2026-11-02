import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCliLauncher } from "../../../src/cli/runtime-launch.js";
import { Effect } from "effect";
import { createBashDefinition } from "../../../src/orchestration/agent-runtime/tools/bash.js";
import { executeDispatchedTool } from "../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { prepareToolCall } from "../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { quotePowerShell } from "../../../src/orchestration/agent-runtime/tools/bash-script.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();

test("the real bash tool refuses an outside delete before any command runs", async () => {
  const base = directory("bash-outside-write-");
  const projectRoot = join(base, "project");
  const outside = join(base, "outside");
  for (const dir of [projectRoot, outside]) mkdirSync(dir);
  writeFileSync(join(outside, "keep.txt"), "keep");
  const launcher = await createCliLauncher();
  const generation = launcher.scope.open();
  const context = {
    executionCwd: projectRoot, projectRoot,
    userDataRoot: join(base, "account", ".flywheel"),
    scratchDir: join(projectRoot, ".flywheel", "scratch"),
    artifactScopeId: "outside-write", retrievalSessionId: "outside-write",
    sessionId: "outside-write", toolUseId: "outside-delete",
    spawnOwned: generation.spawnOwned,
  };
  const tool = createBashDefinition({ persistentProcesses: true });
  const remove = process.platform === "win32"
    ? `Remove-Item -Recurse -Force ${quotePowerShell(outside)}`
    : `rm -rf '${outside.replaceAll("'", "'\\''")}'`;
  try {
    // The positive control proves that this test has a real launch surface.
    const ran = await tool.execute({ command: "echo ready" }, context);
    expect(ran.outcome).toBe("ok");
    expect(ran.content).toContain("ready");
    const prefix = process.platform === "win32" ? "'ran' | Set-Content marker.txt; " : "echo ran > marker.txt; ";
    for (const flags of [{}, { mutates: true }, { background: true }, { background: true, persist_after_exit: true }]) {
      const prepared = prepareToolCall({ id: "outside-delete", name: "bash", input: { ...flags, command: prefix + remove } }, new Map([["bash", tool]]), { ok: true });
      const result = await Effect.runPromise(executeDispatchedTool({ prepared, context, gate: createToolConcurrencyGate(1) }));
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("outside");
      expect(existsSync(join(projectRoot, "marker.txt"))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    }
  } finally {
    await launcher.dispose();
  }
}, 30_000);
