/**
 * Build collection, one retention reason at a time.
 *
 * Each reason is proved on its own, because they are independent: a build kept
 * for one reason proves nothing about another. The fixtures stamp
 * modification times explicitly, since the retention band is the only thing
 * that reads them and a same-millisecond tie would decide nothing.
 *
 * Liveness is a pid probe, so a dead process is a pid the operating system
 * cannot have issued. Nothing here spawns anything.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../helpers/posix-failure-staging.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Log } from "../../../../src/infra/log.js";
import { currentBuildLink, liveBuildsDir, updateAuthorityDbFile, versionsDir } from "../../../../src/infra/paths.js";
import { buildCollectionPending, collectBuildTrees } from "../../../../src/infra/update/build-retention.js";
import { buildExecutable } from "../../../../src/infra/update/build-identity.js";
import { recordBuildProved } from "../../../../src/infra/update/service-start-record.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../../../src/infra/update/update-authority.js";
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js";
import { activatePlacedBuild } from "../../../helpers/placed-build.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-build-retention-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Higher than any pid an operating system issues. */
const UNISSUED_PID = 2_147_483_646;
const ASSET = "flywheel-darwin-arm64.tar.gz";

let accounts = 0;
let userDataRoot = "";

beforeEach(() => {
  accounts += 1;
  userDataRoot = path.join(TMP, `account-${accounts}`);
  fs.mkdirSync(versionsDir(userDataRoot), { recursive: true });
});

/** One installed build. `age` orders the retention band: a larger age is
 *  older, so `age: 0` is the newest build of a fixture. */
function build(version: string, marker: string, age = 0, executable = buildExecutable(process.platform)): string {
  const buildId = marker.repeat(64).slice(0, 64);
  const buildDir = path.join(versionsDir(userDataRoot), version, buildId);
  fs.mkdirSync(path.join(buildDir, "native"), { recursive: true });
  fs.writeFileSync(path.join(buildDir, "native", "libthing.so"), "payload");
  fs.writeFileSync(path.join(buildDir, executable), "#!/bin/sh\n", { mode: 0o755 });
  const metadata = path.join(buildDir, "build.json");
  fs.writeFileSync(metadata, JSON.stringify({ version, buildId, asset: ASSET }));
  const stamp = new Date(2_000_000_000_000 - age * 60_000);
  fs.utimesSync(metadata, stamp, stamp);
  return buildId;
}

function activate(version: string, buildId: string): void {
  activatePlacedBuild(userDataRoot, { version, buildId });
}

function register(buildId: string, pid: number): void {
  fs.mkdirSync(liveBuildsDir(userDataRoot), { recursive: true });
  fs.writeFileSync(path.join(liveBuildsDir(userDataRoot), `${buildId}.${pid}`), "");
}

function execPathOf(version: string, buildId: string): string {
  return path.join(versionsDir(userDataRoot), version, buildId, buildExecutable(process.platform));
}

function installedBuilds(): readonly string[] {
  const found: string[] = [];
  for (const version of fs.readdirSync(versionsDir(userDataRoot)).sort()) {
    for (const entry of fs.readdirSync(path.join(versionsDir(userDataRoot), version)).sort()) found.push(`${version}/${entry}`);
  }
  return found;
}

/** Two collectible builds newer than anything else a fixture makes, so the
 *  retention band is spent on them and is never the reason a build under test
 *  survives. */
function fillRetentionBand(): void {
  build("0.9.0", "8", 1);
  build("0.9.1", "9", 2);
}

/** One more collectible build, old enough that only a sweep that ran at all
 *  removes it. Its removal is what proves the assertions below are about the
 *  retention reason and not about a sweep that did nothing. */
function collectibleBuild(): string {
  return `0.8.0/${build("0.8.0", "7", 600)}`;
}

