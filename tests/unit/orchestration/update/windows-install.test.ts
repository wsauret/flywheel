/**
 * A Windows installation through the one install engine: the build in the
 * account's versions tree, `current` as the pointer file the Windows launcher
 * reads, the launcher on PATH as `flywheel.exe` under the install record, and
 * the conversion of the flat installation earlier releases wrote.
 *
 * The engine installs the build the request names, not the host's, and the
 * path-held Windows contained-directory backend runs on every host, so a
 * Windows build is installed here on any host. What only Windows does,
 * refusing a rename or a deletion while a process holds the file, is staged
 * through that backend's rename and unlink operations.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Win32ContainedDirectoryOperations } from "../../../../src/infra/descriptor-directory-win32.js";
import { updateAuthorityDbFile, versionsDir } from "../../../../src/infra/paths.js";
import type { ProcessRow } from "../../../../src/infra/process-table.js";
import { computeBuildId, decodeBuildMetadata } from "../../../../src/infra/update/build-identity.js";
import { recordBuildProved } from "../../../../src/infra/update/service-start-record.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../../../src/infra/update/update-authority.js";
import { installBuild, rollBackActivation } from "../../../../src/orchestration/update/install-engine.js";
import { refusedBuild } from "../../../../src/orchestration/update/refused-build.js";
import { collectWindowsLauncherDirectory, windowsLauncherCollectionPending } from "../../../../src/orchestration/update/windows-install.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js";

const temporaryDirectory = temporaryDirectories();

/** What the Windows backend meets instead of the host's own refusals, set by
 *  a case and cleared after it. */
let windows: Partial<Win32ContainedDirectoryOperations> = {};
useWin32ContainedDirectories(() => windows);
afterEach(() => { windows = {}; });

const PLATFORM_ARCH = "win32-x64";
const ASSET = `flywheel-${PLATFORM_ARCH}.tar.gz`;
const RECORD = ".flywheel-install.json";
/** The versions record, byte for byte the text 0.0.11 wrote and reads. */
const LAUNCHER_RECORD = '{"installedBy":"flywheel","layout":"versions","owns":["flywheel.exe"]}';
/** The manifests the flat installers of 0.0.8 and of later flat releases wrote. */
const FLAT_RECORD_0_0_8 = '{"installedBy":"flywheel","owns":["flywheel.exe","fonts","native"]}';
const FLAT_RECORD_0_0_9 = '{"installedBy":"flywheel","owns":["build.json","flywheel.exe","fonts","native","webview"]}';
const RETIRED = /^\.flywheel-retired-[0-9a-f]{16}\.exe$/;

interface Account {
  readonly userDataRoot: string;
  readonly wrapperDir: string;
  readonly payloads: string;
  readonly commands: string[][];
}

function account(): Account {
  const home = temporaryDirectory("flywheel-windows-install-");
  return { userDataRoot: path.join(home, ".flywheel"), wrapperDir: path.join(home, "AppData", "Local", "Flywheel", "bin"), payloads: path.join(home, "payloads"), commands: [] };
}

/** A Windows build payload as the release archive carries it. */
function payload(target: Account, name: string, options: { readonly version: string; readonly launcher?: string; readonly serviceLauncher?: string; readonly launchers?: false }) {
  const dir = path.join(target.payloads, name);
  const native = path.join(dir, "native", PLATFORM_ARCH);
  fs.mkdirSync(native, { recursive: true });
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "webview"), { recursive: true });
  fs.writeFileSync(path.join(dir, "flywheel-bin.exe"), `build ${options.version}`);
  if (options.launchers !== false) {
    fs.writeFileSync(path.join(native, "flywheel-launcher.exe"), options.launcher ?? "launcher v1");
    fs.writeFileSync(path.join(native, "flywheel-service-launcher.exe"), options.serviceLauncher ?? "service launcher v1");
  }
  fs.writeFileSync(path.join(dir, "fonts", "monaspace.txt"), "font");
  fs.writeFileSync(path.join(dir, "webview", "index.html"), "<!doctype html>");
  const buildId = computeBuildId(dir, "win32");
  fs.writeFileSync(path.join(dir, "build.json"), `${JSON.stringify({ version: options.version, buildId, asset: ASSET }, null, 2)}\n`);
  return { dir, buildId };
}

