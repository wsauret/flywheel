/**
 * Process-global memory step log.
 *
 * A long-lived Flywheel process that leaks shows it only as a machine that
 * slows down, hours later, and by then nothing tells when the memory grew or
 * what held it. The sampler reads the process footprint once a minute and
 * writes one record each time the footprint moved a whole step from the last
 * recorded level, so a leak leaves a trail of records that can be put beside
 * the work of the same hours, and a process at a steady size writes nothing.
 *
 * The footprint is the memory the kernel charges to the process, swapped-out
 * memory included: a leaking process is pushed out to swap, so its resident
 * size stays flat while it grows. The record also carries the JavaScript
 * heap, whose distance from the footprint tells memory the JavaScript engine
 * holds from memory the runtime holds outside it.
 */

import * as fs from "node:fs";

import { darwinProcess } from "./darwin-process-api.js";
import { Log } from "./log.js";
import { windowsProcessApi } from "./windows-process-api.js";

const log = Log.create({ service: "process-memory" });

// Captured at module load, as the event-loop sampler does, so a test that
// replaces the global timers cannot drive the production sampler.
const scheduleInterval = setInterval;

const SAMPLE_INTERVAL_MS = 60_000;
const STEP_BYTES = 1024 ** 3;

/** A footprint that moved a whole step from the last recorded level. */
export interface MemoryStep {
  readonly footprintBytes: number;
  readonly previousFootprintBytes: number;
}

let started = false;

/** Starts the sampler of this process once; later calls do nothing. The
 *  first sample runs one interval after the start, so the start does no work,
 *  and the timer never holds the process open. */
export function ensureProcessMemorySampler(): void {
  if (started) return;
  started = true;
  const sample = createProcessMemorySampler(readFootprintBytes, recordStep);
  scheduleInterval(sample, SAMPLE_INTERVAL_MS).unref();
}

/** Builds one sample of the step rule over a footprint reader. The first
 *  footprint read becomes the recorded level without a record. A later
 *  footprint at least one step above or below the level is passed to
 *  `record` and becomes the new level; a smaller move changes nothing, so
 *  slow drift records once it adds up to a step. A read that returns nothing
 *  is skipped. */
export function createProcessMemorySampler(readFootprint: () => number | undefined, record: (step: MemoryStep) => void): () => void {
  let level: number | undefined;
  return () => {
    const footprintBytes = readFootprint();
    if (footprintBytes === undefined) return;
    if (level === undefined) {
      level = footprintBytes;
      return;
    }
    if (Math.abs(footprintBytes - level) < STEP_BYTES) return;
    record({ footprintBytes, previousFootprintBytes: level });
    level = footprintBytes;
  };
}

function recordStep(step: MemoryStep): void {
  const { heapUsed, external } = process.memoryUsage();
  log.info("process memory footprint moved a step", { ...step, heapUsedBytes: heapUsed, externalBytes: external });
}

/** The footprint of this process in bytes, swapped-out memory included, or
 *  nothing when the platform did not answer. */
function readFootprintBytes(): number | undefined {
  switch (process.platform) {
    case "darwin":
      return darwinProcess.footprintBytes(process.pid);
    case "win32":
      return windowsProcessApi()?.commitBytes(process.pid);
    case "linux":
      return linuxFootprintBytes(fs.readFileSync("/proc/self/status", "utf8"));
    default:
      return undefined;
  }
}

/** Resident and swapped memory together, from the `VmRSS` and `VmSwap` lines
 *  of `/proc/<pid>/status`, which state kilobytes. */
function linuxFootprintBytes(status: string): number | undefined {
  const resident = /^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1];
  const swapped = /^VmSwap:\s+(\d+) kB$/m.exec(status)?.[1];
  if (resident === undefined || swapped === undefined) return undefined;
  return (Number(resident) + Number(swapped)) * 1024;
}
