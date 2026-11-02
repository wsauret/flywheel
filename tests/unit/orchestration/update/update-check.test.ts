import { describe, expect, test } from "bun:test";
import { checkForUpdate, releaseManifestUrl, UPDATE_METADATA_STALL_MS, type UpdateScheduler } from "../../../../src/orchestration/update/update-check.js";
import { parseRepositoryIdentity } from "../../../../src/infra/update/release-manifest.js";
import { parseReleaseVersion, type ReleaseVersion } from "../../../../src/infra/update/version-order.js";
import { fakeFetch } from "../../../helpers/fake-fetch.js";

const REPOSITORY = parseRepositoryIdentity("acme/flywheel");
const ASSET = "flywheel-darwin-arm64.tar.gz";
const SHA256 = "a".repeat(64);

function version(canonical: string): ReleaseVersion {
  const parsed = parseReleaseVersion(canonical);
  if (!parsed) throw new Error(`${canonical} is not a release version`);
  return parsed;
}

interface ManifestOverrides {
  readonly [key: string]: unknown;
}

function manifest(released: string, overrides: ManifestOverrides = {}): string {
  return JSON.stringify({
    version: released,
    assets: [{
      name: ASSET,
      url: `https://github.com/acme/flywheel/releases/download/v${released}/${ASSET}`,
      size: 1024,
      sha256: SHA256,
    }],
    ...overrides,
  });
}