/** Every command the engine runs, recorded. A build asked its version answers
 *  from the metadata beside it, as a working build does. */
function runner(target: Account) {
  return async (command: readonly string[]) => {
    target.commands.push([...command]);
    const [executable, argument] = command;
    let stdout = "";
    if (argument === "--version" && executable !== undefined) {
      const metadata = decodeBuildMetadata(fs.readFileSync(path.join(path.dirname(executable), "build.json"), "utf8"));
      stdout = `flywheel ${metadata.version.canonical} (build ${metadata.buildId})\n`;
    }
    return { exitCode: 0, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr: "", timedOut: false };
  };
}

/** The process table of an installation the flat build at `wrapperDir`
 *  started: the install role, two PowerShell hosts, and the flat updater. */
function startedByFlatUpdater(target: Account): readonly ProcessRow[] {
  return [
    { pid: process.pid, ppid: 91, argv: ["C:\\flywheel-install\\build\\flywheel-bin.exe", "--internal-role=binary-install"] },
    { pid: 91, ppid: 92, argv: ["powershell.exe", "-File", "install.ps1"] },
    { pid: 92, ppid: 93, argv: ["powershell.exe", "-File", ".install.ps1"] },
    { pid: 93, ppid: 1, argv: [path.join(target.wrapperDir, "flywheel.exe"), "--internal-role=command-supervisor"] },
  ];
}

/** `table` is the host's process table, and its rows are nothing when the
 *  table cannot be read. */
function install(target: Account, sourceDir: string, table: { readonly rows: readonly ProcessRow[] | undefined } = { rows: [] }) {
  return installBuild({ userDataRoot: target.userDataRoot, sourceDir, wrapperDir: target.wrapperDir, platform: "win32", platformArch: PLATFORM_ARCH, runCommand: runner(target), processTable: async () => table.rows });
}

/** Windows refusing to delete a retired executable, as it does while the
 *  flat build or an old launcher still runs from it. */
function retiredExecutablesRun(): void {
  windows = {
    unlinkEntry: (entryPath) => {
      if (RETIRED.test(path.basename(entryPath))) throw Object.assign(new Error("the executable runs"), { code: "EPERM" });
      fs.unlinkSync(entryPath);
    },
  };
}

function pointer(target: Account): string {
  return fs.readFileSync(path.join(target.userDataRoot, "current"), "utf8");
}

function launcherDirectory(target: Account): readonly string[] {
  return fs.readdirSync(target.wrapperDir).map((name) => (RETIRED.test(name) ? ".flywheel-retired-*.exe" : name)).sort();
}

