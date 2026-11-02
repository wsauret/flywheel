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

describe("renderShellLines", () => {
  it("drops only bun passing-test records behind one counted marker and keeps every diff, code-frame, and console line", () => {
    const result = renderShellLines("bun test x.test.ts", complete(bunFailureOutput(250)), false);
    expect(result.compressed).toBe(true);
    expect(result.output).toBe([...BUN_FAILURE_LINES.slice(0, 3), "[... 250 lines omitted ...]", ...BUN_FAILURE_LINES.slice(3)].join("\n"));
  });

  it("returns output of 200 lines or fewer unchanged for every command", () => {
    const failing = bunFailureOutput(100);
    expect(renderShellLines("bun test", complete(failing), false)).toEqual({ output: failing, compressed: false });
    const generic = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(renderShellLines("make", complete(generic), false)).toEqual({ output: generic, compressed: false });
  });

  it("marks each dropped run of generic output with its exact count around error and warning lines", () => {
    const lines = Array.from({ length: 400 }, (_, index) => index === 100 ? "warning: alpha" : index === 250 ? "error: beta" : `line ${index}`);
    const result = renderShellLines("make", complete(lines.join("\n")), false);
    expect(result.compressed).toBe(true);
    expect(result.output).toBe([
      ...lines.slice(0, 30),
      "[... 70 lines omitted ...]",
      "warning: alpha",
      "[... 149 lines omitted ...]",
      "error: beta",
      "[... 109 lines omitted ...]",
      ...lines.slice(360),
    ].join("\n"));
  });

  it("merges a line gap with the dropped runs that border it into one summed marker", () => {
    const head = Array.from({ length: 50 }, (_, index) => `head ${index}`);
    const tail = Array.from({ length: 50 }, (_, index) => `tail ${index}`);
    const result = renderShellLines("seq", { head, gap: { unit: "lines", count: 1000 }, tail }, false);
    expect(result.output).toBe([...head.slice(0, 30), "[... 1030 lines omitted ...]", ...tail.slice(10)].join("\n"));
  });

  it("keeps a character gap after a fragment of one long line as its own marker and counts the lines after it", () => {
    const fragment = "x".repeat(1_000);
    const tail = Array.from({ length: 250 }, (_, index) => `tail ${index}`);
    const result = renderShellLines("cat", { head: [fragment], gap: { unit: "characters", count: 5000 }, tail }, false);
    expect(result.output).toBe([fragment, "[... 5000 characters omitted ...]", ...tail.slice(0, 29), "[... 181 lines omitted ...]", ...tail.slice(210)].join("\n"));
  });

  it("keeps every line in raw mode but still marks the capture gap", () => {
    const head = Array.from({ length: 300 }, (_, index) => `head ${index}`);
    const result = renderShellLines("seq", { head, gap: { unit: "lines", count: 7 }, tail: ["last"] }, true);
    expect(result).toEqual({ output: [...head, "[... 7 lines omitted ...]", "last"].join("\n"), compressed: false });
  });
});
