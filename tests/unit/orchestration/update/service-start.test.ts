/** A build whose account service cannot start is rolled back, and a lane
 *  whose starts keep failing, before they listen or on their probation after
 *  it, parks.
 *
 *  Each case builds a real account root: two installed builds, the start
 *  record naming the older one as the last build proved here, and `current`
 *  naming the newer one. A service start that never reaches its
 *  listener is a start that `admitServiceStart` counted and that nothing
 *  settled; the next admission in the same process stands for the next
 *  process the service manager starts. The case runs the probation clock: a
 *  start serves its first minute only when the case says so. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Log } from "../../../../src/infra/log.js";
import { accountServeStartRecordPath, versionsDir } from "../../../../src/infra/paths.js";
import { activeBuildDir } from "../../../../src/infra/update/active-build.js";
import { lastServiceStartFailure, provedBuild, recordBuildProved } from "../../../../src/infra/update/service-start-record.js";
import { refusedBuild } from "../../../../src/orchestration/update/refused-build.js";
import type { RuntimeServiceState } from "../../../../src/protocol/app-service-types.js";
import { admitServiceStart, confirmServiceStart, endServiceStart, failServiceStart, type ProbationSchedule, withdrawServiceStart } from "../../../../src/orchestration/update/service-start.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { activatePlacedBuild, placeBuild } from "../../../helpers/placed-build.js";

const PREVIOUS = { version: "1.3.0", buildId: "a".repeat(64) } as const;
const FAILED = { version: "1.4.0", buildId: "b".repeat(64) } as const;
const NOW_MS = 1_000_000;

// A case that ends on a counted start ends it, so no signal listener
// outlives the case. Registered before the directories' own hook, which runs
// after it and removes the record with the directory.
afterEach(() => {
  endServiceStart();
});

const directories = temporaryDirectories();
let userDataRoot: string;
let previousExecutable: string;
let failedExecutable: string;

function activate(build: { readonly version: string; readonly buildId: string }): void {
  activatePlacedBuild(userDataRoot, build);
}

function currentBuild(): string | undefined {
  const active = activeBuildDir(userDataRoot);
  return active === undefined ? undefined : relative(realpathSync(userDataRoot), active).split("\\").join("/");
}

function startRecordText(): string {
  return readFileSync(accountServeStartRecordPath(userDataRoot), "utf8");
}

function startRecord(): { readonly [key: string]: unknown } {
  return JSON.parse(startRecordText());
}

const start = (executable: string = failedExecutable) => admitServiceStart({ userDataRoot, execPath: executable, nowMs: NOW_MS });

/** The probation clock of a case: each start that listens waits for it, and
 *  `serve()` ends every wait, as a start that serves its first minute does. */
let probation: { readonly schedule: ProbationSchedule; readonly serve: () => void };

function probationClock(): typeof probation {
  const waits = new Set<() => void>();
  return {
    schedule: (served) => {
      waits.add(served);
      return () => { waits.delete(served); };
    },
    serve: () => {
      for (const served of waits) {
        waits.delete(served);
        served();
      }
    },
  };
}

/** This start listens at `nowMs`, and its probation waits for the case. */
const listen = (nowMs = NOW_MS, report?: (state: RuntimeServiceState) => void) => { confirmServiceStart({ nowMs, schedule: probation.schedule, ...(report === undefined ? {} : { report }) }); };

beforeEach(async () => {
  probation = probationClock();
  userDataRoot = join(directories("flywheel-service-start-"), ".flywheel");
  mkdirSync(userDataRoot, { mode: 0o700 });
  previousExecutable = placeBuild(userDataRoot, PREVIOUS);
  failedExecutable = placeBuild(userDataRoot, FAILED);
  // PREVIOUS served this account, and one of its project executors reported
  // ready, before FAILED was activated.
  activate(PREVIOUS);
  expect(await start(previousExecutable)).toBe("serve");
  listen();
  recordBuildProved(userDataRoot, PREVIOUS);
  activate(FAILED);
});

