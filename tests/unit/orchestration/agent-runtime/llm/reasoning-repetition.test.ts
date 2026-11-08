/** Degenerate repetition in a stream attempt's reasoning: the attempt stops a
 *  response whose reasoning collapsed into a loop, and leaves reasoning that
 *  only looks regular, such as ASCII art, prose, and code, alone. The loop
 *  fixture is real reasoning that looped; the ASCII-art fixture is the most
 *  compressible normal reasoning that the detector's calibration found. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { reasoningRepetitionDetector, type DegenerateRepetitionError } from "../../../../../src/orchestration/agent-runtime/llm/reasoning-repetition.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import { armStreamLiveness, throwIfLivenessFailure } from "../../../../../src/orchestration/agent-runtime/llm/stream-liveness.js";

const root = join(import.meta.dir, "../../../../..");
const fixture = (name: string): string => readFileSync(join(root, "tests/fixtures/reasoning-repetition", name), "utf8");

/** Streams `text` as reasoning deltas the way an adapter does, through the
 *  shared liveness controller, and reports how much it streamed and how the
 *  attempt ended. */
async function streamReasoning(text: string, detectRepetition: boolean): Promise<{ streamed: number; error: unknown }> {
  let streamed = 0;
  const stream = withStreamAttempt(async function* (attempt) {
    const liveness = armStreamLiveness(attempt, { label: "test", provider: "Test", telemetry: undefined });
    try {
      liveness.begin("reasoning:0");
      for (let at = 0; at < text.length; at += 64) {
        attempt.signal.throwIfAborted();
        const delta = text.slice(at, at + 64);
        liveness.append(delta);
        streamed += delta.length;
        yield { kind: "thinking_delta", text: delta, blockKey: "reasoning:0" } as const;
      }
      liveness.complete("reasoning:0");
    } catch (error) {
      throwIfLivenessFailure(error, attempt, undefined);
      throw error;
    }
  }, { detectRepetition });
  try {
    for await (const _event of stream) { /* drain */ }
    return { streamed, error: undefined };
  } catch (error) {
    return { streamed, error };
  }
}

describe("reasoning repetition detection", () => {
  test("stops the attempt soon after the reasoning starts to loop", async () => {
    const loop = fixture("loop.txt");
    const { streamed, error } = await streamReasoning(loop, true);

    if (!(error instanceof ProviderAttemptFailure)) throw new Error(`expected a provider attempt failure, got ${String(error)}`);
    expect(error.failure).toMatchObject({ _tag: "DegenerateRepetitionFailure", windowChars: 8192, reasoningChars: streamed });
    if (error.failure._tag !== "DegenerateRepetitionFailure") throw new Error("expected a repetition failure");
    expect(error.failure.ratio).toBeLessThanOrEqual(0.08);
    // The loop in this excerpt starts near char 8,200 and trips within one window of it.
    expect(streamed).toBeGreaterThan(8_192);
    expect(streamed).toBeLessThan(loop.length);
  });

  test.each([
    ["ASCII art", fixture("ascii-art.txt")],
    ["prose", readFileSync(join(root, "docs/architecture.md"), "utf8").slice(0, 40_000)],
    ["code", readFileSync(join(root, "src/orchestration/agent-runtime/llm/failover-client.ts"), "utf8").slice(0, 40_000)],
  ])("streams %s reasoning in full", async (_kind, text) => {
    expect(await streamReasoning(text, true)).toEqual({ streamed: text.length, error: undefined });
  });

  test("checks the same windows whatever size the provider's deltas are", () => {
    const loop = fixture("loop.txt");
    const noise = readFileSync(join(root, "docs/architecture.md"), "utf8").slice(0, 10_000);
    const firstTrip = (text: string, chunk: number): DegenerateRepetitionError | undefined => {
      const detector = reasoningRepetitionDetector();
      for (let at = 0; at < text.length; at += chunk) {
        const detected = detector.observe(text.slice(at, at + chunk));
        if (detected) return detected;
      }
      return undefined;
    };
    const reference = firstTrip(loop, 64);
    if (reference === undefined) throw new Error("expected the loop to trip");
    for (const chunk of [100, 200, 1_000, loop.length]) expect(firstTrip(loop, chunk)?.ratio).toBe(reference.ratio);
    // One delta that carries the loop and then more than a window of ordinary text still trips on the loop.
    const looped = loop + noise;
    expect(firstTrip(looped, looped.length)?.ratio).toBe(reference.ratio);
  });

  test("an attempt without detection streams a loop in full", async () => {
    const loop = fixture("loop.txt");
    expect(await streamReasoning(loop, false)).toEqual({ streamed: loop.length, error: undefined });
  });
});
