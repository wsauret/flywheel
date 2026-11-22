/**
 * Release ownership of the Antigravity CLI (`agy`) that ships with Flywheel, as scripts/antigravity-engine-pin.json
 * pins it (scripts/antigravity-engine-asset.ts). The same two questions decide what a release owes it as for the
 * Claude engine (scripts/claude-engine-release.ts):
 *
 * 1. Freshness. The shared rule of scripts/engine-freshness.ts applies, with the hold in `HOLD_FILE`. Google's release
 *    manifest serves only its latest version and dates nothing, so the day on which a newer version superseded the pin
 *    comes from records: the tracked observation file `OBSERVED_FILE`, which `bun run engine:antigravity:pin --observe`
 *    writes and a person commits, and the `Last-Modified` header of the newer version's artifact. The earliest day that
 *    any record establishes is the supersession day, so a later newer version never moves it later. When a newer
 *    version is served and no record dates it, or the manifest does not answer, the question stays open (blocked).
 * 2. A bump. A release whose pin differs from the one its last release tag pinned ships a new agy. It must pass the
 *    fake-host tier under tests/integration/orchestration/modules/provider-google-antigravity on macOS, Linux, and
 *    Windows. No live tier exists yet.
 *
 * `bun run check:antigravity-engine` answers the first question. Ordinary development, startup, and unit tests never
 * reach Google: only this command, the observer, readiness, and the release script do.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ageDays, day, dayMs, exitWithVerdict, FRESHNESS_WINDOW_DAYS, holdVerdict, isRecord, parseHold, plural, readOptionalText, type EngineBump, type FreshnessVerdict, type HoldRule } from "./engine-freshness.js";
import { antigravityManifestUrl, parseAntigravityPin, parseReleaseManifest, PIN_FILE, type AntigravityPin } from "./antigravity-engine-asset.js";
import { compareSemanticVersions, parseSemanticVersion } from "./release-version.js";

/** The tracked file that holds a stale pin past the window, relative to the repository root. */
const HOLD_FILE = "scripts/antigravity-engine-hold.json";
const HOLD_RULE: HoldRule = { file: HOLD_FILE, versionKey: "version", bump: "bump the Antigravity CLI (bun run engine:antigravity:pin <version>) and qualify it" };
/** The tracked record of newer versions that the observer saw, relative to the repository root. */
const OBSERVED_FILE = "scripts/antigravity-engine-observed.json";
const OBSERVED_EXAMPLE = '{"pin": "<pinned version>", "firstSupersededOn": "YYYY-MM-DD" | null, "evidence": [{"version": "<newer version>", "seenOn": "YYYY-MM-DD", "lastModified": "YYYY-MM-DD" | null}]}';
/** Every target of one Google release has the same version, so one target's manifest answers for all of them. */
const FRESHNESS_TARGET = "linux-x64";
const OBSERVE_COMMAND = "bun run engine:antigravity:pin --observe";

/** Google's release source. The commands use `fetch`; tests give a fake source. */
export interface ReleaseSource {
  /** The text of the release manifest at `url`. */
  readonly manifest: (url: string) => Promise<string>;
  /** The `Last-Modified` header of the artifact at `url`, from a `HEAD` request, or undefined when it states none. */
  readonly lastModified: (url: string) => Promise<string | undefined>;
}

interface Evidence {
  readonly version: string;
  readonly seenOn: string;
  readonly lastModified: string | null;
}

interface Observation {
  readonly pin: string;
  readonly firstSupersededOn: string | null;
  readonly evidence: readonly Evidence[];
}

const optionalDay = (value: unknown) => value === null || !Number.isNaN(dayMs(value));

/** The observation in `text`, none for no file, or an error that states the shape. */
function parseObservation(text: string | undefined): Observation | undefined | Error {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const evidence = isRecord(value) && Array.isArray(value["evidence"]) ? value["evidence"] : undefined;
  const entries = evidence?.flatMap((entry: unknown) => isRecord(entry) && typeof entry["version"] === "string" && !Number.isNaN(dayMs(entry["seenOn"])) && optionalDay(entry["lastModified"])
    ? [{ version: entry["version"], seenOn: String(entry["seenOn"]), lastModified: entry["lastModified"] === null ? null : String(entry["lastModified"]) }]
    : []);
  if (!isRecord(value) || typeof value["pin"] !== "string" || !optionalDay(value["firstSupersededOn"]) || evidence === undefined || entries === undefined || entries.length !== evidence.length) {
    return new Error(`${OBSERVED_FILE} is not an observation: run ${OBSERVE_COMMAND}, or write ${OBSERVED_EXAMPLE}`);
  }
  return { pin: value["pin"], firstSupersededOn: value["firstSupersededOn"] === null ? null : String(value["firstSupersededOn"]), evidence: entries };
}

