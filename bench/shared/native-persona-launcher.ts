import { dirname, join } from "node:path";
import { ownedCommandRunner } from "../../src/infra/owned-command.js";
import { decodeNativePersonaRequest, nativePersonaPath, nativePersonaStartupFailure, writeNativePersonaResult, NATIVE_STARTUP_TIMEOUT_MS, NATIVE_SETTLEMENT_GRACE_MS, NATIVE_CANDIDATE_TIMEOUT_MS } from "../../src/orchestration/modules/development/benchmark/native-persona-codec.js";
import { cellIsolation, inheritedCellEnvironment } from "../chat-ab/isolation.js";
import { unavailableBenchmarkAccounting } from "../../src/orchestration/modules/development/benchmark/evidence.js";

/** The trusted launcher owns only OS confinement and the worker process, never the matrix or grading. */
async function main(requestPath: string, resultPath: string, cancelPath: string, resultsRoot: string): Promise<void> {
  const startedAt = performance.now();
  let phase: Parameters<typeof nativePersonaStartupFailure>[0] = "request";
  let cause: Parameters<typeof nativePersonaStartupFailure>[1] = "operation-failed";
  try {
    const request = decodeNativePersonaRequest(JSON.parse(await Bun.file(requestPath).text()));
    phase = "imports";
    const { createCliLauncher } = await import("../../src/cli/runtime-launch.js");
    phase = "launcher";
    const launcher = await createCliLauncher();
    try {
      const run = ownedCommandRunner(launcher.scope);
      phase = "isolation";
      const isolation = await cellIsolation(request.sourceRoot, resultsRoot, run, {
        kind: "flywheel", authProfile: request.usageAuthority.profileId,
      });
      phase = "account";
      if (isolation.accountHome !== request.accountHome) {
        cause = "account-home-changed";
        throw new Error("Native launcher account home changed");
      }
      phase = "isolation";
      const shared = join(request.sourceRoot, "bench", "shared");
      const job = dirname(requestPath);
      const home = await isolation.prepareHome(join(job, "home"));
      const confined = await isolation.confine({
        hidden: [join(request.sourceRoot, "bench"), resultsRoot, dirname(request.workspace)],
        own: [job, request.workspace],
        readonly: [shared],
      });
      phase = "runtime";
      const exit = await run(confined.wrap([
        process.execPath, "--conditions=browser", join(shared, "native-persona-worker.ts"), requestPath, resultPath, cancelPath,
      ]), {
        cwd: request.workspace,
        env: { ...inheritedCellEnvironment(process.env), ...home, PATH: nativePersonaPath(request, process.env.PATH) },
        timeoutMs: NATIVE_STARTUP_TIMEOUT_MS + (request.timeoutMs ?? NATIVE_CANDIDATE_TIMEOUT_MS) + NATIVE_SETTLEMENT_GRACE_MS,
      });
      if (exit.exitCode !== 0 && !await Bun.file(resultPath).exists()) {
        const durationMs = Math.round(performance.now() - startedAt);
        if (await Bun.file(join(job, "ready")).exists()) {
          const message = "Native worker exited without recoverable accounting";
          await writeNativePersonaResult(resultPath, {
            kind: "unsuccessful", durationMs, message,
            terminal: exit.timedOut
              ? { kind: "timed-out", timeoutMs: request.timeoutMs ?? NATIVE_CANDIDATE_TIMEOUT_MS }
              : { kind: "failed", message },
            accounting: unavailableBenchmarkAccounting(message),
          });
        } else {
          await writeNativePersonaResult(resultPath, nativePersonaStartupFailure(phase, cause, durationMs));
        }
      }
      process.exitCode = exit.exitCode ?? 1;
    } finally {
      await launcher.dispose();
    }
  } catch {
    if (!await Bun.file(resultPath).exists()) {
      await writeNativePersonaResult(resultPath, nativePersonaStartupFailure(phase, cause, Math.round(performance.now() - startedAt)));
    }
    process.exitCode = 1;
  }
}

const [requestPath, resultPath, cancelPath, resultsRoot] = process.argv.slice(2);
if (!requestPath || !resultPath || !cancelPath || !resultsRoot) throw new Error("Native launcher requires request, result, cancellation, and results paths");
await main(requestPath, resultPath, cancelPath, resultsRoot);