interface PendingTimer {
  readonly fire: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function testScheduler() {
  const timers: PendingTimer[] = [];
  const scheduler: UpdateScheduler = {
      nowMs: () => 1_000,
      setTimer: (fire, delayMs) => {
        const timer: PendingTimer = { fire, delayMs, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
  };
  return {
    timers,
    scheduler,
    fireAll: () => {
      for (const timer of timers) if (!timer.cancelled) timer.fire();
    },
  };
}

/** A scheduler on fake time: `advance` moves the clock and fires every
 *  live timer whose delay has passed. */
function fakeClock() {
  let now = 0;
  const timers: { readonly fire: () => void; readonly atMs: number; cancelled: boolean }[] = [];
  const scheduler: UpdateScheduler = {
    nowMs: () => now,
    setTimer: (fire, delayMs) => {
      const timer = { fire, atMs: now + delayMs, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  return {
    scheduler,
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers) {
        if (timer.cancelled || timer.atMs > now) continue;
        timer.cancelled = true;
        timer.fire();
      }
    },
  };
}

function respondWith(body: string, init: ResponseInit = {}): typeof globalThis.fetch {
  return fakeFetch(async () => new Response(body, { status: 200, ...init }));
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** A publisher that answers every request with `answer`, and remembers what it
 *  was asked for. */
function recordingFetch(answer: (url: string) => Response) {
  const requested: string[] = [];
  const fetch = fakeFetch(async (input) => {
    const url = String(input);
    requested.push(url);
    return answer(url);
  });
  return { fetch, requested };
}

async function check(fetch: typeof globalThis.fetch, currentVersion = "1.2.3", scheduler = testScheduler().scheduler) {
  return checkForUpdate({ repository: REPOSITORY, assetName: ASSET, currentVersion: version(currentVersion), fetch, scheduler });
}

describe("update metadata check", () => {
  test("reports the release as a candidate when the publisher is ahead of this build", async () => {
    const result = await check(respondWith(manifest("1.3.0")));

    expect(result.kind).toBe("candidate");
    if (result.kind !== "candidate") throw new Error("expected a candidate");
    expect(result.release.version.canonical).toBe("1.3.0");
    expect(result.release.asset).toEqual({ name: ASSET, url: `https://github.com/acme/flywheel/releases/download/v1.3.0/${ASSET}`, sizeBytes: 1024, sha256: SHA256 });
  });

  test("reports current for an equal or older published release", async () => {
    expect(await check(respondWith(manifest("1.2.3")))).toEqual({ kind: "current" });
    expect(await check(respondWith(manifest("1.2.2")))).toEqual({ kind: "current" });
  });

  test("asks the configured repository's own release channel", async () => {
    const requested: string[] = [];
    const fetch = fakeFetch(async (input) => {
      requested.push(String(input));
      return new Response(manifest("1.3.0"));
    });

    await check(fetch);

    expect(requested).toEqual([releaseManifestUrl(REPOSITORY)]);
    expect(requested[0]).toBe("https://github.com/acme/flywheel/releases/latest/download/release.json");
  });

  test("asks for one named release when the caller names it, and refuses a manifest of another", async () => {
    const { fetch, requested } = recordingFetch(() => new Response(manifest("1.4.0")));
    const result = await checkForUpdate({ repository: REPOSITORY, assetName: ASSET, currentVersion: version("1.2.3"), release: "1.4.0", fetch, scheduler: testScheduler().scheduler });
    expect(requested).toEqual(["https://github.com/acme/flywheel/releases/download/v1.4.0/release.json"]);
    expect(result.kind === "candidate" ? result.release.version.canonical : result.kind).toBe("1.4.0");
    const other = await checkForUpdate({ repository: REPOSITORY, assetName: ASSET, currentVersion: version("1.2.3"), release: "1.3.0", fetch, scheduler: testScheduler().scheduler });
    expect(other).toEqual({ kind: "unavailable", reason: "the manifest of release 1.3.0 states release 1.4.0" });
  });

  test("a malformed manifest is unavailable, not a candidate", async () => {
    const notJson = await check(respondWith("<html>rate limited</html>"));
    const missingVersion = await check(respondWith(JSON.stringify({ assets: [] })));

    expect(notJson.kind).toBe("unavailable");
    expect(missingVersion.kind).toBe("unavailable");
  });

  test("a platform the release publishes no archive for is unavailable", async () => {
    const result = await checkForUpdate({
      repository: REPOSITORY,
      assetName: "flywheel-sunos-sparc.tar.gz",
      currentVersion: version("1.2.3"),
      fetch: respondWith(manifest("1.3.0")),
      scheduler: testScheduler().scheduler,
    });

    expect(result.kind).toBe("unavailable");
  });

  test("a release past every bound an earlier client set is a candidate", async () => {
    // A manifest over v0.1.0's 64 KiB, an asset over its 512 MiB on another
    // host, a prerelease version, and fields it never knew.
    const raw = JSON.stringify({
      version: "2.0.0-rc.1",
      padding: "x".repeat(1024 * 1024),
      assets: [{ name: ASSET, url: "https://cdn.example.org/flywheel.tgz", size: 600 * 1024 * 1024, sha256: SHA256, signature: "reserved" }],
    });

    const result = await check(respondWith(raw));

    expect(result.kind).toBe("candidate");
    if (result.kind !== "candidate") throw new Error("expected a candidate");
    expect(result.release.version.canonical).toBe("2.0.0-rc.1");
    expect(result.release.asset).toEqual({ name: ASSET, url: "https://cdn.example.org/flywheel.tgz", sizeBytes: 600 * 1024 * 1024, sha256: SHA256 });
  });

  test("a version this build cannot order is a candidate, because the channel only moves forward", async () => {
    expect((await check(respondWith(manifest("2027.1")))).kind).toBe("candidate");
  });

  test("an HTTP failure is unavailable and names the status", async () => {
    const result = await check(respondWith("", { status: 503 }));

    expect(result).toEqual({ kind: "unavailable", reason: "the release metadata request answered 503" });
  });

  test("a request that never answers is bounded by the stall timer of the injected scheduler", async () => {
    const { scheduler, timers, fireAll } = testScheduler();
    const fetch = fakeFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new Error("The operation was aborted.")); });
    }));

    const pending = check(fetch, "1.2.3", scheduler);
    expect(timers.map((timer) => timer.delayMs)).toEqual([UPDATE_METADATA_STALL_MS]);
    fireAll();

    expect(await pending).toEqual({ kind: "unavailable", reason: `the release metadata delivered nothing for ${UPDATE_METADATA_STALL_MS}ms` });
  });