describe("what keeps a build", () => {
  test("the build current resolves to is never collected", async () => {
    const active = build("1.4.0", "a", 100);
    activate("1.4.0", active);
    fillRetentionBand();
    const spare = collectibleBuild();

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toEqual([spare]);
    expect(installedBuilds()).toContain(`1.4.0/${active}`);
  });

  test("the build this process is executing is never collected", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const running = build("1.4.0", "b", 300);
    fillRetentionBand();
    const spare = collectibleBuild();

    const collected = await collectBuildTrees({ userDataRoot, execPath: execPathOf("1.4.0", running) });

    expect(collected.removedBuilds).toEqual([spare]);
    expect(installedBuilds()).toContain(`1.4.0/${running}`);
  });

  test("a build a live registration names is never collected", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const held = build("1.0.0", "b", 300);
    fillRetentionBand();
    const spare = collectibleBuild();
    register(held, process.pid);

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toEqual([spare]);
    expect(installedBuilds()).toContain(`1.0.0/${held}`);
  });

  test("the last proved build is never collected, however many builds are newer", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const proved = build("1.0.0", "b", 300);
    fillRetentionBand();
    const spare = collectibleBuild();
    // A rollback returns to this build when the active one cannot start or
    // cannot open any project.
    recordBuildProved(userDataRoot, { version: "1.0.0", buildId: proved });

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toEqual([spare]);
    expect(installedBuilds()).toContain(`1.0.0/${proved}`);
  });

  test("a registration whose process is gone keeps nothing", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const abandoned = build("1.0.0", "b", 300);
    fillRetentionBand();
    register(abandoned, UNISSUED_PID);

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toContain(`1.0.0/${abandoned}`);
  });

  test("the newest collectible builds are kept as the retention band", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const newest = build("1.4.0", "b", 10);
    const next = build("1.3.0", "c", 20);
    const oldest = build("1.2.0", "d", 30);

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toEqual([`1.2.0/${oldest}`]);
    expect(installedBuilds()).toEqual([`1.3.0/${next}`, `1.4.0/${newest}`, `1.5.0/${active}`]);
  });

  test("an account whose current build cannot be read keeps every build it has", async () => {
    build("1.5.0", "a");
    fillRetentionBand();
    const before = installedBuilds();

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedBuilds).toEqual([]);
    expect(collected.keptBuilds).toBe(3);
    expect(installedBuilds()).toEqual(before);
  });

  test("a directory that states no build is left exactly as it is", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();
    const stranger = path.join(versionsDir(userDataRoot), "1.5.0", "not-a-build");
    fs.mkdirSync(stranger);
    fs.writeFileSync(path.join(stranger, "notes.txt"), "someone else's");

    await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(fs.existsSync(path.join(stranger, "notes.txt"))).toBe(true);
  });
});

/** A Windows account's builds: `flywheel-bin.exe`, and `current` as the
 *  pointer file the Windows launcher reads. */
function windowsBuild(version: string, marker: string, age = 0): string {
  return build(version, marker, age, "flywheel-bin.exe");
}

function point(version: string, buildId: string): void {
  fs.writeFileSync(currentBuildLink(userDataRoot), `versions\\${version}\\${buildId}`);
}

/** The executables a Windows process runs, by inode: Windows refuses to
 *  delete one, and lets its directory be renamed. */
const runningExecutables = new Set<number>();

describe("a Windows account", () => {
  useWin32ContainedDirectories(() => ({
    unlinkEntry: (entryPath) => {
      if (runningExecutables.has(fs.statSync(entryPath).ino)) throw Object.assign(new Error("the executable runs"), { code: "EPERM" });
      fs.unlinkSync(entryPath);
    },
  }));

  test("the build the pointer names is never collected", async () => {
    const active = windowsBuild("1.4.0", "a", 100);
    point("1.4.0", active);
    fillRetentionBand();
    const spare = collectibleBuild();

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });

    expect(collected.removedBuilds).toEqual([spare]);
    expect(installedBuilds()).toContain(`1.4.0/${active}`);
  });

  test("a pointer that names no installed build keeps every build", async () => {
    windowsBuild("1.4.0", "a");
    fillRetentionBand();
    fs.writeFileSync(currentBuildLink(userDataRoot), "..\\elsewhere\\1.4.0");
    const before = installedBuilds();

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });

    expect(collected.removedBuilds).toEqual([]);
    expect(installedBuilds()).toEqual(before);
  });

  test("builds whose executables refuse deletion stay whole for the next collection, reported once with a count", async () => {
    const active = windowsBuild("1.5.0", "a");
    point("1.5.0", active);
    fillRetentionBand();
    const running = [windowsBuild("0.8.0", "7", 600), windowsBuild("0.7.0", "6", 700)];
    const runningDirs = running.map((buildId, index) => path.join(versionsDir(userDataRoot), index === 0 ? "0.8.0" : "0.7.0", buildId));
    for (const dir of runningDirs) runningExecutables.add(fs.statSync(path.join(dir, "flywheel-bin.exe")).ino);
    const info = spyOn(Log.create({ service: "build-retention" }), "info").mockImplementation(() => {});
    try {
      const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });

      expect(collected.removedBuilds).toEqual([]);
      for (const dir of runningDirs) {
        expect(fs.existsSync(path.join(dir, "flywheel-bin.exe"))).toBe(true);
        expect(fs.existsSync(path.join(dir, "build.json"))).toBe(true);
      }
      expect(info.mock.calls.map(([message]) => message)).toEqual([
        "build collection kept a build whose executable still runs",
        "build collection kept more builds whose executables still run",
      ]);
    } finally {
      info.mockRestore();
      runningExecutables.clear();
    }

    const later = await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });
    expect([...later.removedBuilds].sort()).toEqual([`0.7.0/${running[1]}`, `0.8.0/${running[0]}`]);
  });

  test("a remainder whose executable still runs is not emptied", async () => {
    const active = windowsBuild("1.5.0", "a");
    point("1.5.0", active);
    const stranded = path.join(versionsDir(userDataRoot), "1.5.0", `.staging.${UNISSUED_PID}.0123456789abcdef`);
    fs.mkdirSync(path.join(stranded, "native"), { recursive: true });
    fs.writeFileSync(path.join(stranded, "flywheel-bin.exe"), "running");
    fs.writeFileSync(path.join(stranded, "native", "lib.dll"), "loaded");
    runningExecutables.add(fs.statSync(path.join(stranded, "flywheel-bin.exe")).ino);
    try {
      await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });

      expect(fs.existsSync(path.join(stranded, "native", "lib.dll"))).toBe(true);
    } finally {
      runningExecutables.clear();
    }
    await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });
    expect(fs.existsSync(stranded)).toBe(false);
  });

  test("a private activation name whose writer is gone is collected, and one whose writer runs is kept", async () => {
    const active = windowsBuild("1.5.0", "a");
    point("1.5.0", active);
    const abandoned = `.current.${UNISSUED_PID}.0123456789abcdef`;
    const live = `.current.${process.pid}.0123456789abcdef`;
    fs.writeFileSync(path.join(userDataRoot, abandoned), "versions\\1.5.0\\x");
    fs.writeFileSync(path.join(userDataRoot, live), "versions\\1.5.0\\x");
    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath, platform: "win32" })).toBe(true);

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath, platform: "win32" });

    expect(collected.removedRemainders).toContain(abandoned);
    expect(fs.existsSync(path.join(userDataRoot, abandoned))).toBe(false);
    expect(fs.existsSync(path.join(userDataRoot, live))).toBe(true);
  });
});

