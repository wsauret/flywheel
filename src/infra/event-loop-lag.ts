/**
 * Process-global event-loop lag meter.
 *
 * One process, one event loop, one sampler; like `log`, this is legitimately a
 * module-scoped singleton. A self-rescheduling timer measures how late it fires
 * relative to its target; that delay is event-loop lag (the main thread was
 * busy and could not service the timer on time).
 *
 * Why: the model-request dead zone (`model.requested` -> first `message_start`)
 * fuses our prep, client-side connect/TLS, and server think-time. A fourth,
 * invisible contributor is main-thread starvation: under concurrent streams the
 * single Bun thread decodes other SSE streams / GCs / parses large payloads, so
 * a resolved fetch promise sits unprocessed. `maxEventLoopLagBetween` lets the
 * request-timing fact attribute dead-zone time to loop starvation vs the wire.
 */

import { Log } from "./log.js";
import { coalesceRepeats } from "./repeat-coalescer.js";

const log = Log.create({ service: "event-loop-lag" });

/** The longest synchronous unit the event loop treats as normal. The sampler
 *  attributes a stall to a longer unit, and cooperative work in
 *  task-scheduling yields when its current slice reaches this length. */
export const SLOW_UNIT_BUDGET_MS = 8;

// Captured at module load: the sampler must measure the real event loop even
// when a test replaces globalThis.setTimeout, and an immediately-firing stub
// would otherwise drive the self-rescheduling sampler into synchronous
// infinite recursion.
const scheduleTimer = setTimeout;

const SAMPLE_INTERVAL_MS = 50;
const RETENTION_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 8192;
const RECENT_SLOW_RETENTION_MS = 2_000;
const MAX_ATTRIBUTED_SPANS = 8;
/** One stall records in full; the stalls after it in this window report once,
 *  as a count with the worst and typical lag and the unit most often behind
 *  them. A busy loop stalls every few seconds, and a record for each stall
 *  was the second largest warning family in the log. */
const STALL_WINDOW_MS = 60_000;

interface LagSample {
  at: number;
  lagMs: number;
}

interface LoopSpan {
  kind: string;
  name: string;
  startedAt: number;
}

let samples: LagSample[] = [];
let started = false;
let observeStallsFromMs: number | null = null;
let warnOnStallMs: number | null = null;
const inflightSpans = new Map<symbol, LoopSpan>();
let recentSlowUnit: { kind: string; name: string; durationMs: number; endedAt: number } | null = null;
let sampleTargetAt: number | null = null;
// Units that ran after the sampler's timer was due, summed by unit: a stall
// is usually many short units back to back, not one long one.
let gapUnits = new Map<string, { count: number; overlapMs: number }>();
// Spans that ended after the sampler's timer was due. A span can end in the
// task that follows the work it names, and that task can run before the late
// sampler, so the stall record would otherwise lose it.
let gapEndedSpans: string[] = [];

/** Starts the sampler. A stall of at least `observeStallsFromMs` records at
 *  DEBUG with its attribution, which is what a fairness measurement reads; a
 *  stall of at least `warnOnStallMs` is one a person notices and reaches the
 *  default level, coalesced per window. */
export function ensureEventLoopLagSampler(options: { readonly observeStallsFromMs?: number; readonly warnOnStallMs?: number } = {}): void {
  if (options.warnOnStallMs !== undefined) warnOnStallMs = options.warnOnStallMs;
  if (options.observeStallsFromMs !== undefined) observeStallsFromMs = options.observeStallsFromMs;
  if (started) return;
  started = true;
  schedule(performance.now() + SAMPLE_INTERVAL_MS);
}

function schedule(targetAt: number): void {
  sampleTargetAt = targetAt;
  const timer = scheduleTimer(() => {
    const now = performance.now();
    const lagMs = Math.max(0, now - targetAt);
    samples.push({ at: now, lagMs });
    if (samples.length > MAX_SAMPLES) {
      const cutoff = now - RETENTION_MS;
      samples = samples.filter((sample) => sample.at >= cutoff);
    }
    const observeFrom = observeStallsFromMs ?? warnOnStallMs;
    if (observeFrom !== null && lagMs >= observeFrom) observeStall(now, lagMs);
    gapUnits = new Map();
    gapEndedSpans = [];
    schedule(now + SAMPLE_INTERVAL_MS);
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

interface Stall {
  readonly lagMs: number;
  /** The last probed unit that blew its budget before the stall, as kind:name. */
  readonly unit?: string;
  readonly unitMs?: number;
  readonly inflight?: readonly string[];
  readonly gapUnits: readonly { unit: string; count: number; overlapMs: number }[];
}

const stalls = coalesceRepeats<Stall>({
  windowMs: STALL_WINDOW_MS,
  first: (_condition, stall) => {
    log.warn("event loop stalled", {
      lagMs: stall.lagMs,
      recentSlowUnit: stall.unit === undefined ? undefined : `${stall.unit} ${stall.unitMs}ms`,
      inflight: stall.inflight,
      gapUnits: stall.gapUnits,
    });
  },
  repeated: (_condition, repeats) => {
    const lags = repeats.events.map((stall) => stall.lagMs).sort((a, b) => a - b);
    const causes = repeats.events.flatMap((stall) => {
      const cause = stallCause(stall);
      return cause === undefined ? [] : [cause];
    });
    const unattributed = repeats.events.length - causes.length;
    log.warn("event loop stalled again", {
      count: repeats.count,
      windowMs: repeats.windowMs,
      maxLagMs: lags.at(-1),
      p90LagMs: lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.9))],
      topUnit: mostFrequent(causes),
      ...(unattributed > 0 ? { unattributed } : {}),
    });
  },
});

