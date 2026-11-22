import { describe, expect, test } from "bun:test";
import { antigravityEngineBump, antigravityEngineFreshness, recordAntigravityObservation, type ReleaseSource } from "../../../scripts/antigravity-engine-release.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-20T12:00:00Z");
const MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json";
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString().slice(0, 10);
const artifact = (version: string) => `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1/linux-x64/cli_linux_x64.tar.gz`;

/** A pin of `version` with the one target that the gate reads. */
const pin = (version: string, build = `${version}-1`) => JSON.stringify({
  version, build,
  targets: { "linux-x64": { manifestTarget: "linux_amd64", url: artifact(version), sha512: "a".repeat(128), archive: "tar.gz", member: "antigravity", size: 1, sha256: "b".repeat(64) } },
});

/** Google serving `version`, whose artifact states `lastModified` (an HTTP date) or nothing. Each request is kept. */
function google(version: string, lastModified?: string): ReleaseSource & { readonly requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    manifest: async (url) => {
      requests.push(`GET ${url}`);
      expect(url).toBe(MANIFEST);
      return JSON.stringify({ version, url: artifact(version), sha512: "c".repeat(128) });
    },
    lastModified: async (url) => {
      requests.push(`HEAD ${url}`);
      return lastModified;
    },
  };
}

const observed = (pinned: string, firstSupersededOn: string | null, evidence: readonly { readonly version: string; readonly seenOn: string; readonly lastModified: string | null }[] = []) => JSON.stringify({ pin: pinned, firstSupersededOn, evidence });
const hold = (version: string, recordedOn: string) => JSON.stringify({ version, recordedOn, reason: "1.5.15 drops the PreInvocation hook." });
const check = (source: ReleaseSource, input: { readonly observedText?: string; readonly holdText?: string } = {}) =>
  antigravityEngineFreshness({ pinText: pin("1.5.14"), observedText: input.observedText, holdText: input.holdText, nowMs: NOW, source });
const httpDate = (days: number) => new Date(NOW - days * DAY_MS).toUTCString();

