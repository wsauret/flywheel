/**
 * Release ownership of the Claude engine that ships with Flywheel: the platform binary of the pinned
 * `@anthropic-ai/claude-agent-sdk` (scripts/claude-engine-asset.ts).
 *
 * Two questions decide what a release owes the engine:
 *
 * 1. Freshness. The SDK and its engine release about once a day, and every engine changes what Claude requests
 *    send. A release must not ship an engine that newer releases superseded more than `FRESHNESS_WINDOW_DAYS` ago,
 *    unless a tracked hold (`HOLD_FILE`) states why, with the date it was recorded. A hold names the pinned SDK
 *    version and lasts one window, so a bump or the passing of time ends it.
 * 2. A bump. A release whose pinned SDK differs from the one its last release tag pinned ships a new engine. It must
 *    pass both qualification tiers on macOS, Linux, and Windows: the fake-host tier under
 *    tests/integration/orchestration/modules/provider-claude-agent-sdk and the live tier under
 *    tests/integration/providers, which runs on the Claude logins of the auth profile that `LIVE_AUTH_PROFILE_SETTING`
 *    names: the production provider walk chooses the login that serves each request.
 *
 * `bun run check:claude-engine` answers the first question from the npm registry. Ordinary development, startup, and
 * unit tests never reach the registry: only this command, readiness, and the release script run it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalAccount } from "../src/infra/llm/access-provider.js";
import { authDir } from "../src/infra/paths.js";
import { compareSemanticVersions, parseSemanticVersion, type SemanticVersion } from "./release-version.js";
import { AuthProfileManager } from "../src/orchestration/auth/auth-profile-manager.js";
import { profileClaudeAccounts } from "../src/orchestration/modules/provider-claude-agent-sdk/cli-login.js";
import { lockedPackageIn, lockHasPackage, REGISTRY, SDK_PACKAGE } from "./claude-engine-asset.js";

/** How long newer releases may supersede the pin before readiness fails. The SDK releases about daily, so a count of
 *  releases would fail within a week, and every bump costs a qualification pass on three hosts. Three weeks lets a
 *  bump wait for a convenient pass, and keeps the shipped engine within three weeks of the newest SDK release. */
export const FRESHNESS_WINDOW_DAYS = 21;
/** The tracked file that holds a stale pin past the window, relative to the repository root. */
export const HOLD_FILE = "scripts/claude-engine-hold.json";
/** The variable that names the auth profile whose accounts the live provider tests run on, on every host. The live
 *  Claude engine tier is one of those tests, so its release logins are logins of that profile. */
export const LIVE_AUTH_PROFILE_SETTING = "FLYWHEEL_LIVE_AUTH_PROFILE";
/** Why a live run cannot start when `LIVE_AUTH_PROFILE_SETTING` is unset. */
export const LIVE_AUTH_PROFILE_UNSET = `${LIVE_AUTH_PROFILE_SETTING} is unset: set it to the auth profile whose accounts the live provider tests and the live Claude engine tier run on`;

/** The auth profile that `LIVE_AUTH_PROFILE_SETTING` names in `env`, or undefined when it is unset or empty. A live
 *  run never chooses a profile of its own. */
export function liveAuthProfile(env: NodeJS.ProcessEnv): string | undefined {
  return env[LIVE_AUTH_PROFILE_SETTING] || undefined;
}

/** The Claude logins of the auth profile that `profile` selects, read without changing the auth store. The profile is
 *  resolved as `FLYWHEEL_AUTH_PROFILE` resolves it, by id or by display name, because a renamed profile keeps the
 *  directory of its original id. */
export function liveClaudeAccounts(userDataRoot: string, projectRoot: string, profile: string): readonly ExternalAccount[] {
  const { id } = new AuthProfileManager({ userDataRoot, projectRoot, env: { FLYWHEEL_AUTH_PROFILE: profile } }).inspect();
  return profileClaudeAccounts(authDir(userDataRoot, id));
}

