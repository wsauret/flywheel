// ---------------------------------------------------------------------------
// Production command runner for trust-but-verify evaluator
// ---------------------------------------------------------------------------
//
// Executes shell commands via Bun.spawn with timeout support.
// Used by the trust-but-verify evaluator to re-run worker's claimed
// test commands.
// ---------------------------------------------------------------------------

import { Log } from "../utils/log";
import type { CommandRunner } from "./trust-verify";

const log = Log.create({ service: "evaluator-command-runner" });

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Creates a production command runner that executes shell commands
 * via Bun.spawn. Captures stdout/stderr and enforces a timeout.
 */
export function createCommandRunner(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): CommandRunner {
  return async (command: string, cwd?: string) => {
    log.info("re-running worker command", { command, cwd });

    const proc = Bun.spawn(["sh", "-c", command], {
      cwd: cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    // Set up timeout
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      return {
        command,
        exitCode: timedOut ? -1 : exitCode,
        stdout: stdout.slice(0, 5000),
        stderr: stderr.slice(0, 5000),
        timedOut,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}
