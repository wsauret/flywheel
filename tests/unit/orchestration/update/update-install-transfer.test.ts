/** The transfer of a release asset over a network that stalls, drops, and
 *  comes back: what the account looks like afterwards, and how long the
 *  transfer waits before it gives up. Time is fake, so every wait is exact. */

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DebugLogRecordInput } from "../../../../src/infra/debug-log.js";
import { Log } from "../../../../src/infra/log.js";
import { account, ASSET_URL, bodyOf, buildArchive, cutBody, cutRangeOf, GIVE_UP_MS, harness, pieces, POSIX_HOST, rangeFrom, rangeOf, redirectTo, rejection, releaseOf, settleOnFakeTime, shortRangeOf, STALL_MS, stallingBody, VERSION, versionsEntries, useFreshAccount } from "./_update-install-harness.js";

useFreshAccount();

describe.skipIf(!POSIX_HOST)("bounded waiting", () => {
  test("asks again after a stall and installs from the request that delivers", async () => {
    const archive = await buildArchive();
    let answers = 0;
    const run = harness((_url, signal) => {
      answers += 1;
      return answers === 1 ? stallingBody(signal) : bodyOf([archive]);
    });

    expect(await settleOnFakeTime(run, run.install(releaseOf(archive)), 1_000)).toEqual({ kind: "installed" });
    expect(answers).toBe(2);
    expect(versionsEntries()).toEqual([VERSION]);
  });

  test("gives up on stalled requests only once no byte has arrived for ten minutes, and leaves the account untouched", async () => {
    const archive = await buildArchive();
    let answers = 0;
    const run = harness((_url, signal) => {
      answers += 1;
      return stallingBody(signal);
    });

    await expect(settleOnFakeTime(run, run.install(releaseOf(archive)), 10_000)).rejects.toThrow(`no byte arrived for ${GIVE_UP_MS}ms`);
    expect(run.scheduler.nowMs() - 10_000).toBeGreaterThanOrEqual(GIVE_UP_MS);
    expect(answers).toBeGreaterThan(3);
    expect(versionsEntries()).toEqual([]);
    expect(existsSync(join(account.userDataRoot, "current"))).toBe(false);
  });

  test("a connection cut mid-transfer resumes from the byte it reached, against the host that served it", async () => {
    const archive = await buildArchive({ payload: [{ path: "large.bin", mode: 0o644, content: randomBytes(64 * 1024) }] });
    const half = Math.floor(archive.byteLength / 2);
    const blob = "https://objects.githubusercontent.com/blob?sig=1";
    let answers = 0;
    const run = harness((url, _signal, range) => {
      answers += 1;
      if (url === ASSET_URL) return redirectTo(blob);
      return range === undefined ? cutBody([archive.subarray(0, half)]) : rangeOf(archive, half);
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toEqual([ASSET_URL, blob, blob]);
    expect(run.ranges).toEqual([undefined, undefined, `bytes=${half}-`]);
    expect(answers).toBe(3);
  });

  test("a host that does not resume answers the whole asset again, and the bytes already written are dropped", async () => {
    const archive = await buildArchive();
    const half = Math.floor(archive.byteLength / 2);
    let answers = 0;
    const run = harness(() => {
      answers += 1;
      return answers === 1 ? cutBody([archive.subarray(0, half)]) : bodyOf([archive]);
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.ranges).toEqual([undefined, `bytes=${half}-`]);
  });

  test("a body that ends cleanly short of the stated size resumes from the byte it reached, as a cut one does", async () => {
    const archive = await buildArchive({ payload: [{ path: "large.bin", mode: 0o644, content: randomBytes(64 * 1024) }] });
    const half = Math.floor(archive.byteLength / 2);
    const threeQuarters = Math.floor((archive.byteLength * 3) / 4);
    const run = harness((_url, _signal, range) => {
      // A body delimited by the connection's close, then a 206 that holds
      // less than the range it states: both end with no error.
      if (range === undefined) return bodyOf([archive.subarray(0, half)]);
      if (range === `bytes=${half}-`) return shortRangeOf(archive, half, threeQuarters);
      return rangeOf(archive, threeQuarters);
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.ranges).toEqual([undefined, `bytes=${half}-`, `bytes=${threeQuarters}-`]);
    expect(versionsEntries()).toEqual([VERSION]);
  });

  test.each([503, 429])("a %d answer partway through waits and asks again from the byte it reached", async (status) => {
    const archive = await buildArchive();
    const half = Math.floor(archive.byteLength / 2);
    const askedAtMs: number[] = [];
    const run = harness((_url, _signal, range) => {
      askedAtMs.push(run.scheduler.nowMs());
      if (range === undefined) return cutBody([archive.subarray(0, half)]);
      return askedAtMs.length === 2 ? rejection(status) : rangeOf(archive, half);
    });

    expect(await settleOnFakeTime(run, run.install(releaseOf(archive)), 1_000)).toEqual({ kind: "installed" });
    expect(run.ranges).toEqual([undefined, `bytes=${half}-`, `bytes=${half}-`]);
    expect((askedAtMs[2] ?? 0) - (askedAtMs[1] ?? 0)).toBe(1_000);
    expect(versionsEntries()).toEqual([VERSION]);
  });

  test("a resume target that no longer serves the bytes sends the next request to the asset URL", async () => {
    const archive = await buildArchive();
    const half = Math.floor(archive.byteLength / 2);
    const blob = "https://objects.githubusercontent.com/blob?sig=expires";
    let blobAnswers = 0;
    const run = harness((url, _signal, range) => {
      if (url === ASSET_URL) return redirectTo(blob);
      blobAnswers += 1;
      if (blobAnswers === 1) return cutBody([archive.subarray(0, half)]);
      if (blobAnswers === 2) return rejection(403);
      return range === `bytes=${half}-` ? rangeOf(archive, half) : bodyOf([archive]);
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toEqual([ASSET_URL, blob, blob, ASSET_URL, blob]);
    expect(run.ranges.slice(2)).toEqual([`bytes=${half}-`, `bytes=${half}-`, `bytes=${half}-`]);
  });

  test("a resume target that answers a server error sends the next request to the asset URL, which can redirect to a healthy host", async () => {
    const archive = await buildArchive();
    const half = Math.floor(archive.byteLength / 2);
    const failing = "https://objects.githubusercontent.com/blob?sig=failing";
    const healthy = "https://release-assets.githubusercontent.com/blob?sig=healthy";
    let redirects = 0;
    const run = harness((url, _signal, range) => {
      if (url === ASSET_URL) return redirectTo(redirects++ === 0 ? failing : healthy);
      if (url === failing) return range === undefined ? cutBody([archive.subarray(0, half)]) : rejection(503);
      return rangeOf(archive, half);
    });

    expect(await settleOnFakeTime(run, run.install(releaseOf(archive)), 1_000)).toEqual({ kind: "installed" });
    expect(run.requests).toEqual([ASSET_URL, failing, failing, ASSET_URL, healthy]);
    expect(run.ranges.slice(2)).toEqual([`bytes=${half}-`, `bytes=${half}-`, `bytes=${half}-`]);
  });

  test("a network that is down for seconds after a cut resumes when it returns, from the byte it reached", async () => {
    const archive = await buildArchive();
    const half = Math.floor(archive.byteLength / 2);
    let downUntilMs = Number.POSITIVE_INFINITY;
    const run = harness((_url, _signal, range) => {
      if (range === undefined) {
        downUntilMs = run.scheduler.nowMs() + 5_000;
        return cutBody([archive.subarray(0, half)]);
      }
      if (run.scheduler.nowMs() < downUntilMs) throw new Error("getaddrinfo ENOTFOUND github.com");
      return rangeOf(archive, half);
    });

    expect(await settleOnFakeTime(run, run.install(releaseOf(archive)), 1_000)).toEqual({ kind: "installed" });
    expect(run.ranges.slice(1).every((range) => range === `bytes=${half}-`)).toBe(true);
    expect(run.requests.length).toBeGreaterThan(2);
    expect(versionsEntries()).toEqual([VERSION]);
  });

  test("gives up on failing requests only once no byte has arrived for ten minutes, waiting longer between them", async () => {
    const archive = await buildArchive();
    const askedAtMs: number[] = [];
    const run = harness(() => {
      askedAtMs.push(run.scheduler.nowMs());
      return cutBody([]);
    });

    await expect(settleOnFakeTime(run, run.install(releaseOf(archive)), 1_000)).rejects.toThrow(`no byte arrived for ${GIVE_UP_MS}ms across requests; the last failed: the connection was reset`);
    expect((askedAtMs.at(-1) ?? 0) - (askedAtMs[0] ?? 0)).toBeGreaterThanOrEqual(GIVE_UP_MS);
    const waits = askedAtMs.slice(1).map((atMs, index) => atMs - (askedAtMs[index] ?? 0));
    expect(waits.slice(0, 4)).toEqual([1_000, 10_000, 60_000, 60_000]);
    expect(versionsEntries()).toEqual([]);
  });

  test("a withdrawal while the transfer waits to ask again ends the wait at once", async () => {
    const archive = await buildArchive();
    const withdrawal = new AbortController();
    const run = harness(() => cutBody([]));

    const settled = run.install(releaseOf(archive), withdrawal.signal);
    await Bun.sleep(1);
    withdrawal.abort();

    expect(await settled).toEqual({ kind: "revoked" });
    expect(run.requests).toHaveLength(1);
    expect(versionsEntries()).toEqual([]);
  });

  test("an error after the last byte ends the transfer as complete, and the digest decides", async () => {
    const archive = await buildArchive();
    const run = harness((_url, _signal, range) => (
      range === undefined ? cutBody([archive]) : rejection(416)
    ));

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toHaveLength(1);
  });

  test("a link that drops on every request writes one interruption record and one count, not one record each", async () => {
    const archive = await buildArchive({ payload: [{ path: "large.bin", mode: 0o644, content: randomBytes(64 * 1024) }] });
    const step = Math.ceil(archive.byteLength / 10);
    const records: DebugLogRecordInput[] = [];
    await Log.init({ forward: (record) => { records.push(record); } });
    const run = harness((_url, _signal, range) => {
      const start = rangeFrom(range);
      const end = Math.min(start + step, archive.byteLength);
      return start === 0 ? cutBody([archive.subarray(0, end)]) : cutRangeOf(archive, start, end);
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(run.requests).toHaveLength(10);
    const interruptions = records.filter((record) => JSON.stringify(record).includes("update download interrupted"));
    expect(interruptions).toHaveLength(2);
    expect(JSON.stringify(interruptions[1])).toContain('"repeats":8');
  });

  test("a slow transfer that keeps delivering installs, however far past fifteen minutes it runs", async () => {
    const archive = await buildArchive({ payload: [{ path: "large.bin", mode: 0o644, content: randomBytes(64 * 1024) }] });
    const delivered = pieces(archive, 40);
    let answers = 0;
    const run = harness(() => {
      answers += 1;
      // Each piece arrives just inside the stall bound, so the attempt runs
      // about forty minutes of fake time on one connection.
      return bodyOf(delivered, async () => {
        run.scheduler.advance(STALL_MS - 1);
        await Promise.resolve();
      });
    });

    expect(await run.install(releaseOf(archive))).toEqual({ kind: "installed" });
    expect(answers).toBe(1);
    expect(run.scheduler.nowMs() - 10_000).toBeGreaterThan(15 * 60_000);
  });

  test("a caller that withdraws gets a revoked attempt, not a failure, and nothing is left staged", async () => {
    const archive = await buildArchive();
    const withdrawal = new AbortController();
    const run = harness((_url, signal) => stallingBody(signal));

    const settled = run.install(releaseOf(archive), withdrawal.signal);
    await Bun.sleep(1);
    withdrawal.abort();

    expect(await settled).toEqual({ kind: "revoked" });
    expect(versionsEntries()).toEqual([]);
    expect(existsSync(join(account.userDataRoot, "current"))).toBe(false);
  });
});