describe("the survey before a collection", () => {
  test("an account whose builds every retention reason keeps has nothing to collect", () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();

    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath })).toBe(false);
  });

  test("a build no reason keeps is something to collect, and the survey removes nothing", () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();
    const spare = collectibleBuild();

    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath })).toBe(true);
    expect(installedBuilds()).toContain(spare);
  });

  test("an abandoned staging remainder is something to collect, at the versions root or inside a version", () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const placement = path.join(versionsDir(userDataRoot), "1.5.0", `.staging.${UNISSUED_PID}.abcdef`);
    fs.mkdirSync(placement);
    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath })).toBe(true);

    fs.rmSync(placement, { recursive: true });
    fs.mkdirSync(path.join(versionsDir(userDataRoot), `.update.${UNISSUED_PID}.def456`));
    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath })).toBe(true);
  });

  test("an account whose current build cannot be read has only its remainders to collect", () => {
    build("1.5.0", "a");
    fillRetentionBand();
    collectibleBuild();

    expect(buildCollectionPending({ userDataRoot, execPath: process.execPath })).toBe(false);
  });

  test("an account with no versions root has nothing to collect", () => {
    const empty = path.join(TMP, "account-never-surveyed");
    fs.mkdirSync(empty, { recursive: true });

    expect(buildCollectionPending({ userDataRoot: empty })).toBe(false);
  });
});

