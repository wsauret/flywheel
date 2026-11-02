/**
 * The account service's installer, which runs every update job on its own
 * Worker.
 *
 * The Worker is the build's real Worker entry, so each case proves the whole
 * path: the job crosses to the Worker, the installer runs there, and the
 * answer comes back. The calling thread's collector is watched, and it must
 * never run: the removal happens on the Worker or not at all. The guardian is
 * a fake that counts generations, because every command a job runs belongs to
 * a generation the account opened for that job, so its count is also the
 * count of update Workers the account started.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebugLog, listDebugLogFiles, resolveDebugLogDirectory, scanDebugLogFiles } from "../../../../src/infra/debug-log.js";
import { updateAuthorityDbFile, versionsDir } from "../../../../src/infra/paths.js";
import type { GuardianControl, GuardianGeneration } from "../../../../src/infra/process-supervisor.js";
import * as retention from "../../../../src/infra/update/build-retention.js";
import type { SelectedRelease } from "../../../../src/infra/update/release-manifest.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../../../src/infra/update/update-authority.js";
import { parseReleaseVersion } from "../../../../src/infra/update/version-order.js";
import { systemUpdateScheduler } from "../../../../src/orchestration/update/update-check.js";
import { createUpdateService } from "../../../../src/orchestration/update/update-service.js";
import { createUpdateWorkerInstaller } from "../../../../src/orchestration/update/update-worker-installer.js";
import { activatePlacedBuild, placeBuild } from "../../../helpers/placed-build.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-update-worker-"));
const WORKER_URL = new URL("../../../../src/orchestration/app-service/worker-entry.ts", import.meta.url).href;
const ASSET = "flywheel-darwin-arm64.tar.gz";
/** An archive one byte longer than every fixture release states. The transfer
 *  refuses it at once as the publisher's answer. A missing file would read as a
 *  cut connection, which the transfer retries for minutes. */
const OVERSIZED_ARCHIVE = path.join(TMP, "oversized-archive.tar.gz");
fs.writeFileSync(OVERSIZED_ARCHIVE, "xy");

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let accounts = 0;
let userDataRoot = "";
let collector: ReturnType<typeof spyOn<typeof retention, "collectBuildTrees">>;

beforeEach(() => {
  accounts += 1;
  userDataRoot = path.join(TMP, `account-${accounts}`, ".flywheel");
  fs.mkdirSync(versionsDir(userDataRoot), { recursive: true });
  collector = spyOn(retention, "collectBuildTrees");
});

afterEach(() => {
  collector.mockRestore();
});

/** One installed build, older as `age` grows. */
function build(version: string, marker: string, age: number): string {
  const buildId = marker.repeat(64).slice(0, 64);
  const buildDir = path.join(versionsDir(userDataRoot), version, buildId);
  placeBuild(userDataRoot, { version, buildId });
  const metadata = path.join(buildDir, "build.json");
  const stamp = new Date(2_000_000_000_000 - age * 60_000);
  fs.utimesSync(metadata, stamp, stamp);
  return buildId;
}

function installedVersions(): readonly string[] {
  return fs.readdirSync(versionsDir(userDataRoot)).filter((name) => !name.startsWith(".")).sort();
}

/** A guardian whose generations own nothing, counted as they open and close. */
function countingGuardian() {
  const counts = { opened: 0, closed: 0 };
  const generation: GuardianGeneration = {
    request: async () => { throw new Error("no command runs in this job"); },
    pid: async () => process.pid,
    close: async () => { counts.closed += 1; return { settled: true }; },
  };
  const guardian: GuardianControl = {
    openGeneration: async () => { counts.opened += 1; return generation; },
    pid: async () => process.pid,
  };
  return { guardian, counts };
}

function installer(guardian: GuardianControl) {
  return createUpdateWorkerInstaller({
    workerUrl: WORKER_URL,
    guardian,
    installation: { userDataRoot, wrapperDir: path.join(path.dirname(userDataRoot), "bin"), platform: "darwin", platformArch: "darwin-arm64" },
  });
}

