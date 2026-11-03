/** A build proves itself when one of its project executors reports ready, and
 *  a build that has not proved itself returns its lane to the last proved
 *  build after three failed opens in a row.
 *
 *  The installed cases build a real account root: two installed builds, the
 *  start record naming the older one as proved, and `current` naming the
 *  newer one, which the service runs. The dev case builds a checkout's
 *  snapshot home with two snapshots. */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sourceSnapshotHome } from "../../../../src/infra/cli-subprocess.js";
import { Log } from "../../../../src/infra/log.js";
import { accountServeStartRecordPath, updateAuthorityDbFile } from "../../../../src/infra/paths.js";
import { activeBuildDir } from "../../../../src/infra/update/active-build.js";
import { provedBuild, recordBuildProved } from "../../../../src/infra/update/service-start-record.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../../../src/infra/update/update-authority.js";
import { type BuildFallbackTrigger, type BuildProof, createBuildFallback, type FallbackBuild } from "../../../../src/orchestration/update/build-fallback.js";
// The fallback loads the install engine lazily on its first return. Its cold
// load takes seconds on a loaded runner, so it happens here, with the file,
// and not inside the timeout of the first test that returns.
import "../../../../src/orchestration/update/install-engine.js";
import { refusedBuild } from "../../../../src/orchestration/update/refused-build.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { activatePlacedBuild, placeBuild } from "../../../helpers/placed-build.js";
import { useWin32ContainedDirectories } from "../../../helpers/win32-contained-directories.js";

const PROVED = { version: "1.3.0", buildId: "a".repeat(64) } as const;
const FAILED = { version: "1.4.0", buildId: "b".repeat(64) } as const;
const RETURN = "the build could not open a project too many times in a row; the account returns to the last proved build";

const directories = temporaryDirectories();
let userDataRoot: string;
let failedExecutable: string;
let requests: BuildFallbackTrigger[];
const logger = Log.create({ service: "build-fallback" });
const info = spyOn(logger, "info").mockImplementation(() => {});
const warn = spyOn(logger, "warn").mockImplementation(() => {});
const debug = spyOn(logger, "debug").mockImplementation(() => {});
afterAll(() => {
  info.mockRestore();
  warn.mockRestore();
  debug.mockRestore();
});

