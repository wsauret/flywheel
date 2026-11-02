/**
 * The install engine's own proofs of a payload: that its build runs here,
 * and what it records when the tree is not the one `build.json` names.
 *
 * Each case installs a Windows build, because the path-held Windows
 * contained-directory backend runs on every host and needs no execute bit,
 * so the same case means the same thing on macOS, Linux, and Windows.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DebugLogRecordInput } from "../../../../src/infra/debug-log.js";
import { Log } from "../../../../src/infra/log.js";
import type { OwnedCommandOptions, OwnedCommandResult } from "../../../../src/infra/owned-command.js";
import { versionsDir } from "../../../../src/infra/paths.js";
import { computeBuildId } from "../../../../src/infra/update/build-identity.js";
import { installBuild } from "../../../../src/orchestration/update/install-engine.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js";

const temporaryDirectory = temporaryDirectories();
useWin32ContainedDirectories();
afterEach(async () => { await Log.closeGlobal(); });

const PLATFORM_ARCH = "win32-x64";
const VERSION = "2.0.0";

interface Account {
  readonly userDataRoot: string;
  readonly wrapperDir: string;
  readonly payload: string;
}

/** One Windows build payload, and the account it installs into. `buildId`
 *  is what its `build.json` states; the tree's own digest by default. */
function account(options: { readonly buildId?: string } = {}): Account & { readonly digest: string } {
  const home = temporaryDirectory("flywheel-install-engine-");
  const payload = path.join(home, "payload");
  const native = path.join(payload, "native", PLATFORM_ARCH);
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(payload, "flywheel-bin.exe"), "build");
  fs.writeFileSync(path.join(native, "flywheel-launcher.exe"), "launcher");
  fs.writeFileSync(path.join(native, "flywheel-service-launcher.exe"), "service launcher");
  const digest = computeBuildId(payload, "win32");
  fs.writeFileSync(path.join(payload, "build.json"), `${JSON.stringify({ version: VERSION, buildId: options.buildId ?? digest })}\n`);
  return { userDataRoot: path.join(home, ".flywheel"), wrapperDir: path.join(home, "bin"), payload, digest };
}

/** A run of the build's executable that answers `timedOut` for each bound in
 *  `slowUnder`, and every other command, which succeeds. */
function runner(slowUnder: readonly number[], bounds: (number | undefined)[]) {
  return async (command: readonly string[], options?: OwnedCommandOptions): Promise<OwnedCommandResult> => {
    const asked = command[1] === "--version";
    if (asked) bounds.push(options?.timeoutMs);
    const timedOut = asked && options?.timeoutMs !== undefined && slowUnder.includes(options.timeoutMs);
    return { exitCode: timedOut ? null : 0, stdoutBytes: new Uint8Array(0), stdout: "", stderr: "", timedOut };
  };
}

function install(target: Account, run: ReturnType<typeof runner>) {
  return installBuild({ userDataRoot: target.userDataRoot, sourceDir: target.payload, wrapperDir: target.wrapperDir, platform: "win32", platformArch: PLATFORM_ARCH, runCommand: run, processTable: async () => [] });
}

describe("the run proof of a staged build", () => {
  test("a first run that does not answer within 30 s is asked again within 120 s before the build is refused", async () => {
    const target = account();
    const bounds: (number | undefined)[] = [];

    const outcome = await install(target, runner([30_000], bounds));

    expect(outcome.kind).toBe("placed");
    expect(bounds).toEqual([30_000, 120_000]);
  });

  test("a build that answers within neither bound is refused, and nothing is placed", async () => {
    const target = account();
    const bounds: (number | undefined)[] = [];

    await expect(install(target, runner([30_000, 120_000], bounds))).rejects.toThrow("did not answer its version within 120000ms");
    expect(bounds).toEqual([30_000, 120_000]);
    expect(fs.readdirSync(path.join(versionsDir(target.userDataRoot), VERSION))).toEqual([]);
  });
});

describe("a tree that is not the build its build.json names", () => {
  test("is installed under the build id it states, and one INFO record names both ids", async () => {
    const stated = "f".repeat(64);
    const target = account({ buildId: stated });
    const records: DebugLogRecordInput[] = [];
    await Log.init({ forward: (record) => { records.push(record); } });

    const outcome = await install(target, runner([], []));

    expect(outcome).toMatchObject({ kind: "placed", buildDir: path.join(versionsDir(target.userDataRoot), VERSION, stated) });
    const mismatches = records.filter((record) => JSON.stringify(record).includes("does not digest to the build id"));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.type).toBe("log.info");
    expect(JSON.stringify(mismatches[0])).toContain(stated);
    expect(JSON.stringify(mismatches[0])).toContain(target.digest);
  });
});
