import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { trialEvidence } from "../../helpers/terminal-bench-trial-evidence.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("the standalone trial store analysis", () => {
  // A hosted trial runs the analyzer as its own process, which no test preload
  // prepares, so only a separate process proves that the analyzer installs the
  // module catalog that prompt reconstruction reads for the Claude reminders.
  test("proves a Claude engine trial store in a process of its own", async () => {
    const fixture = await trialEvidence(temporaryDirectory("tb-standalone-"), { route: "claude" });
    const child = Bun.spawn([process.execPath, resolve("bench/terminal_bench/trial-store-analysis.ts"), join(fixture.root, "trial", "agent", "state", ".flywheel", "flywheel.sqlite")], {
      stdout: "pipe", stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ requestAuditComplete: true, executableToolInputs: { bash: 2 }, toolSettlement: { inputs: 2, identityConflicts: 0 } });
  });
});
