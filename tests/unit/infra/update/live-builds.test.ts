/**
 * The live-build registry, exercised the way a launch and a collector use it.
 *
 * Liveness is a pid probe, so a dead process is represented by a pid the
 * operating system cannot have issued rather than by killing anything: these
 * tests spawn nothing.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { liveBuildsDir, versionsDir } from "../../../../src/infra/paths.js";
import { liveBuildIds, ownBuildId, registerLiveBuild } from "../../../../src/infra/update/live-builds.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-live-builds-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Higher than any pid an operating system issues, so nothing runs under it. */
const UNISSUED_PID = 2_147_483_646;

const BUILD_A = "a".repeat(64);
const BUILD_B = "b".repeat(64);
const ASSET = "flywheel-darwin-arm64.tar.gz";

let accounts = 0;

/** An account root holding one installed build, and the path of the executable
 *  a process launched from it would run. */
function accountWithBuild(options: { readonly version?: string; readonly buildId?: string; readonly states?: object } = {}) {
  accounts += 1;
  const userDataRoot = path.join(TMP, `account-${accounts}`);
  const version = options.version ?? "1.4.0";
  const buildId = options.buildId ?? BUILD_A;
  const buildDir = path.join(versionsDir(userDataRoot), version, buildId);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "build.json"), JSON.stringify(options.states ?? { version, buildId, asset: ASSET }));
  fs.writeFileSync(path.join(buildDir, "flywheel-bin"), "#!/bin/sh\n", { mode: 0o755 });
  return { userDataRoot, buildId, execPath: path.join(buildDir, "flywheel-bin") };
}

function registrationNames(userDataRoot: string): readonly string[] {
  try {
    return fs.readdirSync(liveBuildsDir(userDataRoot)).sort();
  } catch {
    return [];
  }
}

describe("identifying the running build", () => {
  test("the build an installed executable belongs to is read off its own path", () => {
    const account = accountWithBuild();

    expect(ownBuildId(account.userDataRoot, account.execPath)).toBe(account.buildId);
  });

  test("a build whose build.json is larger than any earlier client read still identifies itself", () => {
    const account = accountWithBuild({ states: { version: "1.4.0", buildId: BUILD_A, asset: ASSET, notes: "x".repeat(64 * 1024) } });

    expect(ownBuildId(account.userDataRoot, account.execPath)).toBe(BUILD_A);
  });

  test("an executable outside the account's versions root is running no installed build", () => {
    const account = accountWithBuild();
    const elsewhere = path.join(TMP, "elsewhere", "flywheel-bin");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 });

    expect(ownBuildId(account.userDataRoot, elsewhere)).toBeUndefined();
    // A source checkout runs bun itself, which is the ordinary case.
    expect(ownBuildId(account.userDataRoot, process.execPath)).toBeUndefined();
  });

  test("a tree that states another build than its own place is not the build it sits in", () => {
    // The one case that makes an identity claim worth checking: the directory
    // name says one build, the metadata inside says another.
    const account = accountWithBuild({ states: { version: "1.4.0", buildId: BUILD_B, asset: ASSET } });

    expect(ownBuildId(account.userDataRoot, account.execPath)).toBeUndefined();
  });

  test("a build directory that describes nothing is not identified", () => {
    const account = accountWithBuild();
    fs.rmSync(path.join(path.dirname(account.execPath), "build.json"));

    expect(ownBuildId(account.userDataRoot, account.execPath)).toBeUndefined();
  });
});

describe("declaring and withdrawing", () => {
  test("a process running an installed build declares it, and the withdrawal takes it back", () => {
    const account = accountWithBuild();

    const withdraw = registerLiveBuild(account.userDataRoot, account.execPath);

    expect(registrationNames(account.userDataRoot)).toEqual([`${account.buildId}.${process.pid}`]);
    expect(liveBuildIds(account.userDataRoot)).toEqual(new Set([account.buildId]));

    withdraw();
    expect(registrationNames(account.userDataRoot)).toEqual([]);
    expect(liveBuildIds(account.userDataRoot)).toEqual(new Set());
    // Withdrawing twice is withdrawing: an absent entry is already gone.
    expect(() => withdraw()).not.toThrow();
  });

  test("a run from a source checkout declares nothing and writes no registry", () => {
    const account = accountWithBuild();

    // The ordinary source-checkout launch: bun itself, under no versions root.
    const withdraw = registerLiveBuild(account.userDataRoot, process.execPath);
    withdraw();

    expect(registrationNames(account.userDataRoot)).toEqual([]);
  });

  test("a registry that was never written to holds no live build", () => {
    const account = accountWithBuild();

    expect(liveBuildIds(account.userDataRoot)).toEqual(new Set());
  });
});

describe("reading the registry", () => {
  test("a registration whose process is gone is removed instead of believed", () => {
    const account = accountWithBuild();
    fs.mkdirSync(liveBuildsDir(account.userDataRoot), { recursive: true });
    fs.writeFileSync(path.join(liveBuildsDir(account.userDataRoot), `${BUILD_A}.${UNISSUED_PID}`), "");
    fs.writeFileSync(path.join(liveBuildsDir(account.userDataRoot), `${BUILD_B}.${process.pid}`), "");

    expect(liveBuildIds(account.userDataRoot)).toEqual(new Set([BUILD_B]));
    expect(registrationNames(account.userDataRoot)).toEqual([`${BUILD_B}.${process.pid}`]);
  });

  test("an entry this registry did not write is neither believed nor removed", () => {
    const account = accountWithBuild();
    fs.mkdirSync(liveBuildsDir(account.userDataRoot), { recursive: true });
    for (const name of ["notes.txt", `${BUILD_A}.0`, `${BUILD_A}.${process.pid}.extra`, "short.1"]) {
      fs.writeFileSync(path.join(liveBuildsDir(account.userDataRoot), name), "");
    }

    expect(liveBuildIds(account.userDataRoot)).toEqual(new Set());
    expect(registrationNames(account.userDataRoot)).toEqual([`${BUILD_A}.0`, `${BUILD_A}.${process.pid}.extra`, "notes.txt", "short.1"]);
  });
});