describe("an activated build whose account service stops before it listens", () => {
  test("three failed starts roll the account back to the last proved build, once", async () => {
    expect([await start(), await start(), await start()]).toEqual(["serve", "serve", "serve"]);
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);

    expect(await start()).toBe("rolled-back");

    expect(currentBuild()).toBe(`versions/${PREVIOUS.version}/${PREVIOUS.buildId}`);
    // The failed build stays installed and refused, so the update check does
    // not activate this version again.
    expect(existsSync(failedExecutable)).toBe(true);
    expect(refusedBuild(userDataRoot)).toEqual(FAILED);

    // The build it returned to is the proved one, so its own failed starts
    // never move `current` again.
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await start(previousExecutable)).toBe("serve");
    expect(currentBuild()).toBe(`versions/${PREVIOUS.version}/${PREVIOUS.buildId}`);
  });

  test("rolls back again when an engine that predates the refusal activates the failed build again", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) await start();
    expect(await start()).toBe("rolled-back");
    // The service manager starts the build it returned to, which listens.
    expect(await start(previousExecutable)).toBe("serve");
    listen();
    // An older engine reads no refusal and moves `current` forward again.
    activate(FAILED);

    expect([await start(), await start(), await start(), await start()]).toEqual(["serve", "serve", "serve", "rolled-back"]);
    expect(currentBuild()).toBe(`versions/${PREVIOUS.version}/${PREVIOUS.buildId}`);
  });

  test("a later start that listens clears the count and proves nothing, so three more failed starts still roll the build back", async () => {
    await start();
    await start();
    listen();

    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS });
    expect([await start(), await start(), await start(), await start()]).toEqual(["serve", "serve", "serve", "rolled-back"]);
    expect(currentBuild()).toBe(`versions/${PREVIOUS.version}/${PREVIOUS.buildId}`);
  });

  test("a build that one of its project executors proved is never rolled back", async () => {
    expect(recordBuildProved(userDataRoot, FAILED)).toBe(true);
    // A proof the record already holds is not recorded again.
    expect(recordBuildProved(userDataRoot, FAILED)).toBe(false);

    expect(provedBuild(userDataRoot)).toEqual(FAILED);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await start()).toBe("serve");
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("a start that ends without failing takes its count back", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await start()).toBe("serve");
      endServiceStart();
    }
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
    expect(JSON.parse(startRecordText())).toEqual({ version: 2, proved: PREVIOUS });
  });

  test("a start whose account home is removed on its probation ends there and creates nothing in the removed home", async () => {
    expect(await start()).toBe("serve");
    listen();
    // Another run removed this run's home, as the service's retirement finds.
    rmSync(userDataRoot, { recursive: true, force: true });

    endServiceStart();

    expect(existsSync(userDataRoot)).toBe(false);
  });

  test("a signal before the start listens takes its count back and ends the process as the signal would", async () => {
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    const listeners = process.listenerCount("SIGINT");
    try {
      expect(await start()).toBe("serve");
      expect(process.listenerCount("SIGINT")).toBe(listeners + 1);
      process.emit("SIGINT", "SIGINT");

      expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
      expect(JSON.parse(startRecordText())).toEqual({ version: 2, proved: PREVIOUS });
      expect(process.listenerCount("SIGINT")).toBe(listeners);
    } finally {
      kill.mockRestore();
    }
  });

  test("a build that is not installed counts nothing, and records no failure", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await start(process.execPath)).toBe("serve");
    expect(failServiceStart({ cause: "the account store cannot be opened", causeKind: "thrown" }, () => {})).toBe("restart");
    expect(JSON.parse(startRecordText())).toEqual({ version: 2, proved: PREVIOUS });
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("keeps the build current when the proved build is gone, and says so once", async () => {
    rmSync(join(versionsDir(userDataRoot), PREVIOUS.version, PREVIOUS.buildId), { recursive: true });
    const warn = spyOn(Log.create({ service: "service-start-record" }), "warn");
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) expect(await start()).toBe("serve");
      expect(warn.mock.calls.filter(([message]) => String(message).includes("cannot be rolled back"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
    expect(refusedBuild(userDataRoot)).toBeUndefined();
  });
});