describe("the Antigravity CLI pin's freshness", () => {
  test("a pin that Google still serves passes and requests no artifact date", async () => {
    const source = google("1.5.14");
    expect(await check(source)).toEqual({ status: "pass", lines: ["Antigravity CLI 1.5.14 (build 1.5.14-1) pinned; Google serves 1.5.14"] });
    expect(source.requests).toEqual([`GET ${MANIFEST}`]);
  });

  test("a newer version first superseded the pin 22 days ago fails, naming both versions and the date", async () => {
    const verdict = await check(google("1.5.15"), { observedText: observed("1.5.14", daysAgo(22), [{ version: "1.5.15", seenOn: daysAgo(22), lastModified: null }]) });
    expect(verdict).toEqual({ status: "fail", lines: [
      "Antigravity CLI 1.5.14 (build 1.5.14-1) pinned; Google serves 1.5.15",
      `a newer version superseded 1.5.14 on ${daysAgo(22)}, 22 days ago, and readiness fails after 21`,
      'stale: bump the Antigravity CLI (bun run engine:antigravity:pin <version>) and qualify it, or record a dated reason in scripts/antigravity-engine-hold.json as {"version": "<pinned version>", "recordedOn": "YYYY-MM-DD", "reason": "<why>"}',
    ] });
  });

  test("a later newer version does not move the supersession date later", async () => {
    const record = observed("1.5.14", daysAgo(22), [{ version: "1.5.15", seenOn: daysAgo(22), lastModified: null }]);
    const verdict = await check(google("1.5.16", httpDate(2)), { observedText: record });
    expect(verdict.status).toBe("fail");
    expect(verdict.lines[1]).toBe(`a newer version superseded 1.5.14 on ${daysAgo(22)}, 22 days ago, and readiness fails after 21`);
  });

  test("the newer artifact's Last-Modified alone dates the supersession", async () => {
    const within = await check(google("1.5.15", httpDate(21)));
    expect(within.status).toBe("pass");
    expect(within.lines[1]).toBe(`a newer version superseded 1.5.14 on ${daysAgo(21)}, 21 days ago, and readiness fails after 21`);
    expect((await check(google("1.5.15", httpDate(23)))).status).toBe("fail");
  });

  test("a hold for the pinned version, recorded within 21 days, passes a stale pin and names its reason", async () => {
    const record = observed("1.5.14", daysAgo(22));
    const held = await check(google("1.5.15"), { observedText: record, holdText: hold("1.5.14", daysAgo(5)) });
    expect(held.status).toBe("pass");
    expect(held.lines.at(-1)).toBe(`held since ${daysAgo(5)} until ${daysAgo(-16)}: 1.5.15 drops the PreInvocation hook.`);
    expect((await check(google("1.5.15"), { observedText: record, holdText: hold("1.5.13", daysAgo(5)) })).lines.at(-1)).toBe("scripts/antigravity-engine-hold.json holds 1.5.13, not the pinned 1.5.14; remove it");
  });

  test("a newer version that no record dates leaves the question open, also when the record names an earlier pin", async () => {
    const undated = await check(google("1.5.15"));
    expect(undated.status).toBe("blocked");
    expect(undated.lines.at(-1)).toBe(`no record dates when 1.5.15 or an earlier newer version superseded the pin: scripts/antigravity-engine-observed.json records no past day for 1.5.14, and the artifact ${artifact("1.5.15")} dates nothing because it states no Last-Modified; run bun run engine:antigravity:pin --observe and commit scripts/antigravity-engine-observed.json, or bump the pin`);
    expect((await check(google("1.5.15"), { observedText: observed("1.5.13", daysAgo(40)) })).status).toBe("blocked");
  });

  test("a manifest that does not answer leaves the question open", async () => {
    const unreachable = await check({ manifest: async () => { throw new Error("getaddrinfo ENOTFOUND antigravity-cli-auto-updater"); }, lastModified: async () => undefined });
    expect(unreachable).toEqual({ status: "blocked", lines: [`Google's release manifest ${MANIFEST} did not answer: getaddrinfo ENOTFOUND antigravity-cli-auto-updater`] });
  });

  test("a served version that does not order against the pin leaves the question open", async () => {
    for (const served of ["", "unknown", "latest", "2.0"]) {
      expect(await check(google(served))).toEqual({ status: "blocked", lines: [`${MANIFEST} serves ${JSON.stringify(served)}, which is not a release version`] });
    }
  });

  test("a day that has not begun dates nothing, from the artifact or from the observation", async () => {
    const future = await check(google("1.5.15", httpDate(-3)));
    expect(future.status).toBe("blocked");
    expect(future.lines.at(-1)).toContain(`dates nothing because its Last-Modified ${daysAgo(-3)} is in the future`);
    const record = observed("1.5.14", daysAgo(-39), [{ version: "1.5.15", seenOn: daysAgo(-39), lastModified: daysAgo(-39) }]);
    expect((await check(google("1.5.15"), { observedText: record })).status).toBe("blocked");
    expect((await check(google("1.5.15", httpDate(23)), { observedText: record })).status).toBe("fail");
  });

  test("a malformed observation fails and states the shape", async () => {
    const verdict = await check(google("1.5.14"), { observedText: JSON.stringify({ pin: "1.5.14", evidence: [{ version: "1.5.15" }] }) });
    expect(verdict).toEqual({ status: "fail", lines: [expect.stringContaining("scripts/antigravity-engine-observed.json is not an observation: run bun run engine:antigravity:pin --observe")] });
  });
});

