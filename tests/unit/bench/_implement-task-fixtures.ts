import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";

/** Answers sandbox commands as if the candidate changed value.ts and the acceptance suite passed. */
export const syntheticCommands: OwnedCommandRunner = async (command) => {
  const stdout = command.includes("--numstat")
    ? "1\t1\tvalue.ts\n"
    : command[0] === "bun"
      ? "1 pass\n0 fail\n"
      : command.includes("diff")
        ? "diff --git a/value.ts b/value.ts\n"
        : "";
  const output = command.find(argument => argument.startsWith("--output="));
  if (output) await Bun.write(output.slice("--output=".length), stdout);
  return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout, stderr: "" };
};

/** A tasks directory with one plan task named "synthetic"; the caller removes it. */
export async function writeSyntheticTaskDir(): Promise<string> {
  const tasksDir = await mkdtemp(join(tmpdir(), "bench-implement-tasks-"));
  const taskDir = join(tasksDir, "synthetic");
  await mkdir(join(taskDir, "project"), { recursive: true });
  await mkdir(join(taskDir, "acceptance"), { recursive: true });
  await Bun.write(join(taskDir, "task.json"), JSON.stringify({ id: "synthetic", stratum: "small" }));
  await Bun.write(join(taskDir, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
  await Bun.write(join(taskDir, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
  await Bun.write(join(taskDir, "project", "value.ts"), "export const value = 1;\n");
  await Bun.write(
    join(taskDir, "acceptance", "value.test.ts"),
    'import { expect, test } from "bun:test";\nimport { value } from "../value.js";\ntest("value is two", () => { expect(value).toBe(2); });\n',
  );
  return tasksDir;
}
