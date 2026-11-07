import { describe, expect, it } from "bun:test";
import { renderShellLines, type ShellLines } from "../../../../../src/orchestration/agent-runtime/tools/bash-compressor.js";

const complete = (text: string): ShellLines => ({ head: text.split("\n"), tail: [] });

// The shape of a real `bun test` run with one failing test, captured from bun 1.4.
const BUN_FAILURE_LINES = [
  "bun test v1.4.0 (34cbb9a40)",
  "",
  "x.test.ts:",
  "noise line",
  "1 | import { test, expect } from \"bun:test\";",
  `2 | for (let i = 0; i < 3; i++) test(\`ok \${i}\`, () => expect(1).toBe(1));`,
  "3 | test(\"bad\", () => { console.log(\"noise line\"); expect({ a: 1, depth: 2, b: [1,2,3] }).toEqual({ a: 1, depth: 1, b: [1,2,3] }); });",
  "                                                                                          ^",
  "error: expect(received).toEqual(expected)",
  "",
  "  {",
  "    \"a\": 1,",
  "    \"b\": [",
  "      1,",
  "      2,",
  "      3,",
  "    ],",
  "-   \"depth\": 1,",
  "+   \"depth\": 2,",
  "  }",
  "",
  "- Expected  - 1",
  "+ Received  + 1",
  "",
  "      at <anonymous> (/repo/x.test.ts:3:87)",
  "(fail) bad [0.45ms]",
  "",
  " 250 pass",
  " 1 fail",
  " 251 expect() calls",
  "Ran 251 tests across 1 file. [7.00ms]",
];

function bunFailureOutput(passing: number): string {
  const passes = Array.from({ length: passing }, (_, index) => `(pass) ok ${index}${index === 0 ? " [0.03ms]" : ""}`);
  return [...BUN_FAILURE_LINES.slice(0, 3), ...passes, ...BUN_FAILURE_LINES.slice(3)].join("\n");
}

// Lines of exactly `chars` characters with their newline, so sizes are exact.
const sized = (count: number, chars: number, prefix = "line"): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`.padEnd(chars - 1, "."));

describe("renderShellLines", () => {
  it("drops only bun passing-test records behind one counted marker and keeps every diff, code-frame, and console line", () => {
    const result = renderShellLines("bun test x.test.ts", complete(bunFailureOutput(250)), false);
    expect(result.compressed).toBe(true);
    expect(result.output).toBe([...BUN_FAILURE_LINES.slice(0, 3), "[... 250 lines omitted ...]", ...BUN_FAILURE_LINES.slice(3)].join("\n"));
  });

  it("returns test-runner output of 200 lines or fewer and other output of 28,000 bytes or fewer unchanged", () => {
    const failing = bunFailureOutput(150);
    expect(renderShellLines("bun test", complete(failing), false)).toEqual({ output: failing, compressed: false });
    const generic = sized(2_800, 10).join("\n");
    expect(renderShellLines("make", complete(generic), false)).toEqual({ output: generic, compressed: false });
  });

  it("counts UTF-8 bytes, so multibyte output short in characters still keeps its middle error line within the byte cap", () => {
    // 2,000 lines of 10 characters and 19 bytes with their newline: 20,000 characters, 38,000 bytes.
    const lines = Array.from({ length: 2_000 }, (_, index) => index === 1_000 ? "error: mid" : "\u00e9".repeat(9));
    const result = renderShellLines("make", complete(lines.join("\n")), false);
    expect(result.compressed).toBe(true);
    expect(result.output).toContain("\nerror: mid\n");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(30_000);
  });

  it("keeps a final line longer than the tail window whole", () => {
    const last = `FINAL_RESULT ${"y".repeat(13_000)}`;
    const lines = [...sized(3_000, 10), last];
    const result = renderShellLines("make", complete(lines.join("\n")), false);
    expect(result.output.endsWith(`[... 2400 lines omitted ...]\n${last}`)).toBe(true);
  });

  it("keeps the first 6,000 and the last 12,000 characters of larger generic output and marks each dropped run around error and warning lines", () => {
    // 3,000 lines of 10 characters: the head is lines 0-599 and the tail lines 1800-2999.
    const lines = sized(3_000, 10).map((line, index) => index === 1_000 ? "warning: a" : index === 1_500 ? "error: b" : line);
    const result = renderShellLines("make", complete(lines.join("\n")), false);
    expect(result.compressed).toBe(true);
    expect(result.output).toBe([
      ...lines.slice(0, 600),
      "[... 400 lines omitted ...]",
      "warning: a",
      "[... 499 lines omitted ...]",
      "error: b",
      "[... 299 lines omitted ...]",
      ...lines.slice(1_800),
    ].join("\n"));
  });

  it("merges a line gap with the dropped runs that border it into one summed marker", () => {
    const head = sized(1_000, 10, "head");
    const tail = sized(2_000, 10, "tail");
    const result = renderShellLines("seq", { head, gap: { unit: "lines", count: 1000 }, tail }, false);
    expect(result.output).toBe([...head.slice(0, 600), "[... 2200 lines omitted ...]", ...tail.slice(800)].join("\n"));
  });

  it("keeps a character gap after a fragment of one long line as its own marker and counts the lines after it", () => {
    const fragment = "x".repeat(1_000);
    // The gap ends at character 4,001, so the head runs on through tail line 199.
    const tail = sized(2_500, 10, "tail");
    const result = renderShellLines("cat", { head: [fragment], gap: { unit: "characters", count: 3000 }, tail }, false);
    expect(result.output).toBe([fragment, "[... 3000 characters omitted ...]", ...tail.slice(0, 200), "[... 1100 lines omitted ...]", ...tail.slice(1_300)].join("\n"));
  });

  it("keeps every line in raw mode but still marks the capture gap", () => {
    const head = Array.from({ length: 300 }, (_, index) => `head ${index}`);
    const result = renderShellLines("seq", { head, gap: { unit: "lines", count: 7 }, tail: ["last"] }, true);
    expect(result).toEqual({ output: [...head, "[... 7 lines omitted ...]", "last"].join("\n"), compressed: false });
  });
});