describe("the observer", () => {
  const observe = (source: ReleaseSource, observedText: string | undefined, nowMs = NOW) => recordAntigravityObservation({ pinText: pin("1.5.14"), observedText, nowMs, source });

  test("records a newer version once, keeps its first sighting, and keeps the earliest date when a later version appears", async () => {
    const first = await observe(google("1.5.15", httpDate(3)), undefined);
    expect(JSON.parse(first.text)).toEqual({ pin: "1.5.14", firstSupersededOn: daysAgo(3), evidence: [{ version: "1.5.15", seenOn: daysAgo(0), lastModified: daysAgo(3) }] });
    const again = await observe(google("1.5.15", httpDate(3)), first.text, NOW + 4 * DAY_MS);
    expect(again.text).toBe(first.text);
    const later = await observe(google("1.5.16", httpDate(-1)), first.text, NOW + 2 * DAY_MS);
    expect(JSON.parse(later.text)).toMatchObject({ firstSupersededOn: daysAgo(3), evidence: [{ version: "1.5.15" }, { version: "1.5.16", seenOn: daysAgo(-2), lastModified: daysAgo(-1) }] });
  });

  test("records a sighting when HEAD fails or states a future day, and dates it earlier when a later look can", async () => {
    const headFails: ReleaseSource = { manifest: google("1.5.15").manifest, lastModified: async () => { throw new Error("socket hang up"); } };
    const undated = await observe(headFails, undefined);
    expect(JSON.parse(undated.text)).toEqual({ pin: "1.5.14", firstSupersededOn: daysAgo(0), evidence: [{ version: "1.5.15", seenOn: daysAgo(0), lastModified: null }] });
    expect(undated.lines.at(-1)).toBe(`recorded 1.5.15, first seen ${daysAgo(0)}, undated because its HEAD request failed: socket hang up`);
    expect(JSON.parse((await observe(google("1.5.15", httpDate(-5)), undefined)).text).evidence[0].lastModified).toBeNull();

    const dated = await observe(google("1.5.15", httpDate(10)), undated.text, NOW + 4 * DAY_MS);
    expect(JSON.parse(dated.text)).toEqual({ pin: "1.5.14", firstSupersededOn: daysAgo(10), evidence: [{ version: "1.5.15", seenOn: daysAgo(0), lastModified: daysAgo(10) }] });
    expect((await observe(google("1.5.15", httpDate(1)), dated.text, NOW + 4 * DAY_MS)).text).toBe(dated.text);
  });

  test("refuses a served version that does not order against the pin, and writes nothing", async () => {
    await expect(observe(google("unknown"), undefined)).rejects.toThrow(`${MANIFEST} serves "unknown", which is not a release version`);
  });

  test("replaces the observation of an earlier pin and records nothing while Google serves the pin", async () => {
    const result = await observe(google("1.5.14"), observed("1.5.13", daysAgo(40), [{ version: "1.5.14", seenOn: daysAgo(40), lastModified: null }]));
    expect(JSON.parse(result.text)).toEqual({ pin: "1.5.14", firstSupersededOn: null, evidence: [] });
    expect(result.lines).toEqual(["Google serves the Antigravity CLI 1.5.14; the pin is 1.5.14"]);
  });
});

describe("an Antigravity CLI bump", () => {
  test("is a pinned build that differs from the last release tag's, a pin that release did not have, or any pin before a first release", () => {
    expect(antigravityEngineBump(pin("1.5.15"), { tag: "v0.0.12", pinText: pin("1.5.14") })).toEqual({ bumped: true, detail: "the Antigravity CLI 1.5.14-1 in v0.0.12 is now 1.5.15-1" });
    expect(antigravityEngineBump(pin("1.5.14", "1.5.14-2"), { tag: "v0.0.12", pinText: pin("1.5.14") }).bumped).toBe(true);
    expect(antigravityEngineBump(pin("1.5.14"), { tag: "v0.0.12", pinText: pin("1.5.14") })).toEqual({ bumped: false, detail: "v0.0.12 already shipped the Antigravity CLI 1.5.14" });
    expect(antigravityEngineBump(pin("1.5.14"), { tag: "v0.0.12", pinText: undefined })).toEqual({ bumped: true, detail: "v0.0.12 shipped no Antigravity CLI; this release adds 1.5.14" });
    expect(antigravityEngineBump(pin("1.5.14"), undefined)).toEqual({ bumped: true, detail: "no release tag precedes the Antigravity CLI 1.5.14" });
  });
});
