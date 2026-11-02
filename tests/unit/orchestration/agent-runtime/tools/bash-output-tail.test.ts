import { describe, expect, it } from "bun:test";

import { createStreamingSanitizer } from "../../../../../src/infra/control-characters.js";
import { createShellOutputAccumulator, readBackgroundLog, readBackgroundProcessOutput, readBoundedSpoolTail, readSpoolGrowth, shellObservation } from "../../../../../src/orchestration/agent-runtime/tools/bash-output-tail.js";

const CHUNK_BYTES = 64 * 1024;

interface SyntheticSpool {
  open(): { size: number; slice(start?: number, end?: number): Blob };
  reads: Array<{ start: number; end: number }>;
  size: number;
}

function syntheticSpool(text: string): SyntheticSpool {
  const bytes = new TextEncoder().encode(text);
  const reads: Array<{ start: number; end: number }> = [];
  return {
    open: () => ({
      size: bytes.byteLength,
      slice: (start = 0, end = bytes.byteLength) => {
        reads.push({ start, end });
        return new Blob([bytes.slice(start, end)]);
      },
    }),
    reads,
    size: bytes.byteLength,
  };
}

function expectSanitizedAtEveryBoundary(control: string): void {
  for (let split = 0; split <= control.length; split++) {
    let output = "";
    const sanitizer = createStreamingSanitizer((text) => { output += text; });
    const raw = `before${control}after`;
    sanitizer.push(raw.slice(0, "before".length + split));
    sanitizer.push(raw.slice("before".length + split));
    sanitizer.finish();
    expect(output).toBe("beforeafter");
  }
}

describe("streaming external-output sanitizer", () => {
  it("consumes control sequences split at every boundary", () => {
    const esc = "\u001b";
    for (const control of [
      `${esc}Ppayload${esc}\\`, `${esc}Xpayload${esc}\\`, `${esc}^payload${esc}\\`, `${esc}_payload${esc}\\`,
      `\u0090payload\u009c`, `\u0098payload\u009c`, `\u009epayload\u009c`, `\u009fpayload\u009c`,
      `${esc}]title\u0007`, `${esc}]title${esc}\\`, `\u009dtitle\u0007`, `\u009dtitle\u009c`,
      `${esc}[31m`, `\u009b31m`, `${esc}c`, `${esc} 0`,
    ]) expectSanitizedAtEveryBoundary(control);
  });

  it("does not emit incomplete control-string payloads", () => {
    for (const control of ["\u001bPpayload", "\u001bXpayload", "\u001b^payload", "\u001b_payload", "\u001b]payload", "\u0090payload", "\u0098payload", "\u009dpayload", "\u009epayload", "\u009fpayload"]) {
      let output = "";
      const sanitizer = createStreamingSanitizer((text) => { output += text; });
      sanitizer.push(`before${control}`);
      sanitizer.finish();
      expect(output).toBe("before");
    }
  });
});