/** The flat installation an earlier release left in the launcher directory. */
function flatInstallation(target: Account, record: string): void {
  fs.mkdirSync(path.join(target.wrapperDir, "native", PLATFORM_ARCH), { recursive: true });
  fs.mkdirSync(path.join(target.wrapperDir, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(target.wrapperDir, "flywheel.exe"), "flat 0.0.8");
  fs.writeFileSync(path.join(target.wrapperDir, "native", PLATFORM_ARCH, "libopentui.dll"), "dll");
  fs.writeFileSync(path.join(target.wrapperDir, "fonts", "monaspace.txt"), "font");
  if (record.includes("webview")) {
    fs.mkdirSync(path.join(target.wrapperDir, "webview"));
    fs.writeFileSync(path.join(target.wrapperDir, "build.json"), JSON.stringify({ version: "0.0.9", buildId: "9".repeat(64), asset: ASSET }));
  }
  fs.writeFileSync(path.join(target.wrapperDir, RECORD), record);
}

/** Holds the account update lease, as a flat updater does while its
 *  bootstrap installer runs, for the length of `use`. */
async function underHeldLease<T>(target: Account, use: (renew: () => string) => Promise<T>): Promise<T> {
  fs.mkdirSync(path.join(target.userDataRoot, "update"), { recursive: true });
  const holder = createUpdateAuthority({ dbFile: updateAuthorityDbFile(target.userDataRoot, UPDATE_PROTOCOL_VERSION) });
  try {
    const claim = holder.claim({ nowMs: Date.now(), freshForMs: 0, leaseMs: 60_000 });
    if (claim.kind !== "won") throw new Error("the lease was not free");
    return await use(() => holder.renew({ fence: claim.fence, nowMs: Date.now(), leaseMs: 60_000 }));
  } finally {
    holder.dispose();
  }
}

/** A rename in the launcher directory that fails at the `failing` renames
 *  counted from 1, as Windows refuses one while another process holds the
 *  file beyond the rename's bound. */
function refuseLauncherRenames(target: Account, failing: readonly number[]): void {
  let renames = 0;
  windows = {
    renameEntry: (source, destination) => {
      if (path.dirname(source) === fs.realpathSync(target.wrapperDir)) {
        renames += 1;
        if (failing.includes(renames)) throw Object.assign(new Error(`rename ${renames} refused`), { code: "EPERM" });
      }
      fs.renameSync(source, destination);
    },
  };
}

describe("a Windows installation", () => {
  test("places the build in the versions tree, points current at it, and puts its launcher on PATH", async () => {
    const target = account();
    const build = payload(target, "a", { version: "0.0.10" });

    const outcome = await install(target, build.dir);

    const buildDir = path.join(versionsDir(target.userDataRoot), "0.0.10", build.buildId);
    expect(outcome).toMatchObject({ kind: "placed", buildDir, wrapperPath: path.join(target.wrapperDir, "flywheel.exe") });
    expect(fs.readFileSync(path.join(buildDir, "flywheel-bin.exe"), "utf8")).toBe("build 0.0.10");
    expect(pointer(target)).toBe(`versions\\0.0.10\\${build.buildId}`);
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "utf8")).toBe("service launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(LAUNCHER_RECORD);
    expect(launcherDirectory(target)).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
    // The build runs from its own directory before it is placed, and the
    // account service is registered through the launcher.
    expect(target.commands[0]?.[1]).toBe("--version");
    expect(target.commands.at(-1)).toEqual([path.join(target.wrapperDir, "flywheel.exe"), "serve", "install"]);
  });

  test("adds the service launcher to an installation 0.0.11 wrote and keeps the record that build reads", async () => {
    // A rollback returns the account to 0.0.11, whose installer accepts only
    // the record text it wrote, so the record must not change.
    const target = account();
    fs.mkdirSync(target.wrapperDir, { recursive: true });
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel.exe"), "launcher v1");
    fs.writeFileSync(path.join(target.wrapperDir, RECORD), LAUNCHER_RECORD);

    await install(target, payload(target, "a", { version: "0.0.12" }).dir);

    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "utf8")).toBe("service launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(LAUNCHER_RECORD);
  });

  test("places the build under an account data root held by this account alone", async () => {
    const target = account();
    const privateRoots: string[] = [];
    windows = { applyPrivateDirectoryAcl: (directory) => { privateRoots.push(directory); } };

    await install(target, payload(target, "a", { version: "0.0.10" }).dir);

    expect(privateRoots).toContain(path.join(fs.realpathSync(path.dirname(target.userDataRoot)), ".flywheel"));
  });

  test("a second build moves the pointer and leaves a launcher that is the same in place", async () => {
    const target = account();
    await install(target, payload(target, "a", { version: "0.0.10" }).dir);
    const before = fs.statSync(path.join(target.wrapperDir, "flywheel.exe")).ino;
    const second = payload(target, "b", { version: "0.0.11" });

    await install(target, second.dir);

    expect(pointer(target)).toBe(`versions\\0.0.11\\${second.buildId}`);
    expect(fs.statSync(path.join(target.wrapperDir, "flywheel.exe")).ino).toBe(before);
  });

  test("a build whose launcher differs replaces the one in place, which goes once nothing runs it", async () => {
    const target = account();
    await install(target, payload(target, "a", { version: "0.0.10" }).dir);

    await install(target, payload(target, "b", { version: "0.0.11", launcher: "launcher v2", serviceLauncher: "service launcher v2" }).dir);

    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v2");
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "utf8")).toBe("service launcher v2");
    expect(launcherDirectory(target)).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
  });

  test("a later build that carries its launchers under other names is activated, and the launchers in place stay", async () => {
    const target = account();
    await install(target, payload(target, "a", { version: "0.0.10" }).dir);
    const later = payload(target, "b", { version: "2.0.0", launchers: false });

    await install(target, later.dir);

    expect(pointer(target)).toBe(`versions\\2.0.0\\${later.buildId}`);
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "utf8")).toBe("service launcher v1");
  });

  test("a first installation of a build that carries no launcher it can place is refused before anything moves", async () => {
    const target = account();

    await expect(install(target, payload(target, "a", { version: "2.0.0", launchers: false }).dir)).rejects.toThrow("carries no Windows launcher");
    expect(fs.existsSync(path.join(target.userDataRoot, "current"))).toBe(false);
    expect(fs.existsSync(path.join(target.userDataRoot, "versions", "2.0.0"))).toBe(false);
  });

  test("a launcher swap that fails keeps the previous launcher at flywheel.exe and no private copy", async () => {
    const target = account();
    await install(target, payload(target, "a", { version: "0.0.10" }).dir);
    refuseLauncherRenames(target, [2]);

    await expect(install(target, payload(target, "b", { version: "0.0.11", launcher: "launcher v2" }).dir)).rejects.toThrow("rename 2 refused");

    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v1");
    expect(launcherDirectory(target)).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
  });

  test("rolls current back to the proved build through the engine's rollback", async () => {
    const target = account();
    const first = payload(target, "a", { version: "0.0.10" });
    await install(target, first.dir);
    recordBuildProved(target.userDataRoot, { version: "0.0.10", buildId: first.buildId });
    const second = payload(target, "b", { version: "0.0.11" });
    await install(target, second.dir);

    const outcome = rollBackActivation({ userDataRoot: target.userDataRoot, failed: { version: "0.0.11", buildId: second.buildId }, reason: "no project opened", nowMs: Date.now(), platform: "win32" });

    expect(outcome).toMatchObject({ kind: "rolled-back", to: { version: "0.0.10", buildId: first.buildId } });
    expect(pointer(target)).toBe(`versions\\0.0.10\\${first.buildId}`);
    expect(refusedBuild(target.userDataRoot)).toEqual({ version: "0.0.11", buildId: second.buildId });
  });

  test("a rollback whose pointer Windows readers hold past the bound can ask again, and one it cannot write stays", () => {
    const target = account();
    for (const [code, cause] of [["EPERM", "activation-busy"], ["EIO", "activation-unwritable"]] as const) {
      fs.rmSync(target.userDataRoot, { recursive: true, force: true });
      const first = { version: "0.0.10", buildId: "a".repeat(64) };
      const second = { version: "0.0.11", buildId: "b".repeat(64) };
      for (const build of [first, second]) {
        const dir = path.join(versionsDir(target.userDataRoot), build.version, build.buildId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "build.json"), JSON.stringify({ ...build, asset: ASSET }));
        fs.writeFileSync(path.join(dir, "flywheel-bin.exe"), "build");
      }
      fs.writeFileSync(path.join(target.userDataRoot, "current"), `versions\\0.0.11\\${second.buildId}`);
      recordBuildProved(target.userDataRoot, first);
      windows = { renamePointer: () => { throw Object.assign(new Error("refused"), { code }); } };

      const outcome = rollBackActivation({ userDataRoot: target.userDataRoot, failed: second, reason: "no project opened", nowMs: Date.now(), platform: "win32" });

      expect(outcome).toMatchObject({ kind: "kept", cause });
      expect(pointer(target)).toBe(`versions\\0.0.11\\${second.buildId}`);
    }
  });
});

