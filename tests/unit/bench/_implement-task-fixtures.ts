import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";

/** The synthetic task's one acceptance test, by its JUnit name. */
export const SYNTHETIC_CHECK = "acceptance/value.test.ts > value is two";

/** A Bun JUnit report of acceptance tests in acceptance/value.test.ts, each named with whether it passed. */
export function junitReport(tests: readonly (readonly [string, boolean])[]): string {
  const cases = tests.map(([name, passed]) => `<testcase name="${name}" classname="" file="acceptance/value.test.ts"${passed ? " />" : "><failure type=\"AssertionError\" /></testcase>"}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="acceptance/value.test.ts" file="acceptance/value.test.ts">${cases.join("")}</testsuite></testsuites>\n`;
}

/** Answers sandbox commands as if the candidate changed value.ts and the acceptance suite passed. */
export const syntheticCommands: OwnedCommandRunner = async (command) => {
  const stdout = command.includes("--numstat")
    ? "1\t1\tvalue.ts\n"
    : command.includes("diff")
      ? "diff --git a/value.ts b/value.ts\n"
      : "";
  const output = command.find(argument => argument.startsWith("--output="));
  if (output) await Bun.write(output.slice("--output=".length), stdout);
  const report = command.find(argument => argument.startsWith("--reporter-outfile="));
  if (report) await Bun.write(report.slice("--reporter-outfile=".length), junitReport([["value is two", true]]));
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
  await Bun.write(join(taskDir, "checks.json"), JSON.stringify({ [SYNTHETIC_CHECK]: "core" }));
  await Bun.write(
    join(taskDir, "acceptance", "value.test.ts"),
    'import { expect, test } from "bun:test";\nimport { value } from "../value.js";\ntest("value is two", () => { expect(value).toBe(2); });\n',
  );
  return tasksDir;
}