  test("a manifest that keeps delivering is read to its end however long it takes", async () => {
    const clock = fakeClock();
    const text = manifest("1.3.0");
    let sent = 0;
    // Each byte arrives just inside the stall bound of the byte before it, so
    // the whole transfer takes many times one bound of fake time.
    const fetch = fakeFetch(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === text.length) {
          controller.close();
          return;
        }
        clock.advance(UPDATE_METADATA_STALL_MS - 1);
        controller.enqueue(new TextEncoder().encode(text.slice(sent, sent + 1)));
        sent += 1;
      },
    })));

    const result = await check(fetch, "1.2.3", clock.scheduler);

    expect(result.kind).toBe("candidate");
    expect(clock.nowMs()).toBeGreaterThan(UPDATE_METADATA_STALL_MS * 100);
  });

  test("the caller's cancellation ends the check", async () => {
    const controller = new AbortController();
    const fetch = fakeFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new Error("The operation was aborted.")); });
    }));

    const pending = checkForUpdate({ repository: REPOSITORY, assetName: ASSET, currentVersion: version("1.2.3"), fetch, scheduler: testScheduler().scheduler, signal: controller.signal });
    controller.abort();

    expect((await pending).kind).toBe("unavailable");
  });
});

describe("the redirects a metadata request follows", () => {
  const MANIFEST_URL = releaseManifestUrl(REPOSITORY);
  const TAGGED = "https://github.com/acme/flywheel/releases/download/v1.3.0/release.json";
  const MIRROR = "https://release-mirror.example.net/release.json?token=1";

  test("a chain of HTTPS hops to any host is followed, and the manifest is read from its end", async () => {
    const publisher = recordingFetch((url) => {
      if (url === MANIFEST_URL) return redirectTo(TAGGED);
      if (url === TAGGED) return redirectTo(MIRROR);
      return new Response(manifest("1.3.0"));
    });

    expect((await check(publisher.fetch)).kind).toBe("candidate");
    expect(publisher.requested).toEqual([MANIFEST_URL, TAGGED, MIRROR]);
  });

  test("each hop that answers restarts the stall bound, so a slow chain is not a stalled one", async () => {
    const clock = fakeClock();
    // Every hop answers just inside one bound, so the whole chain takes
    // nearly three bounds of fake time before the first byte of the body.
    const fetch = fakeFetch(async (input, init) => {
      clock.advance(UPDATE_METADATA_STALL_MS - 1);
      if (init?.signal?.aborted === true) throw new Error("The operation was aborted.");
      const url = String(input);
      if (url === MANIFEST_URL) return redirectTo(TAGGED);
      if (url === TAGGED) return redirectTo(MIRROR);
      return new Response(manifest("1.3.0"));
    });

    expect((await check(fetch, "1.2.3", clock.scheduler)).kind).toBe("candidate");
    expect(clock.nowMs()).toBeGreaterThan(UPDATE_METADATA_STALL_MS * 2);
  });

  test("a hop to plain HTTP is unavailable, and is never requested", async () => {
    const publisher = recordingFetch((url) => (url === MANIFEST_URL ? redirectTo("http://objects.githubusercontent.com/release.json") : new Response(manifest("1.3.0"))));

    expect((await check(publisher.fetch)).kind).toBe("unavailable");
    expect(publisher.requested).toEqual([MANIFEST_URL]);
  });

  test("a redirect that names no target is unavailable", async () => {
    const publisher = recordingFetch(() => new Response(null, { status: 302 }));

    expect((await check(publisher.fetch)).kind).toBe("unavailable");
    expect(publisher.requested).toEqual([MANIFEST_URL]);
  });
});
