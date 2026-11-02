import { join } from "node:path";
import { checkoutProgram, runsThroughBun } from "../../../infra/cli-subprocess.js";
import { buildPlatformArch, checkoutClaudeEngine, claudeEngineFile, nativeAssetDir } from "../../../infra/native-assets.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";

/** A `--version` call takes about 150 ms. */
const VERSION_BOUND_MS = 10_000;

/**
 * The `claude` engine that ships with Flywheel: the platform binary of the pinned Agent SDK, `claude` or
 * `claude.exe`. A release runs the copy that its build placed in the build's native directory, which the build
 * verified against the SDK's manifest. A source run runs the copy in the SDK's platform package, which `bun install`
 * placed from the lockfile in the checkout. A dev service's source snapshot pins that copy when the snapshot is made,
 * so a service runs the engine it started with until it restarts, whatever a later install places in the checkout.
 * Flywheel never runs a `claude` from the PATH, so the person's own `claude` installation and its updates never change what
 * serves Flywheel. Nothing here runs or reads the engine, so it starts only when a query, a login, or `/doctor` starts
 * it.
 */
export function enginePath(): string {
  const platformArch = buildPlatformArch();
  if (!runsThroughBun(process.execPath)) return join(nativeAssetDir(), claudeEngineFile(platformArch));
  return checkoutProgram(checkoutClaudeEngine(platformArch));
}

/** What `<engine> --version` names, run through the caller's owned-command runner. The call prints the version and
 *  exits: it reads no login, writes no file, and sends nothing. Rejects with the reason that it named none. */
export async function readEngineVersion(engine: string, run: OwnedCommandRunner): Promise<string> {
  const result = await run([engine, "--version"], { timeoutMs: VERSION_BOUND_MS });
  if (result.timedOut) throw new Error(`it did not answer --version within ${VERSION_BOUND_MS / 1000} s`);
  if (result.exitCode !== 0) throw new Error(`its --version call exited with code ${String(result.exitCode)}`);
  const version = /^(\d+\.\d+\.\d+)\b/u.exec(result.stdout.trim())?.[1];
  if (version === undefined) throw new Error("its --version output names no version");
  return version;
}
