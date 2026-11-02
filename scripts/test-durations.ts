/**
 * The measured wall time of each unit test file, which the parallel runner
 * uses to plan its bands. File size predicts duration badly: a small file that
 * starts a real shell or waits on a timer can outlast a large table of pure
 * cases, and one such file in a band holds the whole suite at its budget.
 *
 * The record maps a repository-relative POSIX path to the milliseconds of its
 * last few full runs, oldest first, and a file weighs the lower median of
 * them. One run is a noisy sample: on a Windows host a scan or a burst of
 * contention can stall a file that takes a fraction of a second for five or
 * more, and a plan that believed that one sample gave the stalled file's band
 * a fraction of its work and the other bands the rest. It lives
 * outside the repository, so a run never changes a tracked file that a
 * concurrent agent also edits, and every worktree of the repository shares it.
 * Only the validation lane writes it, one run at a time. It is a cache: a
 * missing or unreadable record plans by size, which is the behavior before any
 * measurement. A run that the hang guard ends still stores the files it
 * finished, so a machine whose first run is too slow does not plan by size
 * again on every later run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export type DurationRecord = ReadonlyMap<string, readonly number[]>;

/** How many recent runs the record keeps for each file. Three is the fewest
 *  whose median ignores one stalled run. */
const KEPT_SAMPLES = 3;

/** The lower median: the middle sample of an odd count, and the smaller of
 *  the middle two of an even count, so that of two samples a stall is the one
 *  ignored. */
function lowerMedian(samples: readonly number[]): number {
  return samples.toSorted((left, right) => left - right)[Math.floor((samples.length - 1) / 2)]!;
}

export const durationRecordPath = join(homedir(), ".cache", "flywheel", "test-durations.json");

/** The record key of one test file: its path relative to the repository, with
 *  `/` separators on every platform. */
function recordKey(file: string, repoRoot: string): string {
  return relative(repoRoot, resolve(repoRoot, file)).split(sep).join("/");
}

/** The wall time of every file that a band finished, in milliseconds, by
 *  record key. The timings come from the file headings that Bun prints as it
 *  starts each file, so a band that the hang guard killed or that crashed
 *  still measures every file it finished. A file that was still running has no
 *  duration yet: it is left out and keeps its recorded samples. */
export function finishedFileDurations(timings: Iterable<{ readonly file: string; readonly elapsedMs: number; readonly running: boolean }>, repoRoot: string): Map<string, number> {
  const durations = new Map<string, number>();
  for (const timing of timings) {
    // Whole milliseconds: finer digits are clock noise that only grows the record.
    if (!timing.running) durations.set(recordKey(timing.file, repoRoot), Math.round(timing.elapsedMs));
  }
  return durations;
}

/** The band-planning weight of each file of `files`: the lower median of its
 *  recorded durations,
 *  or, for a file the record does not have, its size converted at the rate
 *  that the recorded files of this suite ran at. With no recorded file in the
 *  suite, every file weighs its size. The weight is a pure function of the
 *  record and the sizes, so one record always plans the same bands. */
export function bandWeight(files: readonly string[], record: DurationRecord, repoRoot: string, sizeOf: (file: string) => number): (file: string) => number {
  let measuredMs = 0;
  let measuredBytes = 0;
  const recorded = (file: string): number | undefined => {
    const samples = record.get(recordKey(file, repoRoot));
    return samples === undefined ? undefined : lowerMedian(samples);
  };
  for (const file of files) {
    const duration = recorded(file);
    if (duration === undefined) continue;
    measuredMs += duration;
    measuredBytes += sizeOf(file);
  }
  const msPerByte = measuredMs > 0 && measuredBytes > 0 ? measuredMs / measuredBytes : 1;
  return (file) => recorded(file) ?? sizeOf(file) * msPerByte;
}

/** The record after one full run of `files`: a measured file adds its new
 *  duration and keeps its latest samples, a file the run did not measure (its
 *  band was killed or crashed before the file finished) keeps its old ones,
 *  and a file that is no longer in the suite leaves the record. */
export function recordDurations(record: DurationRecord, measured: ReadonlyMap<string, number>, files: readonly string[], repoRoot: string): DurationRecord {
  const next = new Map<string, readonly number[]>();
  for (const key of files.map((file) => recordKey(file, repoRoot)).toSorted()) {
    const previous = record.get(key) ?? [];
    const duration = measured.get(key);
    const samples = duration === undefined ? previous : [...previous, duration].slice(-KEPT_SAMPLES);
    if (samples.length > 0) next.set(key, samples);
  }
  return next;
}

/** The stored record, or an empty one when there is none. A record that does
 *  not parse is reported and replaced by the next full run. */
export function readDurationRecord(path: string = durationRecordPath): DurationRecord {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the record is not an object");
    const record = new Map<string, readonly number[]>();
    const isDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
    for (const [key, value] of Object.entries(parsed)) {
      // A record written before 2026-10-18 holds one number per file, which
      // reads as one sample. Remove this conversion after 2026-11-18.
      const samples: unknown[] = Array.isArray(value) ? value : [value];
      if (samples.length === 0 || samples.length > KEPT_SAMPLES || !samples.every(isDuration)) throw new Error(`the durations of ${key} are not one to ${KEPT_SAMPLES} non-negative numbers`);
      record.set(key, samples);
    }
    return record;
  } catch (error) {
    process.stderr.write(`test-parallel: ignoring the unreadable duration record ${path} (${error instanceof Error ? error.message : String(error)}); bands are planned by file size until the next full run replaces it\n`);
    return new Map();
  }
}

/** Stores the record by rename, so a run that is killed while it writes leaves
 *  the previous record. The record is a cache, so a failed store never fails
 *  the run: a read-only or full HOME gets one warning, the staging file is
 *  removed, and the next run plans from the previous record or by size. */
export function writeDurationRecord(record: DurationRecord, path: string = durationRecordPath): void {
  const staging = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, `${JSON.stringify(Object.fromEntries(record), null, 2)}\n`);
    renameSync(staging, path);
  } catch (error) {
    // Bun's `rmSync` throws even with `force` when a parent is not a
    // directory, so only a staging file that exists is removed.
    if (existsSync(staging)) rmSync(staging);
    process.stderr.write(`test-parallel: could not store the duration record ${path} (${error instanceof Error ? error.message : String(error)}); the next run plans its bands from the previous record or by file size\n`);
  }
}