describe("what is collected", () => {
  test("a version directory left with no build goes with the builds", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    build("1.4.0", "b", 10);
    build("1.3.0", "c", 20);
    const lonely = build("1.2.0", "d", 30);

    await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(fs.existsSync(path.join(versionsDir(userDataRoot), "1.2.0"))).toBe(false);
    expect(installedBuilds()).not.toContain(`1.2.0/${lonely}`);
  });

  test("a withdrawn sweep stops between trees and says there is more to take", async () => {
    const active = build("1.9.0", "a");
    activate("1.9.0", active);
    for (const [index, marker] of ["b", "c", "d", "e", "f"].entries()) build(`1.${index}.0`, marker, 100 + index);
    const abandoned = path.join(versionsDir(userDataRoot), `.update.${UNISSUED_PID}.def456`);
    fs.mkdirSync(abandoned);
    const withdrawal = new AbortController();
    withdrawal.abort();

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath, signal: withdrawal.signal });

    // A shutdown withdraws the sweep, and the next run takes what it left.
    expect(collected.removedBuilds).toEqual([]);
    expect(collected.removedRemainders).toEqual([]);
    expect(collected.truncated).toBe(true);
    expect(collected.keptBuilds).toBe(6);
    expect(fs.existsSync(abandoned)).toBe(true);
  });

  test("a placement remainder is collected only once its creator is gone", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const versionDir = path.join(versionsDir(userDataRoot), "1.5.0");
    fs.mkdirSync(path.join(versionDir, `.staging.${UNISSUED_PID}.abcdef`));
    fs.mkdirSync(path.join(versionDir, `.staging.${process.pid}.123456`));
    fs.mkdirSync(path.join(versionDir, ".staging.no-pid-at-all"));

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedRemainders).toEqual([`1.5.0/.staging.${UNISSUED_PID}.abcdef`]);
    expect(fs.existsSync(path.join(versionDir, `.staging.${process.pid}.123456`))).toBe(true);
    expect(fs.existsSync(path.join(versionDir, ".staging.no-pid-at-all"))).toBe(true);
  });

  test("a transfer remainder is collected only once its creator is gone", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    const running = path.join(versionsDir(userDataRoot), `.update.${process.pid}.abc123`);
    const abandoned = path.join(versionsDir(userDataRoot), `.update.${UNISSUED_PID}.def456`);
    const anonymous = path.join(versionsDir(userDataRoot), ".update.beforethepidwasstated");
    for (const remainder of [running, abandoned, anonymous]) {
      fs.mkdirSync(remainder);
      fs.writeFileSync(path.join(remainder, "spooled"), "half a download");
    }

    const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(collected.removedRemainders).toEqual([`.update.${UNISSUED_PID}.def456`]);
    // A live transfer is still writing into its own directory, and a name that
    // states no owner cannot be proved abandoned at all.
    expect(fs.existsSync(running)).toBe(true);
    expect(fs.existsSync(anonymous)).toBe(true);
  });

  // The lease is what orders a removal against an activation moving `current`.
  // Without it, a sweep can unlink the very tree an activation just published,
  // leaving the account with no runnable build at all.
  test("a sweep takes the account update lease, and takes nothing without it", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();
    const spare = collectibleBuild();

    const holder = createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
    try {
      expect(holder.claim({ nowMs: Date.now(), freshForMs: 0, leaseMs: 60_000 }).kind).toBe("won");
      expect(await collectBuildTrees({ userDataRoot, execPath: process.execPath })).toEqual({ removedBuilds: [], removedRemainders: [], keptBuilds: 0, truncated: false });
      expect(installedBuilds()).toContain(spare);
    } finally {
      // Disposal hands the lease back, which is what the next claimant needs.
      holder.dispose();
    }

    expect((await collectBuildTrees({ userDataRoot, execPath: process.execPath })).removedBuilds).toEqual([spare]);
  });

  // A recursive unlink is not atomic, so what an interrupted removal leaves has
  // to be a name a later sweep still recognizes.
  test.skipIf(!POSIX_FAILURE_STAGING)("a build whose removal cannot finish is left under a name a later sweep collects", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();
    const doomed = build("0.8.0", "7", 600);
    const versionDir = path.join(versionsDir(userDataRoot), "0.8.0");
    // A directory the unlink cannot open, so the removal stops part way.
    fs.chmodSync(path.join(versionDir, doomed, "native"), 0o000);
    try {
      const collected = await collectBuildTrees({ userDataRoot, execPath: process.execPath });

      // Out of the installed set either way: the rename is the point of no
      // return, and what is left states this process, so a later sweep takes it.
      expect(collected.removedBuilds).toEqual([`0.8.0/${doomed}`]);
      expect(fs.readdirSync(versionDir)).toEqual([expect.stringMatching(new RegExp(`^\\.staging\\.${process.pid}\\.[0-9a-f]{16}$`))]);
    } finally {
      for (const entry of fs.readdirSync(versionDir)) fs.chmodSync(path.join(versionDir, entry, "native"), 0o700);
    }
  });

  test("an account with no versions root is nothing to collect", async () => {
    const empty = path.join(TMP, "account-never-installed");
    fs.mkdirSync(empty, { recursive: true });

    expect(await collectBuildTrees({ userDataRoot: empty })).toEqual({ removedBuilds: [], removedRemainders: [], keptBuilds: 0, truncated: false });
  });

  test("nothing outside the versions root is touched", async () => {
    const active = build("1.5.0", "a");
    activate("1.5.0", active);
    fillRetentionBand();
    fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), "theme = 'dark'\n");
    fs.mkdirSync(path.join(userDataRoot, "sessions", "one"), { recursive: true });

    await collectBuildTrees({ userDataRoot, execPath: process.execPath });

    expect(fs.existsSync(path.join(userDataRoot, "flywheel.toml"))).toBe(true);
    expect(fs.existsSync(path.join(userDataRoot, "sessions", "one"))).toBe(true);
    expect(fs.existsSync(currentBuildLink(userDataRoot))).toBe(true);
  });
});
