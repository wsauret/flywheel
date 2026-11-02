import { describe, expect, spyOn, test } from "bun:test";
import { Log } from "../../../../src/infra/log.js";
import type { UpdateCheckResult } from "../../../../src/orchestration/update/update-check.js";
import type { UpdateService } from "../../../../src/orchestration/update/update-service.js";
import type { UpdateStatus } from "../../../../src/protocol/update-protocol-types.js";
import { candidate, fakeAuthority, harness, statuses, blockingInstaller } from "./_update-service-harness.js";

/** The build a rollback refused on the account of most cases. */
const REFUSED = { version: "1.3.0", buildId: "c".repeat(64) } as const;

describe("update service coordination", () => {
  test("a check another process already made recently suppresses this one", async () => {
    let checks = 0;
    const { service, published, authority } = harness({
      openAuthority: () => fakeAuthority({ claim: () => ({ kind: "fresh", checkedAtMs: 500 }) }).authority,
      check: async () => { checks += 1; return candidate(); },
    });

    expect(await service.run()).toEqual({ kind: "fresh" });
    expect(checks).toBe(0);
    expect(published).toEqual([]);
    expect(authority.calls.claims).toBe(0);
  });

  test("a manual check bypasses account freshness without bypassing its lease", async () => {
    let requestedFreshForMs = -1;
    const { service } = harness({
      openAuthority: () => fakeAuthority({
        claim: (request) => {
          requestedFreshForMs = request.freshForMs;
          return { kind: "won", fence: 7, leaseExpiresAtMs: 61_000 };
        },
      }).authority,
      check: async () => ({ kind: "current" }),
    });

    expect(await service.run({ manual: true })).toEqual({ kind: "current" });
    expect(requestedFreshForMs).toBe(0);
  });

  test("a run that names a release reads that release's manifest", async () => {
    const asked: (string | undefined)[] = [];
    const { service } = harness({ check: async (request) => { asked.push(request.release); return { kind: "current" }; } });
    await service.run({ manual: true, release: "1.4.0" });
    await service.run({ manual: true });
    expect(asked).toEqual(["1.4.0", undefined]);
  });

  test("a background check asks the account for the five-minute freshness window", async () => {
    let requestedFreshForMs = -1;
    const { service } = harness({
      openAuthority: () => fakeAuthority({
        claim: (request) => {
          requestedFreshForMs = request.freshForMs;
          return { kind: "won", fence: 7, leaseExpiresAtMs: 61_000 };
        },
      }).authority,
      check: async () => ({ kind: "current" }),
    });

    expect(await service.run()).toEqual({ kind: "current" });
    expect(requestedFreshForMs).toBe(5 * 60 * 1_000);
  });

  test("an authority open failure is a typed background failure", async () => {
    const { service, clock } = harness({ openAuthority: () => { throw new Error("authority corrupt"); } });

    service.start();
    clock.fireAll();
    await service.settled();
    expect(await service.run()).toEqual({ kind: "failed", reason: "authority corrupt" });
  });

  test("only one claimant works; a busy account never reaches the network", async () => {
    let checks = 0;
    const { service, published } = harness({
      openAuthority: () => fakeAuthority({ claim: () => ({ kind: "busy", leaseExpiresAtMs: 90_000 }) }).authority,
      check: async () => { checks += 1; return candidate(); },
    });

    expect(await service.run()).toEqual({ kind: "busy" });
    expect(checks).toBe(0);
    expect(published).toEqual([]);
  });

  test("a published release no newer than this build commits the check and leaves the published state alone", async () => {
    const { service, published, authority } = harness({ check: async () => ({ kind: "current" }) });

    expect(await service.run()).toEqual({ kind: "current" });
    expect(service.status()).toEqual({ revision: 0, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } });
    // Latest-collapsible: an unchanged view is not republished.
    expect(published).toEqual([]);
    expect(authority.calls.committedChecks).toBe(1);
  });

  test("a release a rollback refused is not installed again, and a newer one is", async () => {
    let installs = 0;
    let answer: UpdateCheckResult = candidate("1.3.0");
    const { service, published, authority } = harness({
      check: async () => answer,
      refusedBuild: () => REFUSED,
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });

    expect(await service.run({ manual: true })).toEqual({ kind: "refused", version: "1.3.0" });
    expect(installs).toBe(0);
    // The account runs 1.2.3, older than the release that could not start.
    expect(published.map((view) => view.status)).toEqual([{ kind: "refused", version: "1.3.0" }]);
    expect(authority.calls.committedChecks).toBe(1);

    answer = candidate("1.3.1");
    expect(await service.run({ manual: true })).toEqual({ kind: "installed", version: "1.3.1" });
    expect(installs).toBe(1);

    // A publisher out of reach changes nothing on this machine: the next
    // launch still runs 1.3.1, so the refused release is not named again.
    answer = { kind: "unavailable", reason: "getaddrinfo ENOTFOUND" };
    await service.run({ manual: true });
    expect(statuses(published)).toEqual(["refused", "available", "installing", "installed"]);
  });

  test("start publishes the release a rollback refused while it is newer than this build, and checks nothing for it", async () => {
    let checks = 0;
    const { service, published } = harness({
      currentVersion: "1.2.0",
      refusedBuild: () => REFUSED,
      check: async () => { checks += 1; return { kind: "current" }; },
    });

    service.start();
    expect(published.map((view) => view.status)).toEqual([{ kind: "refused", version: "1.3.0" }]);
    expect(checks).toBe(0);
  });

  test("every check that finds nothing to take rests on the release a rollback refused, never on idle or on the release it found", async () => {
    let answer: UpdateCheckResult = candidate("1.4.0");
    // No installer is bound, so a newer release is only announced.
    const { service, published } = harness({ refusedBuild: () => REFUSED, check: async () => answer });
    const runWith = async (next: UpdateCheckResult) => { answer = next; await service.run(); };

    await runWith(candidate("1.4.0"));
    await runWith({ kind: "unavailable", reason: "getaddrinfo ENOTFOUND" });
    await runWith(candidate("1.4.0"));
    await runWith({ kind: "current" });
    await runWith(candidate("1.4.0"));
    // Newer than this build and no newer than the refused one.
    await runWith(candidate("1.2.5"));
    // An unchanged resting status is not published again.
    await runWith({ kind: "current" });
    const available: UpdateStatus = { kind: "available", version: "1.4.0", blocking: "platform" };
    const refused: UpdateStatus = { kind: "refused", version: "1.3.0" };
    expect(published.map((view) => view.status)).toEqual([available, refused, available, refused, available, refused]);
  });

  test("a dev service that runs the proved snapshot in place of its checkout's source rests on naming both, however its checks end", async () => {
    const refusedSource = { refused: "6acd416c00000000", running: "1b2c3d4e00000000" };
    const { service, published } = harness({ currentVersion: "source", refusedSource, check: async () => ({ kind: "current" }) });

    service.start();
    await service.run({ manual: true });
    expect(published.map((view) => view.status)).toEqual([{ kind: "source-refused", ...refusedSource }]);
  });

  test("names a refused build of this build's own version by its build, because the version alone would name this build", async () => {
    const { service, published } = harness({ currentVersion: REFUSED.version, currentBuildId: "d".repeat(64), refusedBuild: () => REFUSED, check: async () => ({ kind: "current" }) });

    service.start();
    await service.run();
    expect(published.map((view) => view.status)).toEqual([{ kind: "refused", version: REFUSED.version, buildId: REFUSED.buildId }]);
  });

  test.each([
    ["the refused build is this build", "1.3.0", REFUSED.buildId],
    ["the refused build has this build's version and this process names no build of its own", "1.3.0", undefined],
    ["the refused release is older than this build", "1.4.0", undefined],
    ["this process is a source run, which states no release version", undefined, undefined],
  ])("rests on idle when %s", async (_case, currentVersion, currentBuildId) => {
    const { service, published } = harness({ currentVersion, ...(currentBuildId === undefined ? {} : { currentBuildId }), refusedBuild: () => REFUSED, check: async () => ({ kind: "current" }) });

    service.start();
    await service.run();
    expect(published).toEqual([]);
    expect(service.status().status).toEqual({ kind: "idle" });
  });

  test("a network or manifest failure returns to idle, commits nothing, and reports no user error", async () => {
    let answer: UpdateCheckResult = candidate();
    const { service, published, authority } = harness({ autoInstall: false, check: async () => answer });

    await service.run();
    answer = { kind: "unavailable", reason: "getaddrinfo ENOTFOUND" };

    expect(await service.run()).toEqual({ kind: "failed", reason: "getaddrinfo ENOTFOUND" });
    expect(statuses(published)).toEqual(["available", "idle"]);
    expect(authority.calls.committedChecks).toBe(1);
    expect(authority.calls.disposals).toBe(2);
  });

  test("notify-only policy publishes the available release and downloads nothing", async () => {
    let installs = 0;
    const { service, published, authority } = harness({
      autoInstall: false,
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });

    expect(await service.run()).toEqual({ kind: "policy-blocked", version: "1.3.0" });
    expect(installs).toBe(0);
    expect(published.at(-1)).toEqual({ revision: 1, autoInstall: { persisted: false, forcedOff: false, effective: false }, status: { kind: "available", version: "1.3.0", blocking: "auto-install-off" } });
    expect(authority.calls.committedChecks).toBe(1);
  });

  test("Windows installs through the installer bound for it, like every other platform", async () => {
    let installs = 0;
    const { service, published } = harness({
      platformArch: "win32-x64",
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });

    expect(await service.run()).toEqual({ kind: "installed", version: "1.3.0" });
    expect(installs).toBe(1);
    expect(published.at(-1)?.status).toEqual({ kind: "installed", version: "1.3.0" });
  });

  test("a runtime with no installer bound notifies and downloads nothing", async () => {
    // The one platform judgement the service still makes: it can discover a
    // release and owns no way to take it, so the refusal travels with the
    // release and the notice names the installer rather than a command.
    const { service, published } = harness({ installer: undefined });

    expect(await service.run()).toEqual({ kind: "platform-blocked", version: "1.3.0" });
    expect(published.at(-1)?.status).toEqual({ kind: "available", version: "1.3.0", blocking: "platform" });
    expect(published.at(-1)?.autoInstall.effective).toBe(true);
  });

  test("a manual run under a disabled policy is policy-blocked and downloads nothing", async () => {
    let installs = 0;
    const { service } = harness({
      autoInstall: false,
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });

    expect(await service.run({ manual: true })).toEqual({ kind: "policy-blocked", version: "1.3.0" });
    expect(installs).toBe(0);
  });

  test("the durable policy is re-read before activation, so a disable from another process revokes it", async () => {
    let installs = 0;
    const { service, published, policy } = harness({
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });
    // Another process disabled auto-install after this runtime started.
    policy.value = false;

    expect(await service.run()).toEqual({ kind: "policy-blocked", version: "1.3.0" });
    expect(installs).toBe(0);
    expect(published.at(-1)?.autoInstall.effective).toBe(false);
  });

  test("an auto-install publishes available, then installing, then installed", async () => {
    const { service, published, authority } = harness({ installer: { install: async () => ({ kind: "installed" }) } });

    expect(await service.run()).toEqual({ kind: "installed", version: "1.3.0" });
    expect(statuses(published)).toEqual(["available", "installing", "installed"]);
    // The activation commits the check inside the fenced transaction, so the
    // service must not commit a second time over it.
    expect(authority.calls.committedChecks).toBe(0);
  });

  test("the installer works under the fence this run won", async () => {
    const fences: number[] = [];
    const { service } = harness({ installer: { install: async (request) => { fences.push(request.fence); return { kind: "installed" }; } } });

    await service.run();

    expect(fences).toEqual([7]);
  });

  test("a failed install returns to available so the manual notice stays truthful", async () => {
    const { service, published, authority } = harness({
      installer: { install: () => Promise.reject(new Error("digest mismatch")) },
    });

    expect(await service.run()).toEqual({ kind: "failed", reason: "digest mismatch" });
    expect(statuses(published)).toEqual(["available", "installing", "available"]);
    expect(authority.calls.committedChecks).toBe(1);
  });

  test("an activation revoked while staging returns to available", async () => {
    const { service, published } = harness({ installer: { install: async () => ({ kind: "revoked" }) } });

    expect(await service.run()).toEqual({ kind: "available", version: "1.3.0" });
    expect(statuses(published)).toEqual(["available", "installing", "available"]);
  });

  test("closing admission aborts the install in flight and returns to available", async () => {
    const blocked = blockingInstaller();
    const { service, published } = harness({ installer: blocked.installer });

    const run = service.run();
    const signal = await blocked.started;
    expect(signal.aborted).toBe(false);

    service.closeAdmission();
    expect(signal.aborted).toBe(true);
    blocked.release("revoked");

    expect(await run).toEqual({ kind: "cancelled" });
    expect(statuses(published)).toEqual(["available", "installing", "available"]);
    await service.settled();
  });

  test("a superseded fence stops the install this run no longer owns", async () => {
    const blocked = blockingInstaller();
    const superseded = fakeAuthority({ renew: () => "superseded" });
    const { service, published, clock } = harness({ installer: blocked.installer, openAuthority: () => superseded.authority });

    const run = service.run();
    const signal = await blocked.started;
    clock.fireAll();
    expect(signal.aborted).toBe(true);
    blocked.release("revoked");

    expect(await run).toEqual({ kind: "busy" });
    expect(statuses(published)).toEqual(["available", "installing", "available"]);
  });

  test("a lease the installer concluded under this run's fence is done, not superseded: the run publishes installed and collects", async () => {
    const blocked = blockingInstaller();
    // The installer commits activation through its own handle, which concludes
    // the lease under this fence before the install call returns.
    const { service, published, clock, collections } = harness({ installer: blocked.installer, openAuthority: () => fakeAuthority({ renew: () => "concluded" }).authority });

    const run = service.run();
    const signal = await blocked.started;
    clock.fireAll();
    blocked.release(signal.aborted ? "revoked" : "installed");

    expect(await run).toEqual({ kind: "installed", version: "1.3.0" });
    expect(statuses(published)).toEqual(["available", "installing", "installed"]);
    expect(collections.count).toBe(1);
    // Nothing is left to renew, so the renewal that fired is not armed again.
    expect(clock.timers.filter((timer) => timer.delayMs === 30_000)).toHaveLength(1);
  });

  test("a renewal the authority cannot answer is asked again instead of ending the process", async () => {
    const blocked = blockingInstaller();
    let renews = 0;
    const flaky = fakeAuthority({
      renew: () => {
        renews += 1;
        // What contention, a full disk, or an I/O error look like here: the
        // authority throws rather than answering that the fence moved.
        if (renews === 1) throw new Error("database is locked");
        return "held";
      },
    });
    const { service, published, clock } = harness({ installer: blocked.installer, openAuthority: () => flaky.authority });

    const run = service.run();
    const signal = await blocked.started;
    clock.fireAll();
    expect(signal.aborted).toBe(false);
    clock.fireAll();
    expect(renews).toBeGreaterThanOrEqual(2);
    blocked.release("installed");

    expect(await run).toEqual({ kind: "installed", version: "1.3.0" });
    expect(statuses(published)).toEqual(["available", "installing", "installed"]);
  });

  test("a run in flight is joined rather than started twice", async () => {
    const blocked = blockingInstaller();
    const { service, authority } = harness({ installer: blocked.installer });

    const first = service.run();
    await blocked.started;
    const second = service.run();
    blocked.release("installed");

    expect(await first).toEqual(await second);
    expect(authority.calls.claims).toBe(1);
  });

  test("a run for one named release joins no run in flight, which can target another release", async () => {
    const blocked = blockingInstaller();
    const { service, authority } = harness({ installer: blocked.installer });

    const first = service.run();
    await blocked.started;
    expect(await service.run({ release: "1.4.0" })).toEqual({ kind: "busy" });
    blocked.release("installed");

    expect(await first).toEqual({ kind: "installed", version: "1.3.0" });
    expect(authority.calls.claims).toBe(1);
  });

  test("the deferred first check is armed by start and cancelled by closing admission", async () => {
    let checks = 0;
    const { service, clock } = harness({ check: async () => { checks += 1; return { kind: "current" }; } });

    service.start();
    expect(clock.timers).toHaveLength(1);
    service.closeAdmission();
    expect(clock.timers[0]?.cancelled).toBe(true);
    clock.fireAll();
    await service.settled();

    expect(checks).toBe(0);
  });

  test("a build that names no release repository arms no check, never reaches the network, and says why", async () => {
    let checks = 0;
    let installs = 0;
    const { service, clock, published, authority } = harness({
      repository: undefined,
      check: async () => { checks += 1; return candidate(); },
      installer: { install: async () => { installs += 1; return { kind: "installed" }; } },
    });

    service.start();
    expect(clock.timers).toHaveLength(0);
    expect(published.map((view) => view.status)).toEqual([{ kind: "no-repository" }]);
    expect(await service.run({ manual: true })).toEqual({ kind: "failed", reason: "this build names no release repository, so it does not update" });
    expect(await service.run({ manual: true, release: "1.3.0" })).toMatchObject({ kind: "failed" });
    expect([checks, installs, authority.calls.claims]).toEqual([0, 0, 0]);
    expect(service.status().status).toEqual({ kind: "no-repository" });
  });

  test("a completed background check arms the next one at the recheck interval", async () => {
    let checks = 0;
    const { service, clock } = harness({ check: async () => { checks += 1; return { kind: "current" }; } });

    service.start();
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([10_000]);
    clock.fireAll();
    await service.settled();
    // The re-arm rides the run's own finally, one microtask behind settled.
    await Promise.resolve();

    expect(checks).toBe(1);
    expect(clock.timers.at(-1)?.delayMs).toBe(30 * 60 * 1_000);

    clock.timers.at(-1)?.fire();
    await service.settled();
    await Promise.resolve();

    expect(checks).toBe(2);
    expect(clock.timers.at(-1)?.delayMs).toBe(30 * 60 * 1_000);
    expect(clock.timers).toHaveLength(3);
  });

  test("a second start between a fired timer and its re-arm schedules nothing", async () => {
    let checks = 0;
    const { service, clock } = harness({ check: async () => { checks += 1; return { kind: "current" }; } });

    service.start();
    clock.fireAll();
    // The run is in flight and the re-arm has not happened yet: the pending
    // handle is null, which is exactly when a naive idempotence check fails.
    service.start();
    expect(clock.timers).toHaveLength(1);

    await service.settled();
    await Promise.resolve();

    expect(checks).toBe(1);
    expect(clock.timers).toHaveLength(2);
    expect(clock.timers.at(-1)?.delayMs).toBe(30 * 60 * 1_000);
  });

  test("admission closed during an active background run arms no next check", async () => {
    let release!: (result: UpdateCheckResult) => void;
    const gate = new Promise<UpdateCheckResult>((resolve) => { release = resolve; });
    const { service, clock } = harness({ check: () => gate });

    service.start();
    clock.fireAll();
    service.closeAdmission();
    release({ kind: "current" });
    await service.settled();
    await Promise.resolve();

    expect(clock.timers).toHaveLength(1);
  });

  test("closing admission cancels the pending recurring check", async () => {
    let checks = 0;
    const { service, clock } = harness({ check: async () => { checks += 1; return { kind: "current" }; } });

    service.start();
    clock.fireAll();
    await service.settled();
    await Promise.resolve();

    service.closeAdmission();
    expect(clock.timers.at(-1)?.cancelled).toBe(true);
    clock.timers.at(-1)?.fire();
    await service.settled();

    expect(checks).toBe(1);
  });

  test("a start or a run after admission closed starts nothing", async () => {
    let checks = 0;
    const { service, published, clock } = harness({ refusedBuild: () => REFUSED, check: async () => { checks += 1; return candidate(); } });

    service.closeAdmission();

    service.start();
    expect(await service.run()).toEqual({ kind: "cancelled" });
    expect(checks).toBe(0);
    expect(clock.timers).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe("update check records", () => {
  test("a background check records an outcome once while it holds, and again when its reason changes", async () => {
    let answer: UpdateCheckResult = { kind: "unavailable", reason: "getaddrinfo ENOTFOUND" };
    const { service } = harness({ autoInstall: false, check: async () => answer });
    const log = Log.create({ service: "update-service" });
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      await service.run();
      await service.run();
      answer = { kind: "unavailable", reason: "the release manifest was malformed" };
      await service.run();

      expect(info.mock.calls.filter(([message]) => message === "update check settled").map(([, fields]) => fields)).toEqual([
        expect.objectContaining({ outcome: "failed", manual: false, reason: "getaddrinfo ENOTFOUND" }),
        expect.objectContaining({ outcome: "failed", manual: false, reason: "the release manifest was malformed" }),
      ]);
    } finally {
      info.mockRestore();
    }
  });

  test("every check the person asked for records at INFO, even one that repeats the last outcome", async () => {
    const { service } = harness({ autoInstall: false, check: async () => ({ kind: "current" }) });
    const log = Log.create({ service: "update-service" });
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      await service.run();
      await service.run({ manual: true });
      await service.run({ manual: true });

      expect(info.mock.calls.filter(([message]) => message === "update check settled").map(([, fields]) => fields)).toEqual([
        expect.objectContaining({ outcome: "current", manual: false }),
        expect.objectContaining({ outcome: "current", manual: true }),
        expect.objectContaining({ outcome: "current", manual: true }),
      ]);
    } finally {
      info.mockRestore();
    }
  });
});

describe("collecting the account's build trees", () => {
  test("a run that won the fence collects, whether or not it installed anything", async () => {
    const installed = harness({ installer: { install: async () => ({ kind: "installed" }) } });
    expect((await installed.service.run()).kind).toBe("installed");
    expect(installed.collections.count).toBe(1);

    // The cadence that matters for an account that stopped updating: a check
    // that finds nothing newer still collects what earlier updates left.
    const current = harness({ installer: { install: async () => ({ kind: "installed" }) }, check: async () => ({ kind: "current" }) });
    expect((await current.service.run()).kind).toBe("current");
    expect(current.collections.count).toBe(1);
  });

  test("a run that never held the lease collects nothing", async () => {
    const fresh = fakeAuthority({ claim: () => ({ kind: "fresh", checkedAtMs: 500 }) });
    const { service, collections } = harness({
      installer: { install: async () => ({ kind: "installed" }) },
      openAuthority: () => fresh.authority,
    });

    expect(await service.run()).toEqual({ kind: "fresh" });
    // Removing a transfer remainder is only safe under the lease, so a run
    // that lost the claim must not touch the versions root at all.
    expect(collections.count).toBe(0);
  });

  test("a collection that fails leaves the run's outcome alone", async () => {
    const { service, collections } = harness({ installer: { install: async () => ({ kind: "installed" }) } });
    collections.failure = new Error("the versions root is unreadable");

    expect(await service.run()).toEqual({ kind: "installed", version: "1.3.0" });
    expect(collections.count).toBe(1);
  });

  test("a shutdown during a collection withdraws it, and settlement waits until it stops", async () => {
    const { service, collections } = harness({ installer: { install: async () => ({ kind: "installed" }) }, check: async () => ({ kind: "current" }) });
    const started = Promise.withResolvers<AbortSignal>();
    // The removal runs until it is withdrawn.
    collections.work = async (signal) => { started.resolve(signal); await new Promise((resolve) => { signal.addEventListener("abort", resolve, { once: true }); }); };

    const run = service.run();
    const signal = await started.promise;
    let settled = false;
    const settlement = service.settled().then(() => { settled = true; });
    await Promise.resolve();
    // The removal is still running, so the account's shutdown must not pass it.
    expect(settled).toBe(false);

    service.closeAdmission();
    expect(signal.aborted).toBe(true);
    await settlement;
    expect((await run).kind).toBe("current");
  });

});

describe("update service platform admission", () => {
  test.each([
    ["darwin-x64", "flywheel-darwin-x64.tar.gz"],
    ["linux-x64", "flywheel-linux-x64.tar.gz"],
    ["linux-x64-musl", "flywheel-linux-x64-musl.tar.gz"],
    ["linux-arm64-musl", "flywheel-linux-arm64-musl.tar.gz"],
    // Which targets a release publishes is the release's decision, so even a
    // target no release has served asks for its archive.
    ["sunos-sparc", "flywheel-sunos-sparc.tar.gz"],
  ])("a %s build asks for its own kind of archive", async (platformArch, expected) => {
    const asked: string[] = [];
    const { service } = harness({ platformArch, check: async (request) => { asked.push(request.assetName); return candidate(); } });

    await service.run();
    expect(asked).toEqual([expected]);
  });

  test("a source run, which states no release version, never reaches the network", async () => {
    let checks = 0;
    const { service } = harness({ currentVersion: undefined, check: async () => { checks += 1; return candidate(); } });

    expect((await service.run()).kind).toBe("failed");
    expect(checks).toBe(0);
  });

  test("a release build whose version is not SemVer still checks, so a release can choose any version shape", async () => {
    const asked: string[] = [];
    const { service } = harness({ currentVersion: "2027.1", check: async (request) => { asked.push(request.currentVersion.canonical); return { kind: "current" }; } });

    expect((await service.run()).kind).toBe("current");
    expect(asked).toEqual(["2027.1"]);
  });
});

/** The type the runtime binds. Kept as a compile-time assertion so the app
 *  service's port cannot drift from what the service offers. */
const _port: (service: UpdateService) => Pick<UpdateService, "status" | "setAutoInstall"> = (service) => service;
void _port;