/** Whether `version` is newer than `pin`. A version that is not a release version is never newer. */
function isNewer(version: string, pin: string): boolean {
  const candidate = parseSemanticVersion(version);
  const pinned = parseSemanticVersion(pin);
  return candidate !== undefined && pinned !== undefined && compareSemanticVersions(candidate, pinned) > 0;
}

/** The days on which `observation` saw a version newer than `pin` superseded it, up to the day of `nowMs`: none when
 *  it records another pin. A day that has not begun is no evidence of a supersession. */
function supersessionDays(observation: Observation | undefined, pin: string, nowMs: number): number[] {
  if (observation === undefined || observation.pin !== pin) return [];
  const newer = observation.evidence.filter(({ version }) => isNewer(version, pin));
  return [observation.firstSupersededOn, ...newer.flatMap(({ seenOn, lastModified }) => [seenOn, lastModified])]
    .flatMap((text) => text === null ? [] : [dayMs(text)])
    .filter((ms) => ms <= nowMs);
}

/** The UTC day of the `Last-Modified` header of the artifact at `url`, or the reason why it dates nothing: the HEAD
 *  request failed, the header is missing or names no date, or the day has not begun by `nowMs`. */
async function artifactDay(source: ReleaseSource, url: string, nowMs: number): Promise<{ readonly ms: number } | { readonly problem: string }> {
  let header: string | undefined;
  try {
    header = await source.lastModified(url);
  } catch (error) {
    return { problem: `its HEAD request failed: ${message(error)}` };
  }
  const ms = header === undefined ? Number.NaN : Date.parse(header);
  if (Number.isNaN(ms)) return { problem: "it states no Last-Modified" };
  const modified = dayMs(day(ms));
  return modified <= nowMs ? { ms: modified } : { problem: `its Last-Modified ${day(modified)} is in the future` };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The manifest of `FRESHNESS_TARGET` that `source` serves for `pin`. Throws when it does not answer. */
async function servedManifest(pin: AntigravityPin, source: ReleaseSource) {
  const target = pin.targets.get(FRESHNESS_TARGET);
  if (target === undefined) throw new Error(`${PIN_FILE} names no artifact for ${FRESHNESS_TARGET}`);
  const url = antigravityManifestUrl(target.manifestTarget);
  let text: string;
  try {
    text = await source.manifest(url);
  } catch (error) {
    throw new Error(`Google's release manifest ${url} did not answer: ${message(error)}`, { cause: error });
  }
  const manifest = parseReleaseManifest(url, JSON.parse(text));
  // A version that does not order against the pin would read as no newer release, so it answers nothing.
  if (parseSemanticVersion(manifest.version)?.canonical !== manifest.version) throw new Error(`${url} serves ${JSON.stringify(manifest.version)}, which is not a release version`);
  return manifest;
}

/** Whether the Antigravity CLI that `pinText` pins is fresh enough to release, from Google's release manifest, the
 *  committed observation, and the newer artifact's `Last-Modified`. */
export async function antigravityEngineFreshness(input: { readonly pinText: string; readonly observedText: string | undefined; readonly holdText: string | undefined; readonly nowMs: number; readonly source: ReleaseSource }): Promise<FreshnessVerdict> {
  const pin = parseAntigravityPin(input.pinText);
  const hold = parseHold(input.holdText, HOLD_RULE);
  if (hold instanceof Error) return { status: "fail", lines: [hold.message] };
  const observation = parseObservation(input.observedText);
  if (observation instanceof Error) return { status: "fail", lines: [observation.message] };
  let served: Awaited<ReturnType<typeof servedManifest>>;
  try {
    served = await servedManifest(pin, input.source);
  } catch (error) {
    return { status: "blocked", lines: [message(error)] };
  }
  const lines = [`Antigravity CLI ${pin.version} (build ${pin.build}) pinned; Google serves ${served.version}`];
  if (!isNewer(served.version, pin.version)) return holdVerdict({ pin: pin.version, hold, supersededDays: 0, nowMs: input.nowMs, lines, rule: HOLD_RULE });
  const artifact = await artifactDay(input.source, served.url, input.nowMs);
  const days = [...supersessionDays(observation, pin.version, input.nowMs), ...("ms" in artifact ? [artifact.ms] : [])];
  if ("problem" in artifact && days.length === 0) {
    return { status: "blocked", lines: [...lines, `no record dates when ${served.version} or an earlier newer version superseded the pin: ${OBSERVED_FILE} records no past day for ${pin.version}, and the artifact ${served.url} dates nothing because ${artifact.problem}; run ${OBSERVE_COMMAND} and commit ${OBSERVED_FILE}, or bump the pin`] };
  }
  const supersededMs = Math.min(...days);
  const supersededDays = ageDays(supersededMs, input.nowMs);
  lines.push(`a newer version superseded ${pin.version} on ${day(supersededMs)}, ${plural(supersededDays, "day")} ago, and readiness fails after ${FRESHNESS_WINDOW_DAYS}`);
  return holdVerdict({ pin: pin.version, hold, supersededDays, nowMs: input.nowMs, lines, rule: HOLD_RULE });
}

/** The observation file after one look at what Google serves, and the lines that report it. An observation of an
 *  earlier pin is replaced. A version newer than the pin is recorded once, with the day it was first seen, and its
 *  artifact's `Last-Modified` day when one has begun: a sighting is evidence also when HEAD fails, and a later look
 *  dates an undated sighting or moves its date earlier, never later. `firstSupersededOn` keeps the earliest past day
 *  that any record of the pin states. */
export async function recordAntigravityObservation(input: { readonly pinText: string; readonly observedText: string | undefined; readonly nowMs: number; readonly source: ReleaseSource }): Promise<{ readonly text: string; readonly lines: readonly string[] }> {
  const pin = parseAntigravityPin(input.pinText);
  const previous = parseObservation(input.observedText);
  if (previous instanceof Error) throw previous;
  const kept = previous?.pin === pin.version ? previous : { pin: pin.version, firstSupersededOn: null, evidence: [] };
  const served = await servedManifest(pin, input.source);
  let evidence = kept.evidence;
  const lines = [`Google serves the Antigravity CLI ${served.version}; the pin is ${pin.version}`];
  if (isNewer(served.version, pin.version)) {
    const artifact = await artifactDay(input.source, served.url, input.nowMs);
    const modified = "ms" in artifact ? day(artifact.ms) : null;
    const earlier = kept.evidence.find(({ version }) => version === served.version);
    if (earlier === undefined) {
      evidence = [...kept.evidence, { version: served.version, seenOn: day(input.nowMs), lastModified: modified }];
      lines.push(`recorded ${served.version}, first seen ${day(input.nowMs)}${"ms" in artifact ? `, last modified ${modified}` : `, undated because ${artifact.problem}`}`);
    } else if (modified !== null && (earlier.lastModified === null || modified < earlier.lastModified)) {
      evidence = kept.evidence.map((entry) => entry === earlier ? { ...entry, lastModified: modified } : entry);
      lines.push(`dated ${served.version}, first seen ${earlier.seenOn}: last modified ${modified}`);
    }
  }
  const days = supersessionDays({ ...kept, evidence }, pin.version, input.nowMs);
  const observation: Observation = { pin: pin.version, firstSupersededOn: days.length === 0 ? null : day(Math.min(...days)), evidence };
  return { text: `${JSON.stringify(observation, null, 2)}\n`, lines };
}

/** Whether the Antigravity CLI that `pinText` pins is new since the last release tag, whose pin `released` holds. A
 *  tag from before the pin existed has none, so every pin is new to it. Two pins of one version with another build
 *  are two artifacts, so the build decides. */
export function antigravityEngineBump(pinText: string, released: { readonly tag: string; readonly pinText: string | undefined } | undefined): EngineBump {
  const pin = parseAntigravityPin(pinText);
  if (released === undefined) return { bumped: true, detail: `no release tag precedes the Antigravity CLI ${pin.version}` };
  if (released.pinText === undefined) return { bumped: true, detail: `${released.tag} shipped no Antigravity CLI; this release adds ${pin.version}` };
  const shipped = parseAntigravityPin(released.pinText);
  return shipped.build === pin.build
    ? { bumped: false, detail: `${released.tag} already shipped the Antigravity CLI ${pin.version}` }
    : { bumped: true, detail: `the Antigravity CLI ${shipped.build} in ${released.tag} is now ${pin.build}` };
}

const liveSource: ReleaseSource = {
  manifest: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  },
  lastModified: async (url) => {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.headers.get("last-modified") ?? undefined;
  },
};

/** Records what Google serves now in the observation file of the checkout at `root`, for a person to commit, and
 *  returns the lines that report it. Throws when Google does not answer. */
export async function observeAntigravityRelease(root: string): Promise<readonly string[]> {
  const { text, lines } = await recordAntigravityObservation({
    pinText: await readFile(join(root, PIN_FILE), "utf8"), observedText: readOptionalText(join(root, OBSERVED_FILE)), nowMs: Date.now(), source: liveSource,
  });
  await writeFile(join(root, OBSERVED_FILE), text);
  return [...lines, `wrote ${OBSERVED_FILE}; commit it`];
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  exitWithVerdict("antigravity engine", await antigravityEngineFreshness({
    pinText: await readFile(join(root, PIN_FILE), "utf8"), observedText: readOptionalText(join(root, OBSERVED_FILE)), holdText: readOptionalText(join(root, HOLD_FILE)), nowMs: Date.now(), source: liveSource,
  }));
}
