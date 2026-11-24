import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import { darwinProcess } from "../../../../../src/infra/process/kernel/darwin-process-api.js";
import { Log } from "../../../../../src/infra/diagnostics/log.js";
import { windowsProcessApi } from "../../../../../src/infra/process/kernel/windows-process-api.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

let samplers = 0;
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Makes this host's platform answer each footprint in turn, `undefined`
 *  being a platform that did not answer. Linux states its counters in whole
 *  kilobytes, so every footprint is a whole number of them. */
function scriptFootprints(footprints: readonly (number | undefined)[]): void {
  let next = 0;
  const read = (): number | undefined => footprints[next++];
  if (process.platform === "darwin") {
    const footprint = spyOn(darwinProcess, "footprintBytes").mockImplementation(read);
    restores.push(() => footprint.mockRestore());
  } else if (process.platform === "win32") {
    // The API opens once, so the sampler reads the same object.
    const api = windowsProcessApi() ?? expect.unreachable("kernel32 did not open");
    const commit = spyOn(api, "commitBytes").mockImplementation(read);
    restores.push(() => commit.mockRestore());
  } else {
    const realRead = fs.readFileSync;
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: readFileSync's overloads return a Buffer or a string by their options, which one scripted function cannot state
    const status = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, options?: BufferEncoding | null) => {
      if (path !== "/proc/self/status") return options == null ? realRead(path) : realRead(path, options);
      const bytes = read();
      return bytes === undefined ? "Name:\tbun\n" : `Name:\tbun\nVmRSS:\t${bytes / 1024 - 1} kB\nVmSwap:\t1 kB\n`;
    }) as typeof fs.readFileSync);
    restores.push(() => status.mockRestore());
  }
}

/** Starts the production sampler of a fresh process, runs one sample per
 *  scripted footprint, and returns the steps it recorded. */
async function recordedSteps(footprints: readonly (number | undefined)[]): Promise<unknown[]> {
  scriptFootprints(footprints);
  // The sampler captures the timer function when its module loads.
  const schedule = spyOn(globalThis, "setInterval");
  let scheduled: unknown[] = [];
  const info = spyOn(Log.create({ service: "process-memory" }), "info").mockImplementation(() => {});
  restores.push(() => info.mockRestore());
  try {
    samplers += 1;
    const memory: typeof import("../../../../../src/infra/process/kernel/process-memory.js") = await import(`../../../../../src/infra/process/kernel/process-memory.js?sampler=${samplers}`);
    memory.ensureProcessMemorySampler();
    memory.ensureProcessMemorySampler();
    scheduled = schedule.mock.calls.map(([callback]) => callback);
    for (const result of schedule.mock.results) if (result.type === "return") clearInterval(result.value);
  } finally {
    schedule.mockRestore();
  }
  expect(scheduled).toHaveLength(1);
  const [sample] = scheduled;
  if (typeof sample !== "function") throw new Error("the sampler scheduled no sample");
  for (let index = 0; index < footprints.length; index += 1) sample();
  return info.mock.calls.map(([, fields]) => ({ footprintBytes: fields?.footprintBytes, previousFootprintBytes: fields?.previousFootprintBytes }));
}

describe("process memory step sampler", () => {
  test("keeps the first footprint as the level without a record, and records nothing below a step", async () => {
    expect(await recordedSteps([2048 * MIB, 2970 * MIB, 1126 * MIB])).toEqual([]);
  });

  test("records a rise of a whole step, then a fall of a whole step from the new level", async () => {
    expect(await recordedSteps([2 * GIB, 3 * GIB, 2.5 * GIB, 1.5 * GIB])).toEqual([
      { footprintBytes: 3 * GIB, previousFootprintBytes: 2 * GIB },
      { footprintBytes: 1.5 * GIB, previousFootprintBytes: 3 * GIB },
    ]);
  });

  test("moves the level only on a record, so drift records once it adds up to a step", async () => {
    expect(await recordedSteps([2048 * MIB, 2662 * MIB, 3277 * MIB])).toEqual([{ footprintBytes: 3277 * MIB, previousFootprintBytes: 2048 * MIB }]);
  });

  test("skips a sample the platform did not answer, including the first", async () => {
    expect(await recordedSteps([undefined, 2 * GIB, undefined, 3 * GIB])).toEqual([{ footprintBytes: 3 * GIB, previousFootprintBytes: 2 * GIB }]);
  });
});
