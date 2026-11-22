/**
 * The release rules that both bundled engines share: the Claude engine (scripts/claude-engine-release.ts) and the
 * Antigravity CLI (scripts/antigravity-engine-release.ts). A release must not ship an engine that a newer release
 * superseded more than `FRESHNESS_WINDOW_DAYS` ago, unless a tracked hold states why, with the date it was recorded.
 * A hold names the pinned version and lasts one window, so a bump or the passing of time ends it. Where each engine
 * learns when its pin was superseded differs, so each engine's script finds that date itself.
 */
import { readFileSync } from "node:fs";

/** How long newer releases may supersede a pin before readiness fails. Every bump costs a qualification pass on three
 *  hosts, and three weeks lets a bump wait for a convenient pass while the shipped engine stays within three weeks of
 *  the newest release. */
export const FRESHNESS_WINDOW_DAYS = 21;

/** The exit code of a check that could not get its answer. Readiness reports it as blocked, not as failed. */
export const FRESHNESS_BLOCKED_EXIT = 3;

/** `pass` and `fail` decide readiness; `blocked` means the release source could not answer the question. */
export interface FreshnessVerdict {
  readonly status: "pass" | "fail" | "blocked";
  readonly lines: readonly string[];
}

/** Whether a candidate ships another engine than its last release, and the versions that decide it. */
export interface EngineBump {
  readonly bumped: boolean;
  readonly detail: string;
}

/** Where one engine keeps its hold, the key that names the held version, and what a person does instead of holding. */
export interface HoldRule {
  readonly file: string;
  readonly versionKey: string;
  /** The remedy of a stale pin, such as "bump the SDK and qualify it". */
  readonly bump: string;
}

export interface EngineHold {
  readonly version: string;
  readonly recordedOnMs: number;
  readonly recordedOn: string;
  readonly reason: string;
}

export const DAY_MS = 86_400_000;

export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The start of the UTC day that `text` names as `YYYY-MM-DD`, or NaN for any other text. */
export function dayMs(text: unknown): number {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(text) ? Date.parse(`${text}T00:00:00Z`) : Number.NaN;
}

export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export const ageDays = (fromMs: number, nowMs: number) => Math.floor((nowMs - fromMs) / DAY_MS);

const holdExample = (rule: HoldRule) => `{"${rule.versionKey}": "<pinned version>", "recordedOn": "YYYY-MM-DD", "reason": "<why>"}`;

/** The hold in `text`, none for no file, or an error that states the shape. */
export function parseHold(text: string | undefined, rule: HoldRule): EngineHold | undefined | Error {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const recordedOnMs = dayMs(isRecord(value) ? value["recordedOn"] : undefined);
  if (!isRecord(value) || typeof value[rule.versionKey] !== "string" || typeof value["reason"] !== "string" || value["reason"].trim() === "" || Number.isNaN(recordedOnMs)) {
    return new Error(`${rule.file} is not a hold: write ${holdExample(rule)}`);
  }
  return { version: String(value[rule.versionKey]), recordedOn: String(value["recordedOn"]), recordedOnMs, reason: value["reason"].trim() };
}

/** The verdict on a pin that a newer release superseded `supersededDays` ago (0 when none did), after `lines`, which
 *  describe the pin. A hold for another version fails, so a bump removes its hold. */
export function holdVerdict(input: { readonly pin: string; readonly hold: EngineHold | undefined; readonly supersededDays: number; readonly nowMs: number; readonly lines: readonly string[]; readonly rule: HoldRule }): FreshnessVerdict {
  const { pin, hold, lines, rule } = input;
  if (hold !== undefined && hold.version !== pin) return { status: "fail", lines: [...lines, `${rule.file} holds ${hold.version}, not the pinned ${pin}; remove it`] };
  if (input.supersededDays <= FRESHNESS_WINDOW_DAYS) return { status: "pass", lines };
  const holdEndMs = hold === undefined ? undefined : hold.recordedOnMs + FRESHNESS_WINDOW_DAYS * DAY_MS;
  if (hold !== undefined && holdEndMs !== undefined && hold.recordedOnMs <= input.nowMs && input.nowMs < holdEndMs) {
    return { status: "pass", lines: [...lines, `held since ${hold.recordedOn} until ${day(holdEndMs)}: ${hold.reason}`] };
  }
  const expired = hold === undefined ? "" : hold.recordedOnMs > input.nowMs ? `the hold's date ${hold.recordedOn} is in the future; ` : `the hold recorded on ${hold.recordedOn} ended on ${day(holdEndMs ?? 0)}; `;
  return { status: "fail", lines: [...lines, `stale: ${expired}${rule.bump}, or record a dated reason in ${rule.file} as ${holdExample(rule)}`] };
}

/** The text of the tracked file at `path`, or undefined when there is none. */
export function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // No such record is tracked.
  }
}

/** Prints `verdict` with `label` before each line, and exits with the code that readiness classifies. */
export function exitWithVerdict(label: string, verdict: FreshnessVerdict): never {
  for (const line of verdict.lines) console.log(`${label}: ${line}`);
  process.exit(verdict.status === "pass" ? 0 : verdict.status === "blocked" ? FRESHNESS_BLOCKED_EXIT : 1);
}