const DAY_MS = 86_400_000;
const HOLD_EXAMPLE = '{"sdkVersion": "<pinned version>", "recordedOn": "YYYY-MM-DD", "reason": "<why>"}';

/** Fetches the text of one registry document. The command uses `fetch`; tests give a fake registry. */
export type RegistryFetch = (url: string) => Promise<string>;

/** `pass` and `fail` decide readiness; `blocked` means the registry could not answer the question. */
export interface FreshnessVerdict {
  readonly status: "pass" | "fail" | "blocked";
  readonly lines: readonly string[];
}

interface Hold {
  readonly sdkVersion: string;
  readonly recordedOnMs: number;
  readonly recordedOn: string;
  readonly reason: string;
}

interface Release {
  readonly version: SemanticVersion;
  readonly publishedMs: number;
  readonly engine: string;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The hold in `text`, none for no file, or an error that states the shape. */
function parseHold(text: string | undefined): Hold | undefined | Error {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const recordedOn = isRecord(value) ? value["recordedOn"] : undefined;
  const recordedOnMs = typeof recordedOn === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(recordedOn) ? Date.parse(`${recordedOn}T00:00:00Z`) : Number.NaN;
  if (!isRecord(value) || typeof value["sdkVersion"] !== "string" || typeof value["reason"] !== "string" || value["reason"].trim() === "" || Number.isNaN(recordedOnMs)) {
    return new Error(`${HOLD_FILE} is not a hold: write ${HOLD_EXAMPLE}`);
  }
  return { sdkVersion: value["sdkVersion"], recordedOn: String(recordedOn), recordedOnMs, reason: value["reason"].trim() };
}

/** The stable releases of the registry document, and its `latest` tag. */
function parseReleases(document: unknown): { readonly releases: ReadonlyMap<string, Release>; readonly latest: SemanticVersion } | undefined {
  if (!isRecord(document) || !isRecord(document["versions"]) || !isRecord(document["time"]) || !isRecord(document["dist-tags"])) return undefined;
  const latestTag = document["dist-tags"]["latest"];
  const latest = typeof latestTag === "string" ? parseSemanticVersion(latestTag) : undefined;
  if (latest === undefined) return undefined;
  const releases = new Map<string, Release>();
  for (const [name, entry] of Object.entries(document["versions"])) {
    const version = parseSemanticVersion(name);
    const published = document["time"][name];
    const engine = isRecord(entry) ? entry["claudeCodeVersion"] : undefined;
    if (version === undefined || version.canonical !== name || typeof published !== "string") continue;
    releases.set(name, { version, publishedMs: Date.parse(published), engine: typeof engine === "string" ? engine : "unknown" });
  }
  return { releases, latest };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const ageDays = (fromMs: number, nowMs: number) => Math.floor((nowMs - fromMs) / DAY_MS);

/** Whether the SDK that `lockText` pins is fresh enough to release, from the registry that `fetch` reads. */
export async function claudeEngineFreshness(input: { readonly lockText: string; readonly holdText: string | undefined; readonly nowMs: number; readonly fetch: RegistryFetch }): Promise<FreshnessVerdict> {
  const pin = lockedPackageIn(input.lockText, SDK_PACKAGE).version;
  const hold = parseHold(input.holdText);
  if (hold instanceof Error) return { status: "fail", lines: [hold.message] };
  let document: unknown;
  try {
    document = JSON.parse(await input.fetch(`${REGISTRY}/${SDK_PACKAGE}`));
  } catch (error) {
    return { status: "blocked", lines: [`the npm registry did not answer for ${SDK_PACKAGE}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const registry = parseReleases(document);
  const pinned = registry?.releases.get(pin);
  if (registry === undefined || pinned === undefined) return { status: "blocked", lines: [`the npm registry lists no ${SDK_PACKAGE} ${pin}`] };
  const newer = [...registry.releases.values()]
    .filter(({ version }) => compareSemanticVersions(version, pinned.version) > 0 && compareSemanticVersions(version, registry.latest) <= 0)
    .sort((a, b) => a.publishedMs - b.publishedMs);
  const newest = registry.releases.get(registry.latest.canonical) ?? pinned;
  const lines = [`${SDK_PACKAGE} ${pin} (engine ${pinned.engine}), published ${day(pinned.publishedMs)}, ${plural(ageDays(pinned.publishedMs, input.nowMs), "day")} old`];
  const first = newer[0];
  const supersededDays = first === undefined ? 0 : ageDays(first.publishedMs, input.nowMs);
  lines.push(`newest ${newest.version.canonical} (engine ${newest.engine}), ${plural(newer.length, "release")} behind${first === undefined ? "" : `; ${first.version.canonical} superseded the pin ${plural(supersededDays, "day")} ago, and readiness fails after ${FRESHNESS_WINDOW_DAYS}`}`);
  if (hold !== undefined && hold.sdkVersion !== pin) return { status: "fail", lines: [...lines, `${HOLD_FILE} holds ${hold.sdkVersion}, not the pinned ${pin}; remove it`] };
  if (supersededDays <= FRESHNESS_WINDOW_DAYS) return { status: "pass", lines };
  const holdEndMs = hold === undefined ? undefined : hold.recordedOnMs + FRESHNESS_WINDOW_DAYS * DAY_MS;
  if (hold !== undefined && holdEndMs !== undefined && hold.recordedOnMs <= input.nowMs && input.nowMs < holdEndMs) {
    return { status: "pass", lines: [...lines, `held since ${hold.recordedOn} until ${day(holdEndMs)}: ${hold.reason}`] };
  }
  const expired = hold === undefined ? "" : hold.recordedOnMs > input.nowMs ? `the hold's date ${hold.recordedOn} is in the future; ` : `the hold recorded on ${hold.recordedOn} ended on ${day(holdEndMs ?? 0)}; `;
  return { status: "fail", lines: [...lines, `stale: ${expired}bump the SDK and qualify it, or record a dated reason in ${HOLD_FILE} as ${HOLD_EXAMPLE}`] };
}

/** Whether a candidate ships another engine than its last release, and the versions that decide it. */
export interface EngineBump {
  readonly bumped: boolean;
  readonly detail: string;
}

/** Whether the SDK that `headLock` pins is new since the last release tag, whose lockfile `released` holds. A tag
 *  from before the SDK shipped pins none, so every pin is new to it. */
export function engineBump(headLock: string, released: { readonly tag: string; readonly lockText: string } | undefined): EngineBump {
  const pin = lockedPackageIn(headLock, SDK_PACKAGE).version;
  if (released === undefined) return { bumped: true, detail: `no release tag precedes ${SDK_PACKAGE} ${pin}` };
  if (!lockHasPackage(released.lockText, SDK_PACKAGE)) return { bumped: true, detail: `${released.tag} shipped no ${SDK_PACKAGE}; this release adds ${pin}` };
  const shipped = lockedPackageIn(released.lockText, SDK_PACKAGE).version;
  return shipped === pin
    ? { bumped: false, detail: `${released.tag} already shipped ${SDK_PACKAGE} ${pin}` }
    : { bumped: true, detail: `${SDK_PACKAGE} ${shipped} in ${released.tag} is now ${pin}` };
}

/** The exit code of a check that could not reach the registry. Readiness reports it as blocked, not as failed. */
export const FRESHNESS_BLOCKED_EXIT = 3;

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  let holdText: string | undefined;
  try {
    holdText = readFileSync(join(root, HOLD_FILE), "utf8");
  } catch {
    holdText = undefined; // No hold is recorded.
  }
  const verdict = await claudeEngineFreshness({
    lockText: readFileSync(join(root, "bun.lock"), "utf8"), holdText, nowMs: Date.now(),
    fetch: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.text();
    },
  });
  for (const line of verdict.lines) console.log(`claude engine: ${line}`);
  process.exit(verdict.status === "pass" ? 0 : verdict.status === "blocked" ? FRESHNESS_BLOCKED_EXIT : 1);
}