/** Resolves once `condition` holds; the fallback's work runs after a lazy
 *  import, off the caller's turn. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn += 1) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

function currentBuild(): string | undefined {
  const active = activeBuildDir(userDataRoot);
  return active === undefined ? undefined : relative(realpathSync(userDataRoot), active).split("\\").join("/");
}

function fallbackOf(build: FallbackBuild): BuildProof {
  const fallback = createBuildFallback({ build, request: async (trigger) => { requests.push(trigger); return "retiring"; } });
  if (fallback === undefined) throw new Error("the service runs no build");
  return fallback;
}

const installedFallback = () => fallbackOf({ lane: "installed", userDataRoot, execPath: failedExecutable });
const failOpens = (fallback: BuildProof, opens: number) => { for (let open = 0; open < opens; open += 1) fallback.failedToOpen(); };

beforeEach(() => {
  requests = [];
  for (const spy of [info, warn, debug]) spy.mockClear();
  userDataRoot = join(directories("flywheel-build-fallback-"), ".flywheel");
  mkdirSync(userDataRoot, { mode: 0o700 });
  placeBuild(userDataRoot, PROVED);
  failedExecutable = placeBuild(userDataRoot, FAILED);
  recordBuildProved(userDataRoot, PROVED);
  activatePlacedBuild(userDataRoot, FAILED);
});

describe("the installed lane", () => {
  test("three failed opens of an unproved build move `current` back to the proved build, refuse the failed build, and make way for it; a ready executor after that proves nothing", async () => {
    const fallback = installedFallback();
    failOpens(fallback, 2);
    await Bun.sleep(5);
    expect(requests).toEqual([]);
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);

    fallback.failedToOpen();
    await eventually(() => requests.length === 1);

    expect(requests).toEqual([{ kind: "build could not open a project", failedBuild: FAILED.buildId, provedBuild: PROVED.buildId, failedOpens: 3 }]);
    expect(currentBuild()).toBe(`versions/${PROVED.version}/${PROVED.buildId}`);
    expect(refusedBuild(userDataRoot)).toEqual(FAILED);
    expect(warn.mock.calls).toEqual([[RETURN, { lane: "installed", build: FAILED.buildId, failedOpens: 3, proved: PROVED.buildId }]]);
    // The decision holds: a ready executor and later failed opens change
    // nothing, and neither does a ready executor of the refused build in
    // another process.
    fallback.executorReady();
    fallback.failedToOpen();
    installedFallback().executorReady();
    await Bun.sleep(5);
    expect(requests).toHaveLength(1);
    expect(provedBuild(userDataRoot)).toEqual(PROVED);
  });

  test("a ready executor proves the build once, says so once, and no failed open after it counts", async () => {
    const fallback = installedFallback();
    fallback.failedToOpen();
    fallback.executorReady();
    fallback.executorReady();
    await eventually(() => provedBuild(userDataRoot)?.buildId === FAILED.buildId);
    failOpens(fallback, 5);
    await Bun.sleep(5);

    expect(info.mock.calls).toEqual([["the build proved itself on this machine: one of its project executors reported ready", { lane: "installed", build: FAILED.buildId }]]);
    expect(requests).toEqual([]);
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("a build with no proved build to return to stays, says why once, and a ready executor still proves it", async () => {
    rmSync(accountServeStartRecordPath(userDataRoot));
    const fallback = installedFallback();
    failOpens(fallback, 5);
    await eventually(() => info.mock.calls.length > 0);
    fallback.executorReady();
    await eventually(() => provedBuild(userDataRoot)?.buildId === FAILED.buildId);

    expect(info.mock.calls[0]).toEqual(["the build could not open a project too many times in a row, and it stays", { lane: "installed", build: FAILED.buildId, failedOpens: 3, reason: "no build is proved on this account" }]);
    expect(requests).toEqual([]);
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("a return that the update lease refuses for now is asked for again at the next failed open", async () => {
    const holder = createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
    expect(holder.claim({ nowMs: Date.now(), freshForMs: 0, leaseMs: 60_000 }).kind).toBe("won");
    const fallback = installedFallback();
    try {
      failOpens(fallback, 3);
      await eventually(() => info.mock.calls.length === 1);
      fallback.failedToOpen();
      await eventually(() => debug.mock.calls.length === 1);
      expect(info.mock.calls).toEqual([[expect.stringContaining("it cannot return to the last proved build now"), { lane: "installed", build: FAILED.buildId, failedOpens: 3, retries: 1, reason: "another Flywheel process holds the update lease" }]]);
      expect(requests).toEqual([]);
    } finally {
      // The update check that held the lease hands it back.
      holder.dispose();
    }

    fallback.failedToOpen();
    await eventually(() => requests.length === 1);
    expect(requests[0]).toMatchObject({ failedOpens: 5, provedBuild: PROVED.buildId });
    expect(currentBuild()).toBe(`versions/${PROVED.version}/${PROVED.buildId}`);
  });

  test.each([
    ["the proved build is gone", () => { rmSync(join(userDataRoot, "versions", PROVED.version), { recursive: true }); }, "is not usable"],
    ["current no longer names the failed build", () => {
      activatePlacedBuild(userDataRoot, PROVED);
    }, "no longer names this build"],
  ])("a return that cannot happen because %s stays, says why once, and is not asked for again", async (_case, arrange, reason) => {
    arrange();
    const fallback = installedFallback();
    failOpens(fallback, 3);
    await eventually(() => info.mock.calls.length === 1);
    failOpens(fallback, 3);
    await Bun.sleep(5);

    expect(info.mock.calls).toEqual([["the build could not open a project too many times in a row, and it stays", { lane: "installed", build: FAILED.buildId, failedOpens: 3, reason: expect.stringContaining(reason) }]]);
    expect(debug.mock.calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a service that runs no installed build has no fallback", () => {
    expect(createBuildFallback({ build: { lane: "installed", userDataRoot, execPath: process.execPath }, request: async () => "busy" })).toBeUndefined();
  });
});

describe("the installed lane on Windows", () => {
  /** How Windows answers the rename of `current`, set by a case. */
  let pointerRename: ((pendingPath: string, targetPath: string) => void) | undefined;
  useWin32ContainedDirectories(() => (pointerRename === undefined ? {} : { renamePointer: pointerRename }));

  test.each([
    ["readers hold the pointer past the rename's bound, which clears by itself, so the next failed open asks again", "EPERM", "it cannot return to the last proved build now"],
    ["the pointer cannot be written, so the build stays", "EIO", "and it stays"],
  ])("a return in which %s", async (_case, code, outcome) => {
    rmSync(join(userDataRoot, "current"));
    writeFileSync(join(userDataRoot, "current"), `versions\\${FAILED.version}\\${FAILED.buildId}`);
    pointerRename = () => { throw Object.assign(new Error("refused"), { code }); };
    try {
      const fallback = installedFallback();
      failOpens(fallback, 3);
      await eventually(() => info.mock.calls.length === 1);

      expect(info.mock.calls[0]?.[0]).toContain(outcome);
      expect(requests).toEqual([]);
    } finally {
      pointerRename = undefined;
    }
  });
});

describe("the dev lane", () => {
  const PROVED_SNAPSHOT = "0123456789abcdef";
  const FAILED_SNAPSHOT = "fedcba9876543210";

  test("a ready executor proves its snapshot, and three failed opens of another snapshot refuse it and make way for the source the entry chooses, which a later ready executor does not undo", async () => {
    const checkout = join(directories("flywheel-build-fallback-dev-"), "checkout");
    for (const digest of [PROVED_SNAPSHOT, FAILED_SNAPSHOT]) mkdirSync(join(sourceSnapshotHome(checkout), digest), { recursive: true });
    const proofPath = join(sourceSnapshotHome(checkout), "proof.json");
    const proof = () => {
      try {
        return JSON.parse(readFileSync(proofPath, "utf8"));
      } catch {
        return undefined;
      }
    };
    fallbackOf({ lane: "dev", snapshot: { checkout, digest: PROVED_SNAPSHOT } }).executorReady();
    await eventually(() => proof()?.proved === PROVED_SNAPSHOT);

    const fallback = fallbackOf({ lane: "dev", snapshot: { checkout, digest: FAILED_SNAPSHOT } });
    failOpens(fallback, 3);
    await eventually(() => requests.length === 1);
    fallback.executorReady();
    fallbackOf({ lane: "dev", snapshot: { checkout, digest: FAILED_SNAPSHOT } }).executorReady();
    await Bun.sleep(5);

    expect(requests).toEqual([{ kind: "build could not open a project", failedBuild: FAILED_SNAPSHOT, provedBuild: PROVED_SNAPSHOT, failedOpens: 3 }]);
    expect(proof()).toEqual({ version: 1, proved: PROVED_SNAPSHOT, refused: { digest: FAILED_SNAPSHOT, reason: "its project executors stopped before they were ready 3 times in a row" } });
  });
});