/** The probed unit that occupied at least half of a stall, if one did. A unit
 *  that only ran after work no probe covers (a promise continuation, a fold,
 *  native work) is not a cause, even when it is the first to run after the
 *  stall. In the logs, no stall of a second or more had a probed unit that
 *  covered a tenth of it, so the first unit to run after each one is noise. */
function stallCause(stall: Stall): string | undefined {
  const top = stall.gapUnits[0];
  return top !== undefined && top.overlapMs * 2 >= stall.lagMs ? top.unit : undefined;
}

function mostFrequent(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  let top: string | undefined;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (top === undefined || count > (counts.get(top) ?? 0)) top = value;
  }
  return top;
}

/** Completed synchronous units attribute the late interval. Spans that were
 *  open at any point in the late interval name work in flight during it:
 *  delayed async work, or native work outside any JS frame, such as the
 *  thread join of an ending Worker. A span does not prove that its work
 *  occupied the loop. */
function observeStall(now: number, lagMs: number): void {
  const inflight = [
    ...gapEndedSpans,
    ...[...inflightSpans.values()].map((span) => `${span.kind}:${span.name}+${Math.round(now - span.startedAt)}ms`),
  ].slice(0, MAX_ATTRIBUTED_SPANS);
  const slow = recentSlowUnit && now - recentSlowUnit.endedAt <= RECENT_SLOW_RETENTION_MS ? recentSlowUnit : undefined;
  const stall: Stall = {
    lagMs: Math.round(lagMs),
    gapUnits: [...gapUnits].map(([unit, total]) => ({ unit, count: total.count, overlapMs: Math.round(total.overlapMs) }))
      .sort((a, b) => b.overlapMs - a.overlapMs)
      .slice(0, MAX_ATTRIBUTED_SPANS),
    ...(slow ? { unit: `${slow.kind}:${slow.name}`, unitMs: slow.durationMs } : {}),
    ...(inflight.length > 0 ? { inflight } : {}),
  };
  log.debug("event loop stall observed", { ...stall });
  if (warnOnStallMs !== null && lagMs >= warnOnStallMs) stalls.observe("stall", stall);
}

/** Register a span (e.g. an in-flight RPC dispatch) for stall attribution.
 *  A stall names every span that was open when the sampler's timer was due or
 *  that ended after it. No duration budget: awaited I/O legitimately keeps a
 *  span open without occupying the loop. Call the returned function to end
 *  it; later calls do nothing. */
export function trackLoopSpan(kind: string, name: string): () => void {
  const key = Symbol(name);
  const startedAt = performance.now();
  inflightSpans.set(key, { kind, name, startedAt });
  return () => {
    if (!inflightSpans.delete(key)) return;
    const endedAt = performance.now();
    if (sampleTargetAt === null || endedAt <= sampleTargetAt || gapEndedSpans.length >= MAX_ATTRIBUTED_SPANS) return;
    gapEndedSpans.push(`${kind}:${name}+${Math.round(endedAt - startedAt)}ms`);
  };
}

/** Run a synchronous unit under a loop-time budget. A unit that reaches
 *  `slowAfterMs`, SLOW_UNIT_BUDGET_MS unless the caller states a longer
 *  allowance, is remembered for stall attribution, which is where it reaches
 *  the default level, and logged at DEBUG: this is the enforcement point for
 *  the rule that onChange and bus subscribers fold only the delivered units,
 *  so that one session's burst cannot starve the others on the runtime thread. */
export function probeLoopUnit<T>(kind: string, name: string, run: () => T, slowAfterMs = SLOW_UNIT_BUDGET_MS): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    const endedAt = performance.now();
    const durationMs = Math.round((endedAt - start) * 10) / 10;
    if (sampleTargetAt !== null && endedAt > sampleTargetAt) {
      const unit = `${kind}:${name}`;
      const total = gapUnits.get(unit) ?? { count: 0, overlapMs: 0 };
      total.count += 1;
      total.overlapMs += endedAt - Math.max(start, sampleTargetAt);
      gapUnits.set(unit, total);
    }
    if (durationMs >= slowAfterMs) {
      recentSlowUnit = { kind, name, durationMs, endedAt };
      log.debug("slow loop unit", { kind, name, durationMs });
    }
  }
}


/** Peak event-loop lag (ms) observed between two `performance.now()` stamps. */
export function maxEventLoopLagBetween(startMs: number, endMs: number): number {
  let max = 0;
  for (const sample of samples) {
    if (sample.at < startMs) continue;
    if (sample.at > endMs) break;
    if (sample.lagMs > max) max = sample.lagMs;
  }
  return Math.round(max);
}