describe("a flat installation", () => {
  test.each([
    ["0.0.8", FLAT_RECORD_0_0_8],
    ["0.0.9", FLAT_RECORD_0_0_9],
  ])("that %s wrote converts: the launcher takes the executable's name and the flat entries go once nothing runs them", async (_release, record) => {
    const target = account();
    flatInstallation(target, record);
    const build = payload(target, "a", { version: "0.0.10" });

    await install(target, build.dir);

    expect(pointer(target)).toBe(`versions\\0.0.10\\${build.buildId}`);
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(LAUNCHER_RECORD);
    expect(launcherDirectory(target)).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
    expect(target.commands.at(-1)).toEqual([path.join(target.wrapperDir, "flywheel.exe"), "serve", "install"]);
  });

  test("the flat build's own updater converts it under the lease it holds, as an update, and keeps that lease", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_9);
    const build = payload(target, "a", { version: "0.0.10" });
    retiredExecutablesRun();

    await underHeldLease(target, async (renew) => {
      await install(target, build.dir, { rows: startedByFlatUpdater(target) });

      expect(renew()).toBe("held");
    });

    expect(pointer(target)).toBe(`versions\\0.0.10\\${build.buildId}`);
    // The running flat service reads this file to learn it was superseded.
    expect(decodeBuildMetadata(fs.readFileSync(path.join(target.wrapperDir, "build.json"), "utf8")).buildId).toBe(build.buildId);
    expect(target.commands.at(-1)).toEqual([path.join(target.wrapperDir, "flywheel.exe"), "serve", "install", "--update"]);
  });

  test("a table that cannot be read proves nothing, so the lease the conversion meets is taken as its updater's", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_8);
    const build = payload(target, "a", { version: "0.0.10" });

    await underHeldLease(target, async () => { await install(target, build.dir, { rows: undefined }); });

    expect(pointer(target)).toBe(`versions\\0.0.10\\${build.buildId}`);
    expect(target.commands.at(-1)).toContain("--update");
  });

  test("a lease the flat build is proved not to hold refuses the conversion like any other", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_8);

    await underHeldLease(target, async () => {
      await expect(install(target, payload(target, "a", { version: "0.0.10" }).dir, { rows: [] })).rejects.toThrow("another Flywheel process is updating this account");
    });
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("flat 0.0.8");
  });

  test("an installation that is not flat still refuses a lease another process holds", async () => {
    const target = account();

    await underHeldLease(target, async () => {
      await expect(install(target, payload(target, "a", { version: "0.0.10" }).dir)).rejects.toThrow("another Flywheel process is updating this account");
    });
    expect(fs.existsSync(path.join(target.userDataRoot, "current"))).toBe(false);
  });

  // Each step of the swap can fail, and each state the failure leaves is
  // one the next installation resumes from, under the flat record.
  test.each([
    ["the flat executable cannot be renamed away", [1], "flat 0.0.8"],
    ["the launcher cannot take the name, and the flat executable goes back", [2], "flat 0.0.8"],
    ["the launcher cannot take the name, and the flat executable cannot go back either", [2, 3], undefined],
  ] as const)("a conversion in which %s keeps the flat record and resumes", async (_case, failing, left) => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_9);
    const build = payload(target, "a", { version: "0.0.10" });
    refuseLauncherRenames(target, failing);

    await expect(install(target, build.dir)).rejects.toThrow(`rename ${failing[0]} refused`);

    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(FLAT_RECORD_0_0_9);
    expect(JSON.parse(fs.readFileSync(path.join(target.wrapperDir, "build.json"), "utf8")).buildId).toBe("9".repeat(64));
    if (left === undefined) expect(fs.existsSync(path.join(target.wrapperDir, "flywheel.exe"))).toBe(false);
    else expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe(left);
    expect(fs.readdirSync(target.wrapperDir).some((name) => name.startsWith(".flywheel.exe."))).toBe(false);

    windows = {};
    await install(target, build.dir);

    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("launcher v1");
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(LAUNCHER_RECORD);
    expect(launcherDirectory(target)).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
  });

  test("a conversion interrupted after the launcher took the name resumes with the rest of it", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_9);
    const build = payload(target, "a", { version: "0.0.10" });
    fs.renameSync(path.join(target.wrapperDir, "flywheel.exe"), path.join(target.wrapperDir, ".flywheel-retired-0123456789abcdef.exe"));
    fs.copyFileSync(path.join(build.dir, "native", PLATFORM_ARCH, "flywheel-launcher.exe"), path.join(target.wrapperDir, "flywheel.exe"));
    retiredExecutablesRun();

    await install(target, build.dir);

    expect(decodeBuildMetadata(fs.readFileSync(path.join(target.wrapperDir, "build.json"), "utf8")).buildId).toBe(build.buildId);
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe('{"installedBy":"flywheel","layout":"versions","owns":["flywheel.exe"],"retiring":["build.json","fonts","native","webview"]}');
    expect(launcherDirectory(target)).toEqual([RECORD, ".flywheel-retired-*.exe", "build.json", "flywheel-service.exe", "flywheel.exe", "fonts", "native", "webview"]);
  });

  test("a conversion interrupted after the record claims the versions layout resumes under the flat updater's lease", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_9);
    const build = payload(target, "a", { version: "0.0.10" });
    retiredExecutablesRun();
    const { unlinkEntry } = windows;
    windows = {
      unlinkEntry,
      renameEntry: (source, destination) => {
        if (path.basename(destination) === "flywheel-service.exe") throw Object.assign(new Error("service launcher rename refused"), { code: "EPERM" });
        fs.renameSync(source, destination);
      },
    };

    await underHeldLease(target, async (renew) => {
      await expect(install(target, build.dir, { rows: startedByFlatUpdater(target) })).rejects.toThrow("service launcher rename refused");
      expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe('{"installedBy":"flywheel","layout":"versions","owns":["flywheel.exe"],"retiring":["build.json","fonts","native","webview"]}');
      expect(fs.existsSync(path.join(target.wrapperDir, "flywheel-service.exe"))).toBe(false);

      retiredExecutablesRun();
      await install(target, build.dir, { rows: startedByFlatUpdater(target) });

      expect(renew()).toBe("held");
    });

    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "utf8")).toBe("service launcher v1");
    expect(target.commands.at(-1)).toEqual([path.join(target.wrapperDir, "flywheel.exe"), "serve", "install", "--update"]);
  });

  test.each([
    ["an install record of a shape this build does not know", (target: Account) => { fs.writeFileSync(path.join(target.wrapperDir, RECORD), '{"installedBy":"flywheel","layout":"versions-v2","owns":["flywheel.exe"]}'); }, "does not know"],
    ["a flywheel.exe that no record claims", () => {}, "is not a Flywheel entry this installer may replace"],
    ["an install record that is a link", (target: Account) => { fs.writeFileSync(path.join(target.payloads, "planted.json"), FLAT_RECORD_0_0_8); fs.symlinkSync(path.join(target.payloads, "planted.json"), path.join(target.wrapperDir, RECORD)); }, "not an install record this installer can read"],
    ["a flywheel-service.exe that the flat record does not claim", (target: Account) => {
      fs.writeFileSync(path.join(target.wrapperDir, RECORD), FLAT_RECORD_0_0_8);
      fs.mkdirSync(path.join(target.wrapperDir, "fonts"));
      fs.mkdirSync(path.join(target.wrapperDir, "native"));
      fs.writeFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), "someone else's");
    }, 'flywheel-service.exe" is not a Flywheel entry this installer may replace'],
  ])("refuses %s and changes nothing", async (_case, arrange, refusal) => {
    const target = account();
    fs.mkdirSync(target.wrapperDir, { recursive: true });
    fs.mkdirSync(target.payloads, { recursive: true });
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel.exe"), "someone else's");
    arrange(target);
    const before = fs.readdirSync(target.wrapperDir).sort();

    await expect(install(target, payload(target, "a", { version: "0.0.10" }).dir)).rejects.toThrow(refusal);

    expect(fs.readdirSync(target.wrapperDir).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("someone else's");
    expect(fs.existsSync(path.join(target.userDataRoot, "current"))).toBe(false);
  });

  test("refuses a flat entry that is a link, and follows none of it", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_8);
    const elsewhere = temporaryDirectory("flywheel-windows-elsewhere-");
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "not Flywheel's");
    fs.rmSync(path.join(target.wrapperDir, "fonts"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(target.wrapperDir, "fonts"));

    await expect(install(target, payload(target, "a", { version: "0.0.10" }).dir)).rejects.toThrow("symlink or junction");

    expect(fs.readFileSync(path.join(elsewhere, "keep.txt"), "utf8")).toBe("not Flywheel's");
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("flat 0.0.8");
  });

  test("an interrupted transaction of the flat installer refuses the conversion", async () => {
    const target = account();
    flatInstallation(target, FLAT_RECORD_0_0_8);
    fs.writeFileSync(path.join(target.wrapperDir, ".flywheel-install-txn.json"), "{}");

    await expect(install(target, payload(target, "a", { version: "0.0.10" }).dir)).rejects.toThrow("interrupted install");
    expect(fs.readFileSync(path.join(target.wrapperDir, "flywheel.exe"), "utf8")).toBe("flat 0.0.8");
  });
});