/** An active build, the two builds the retention band keeps, and `spare`
 *  more that nothing keeps, all in one version, oldest last. */
function account(spare: number) {
  const active = build("1.9.0", "a", 0);
  activatePlacedBuild(userDataRoot, { version: "1.9.0", buildId: active });
  build("1.8.0", "b", 1);
  build("1.7.0", "c", 2);
  for (let index = 0; index < spare; index += 1) build("0.1.0", index.toString(16).padStart(64, "0"), 100 + index);
  return { spareDir: path.join(versionsDir(userDataRoot), "0.1.0") };
}

function buildsIn(versionDir: string): number {
  return fs.existsSync(versionDir) ? fs.readdirSync(versionDir).filter((name) => !name.startsWith(".")).length : 0;
}

function release(url: string, sizeBytes = 1): SelectedRelease {
  const version = parseReleaseVersion("2.0.0");
  if (!version) throw new Error("fixture version does not parse");
  return { version, asset: { name: ASSET, url, sizeBytes, sha256: "0".repeat(64) } };
}

/** The account's coordinator over the real Worker installer, with the check
 *  and the policy in the test's hands. */
function coordinator(guardian: GuardianControl, found: "current" | "candidate", autoInstall: boolean) {
  const policy = { persisted: autoInstall, forcedOff: false, effective: autoInstall };
  return createUpdateService({
    currentVersion: "1.0.0",
    platformArch: "darwin-arm64",
    repository: "acme/flywheel",
    policy: { read: () => policy, revalidate: async (decide) => decide(policy), write: async () => ({ ok: true }) },
    openAuthority: () => createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) }),
    scheduler: systemUpdateScheduler,
    publish: () => {},
    installer: installer(guardian),
    check: async () => found === "current" ? { kind: "current" } : { kind: "candidate", release: release(`file://${OVERSIZED_ARCHIVE}`) },
  });
}

