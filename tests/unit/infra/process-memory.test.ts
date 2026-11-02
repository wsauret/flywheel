import { describe, expect, test } from "bun:test";

import { createProcessMemorySampler, type MemoryStep } from "../../../src/infra/process-memory.js";

const GIB = 1024 ** 3;

/** Runs one sample per scripted footprint and returns the steps recorded. */
function recordedSteps(footprints: readonly (number | undefined)[]): MemoryStep[] {
  const steps: MemoryStep[] = [];
  let next = 0;
  const sample = createProcessMemorySampler(() => footprints[next++], (step) => steps.push(step));
  for (let index = 0; index < footprints.length; index += 1) sample();
  return steps;
}

describe("process memory step sampler", () => {
  test("keeps the first footprint as the level without a record, and records nothing below a step", () => {
    expect(recordedSteps([2 * GIB, 2.9 * GIB, 1.1 * GIB])).toEqual([]);
  });

  test("records a rise of a whole step, then a fall of a whole step from the new level", () => {
    expect(recordedSteps([2 * GIB, 3 * GIB, 2.5 * GIB, 1.5 * GIB])).toEqual([
      { footprintBytes: 3 * GIB, previousFootprintBytes: 2 * GIB },
      { footprintBytes: 1.5 * GIB, previousFootprintBytes: 3 * GIB },
    ]);
  });

  test("moves the level only on a record, so drift records once it adds up to a step", () => {
    expect(recordedSteps([2 * GIB, 2.6 * GIB, 3.2 * GIB])).toEqual([{ footprintBytes: 3.2 * GIB, previousFootprintBytes: 2 * GIB }]);
  });

  test("skips a sample the platform did not answer, including the first", () => {
    expect(recordedSteps([undefined, 2 * GIB, undefined, 3 * GIB])).toEqual([{ footprintBytes: 3 * GIB, previousFootprintBytes: 2 * GIB }]);
  });
});