describe("a start that fails before it listens", () => {
  const SECOND = 1_000;
  const T0 = NOW_MS;
  const THROWN = { cause: "the account store cannot be opened", causeKind: "thrown" } as const;
  const SETTLING = { cause: "the start lock's claim is empty", causeKind: "clears-itself", refusal: { kind: "claim-settling", path: "/scratch/serve.start.lock.reclaim" } } as const;

  /** One start of `executable` that begins at `beganAtMs` and fails at
   *  `failedAtMs`. A refusal takes its count back before it fails, as the
   *  serve command's refusal does; a thrown failure leaves it standing.
   *  `recordCause` stands for the caller's own record of the cause. */
  async function failedStart(beganAtMs: number, failedAtMs: number, failure: Parameters<typeof failServiceStart>[0], options: { readonly executable?: string; readonly refused?: boolean; readonly recordCause?: (repeat: boolean) => void } = {}) {
    expect(await admitServiceStart({ userDataRoot, execPath: options.executable ?? previousExecutable, nowMs: beganAtMs })).toBe("serve");
    if (options.refused === true) withdrawServiceStart();
    return failServiceStart(failure, options.recordCause ?? (() => {}), failedAtMs);
  }

  /** The park records among a logger spy's calls. The admission of a start
   *  whose build cannot be rolled back writes its own warning beside them. */
  function parkRecords(spy: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
    return spy.mock.calls.filter(([message]) => String(message).includes("parks"));
  }

  test("parks once its starts have failed for two minutes over three starts, says so once, and a start that listens keeps the failure until it serves its first minute", async () => {
    const warn = spyOn(Log.create({ service: "service-start-record" }), "warn");
    try {
      expect(await failedStart(T0 - 10 * SECOND, T0, THROWN)).toBe("restart");
      expect(await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN)).toBe("restart");
      expect(await failedStart(T0 + 50 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("park");
      expect(warn.mock.calls.filter(([message]) => String(message).includes("parks"))).toEqual([[expect.any(String), { starts: 3, failingMs: 130 * SECOND }]]);
    } finally {
      warn.mockRestore();
    }
    const parked = { since: T0 + 130 * SECOND, lastAt: T0 + 130 * SECOND, starts: 1 };
    const failing = { since: T0, lastAt: T0 + 130 * SECOND, starts: 3, cause: THROWN.cause, causeKind: "thrown", parked };
    expect(startRecord().failing).toEqual(failing);
    expect(lastServiceStartFailure(userDataRoot)).toEqual({ lastAt: T0 + 130 * SECOND, cause: THROWN.cause, parked });

    expect(await start(previousExecutable)).toBe("serve");
    listen(T0 + 200 * SECOND);
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS, failing });
    probation.serve();
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS });
    expect(lastServiceStartFailure(userDataRoot)).toBeUndefined();
  });

  test("a refusal that clears by itself never parks, however long it lasts", async () => {
    for (let failedAt = T0; failedAt <= T0 + 20 * 60 * SECOND; failedAt += 15 * SECOND) {
      expect(await failedStart(failedAt - 5 * SECOND, failedAt, SETTLING, { refused: true })).toBe("restart");
    }
    expect(startRecord().failing).toEqual({ since: T0, lastAt: T0 + 20 * 60 * SECOND, starts: 81, ...SETTLING });
  });

  test("a start that begins more than a minute after the last failure of a streak that has not parked begins a new streak", async () => {
    await failedStart(T0 - 10 * SECOND, T0, THROWN);
    await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN);

    // Joined to the streak, this third failure would reach the bound.
    expect(await failedStart(T0 + 110 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("restart");
    expect(startRecord().failing).toEqual({ since: T0 + 130 * SECOND, lastAt: T0 + 130 * SECOND, starts: 1, ...THROWN });
  });

  test("a start after a park that fails parks again at once, however long after the park it begins, and a repeat of the same cause records only at DEBUG", async () => {
    await failedStart(T0 - 10 * SECOND, T0, THROWN);
    await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN);
    expect(await failedStart(T0 + 50 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("park");

    // A client's start request runs one start ten minutes later.
    const requested = T0 + 130 * SECOND + 10 * 60 * SECOND;
    const logger = Log.create({ service: "service-start-record" });
    const warn = spyOn(logger, "warn");
    const debug = spyOn(logger, "debug");
    const causeRecords: boolean[] = [];
    try {
      expect(await failedStart(requested, requested + SECOND, THROWN, { recordCause: (repeat) => causeRecords.push(repeat) })).toBe("park");
      expect(parkRecords(warn)).toEqual([]);
      expect(parkRecords(debug)).toEqual([[expect.stringContaining("parks again"), { parkedStarts: 2, parkedForMs: requested + SECOND - (T0 + 130 * SECOND), causeKind: "thrown" }]]);
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
    expect(causeRecords).toEqual([true]);
    expect(startRecord().failing).toEqual({ since: T0, lastAt: requested + SECOND, starts: 4, ...THROWN, parked: { since: T0 + 130 * SECOND, lastAt: requested + SECOND, starts: 2 } });
  });

  test("a start after a park whose cause changed records at WARN, as a first occurrence does", async () => {
    await failedStart(T0 - 10 * SECOND, T0, THROWN);
    await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN);
    expect(await failedStart(T0 + 50 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("park");

    const refused = { cause: "the address refuses this user", causeKind: "refused", refusal: { kind: "address-access", path: "/scratch/serve.sock", code: "EACCES" } } as const;
    const requested = T0 + 130 * SECOND + 10 * 60 * SECOND;
    const warn = spyOn(Log.create({ service: "service-start-record" }), "warn");
    const causeRecords: boolean[] = [];
    try {
      expect(await failedStart(requested, requested + SECOND, refused, { refused: true, recordCause: (repeat) => causeRecords.push(repeat) })).toBe("park");
      expect(parkRecords(warn)).toEqual([[expect.stringContaining("parks again"), { parkedStarts: 2, parkedForMs: requested + SECOND - (T0 + 130 * SECOND), causeKind: "refused", refusal: "address-access" }]]);
    } finally {
      warn.mockRestore();
    }
    expect(causeRecords).toEqual([false]);
  });

  test.each([
    ["serves its first minute", (listenedAt: number) => { probation.serve(); return listenedAt + 60 * SECOND; }],
    ["ends by its own exit path during that minute", (listenedAt: number) => { endServiceStart(listenedAt + 30 * SECOND); return listenedAt + 30 * SECOND; }],
  ] as const)("the first start after a park that %s reports the park once, with the count of its starts, and its listen alone reports nothing", async (_case, serve) => {
    await failedStart(T0 - 10 * SECOND, T0, THROWN);
    await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN);
    expect(await failedStart(T0 + 50 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("park");
    for (const requested of [T0 + 200 * SECOND, T0 + 300 * SECOND]) expect(await failedStart(requested, requested + SECOND, THROWN)).toBe("park");

    const listenedAt = T0 + 400 * SECOND;
    const info = spyOn(Log.create({ service: "service-start-record" }), "info");
    try {
      expect(await start(previousExecutable)).toBe("serve");
      listen(listenedAt);
      expect(info).not.toHaveBeenCalled();
      const servedAt = serve(listenedAt);
      expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS });
      // A start that serves after it reports nothing more.
      expect(await start(previousExecutable)).toBe("serve");
      listen(servedAt + SECOND);
      probation.serve();
      expect(info.mock.calls).toEqual([["the account service serves after its lane parked", { parkedStarts: 3, parkedForMs: servedAt - (T0 + 130 * SECOND), causeKind: "thrown" }]]);
    } finally {
      info.mockRestore();
    }
  });

  test("a refusal that clears by itself after a park restarts, and keeps the park for the next failure that can park", async () => {
    await failedStart(T0 - 10 * SECOND, T0, THROWN);
    await failedStart(T0 + 10 * SECOND, T0 + 40 * SECOND, THROWN);
    expect(await failedStart(T0 + 50 * SECOND, T0 + 130 * SECOND, THROWN)).toBe("park");

    const requested = T0 + 130 * SECOND + 10 * 60 * SECOND;
    expect(await failedStart(requested, requested + SECOND, SETTLING, { refused: true })).toBe("restart");
    // The failure is the latest, and the park stays the earlier one, so a
    // client that asked after the park keeps waiting.
    expect(lastServiceStartFailure(userDataRoot)).toEqual({ lastAt: requested + SECOND, cause: SETTLING.cause, refusal: SETTLING.refusal, parked: { since: T0 + 130 * SECOND, lastAt: T0 + 130 * SECOND, starts: 2 } });

    const later = requested + 5 * 60 * SECOND;
    expect(await failedStart(later, later + SECOND, THROWN)).toBe("park");
    expect(startRecord().failing).toEqual({ since: T0, lastAt: later + SECOND, starts: 5, ...THROWN, parked: { since: T0 + 130 * SECOND, lastAt: later + SECOND, starts: 3 } });
  });

  test("a thrown failure of a build that a rollback can still replace does not park until the rollback is refused", async () => {
    const failed = { executable: failedExecutable };
    // Each start begins 10 seconds after the previous failure.
    expect(await failedStart(T0 - 10 * SECOND, T0, THROWN, failed)).toBe("restart");
    expect(await failedStart(T0 + 10 * SECOND, T0 + 90 * SECOND, THROWN, failed)).toBe("restart");
    expect(await failedStart(T0 + 100 * SECOND, T0 + 180 * SECOND, THROWN, failed)).toBe("restart");
    expect(startRecord().failing).toMatchObject({ since: T0, starts: 3 });

    // The proved build is gone, so the start after the limit cannot roll the
    // account back.
    rmSync(join(versionsDir(userDataRoot), PREVIOUS.version, PREVIOUS.buildId), { recursive: true });
    expect(await failedStart(T0 + 190 * SECOND, T0 + 200 * SECOND, THROWN, failed)).toBe("park");
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("a record of the previous shape reads the build that listened as proved, so it is counted and rolled back to", async () => {
    // A build from before 2026-09-28 writes this shape. The case goes with
    // its conversion after 2026-12-28.
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 1, listened: PREVIOUS, unlistened: { buildId: FAILED.buildId, starts: 2 } })}\n`);

    expect(await start()).toBe("serve");
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS, unlistened: { buildId: FAILED.buildId, starts: 3 } });
    expect(await start()).toBe("rolled-back");
    expect(currentBuild()).toBe(`versions/${PREVIOUS.version}/${PREVIOUS.buildId}`);
  });

  test.each([
    ["names the build that listened and a failing streak", { listened: PREVIOUS }, { proved: PREVIOUS }],
    ["names no build that listened", {}, {}],
  ] as const)("a record of the previous shape that %s keeps its streak and names only a build that listened as proved", async (_case, listened, proved) => {
    // A build from before 2026-09-28 writes this shape. The case goes with
    // its conversion after 2026-12-28.
    const streak = { since: NOW_MS - 10 * SECOND, lastAt: NOW_MS - 5 * SECOND, starts: 1, ...THROWN };
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 1, ...listened, failing: streak })}\n`);

    expect(await start()).toBe("serve");
    expect(startRecord()).toEqual({ version: 2, ...proved, failing: streak, unlistened: { buildId: FAILED.buildId, starts: 1 } });
  });

  test("a fatal failure within a minute of the listen joins the lane's streak and restarts, and one after the start served its minute records nothing", async () => {
    expect(await start()).toBe("serve");
    listen(T0);
    expect(failServiceStart(THROWN, () => {}, T0 + 20 * SECOND)).toBe("restart");
    // A failure on probation joins the streak with its count confirmed at
    // the listen, so it never counts toward the rollback.
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS, failing: { since: T0 + 20 * SECOND, lastAt: T0 + 20 * SECOND, starts: 1, ...THROWN, stopsAfterListen: 1 } });

    expect(await start()).toBe("serve");
    listen(T0 + 40 * SECOND);
    probation.serve();
    expect(failServiceStart(THROWN, () => {}, T0 + 200 * SECOND)).toBe("restart");
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS });
  });

  test("a fatal failure within a minute of the listen parks a lane whose starts have failed too long, and never counts toward the rollback", async () => {
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 2, proved: PREVIOUS, failing: { since: T0 - 3 * 60 * SECOND, lastAt: T0 - 5 * SECOND, starts: 5, ...THROWN } })}\n`);
    expect(await start()).toBe("serve");
    listen(T0 + 2 * SECOND);

    expect(failServiceStart(THROWN, () => {}, T0 + 20 * SECOND)).toBe("park");
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS, failing: { since: T0 - 3 * 60 * SECOND, lastAt: T0 + 20 * SECOND, starts: 6, ...THROWN, stopsAfterListen: 1, parked: { since: T0 + 20 * SECOND, lastAt: T0 + 20 * SECOND, starts: 1 } } });
    expect(await start()).toBe("serve");
    expect(currentBuild()).toBe(`versions/${FAILED.version}/${FAILED.buildId}`);
  });

  test("a client that reads a record it cannot read at each step of its wait says so once, and counts the repeats", () => {
    const recordPath = accountServeStartRecordPath(userDataRoot);
    rmSync(recordPath);
    mkdirSync(recordPath);
    const debug = spyOn(Log.create({ service: "service-start-record" }), "debug");
    try {
      for (let step = 0; step < 3; step += 1) expect(lastServiceStartFailure(userDataRoot)).toBeUndefined();
      rmSync(recordPath, { recursive: true });
      expect(lastServiceStartFailure(userDataRoot)).toBeUndefined();
      expect(debug.mock.calls).toEqual([
        ["the service start record could not be read", { error: expect.stringContaining("EISDIR") }],
        ["the service start record could not be read again", { count: 2, windowMs: expect.any(Number) }],
      ]);
    } finally {
      debug.mockRestore();
    }
  });
});

describe("a lane whose starts stop within a minute of their listen", () => {
  const SECOND = 1_000;
  const T0 = NOW_MS;
  const THROWN = { cause: "the account store cannot be opened", causeKind: "thrown" } as const;

  /** A counted start of `executable` that begins at `beganAtMs`. */
  async function admit(beganAtMs: number, executable = failedExecutable) {
    expect(await admitServiceStart({ userDataRoot, execPath: executable, nowMs: beganAtMs })).toBe("serve");
  }

  test("reports a crash loop with the latest cause at the listen after its second such stop, and its end once that start serves its minute", async () => {
    const reports: RuntimeServiceState[] = [];
    const report = (state: RuntimeServiceState) => { reports.push(state); };
    await admit(T0);
    listen(T0 + 2 * SECOND, report);
    expect(failServiceStart(THROWN, () => {}, T0 + 20 * SECOND)).toBe("restart");
    // One stop that recovers is invisible.
    await admit(T0 + 30 * SECOND);
    listen(T0 + 32 * SECOND, report);
    expect(reports).toEqual([]);
    const second = { cause: "the hub stopped", causeKind: "thrown" } as const;
    expect(failServiceStart(second, () => {}, T0 + 50 * SECOND)).toBe("restart");

    const info = spyOn(Log.create({ service: "service-start-record" }), "info");
    try {
      await admit(T0 + 60 * SECOND);
      listen(T0 + 62 * SECOND, report);
      expect(reports).toEqual([{ kind: "crash_loop", cause: second.cause }]);
      probation.serve();
      expect(reports).toEqual([{ kind: "crash_loop", cause: second.cause }, { kind: "serving" }]);
      // Each decision is recorded once, with no content.
      expect(info.mock.calls).toEqual([
        ["the account service reports a crash loop to its clients", { starts: 2, stopsAfterListen: 2, causeKind: "thrown" }],
        ["the account service serves after its crash loop", { starts: 2, stopsAfterListen: 2 }],
      ]);
    } finally {
      info.mockRestore();
    }
    expect(startRecord()).toEqual({ version: 2, proved: PREVIOUS });
  });

  test("reports nothing at the listen of the build that a rollback returns to after its successor's starts failed before they listened", async () => {
    for (const [beganAt, failedAt] of [[T0 - 10 * SECOND, T0], [T0 + 10 * SECOND, T0 + 20 * SECOND], [T0 + 30 * SECOND, T0 + 40 * SECOND]] as const) {
      await admit(beganAt);
      expect(failServiceStart(THROWN, () => {}, failedAt)).toBe("restart");
    }
    expect(await admitServiceStart({ userDataRoot, execPath: failedExecutable, nowMs: T0 + 50 * SECOND })).toBe("rolled-back");

    const reports: RuntimeServiceState[] = [];
    await admit(T0 + 55 * SECOND, previousExecutable);
    listen(T0 + 57 * SECOND, (state) => { reports.push(state); });
    expect(reports).toEqual([]);
    expect(startRecord().failing).toMatchObject({ starts: 3, causeKind: "thrown" });
  });

  test("reports nothing when the stops ended at a gap before this start began", async () => {
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 2, proved: PREVIOUS, failing: { since: T0 - 10 * 60 * SECOND, lastAt: T0 - 5 * 60 * SECOND, starts: 2, ...THROWN, stopsAfterListen: 2 } })}\n`);
    const reports: RuntimeServiceState[] = [];
    await admit(T0);
    listen(T0 + 2 * SECOND, (state) => { reports.push(state); });
    expect(reports).toEqual([]);
  });

  test("a streak of the previous shape, which counts no stop after a listen, reports nothing and counts the next such stop as its first", async () => {
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 2, proved: PREVIOUS, failing: { since: T0 - 30 * SECOND, lastAt: T0 - 5 * SECOND, starts: 2, ...THROWN } })}\n`);
    const reports: RuntimeServiceState[] = [];
    await admit(T0);
    listen(T0 + 2 * SECOND, (state) => { reports.push(state); });
    expect(reports).toEqual([]);
    expect(failServiceStart(THROWN, () => {}, T0 + 20 * SECOND)).toBe("restart");
    expect(startRecord().failing).toEqual({ since: T0 - 30 * SECOND, lastAt: T0 + 20 * SECOND, starts: 3, ...THROWN, stopsAfterListen: 1 });
  });
});

describe("a record of a shape this build does not know", () => {
  test("a start record is reported once, replaced, and counting goes on", async () => {
    writeFileSync(accountServeStartRecordPath(userDataRoot), `${JSON.stringify({ version: 3, build: FAILED.buildId, failures: [1, 2, 3] })}\n`);
    const warn = spyOn(Log.create({ service: "service-start-record" }), "warn");
    try {
      expect([await start(), await start()]).toEqual(["serve", "serve"]);
      expect(warn.mock.calls.filter(([message]) => String(message).includes("a shape this build does not know"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(JSON.parse(startRecordText())).toEqual({ version: 2, unlistened: { buildId: FAILED.buildId, starts: 2 } });
  });

  test("a refused-build record is reported once for its content and names no refused build", () => {
    const refusedBuildRecord = join(userDataRoot, "update", "refused-build.json");
    mkdirSync(join(userDataRoot, "update"), { mode: 0o700 });
    const stored = `${JSON.stringify({ version: 2, refusals: [FAILED] })}\n`;
    writeFileSync(refusedBuildRecord, stored);
    const warn = spyOn(Log.create({ service: "refused-build" }), "warn");
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) expect(refusedBuild(userDataRoot)).toBeUndefined();
      expect(warn.mock.calls.filter(([message]) => String(message).includes("a shape this build does not know"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(refusedBuildRecord, "utf8")).toBe(stored);
  });
});