describe("the account's update Worker", () => {
  test("collects the account's builds on its own thread, inside a command generation it closes before it answers", async () => {
    const active = build("1.9.0", "a", 0);
    activatePlacedBuild(userDataRoot, { version: "1.9.0", buildId: active });
    for (const [index, marker] of ["b", "c", "d", "e"].entries()) build(`1.${index}.0`, marker, 10 + index);
    const { guardian, counts } = countingGuardian();

    await installer(guardian).collect(new AbortController().signal);

    // The active build and the two newest collectible ones stay; the rest went.
    expect(installedVersions()).toEqual(["1.0.0", "1.1.0", "1.9.0"]);
    expect(collector).not.toHaveBeenCalled();
    expect(counts).toEqual({ opened: 1, closed: 1 });
  });

  test("an account with nothing to collect starts no Worker for a collection", async () => {
    account(0);
    const { guardian, counts } = countingGuardian();

    await installer(guardian).collect(new AbortController().signal);

    expect(installedVersions()).toEqual(["1.7.0", "1.8.0", "1.9.0"]);
    expect(counts).toEqual({ opened: 0, closed: 0 });
  });

  test("an install starts a Worker only once a newer release is admitted", async () => {
    account(0);
    const current = countingGuardian();
    expect((await coordinator(current.guardian, "current", true).run({ manual: true })).kind).toBe("current");
    expect(current.counts.opened).toBe(0);

    const disabled = countingGuardian();
    expect((await coordinator(disabled.guardian, "candidate", false).run({ manual: true })).kind).toBe("policy-blocked");
    expect(disabled.counts.opened).toBe(0);

    const admitted = countingGuardian();
    const run = await coordinator(admitted.guardian, "candidate", true).run({ manual: true });
    expect(run.kind).toBe("failed");
    // One Worker for the install, and none for a collection with nothing in it.
    expect(admitted.counts).toEqual({ opened: 1, closed: 1 });
  });

  test("a job opens no log file: its records reach the account service's one stream", async () => {
    const { spareDir } = account(3);
    const accountHome = path.join(TMP, `log-home-${accounts}`);
    const logDir = resolveDebugLogDirectory(accountHome);
    fs.mkdirSync(accountHome);
    await DebugLog.init({ dir: accountHome });
    DebugLog.setVerbose(true);
    try {
      const { guardian } = countingGuardian();
      await installer(guardian).collect(new AbortController().signal);
      expect(buildsIn(spareDir)).toBe(0);
    } finally {
      DebugLog.setVerbose(false);
      await DebugLog.close();
    }

    const files = listDebugLogFiles(logDir);
    expect(files).toHaveLength(1);
    const records = [...scanDebugLogFiles(files)];
    expect(records.filter((record) => record.type === "runtime.worker.allocated").map((record) => record.payload)).toEqual([{ kind: "update" }]);
    // Written on the Worker, filed by the account thread.
    expect(records.some((record) => record.type === "log.info" && typeof record.payload === "object" && record.payload !== null && "message" in record.payload && record.payload.message === "collected installed builds")).toBe(true);
    expect(fs.existsSync(resolveDebugLogDirectory(path.dirname(userDataRoot)))).toBe(false);
  });

  test("a withdrawal posted to a running Worker stops its sweep between two removals", async () => {
    const { spareDir } = account(150);
    const { guardian, counts } = countingGuardian();
    const withdrawal = new AbortController();

    const collection = installer(guardian).collect(withdrawal.signal);
    while (buildsIn(spareDir) === 150) await Bun.sleep(1);
    withdrawal.abort();
    await collection;

    // Some trees went before the withdrawal and the rest stay for a later run.
    const left = buildsIn(spareDir);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(150);
    expect(counts).toEqual({ opened: 1, closed: 1 });
  });

  test("a withdrawal posted to a running Worker stops its transfer and leaves no staging", async () => {
    account(0);
    const requested = Promise.withResolvers<void>();
    // A publisher that starts the body and never finishes it.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requested.resolve();
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0x1f, 0x8b])); } }));
      },
    });
    try {
      const { guardian, counts } = countingGuardian();
      const withdrawal = new AbortController();
      const install = installer(guardian).install({ release: release(`http://127.0.0.1:${server.port}/${ASSET}`, 1024), fence: 4, signal: withdrawal.signal });
      await requested.promise;
      withdrawal.abort();

      expect(await install).toEqual({ kind: "revoked" });
      expect(fs.readdirSync(versionsDir(userDataRoot)).filter((name) => name.startsWith(".update."))).toEqual([]);
      expect(counts).toEqual({ opened: 1, closed: 1 });
    } finally {
      await server.stop(true);
    }
  });

  test("a job withdrawn before it starts removes nothing and starts no Worker", async () => {
    const active = build("1.9.0", "a", 0);
    activatePlacedBuild(userDataRoot, { version: "1.9.0", buildId: active });
    for (const [index, marker] of ["b", "c", "d", "e"].entries()) build(`1.${index}.0`, marker, 10 + index);
    const { guardian, counts } = countingGuardian();
    const withdrawal = new AbortController();
    withdrawal.abort();

    await installer(guardian).collect(withdrawal.signal);

    expect(installedVersions()).toEqual(["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.9.0"]);
    expect(counts).toEqual({ opened: 0, closed: 0 });
  });

  test("an install that fails on the Worker fails the caller with the Worker's reason", async () => {
    const { guardian, counts } = countingGuardian();
    const install = installer(guardian).install({ release: release(`file://${OVERSIZED_ARCHIVE}`), fence: 4, signal: new AbortController().signal });

    await expect(install).rejects.toThrow(/could not be transferred/);
    expect(counts).toEqual({ opened: 1, closed: 1 });
  });
});
