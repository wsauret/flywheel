import { expect, test } from "bun:test";
import { coalesceRepeats, type Repeats } from "../src/infra/repeat-coalescer";

function flood(repeats: number) {
  const firsts: number[] = [];
  const summaries: Repeats<number>[] = [];
  const coalescer = coalesceRepeats<number>({
    windowMs: 60_000,
    first: (_key, event) => { firsts.push(event); },
    repeated: (_key, summary) => { summaries.push(summary); },
  });
  for (let event = 0; event <= repeats; event += 1) coalescer.observe("flood", event);
  coalescer.end();
  return { firsts, summaries };
}

test("repeat-coalescer: keeps at most 256 sampled repeats in arrival order", () => {
  for (const repeats of [257, 1_000]) {
    const { firsts, summaries } = flood(repeats);
    expect(firsts).toEqual([0]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.count).toBe(repeats);
    expect(summaries[0]?.events).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
  }
});

test("repeat-coalescer: keeps every repeat when the sample is not full", () => {
  for (const repeats of [1, 255, 256]) {
    const { summaries } = flood(repeats);
    expect(summaries[0]?.count).toBe(repeats);
    expect(summaries[0]?.events).toEqual(Array.from({ length: repeats }, (_, index) => index + 1));
  }
});