describe("the launcher directory's collection", () => {
  const LAUNCHERS = {
    console: new TextEncoder().encode("launcher v1"),
    service: new TextEncoder().encode("service launcher v1"),
  };

  /** What a conversion leaves while the flat build still runs: its
   *  executable renamed out of the way, its entries, and the record that
   *  names them. */
  function convertedWhileRunning(target: Account): string {
    flatInstallation(target, FLAT_RECORD_0_0_9);
    const retired = path.join(target.wrapperDir, ".flywheel-retired-0123456789abcdef.exe");
    fs.renameSync(path.join(target.wrapperDir, "flywheel.exe"), retired);
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel.exe"), LAUNCHERS.console);
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), LAUNCHERS.service);
    fs.mkdirSync(path.join(target.wrapperDir, `.flywheel-txn-${"f".repeat(32)}`, "old"), { recursive: true });
    fs.writeFileSync(path.join(target.wrapperDir, RECORD), '{"installedBy":"flywheel","layout":"versions","owns":["flywheel.exe"],"retiring":["build.json","fonts","native","webview"]}');
    return retired;
  }

  test("keeps the flat entries while a retired executable still runs, and takes them once it ends", () => {
    const target = account();
    const retired = convertedWhileRunning(target);
    const running = fs.statSync(retired).ino;
    windows = {
      unlinkEntry: (entryPath) => {
        if (fs.statSync(entryPath).ino === running) throw Object.assign(new Error("the executable runs"), { code: "EPERM" });
        fs.unlinkSync(entryPath);
      },
    };
    const before = fs.readdirSync(target.wrapperDir).sort();
    expect(windowsLauncherCollectionPending(target.wrapperDir)).toBe(true);

    collectWindowsLauncherDirectory(target.wrapperDir, LAUNCHERS);
    expect(fs.readdirSync(target.wrapperDir).sort()).toEqual(before);

    windows = {};
    collectWindowsLauncherDirectory(target.wrapperDir, LAUNCHERS);
    expect(fs.readdirSync(target.wrapperDir).sort()).toEqual([RECORD, "flywheel-service.exe", "flywheel.exe"]);
    expect(fs.readFileSync(path.join(target.wrapperDir, RECORD), "utf8")).toBe(LAUNCHER_RECORD);
    expect(windowsLauncherCollectionPending(target.wrapperDir)).toBe(false);
  });

  test("keeps the flat entries while flywheel.exe is not the active build's launcher", () => {
    const target = account();
    convertedWhileRunning(target);
    fs.rmSync(path.join(target.wrapperDir, ".flywheel-retired-0123456789abcdef.exe"));

    collectWindowsLauncherDirectory(target.wrapperDir, { ...LAUNCHERS, console: new TextEncoder().encode("another launcher") });

    expect(fs.existsSync(path.join(target.wrapperDir, "fonts"))).toBe(true);
  });

  test("removes a private copy once its writer is gone, and keeps one whose writer runs", () => {
    const target = account();
    fs.mkdirSync(target.wrapperDir, { recursive: true });
    fs.writeFileSync(path.join(target.wrapperDir, RECORD), LAUNCHER_RECORD);
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel.exe"), LAUNCHERS.console);
    fs.writeFileSync(path.join(target.wrapperDir, "flywheel-service.exe"), LAUNCHERS.service);
    const abandoned = [".flywheel.exe.2147483646.0123456789abcdef", ".flywheel-service.exe.2147483646.0123456789abcdef", ".build.json.2147483646.0123456789abcdef", ".flywheel-install.json.2147483646.0123456789abcdef"];
    const live = `.flywheel.exe.${process.pid}.0123456789abcdef`;
    for (const name of [...abandoned, live]) fs.writeFileSync(path.join(target.wrapperDir, name), "partial");

    collectWindowsLauncherDirectory(target.wrapperDir, LAUNCHERS);

    expect(fs.readdirSync(target.wrapperDir).sort()).toEqual([live, RECORD, "flywheel-service.exe", "flywheel.exe"].sort());
  });
});
