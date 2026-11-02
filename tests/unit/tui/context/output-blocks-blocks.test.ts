import { describe, it, expect } from "bun:test";
import { formatDuration, formatElapsed, formatTokens } from "../../../../src/protocol/client/format.js";

/**
 * Output Blocks rendering logic tests — block-shape, component selection,
 * duration formatting, and tool-group display text.
 *
 * These test the pure-logic functions used by block rendering components.
 * Actual OpenTUI rendering cannot be tested in unit tests (per AGENTS.md) —
 * visual verification is done via tmux UAT.
 */

// ── Duration formatting ──

describe("formatDuration", () => {
  it("formats sub-second durations in milliseconds", () => {
    expect(formatDuration(50)).toBe("50ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12345)).toBe("12.3s");
    expect(formatDuration(59949)).toBe("59.9s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(125000)).toBe("2m 5s");
  });

  it("formats hours without changing sub-minute precision", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(21_821_000)).toBe("6h 3m 41s");
    expect(formatDuration(3_599_499)).toBe("59m 59s");
    expect(formatDuration(3_599_600)).toBe("1h 0m 0s");
  });

  it("carries a rounded figure into the next unit instead of showing 60", () => {
    expect(formatDuration(59950)).toBe("1m 0s");
    expect(formatDuration(59960)).toBe("1m 0s");
    expect(formatDuration(119499)).toBe("1m 59s");
    expect(formatDuration(119600)).toBe("2m 0s");
    expect(formatDuration(179689)).toBe("3m 0s");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0ms");
  });
});

describe("formatElapsed", () => {
  it("counts whole seconds, minutes, and hours without rounding up", () => {
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(3_599_999)).toBe("59m 59s");
    expect(formatElapsed(3_600_000)).toBe("1h 0m 0s");
    expect(formatElapsed(21_821_999)).toBe("6h 3m 41s");
  });
});

describe("formatTokens", () => {
  it("abbreviates token counts without redundant trailing decimals", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(270_000)).toBe("270k");
    expect(formatTokens(999_999)).toBe("1000k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