describe("background Bash spool scan", () => {
  it("scans forward in fixed-size reads for a small default tail", async () => {
    const spool = syntheticSpool(Array.from({ length: 100_000 }, (_, index) => `line-${index}`).join("\n"));

    const output = await readBackgroundProcessOutput("synthetic.log", { limit: 3 }, spool.open);

    expect(output).toContain("line-99997\nline-99998\nline-99999");
    expect(spool.reads.reduce((bytes, read) => bytes + read.end - read.start, 0)).toBe(spool.size);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("ignores a terminal newline when selecting the newest line", async () => {
    const spool = syntheticSpool("first\nsecond\n");

    expect((await readBoundedSpoolTail(spool.open(), 1)).lines).toEqual(["second"]);
    expect((await readBoundedSpoolTail(spool.open(), 2)).lines).toEqual(["first", "second"]);
  });

  it("preserves intentional blank lines before a terminal newline", async () => {
    const spool = syntheticSpool("first\n\nthird\n");

    expect((await readBoundedSpoolTail(spool.open(), 3)).lines).toEqual(["first", "", "third"]);
  });

  it("normalizes carriage returns before selecting the newest line", async () => {
    const spool = syntheticSpool("a\rb\n");

    expect((await readBoundedSpoolTail(spool.open(), 1)).lines).toEqual(["b"]);
  });

  it("retains only the requested sanitized line ring", async () => {
    const spool = syntheticSpool(Array.from({ length: 1_000 }, (_, index) => `line-${index}`).join("\n"));

    const output = await readBackgroundProcessOutput("synthetic.log", { limit: 200 }, spool.open);

    expect(output).toContain("line-800");
    expect(output).toContain("line-999");
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("scans a high offset in bounded chunks and reports the total line count", async () => {
    const spool = syntheticSpool(Array.from({ length: 30_000 }, (_, index) => `line-${index}`).join("\n"));

    const output = await readBackgroundProcessOutput("synthetic.log", { offset: 29_990, limit: 3 }, spool.open);

    expect(output).toContain("Lines 29991-29993 of 30000");
    expect(output).toContain("line-29990\nline-29991\nline-29992");
    expect(output.length).toBeLessThan(1_000);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("does not count a terminal newline as an extra offset line", async () => {
    const spool = syntheticSpool("first\nsecond\n");

    const output = await readBackgroundProcessOutput("synthetic.log", { offset: 1, limit: 1 }, spool.open);

    expect(output).toBe("Lines 2-2 of 2:\nsecond");
  });

  it("decodes UTF-8 and sanitizes ANSI sequences split across byte chunks", async () => {
    const first = "x".repeat(CHUNK_BYTES - 2);
    const second = "éneedle";
    const third = "y".repeat(CHUNK_BYTES - 10);
    const fourth = "\u001b[31mneedle\u001b[0m";
    const spool = syntheticSpool([first, second, third, fourth].join("\n"));

    const output = await readBackgroundProcessOutput("synthetic.log", { limit: 10, query: "needle" }, spool.open);

    expect(output).toBe("2 matching line(s):\n2: éneedle\n4: needle");
    expect(output).not.toContain("\u001b");
  });

  it("reports the total line count when a query has no matches", async () => {
    const spool = syntheticSpool(Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join("\n"));

    const output = await readBackgroundProcessOutput("synthetic.log", { limit: 100, query: "absent" }, spool.open);

    expect(output).toBe("No lines contain 'absent' (searched 20000 lines).");
  });

  it("bounds retained output for one multi-megabyte line", async () => {
    const spool = syntheticSpool(`${"z".repeat(3 * 1024 * 1024)}needle`);

    const output = await readBackgroundProcessOutput("synthetic.log", { limit: 1, query: "needle" }, spool.open);

    expect(output).toContain("1 matching line(s):\n1: ");
    expect(output).toContain("...[line truncated]");
    expect(output).toContain("(1 oversized line(s) truncated)");
    expect(output.length).toBeLessThan(70 * 1024);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("treats a missing or not-yet-flushed spool as empty output", async () => {
    const missing = () => {
      const error = new Error("missing");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    };
    const halfFlushed = () => ({ size: 20, slice: () => new Blob() });

    expect(await readBackgroundProcessOutput("missing.log", { limit: 100 }, missing)).toBe("Lines 1-1 of 1:\n");
    expect(await readBackgroundProcessOutput("half.log", { limit: 100 }, halfFlushed)).toBe("Lines 1-1 of 1:\n");
  });

  it("reads a multi-megabyte growth burst in streaming chunks across UTF-8 and ANSI boundaries", async () => {
    const prefix = "x".repeat(CHUNK_BYTES - 1);
    const spool = syntheticSpool(`${prefix}é\u001b[31mred\u001b[0m${"y".repeat(3 * 1024 * 1024)}`);
    const decoder = new TextDecoder();
    let output = "";
    let emits = 0;
    let largestPayload = 0;
    const sanitizer = createStreamingSanitizer((text) => {
      emits++;
      largestPayload = Math.max(largestPayload, text.length);
      output = (output + text).slice(-4 * 1024);
    });

    const offset = await readSpoolGrowth(spool.open(), 0, (bytes) => sanitizer.push(decoder.decode(bytes, { stream: true })));
    sanitizer.push(decoder.decode());
    sanitizer.finish();

    expect(offset).toBe(spool.size);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(emits).toBeGreaterThan(1);
    expect(emits).toBeLessThanOrEqual(spool.reads.length + 1);
    expect(largestPayload).toBeLessThanOrEqual(CHUNK_BYTES + 1);
    expect(output).not.toContain("\u001b");
    expect(output.length).toBeLessThanOrEqual(4 * 1024);
  });

  it("settles one multi-megabyte live accumulation into a line-aligned bounded view without rereading its spool", async () => {
    const text = Array.from({ length: 200_000 }, (_, index) => `${index + 1}`).join("\n") + "\n";
    const spool = syntheticSpool(text);
    const decoder = new TextDecoder();
    const accumulator = createShellOutputAccumulator();
    const sanitizer = createStreamingSanitizer((chunk) => accumulator.push(chunk));
    const offset = await readSpoolGrowth(spool.open(), 0, (bytes) => {
      accumulator.addBytes(bytes);
      sanitizer.push(decoder.decode(bytes, { stream: true }));
    });
    sanitizer.push(decoder.decode());
    sanitizer.finish();

    const first = accumulator.finalize("synthetic.log");
    const second = accumulator.finalize("synthetic.log");
    const view = first.foreground;
    if (view.kind !== "bounded") throw new Error("expected a bounded view");
    const headLines = view.head.split("\n");
    const tailLines = view.tail.split("\n");

    expect(offset).toBe(spool.size);
    expect(first).toBe(second);
    expect(headLines.at(-1)).toBe("");
    expect(tailLines.at(-1)).toBe("");
    expect(headLines[0]).toBe("1");
    expect(tailLines.at(-2)).toBe("200000");
    expect(view.gap).toEqual({ unit: "lines", count: Number(tailLines[0]) - Number(headLines.at(-2)) - 1 });
    expect(view.file).toEqual({ path: "synthetic.log", bytes: spool.size, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") });
    expect(first.executionOutputTail).toEndWith("200000\n");
    expect(spool.reads.reduce((bytes, read) => bytes + read.end - read.start, 0)).toBe(spool.size);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("counts the exact character gap of single-line multi-megabyte output delivered as single-character chunks", () => {
    const accumulator = createShellOutputAccumulator();
    const total = 2 * 1024 * 1024;
    for (let index = 0; index < total; index++) accumulator.push("x");
    accumulator.addBytes(new TextEncoder().encode("x".repeat(total)));
    const result = accumulator.finalize("small-chunks.log");
    const view = result.foreground;
    if (view.kind !== "bounded") throw new Error("expected a bounded view");
    expect(view.gap).toEqual({ unit: "characters", count: total - view.head.length - view.tail.length });
    expect(view.head.length + view.tail.length).toBe(256 * 1024);
    expect(view.file.bytes).toBe(total);
    expect(result.executionOutputTail.length).toBe(256 * 1024);
  });

  it("shapes every real line of a settled capture, outer blank lines included, and adds none", () => {
    const settle = (text: string) => {
      const accumulator = createShellOutputAccumulator();
      accumulator.push(text);
      accumulator.addBytes(new TextEncoder().encode(text));
      return accumulator.finalize("shaped.log").foreground;
    };
    expect(shellObservation("echo", settle("\n\nalpha\n\n"), false)).toEqual({ text: "\n\nalpha\n" });
    expect(shellObservation("echo", settle(" \n\n"), false)).toEqual({ text: "" });

    const numbered = Array.from({ length: 200_000 }, (_, index) => `${index + 1}`);
    const padded = settle(`\n\n${numbered.join("\n")}\n\n\n`);
    expect(shellObservation("seq", padded, false).text).toBe(["", "", ...numbered.slice(0, 28), "[... 199934 lines omitted ...]", ...numbered.slice(-38), "", ""].join("\n"));

    // The last line fills the tail window, so the bounded tail holds no line.
    const short = Array.from({ length: 199 }, (_, index) => `line ${index + 1}`);
    const exactly200 = settle(`${short.join("\n")}\n${"y".repeat(1_100_000)}\n`);
    expect(exactly200).toMatchObject({ kind: "bounded", tail: "", gap: { unit: "lines", count: 1 } });
    expect(shellObservation("cat", exactly200, false).text).toBe([...short, "[... 1 line omitted ...]"].join("\n"));
  });

  it("settles background tails without a full-spool text read", async () => {
    const spool = syntheticSpool(`${"old\n".repeat(500_000)}\u001b[32mfinal\u001b[0m`);
    const result = await readBackgroundLog("synthetic.log", spool.open);

    expect(result.notificationTail).toContain("final");
    expect(result.executionOutputTail).toContain("final");
    expect(spool.reads.reduce((bytes, read) => bytes + read.end - read.start, 0)).toBe(spool.size);
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("does not expose a DCS payload that spans the retained background suffix", async () => {
    const spool = syntheticSpool(`safe\u001bP${"forged".repeat(190_000)}\u001b\\tail`);
    const result = await readBackgroundLog("synthetic.log", spool.open);

    expect(result.notificationTail).toBe("safetail");
    expect(result.executionOutputTail).toBe("safetail");
    expect(Math.max(...spool.reads.map((read) => read.end - read.start))).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it("treats a missing settlement spool as empty", async () => {
    const missing = () => {
      const error = new Error("missing");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    };

    expect(await readBackgroundLog("missing.log", missing)).toEqual({ notificationTail: "", executionOutputTail: "" });
  });
});
