import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Hash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { readDefinition } from "../../../../../../src/orchestration/agent-runtime/tools/read/read.js";
import { readTextWindows } from "../../../../../../src/orchestration/agent-runtime/tools/read/read-text-windows.js";
import { FileReadLedger } from "../../../../../../src/orchestration/agent-runtime/tools/files/file-read-ledger.js";
import { canonicalMutationPath } from "../../../../../../src/infra/process/locks/file-mutation-queue.js";
import * as treeSitter from "../../../../../../src/orchestration/agent-runtime/tools/read/tree-sitter-code.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { makeContext } from "../_fixtures.js";

const temporaryDirectory = temporaryDirectories();
const openStream = fs.createReadStream;
const readWhole = fsp.readFile;

afterEach(() => {
  mock.restore();
});

function writeFile(bytes: Uint8Array, extension: string): string {
  const path = join(temporaryDirectory("flywheel-read-stream-"), `file${extension}`);
  fs.writeFileSync(path, bytes);
  return path;
}

/** Writes `bytes` to a file and counts how the read tool acquires it: the
 *  streams it opens, which deliver `chunkSize` bytes at a time, the whole
 *  snapshots it reads, and the bytes it scans through its streams. A whole
 *  snapshot of the file fails the read unless `allowSnapshot` is set, so a
 *  non-AST read that regresses to a snapshot fails its case. */
function source(bytes: Uint8Array, chunkSize = 7, extension = ".txt", allowSnapshot = false) {
  const path = writeFile(bytes, extension);
  let streams = 0;
  let scanned = 0;
  spyOn(fs, "createReadStream").mockImplementation((file, options) => {
    if (file !== path) return openStream(file, options);
    streams++;
    const stream = openStream(file, { highWaterMark: chunkSize });
    stream.on("data", (chunk) => { scanned += chunk.length; });
    return stream;
  });
  let snapshots = 0;
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: readFile's overloads return a Buffer or a string by their options, which one scripted function cannot state
  spyOn(fsp, "readFile").mockImplementation(((file: Parameters<typeof fsp.readFile>[0], options: Parameters<typeof fsp.readFile>[1] = null) => {
    if (file !== path) return readWhole(file, options);
    snapshots++;
    if (!allowSnapshot) return Promise.reject(new Error("Non-AST reads must not acquire a full snapshot"));
    return readWhole(file, options);
  }) as typeof fsp.readFile);
  return { path, counts: () => ({ streams, snapshots, scanned }) };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("streamed line windows", () => {
  it.each([false, true])("rejects at the abort only after the source's cancellation settles (aborted before the read=%s)", async (abortedBefore) => {
    const bytes = encode("selected\n");
    const abort = new AbortController();
    const reason = new Error("Stopped by user");
    const waiting = Promise.withResolvers<void>();
    const pendingPull = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<void>();
    const sourceController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const cancelReasons: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController.resolve(controller);
        controller.enqueue(bytes);
      },
      pull() {
        waiting.resolve();
        return pendingPull.promise;
      },
      cancel(cancelReason) {
        cancelReasons.push(cancelReason);
        pendingPull.resolve();
        return cancellation.promise;
      },
    });
    const update = spyOn(Hash.prototype, "update");
    if (abortedBefore) abort.abort(reason);
    let settled = false;
    const read = readTextWindows(stream, [{ startLine: 1, endLine: 1 }], abort.signal).finally(() => { settled = true; });
    try {
      if (!abortedBefore) {
        await waiting.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(update).toHaveBeenCalledWith(bytes);
        abort.abort(reason);
      }
      // Let native stream abort jobs drain while the source's cancellation remains held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelReasons).toEqual([reason]);
      expect(stream.locked).toBe(true);
      expect(settled).toBe(false);
      cancellation.resolve();
      await expect(read).rejects.toBe(reason);
      expect(stream.locked).toBe(false);
    } finally {
      cancellation.resolve();
      // A failing regression must release the pre-fix iterator without manufacturing EOF.
      (await sourceController.promise).error(reason);
      pendingPull.resolve();
      await read.catch(() => undefined);
    }
  });
});

describe("streamed read acquisition", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("ends an aborted read as interrupted, with no coverage, and closes its stream (multi-range=%s, aborted at acquisition=%s)", async (multiRange, abortAtAcquisition) => {
    // Many chunks remain when the abort lands, so the read cannot reach the end of the file first.
    const bytes = encode("selected\n".repeat(4096));
    const path = writeFile(bytes, multiRange ? ".ts" : ".txt");
    const abort = new AbortController();
    const reason = new Error("Stopped by user");
    const opened: fs.ReadStream[] = [];
    spyOn(fs, "createReadStream").mockImplementation((file, options) => {
      if (file !== path) return openStream(file, options);
      if (abortAtAcquisition) abort.abort(reason);
      const stream = openStream(file, { highWaterMark: 7 });
      opened.push(stream);
      // The read attaches its own listener first, so the abort lands after it took the first chunk.
      queueMicrotask(() => stream.once("data", () => { abort.abort(reason); }));
      return stream;
    });
    const ledger = new FileReadLedger();
    const recordRead = spyOn(ledger, "recordRead");
    const input = multiRange ? { path: `${path}:1-1,3-3` } : { path, offset: 0, limit: 1 };
    const result = await readDefinition.execute(input, makeContext({ signal: abort.signal, readLedger: ledger }));
    expect(result.outcome).toBe("interrupted");
    expect(result.content).toContain("interrupted");
    expect(result.content).not.toContain("Common causes");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.destroyed).toBe(true);
    expect(recordRead).not.toHaveBeenCalled();
    expect(ledger.staleness(canonicalMutationPath(path), bytes)).toEqual({ kind: "unread" });
  });

  it.each([false, true])("scans the full fingerprint without retaining an unselected long line (multi-range=%s)", async (multiRange) => {
    const bytes = encode(`selected\n${"x".repeat(4 * 1024 * 1024)}\ntail`);
    const acquisition = source(bytes, 4096);
    const ledger = new FileReadLedger();
    const originalDecode = TextDecoder.prototype.decode;
    const originalSplit = String.prototype.split;
    const splitWithSeparator: (this: string, separator: string | RegExp, limit?: number) => string[] = originalSplit;
    const originalJoin = Array.prototype.join;
    let largestDecode = 0;
    let largestSplit = 0;
    let largestJoin = 0;
    const decode = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
      largestDecode = Math.max(largestDecode, input?.byteLength ?? 0);
      return originalDecode.call(this, input, options);
    });
    const split = spyOn(String.prototype, "split").mockImplementation(function (this: string, separator, limit) {
      largestSplit = Math.max(largestSplit, this.length);
      if (typeof separator === "string") return splitWithSeparator.call(this, separator, limit);
      return originalSplit.call(this, separator, limit);
    });
    const joinSpy = spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator) {
      const joined = originalJoin.call(this, separator);
      largestJoin = Math.max(largestJoin, joined.length);
      return joined;
    });
    try {
      const result = await readDefinition.execute(multiRange ? { path: `${acquisition.path}:1-1,3-3` } : { path: acquisition.path, offset: 0, limit: 1 }, makeContext({ readLedger: ledger }));
      expect(result.content).toBe(multiRange ? "1|selected\n\n...\n\n3|tail" : "1|selected\n(2 more lines not shown. Use offset=1 to continue reading.)");
      expect(acquisition.counts()).toEqual({ streams: 1, snapshots: 0, scanned: bytes.length });
      expect(largestDecode).toBeLessThanOrEqual(4096);
      expect(largestSplit).toBeLessThanOrEqual(4096);
      expect(largestJoin).toBeLessThanOrEqual(4096);
    } finally {
      decode.mockRestore();
      split.mockRestore();
      joinSpy.mockRestore();
    }
    const canonical = canonicalMutationPath(acquisition.path);
    expect(ledger.staleness(canonical, bytes, { start: 1, end: 1 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 2, end: 2 })).toEqual({ kind: "uncovered", lines: { start: 2, end: 2 } });
    const changed = bytes.slice();
    changed[changed.length - 1] = 0x58;
    expect(ledger.staleness(canonical, changed)).toEqual({ kind: "changed", sincePosition: 0 });
  });

  it.each([1, 2, 3, 7])("preserves decoder semantics across %i-byte chunks", async (chunkSize) => {
    const bytes = new Uint8Array([...encode("\uFEFFfirst\r\né🙂\rsecond\n\uFEFF"), 0xc3, 0x28, 0xe2, 0x82]);
    const expected = new TextDecoder().decode(bytes).split("\n");
    const input = source(bytes, chunkSize);
    const ledger = new FileReadLedger();
    const result = await readDefinition.execute({ path: `${input.path}:raw`, offset: 1, limit: 2 }, makeContext({ readLedger: ledger }));
    expect(result.content).toBe(`(Starting from line 2 of 3 total lines)\n${expected.slice(1).join("\n")}`);
    expect(input.counts().scanned).toBe(bytes.length);
    expect(ledger.staleness(canonicalMutationPath(input.path), bytes, { start: 2, end: 3 })).toBeUndefined();
  });

  it.each(["", "\n", "one\n", "one\r\n", "\uFEFF"])("counts empty and trailing lines in %j", async (text) => {
    const bytes = encode(text);
    const lines = new TextDecoder().decode(bytes).split("\n");
    const ledger = new FileReadLedger();
    const input = source(bytes, 1);
    const result = await readDefinition.execute({ path: input.path, offset: 0, limit: 10 }, makeContext({ readLedger: ledger }));
    expect(result.content).toBe(lines.map((line, i) => `${i + 1}|${line}`).join("\n"));
    expect(ledger.staleness(canonicalMutationPath(input.path), bytes, { start: 1, end: 20 })).toBeUndefined();
  });

  it.each([8191, 8192])("detects NUL only within the first 8192 bytes: index %i", async (index) => {
    const bytes = encode(`${"x".repeat(index)}\0\nlast`);
    const input = source(bytes, 3);
    const result = await readDefinition.execute({ path: input.path, offset: 1, limit: 1 }, makeContext());
    expect(result.outcome).toBe(index < 8192 ? "error" : "ok");
    if (index < 8192) expect(result.content).toContain("appears to be binary");
    else expect(result.content).toBe("(Starting from line 2 of 2 total lines)\n2|last");
  });

  it.each([false, true])("keeps multi-range order, overlap, open ends, notices, and coverage (raw=%s)", async (raw) => {
    const bytes = encode("one\ntwo\nthree\nfour\n");
    const input = source(bytes, 2, ".ts");
    const ledger = new FileReadLedger();
    const path = input.path;
    const result = await readDefinition.execute({ path: `${path}:2-2,4-5,99-${raw ? ":raw" : ""}` }, makeContext({ readLedger: ledger }));
    const selected = raw ? "two\n\n...\n\nfour\n" : "2|two\n\n...\n\n4|four\n5|";
    expect(result.content).toBe(`${selected}\n[Range 99 is beyond end of file (5 lines total); skipped]`);
    expect(input.counts()).toEqual({ streams: 1, snapshots: 0, scanned: bytes.length });
    const canonical = canonicalMutationPath(path);
    expect(ledger.staleness(canonical, bytes, { start: 2, end: 2 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 4, end: 5 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 3, end: 3 })).toEqual({ kind: "uncovered", lines: { start: 3, end: 3 } });
    expect(ledger.staleness(canonical, bytes, { start: 1, end: 1 })).toEqual({ kind: "uncovered", lines: { start: 1, end: 1 } });
    const open = await readDefinition.execute({ path: `${path}:2-2,2-2,4-${raw ? ":raw" : ""}` }, makeContext());
    expect(open.content).toBe(selected);
  });

  it("preserves single-range context and beyond-EOF output", async () => {
    const bytes = encode("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
    const input = source(bytes);
    const context = await readDefinition.execute({ path: `${input.path}:3-3` }, makeContext());
    expect(context.content).toBe("(Starting from line 2 of 8 total lines)\n2|two\n3|three\n4|four\n5|five\n6|six\n(2 more lines not shown. Use offset=6 to continue reading.)");
    const beyond = await readDefinition.execute({ path: input.path, offset: 99, limit: 1 }, makeContext());
    expect(beyond.content).toBe("(Starting from line 9 of 8 total lines)\n");
  });

  // Each numbered line of this file is 22 bytes, so a budget decides exactly which whole lines fit.
  const twentyByteLines = (count: number) => encode(Array.from({ length: count }, (_, i) => `line ${String(i + 1).padStart(2, "0")} xxxxxxxxxxxx`).join("\n"));

  it("ends a single-range window at a whole line within the byte budget and records only the lines it returned", async () => {
    const bytes = twentyByteLines(12);
    const input = source(bytes);
    const ledger = new FileReadLedger();
    const budget = 180;
    const result = await readDefinition.execute({ path: `${input.path}:3-8` }, makeContext({ readLedger: ledger, outputByteBudget: budget }));
    expect(result.content).toBe("(Starting from line 2 of 12 total lines)\n2|line 02 xxxxxxxxxxxx\n3|line 03 xxxxxxxxxxxx\n(Output limit reached at line 3 of the requested 2-11. Use offset=3 to continue reading.)");
    expect(Buffer.byteLength(String(result.content))).toBeLessThanOrEqual(budget);
    const canonical = canonicalMutationPath(input.path);
    expect(ledger.staleness(canonical, bytes, { start: 2, end: 3 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 4, end: 4 })).toEqual({ kind: "uncovered", lines: { start: 4, end: 4 } });
    // A window that every line fits says only that the file continues.
    const fits = await readDefinition.execute({ path: input.path, offset: 0, limit: 2 }, makeContext({ outputByteBudget: budget }));
    expect(fits.content).toBe("1|line 01 xxxxxxxxxxxx\n2|line 02 xxxxxxxxxxxx\n(10 more lines not shown. Use offset=2 to continue reading.)");
  });

  it("draws multi-range windows from one budget in order and lists ranges it could not show", async () => {
    const bytes = twentyByteLines(16);
    const input = source(bytes);
    const ledger = new FileReadLedger();
    const budget = 310;
    const result = await readDefinition.execute({ path: `${input.path}:1-2,5-12,14-14,40-40` }, makeContext({ readLedger: ledger, outputByteBudget: budget }));
    expect(result.content).toBe([
      "1|line 01 xxxxxxxxxxxx\n2|line 02 xxxxxxxxxxxx\n\n...\n\n5|line 05 xxxxxxxxxxxx\n6|line 06 xxxxxxxxxxxx",
      "(Output limit reached at line 6 of the requested 5-12. Use offset=6 to continue reading.)",
      "[Range 14-14 not shown: the output limit was reached]",
      "[Range 40-40 is beyond end of file (16 lines total); skipped]",
    ].join("\n"));
    expect(Buffer.byteLength(String(result.content))).toBeLessThanOrEqual(budget);
    const canonical = canonicalMutationPath(input.path);
    expect(ledger.staleness(canonical, bytes, { start: 1, end: 2 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 5, end: 6 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 7, end: 7 })).toEqual({ kind: "uncovered", lines: { start: 7, end: 7 } });
    expect(ledger.staleness(canonical, bytes, { start: 14, end: 14 })).toEqual({ kind: "uncovered", lines: { start: 14, end: 14 } });

    // Ranges keep the caller's order, also when it is not line order.
    const reversed = await readDefinition.execute({ path: `${input.path}:15-16,1-2` }, makeContext({ outputByteBudget: budget }));
    expect(reversed.content).toBe("15|line 15 xxxxxxxxxxxx\n16|line 16 xxxxxxxxxxxx\n\n...\n\n1|line 01 xxxxxxxxxxxx\n2|line 02 xxxxxxxxxxxx");
    const drawnInOrder = String((await readDefinition.execute({ path: `${input.path}:4-15,1-2` }, makeContext({ outputByteBudget: budget }))).content);
    expect(drawnInOrder).toStartWith("4|line 04 xxxxxxxxxxxx\n");
    expect(drawnInOrder).toEndWith("[Range 1-2 not shown: the output limit was reached]");

    // However many ranges the call names, the ranges it leaves out share one notice of each kind.
    const odd = Array.from({ length: 300 }, (_, i) => `${2 * i + 1}-${2 * i + 1}`).join(",");
    const cut = String((await readDefinition.execute({ path: `${input.path}:${odd}` }, makeContext({ outputByteBudget: 300 }))).content);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(300);
    expect(cut).toStartWith("1|line 01 xxxxxxxxxxxx\n\n...\n\n3|line 03 xxxxxxxxxxxx");
    expect(cut).toMatch(/\n\[\d+ ranges not shown, \d+-\d+ through 15-15: the output limit was reached\]\n\[292 ranges from 17-17 are beyond end of file \(16 lines total\); skipped\]$/u);
  });

  it("shows a marked prefix of a line longer than the budget, records no coverage for it, and moves past it", async () => {
    const bytes = encode(`short\n${"é".repeat(200)}\nafter`);
    const input = source(bytes);
    const ledger = new FileReadLedger();
    const budget = 260;
    const result = await readDefinition.execute({ path: input.path, offset: 1 }, makeContext({ readLedger: ledger, outputByteBudget: budget }));
    const text = String(result.content);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
    expect(text).toStartWith("(Starting from line 2 of 3 total lines)\n2|éé");
    expect(text).toMatch(/\n\[Line 2 is longer than the output limit: showed \d+ of its 400 bytes\. Use the bash tool to see the rest of the line\.\]\n\(Output limit reached at line 2 of the requested 2-3\. Use offset=2 to continue reading\.\)$/u);
    expect(text).not.toContain("�");
    const canonical = canonicalMutationPath(input.path);
    expect(ledger.staleness(canonical, bytes, { start: 2, end: 2 })).toEqual({ kind: "uncovered", lines: { start: 2, end: 2 } });
    const unshelled = await readDefinition.execute({ path: input.path, offset: 1 }, makeContext({ outputByteBudget: budget, capabilities: (term) => term !== "bash" }));
    expect(unshelled.content).not.toContain("bash");
    expect((await readDefinition.execute({ path: input.path, offset: 2 }, makeContext({ outputByteBudget: budget }))).content).toBe("(Starting from line 3 of 3 total lines)\n3|after");
  });

  it("reads unsupported summary fallback and unsupported symbol fallback in a window", async () => {
    const bytes = encode(Array.from({ length: 2002 }, (_, i) => `line ${i + 1}`).join("\n"));
    const input = source(bytes);
    const full = await readDefinition.execute({ path: input.path }, makeContext());
    expect(full.content).toStartWith("1|line 1\n");
    expect(full.content).toEndWith("2000|line 2000\n(2 more lines not shown. Use offset=2000 to continue reading.)");
    const symbol = await readDefinition.execute({ path: input.path, symbol: "missing" }, makeContext());
    expect(symbol.content).toStartWith("[Warning: structural map not available for this file type. Falling back to normal read.]\n1|line 1");
    expect(symbol.content).toEndWith("(2 more lines not shown. Use offset=2000 to continue reading.)");
    expect(input.counts().snapshots).toBe(0);
  });

  it("reads only the requested decorated Python method", async () => {
    const input = source(encode("LIMIT = 5\nclass Card:\n    @staticmethod\n    def _split(value):\n        return value\n    def _parse_value(self):\n        return LIMIT"), 7, ".py", true);
    const result = await readDefinition.execute({ path: input.path, symbol: "Card._split" }, makeContext());
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("[Symbol: _split (method), lines 3-5 of 7 total]\n3|    @staticmethod\n4|    def _split(value):\n5|        return value");
  });

  it.each(["map", "symbol", "summary", "truncated", "complete"])("preserves source output and coverage with one acquisition and fingerprint: %s", async (mode) => {
    const bytes = encode("export function greet() {\n  return 1;\n}\nconst last = 2;");
    const input = source(bytes, 2, ".ts", true);
    const path = input.path;
    const options = mode === "map" ? { map: true } : mode === "symbol" ? { symbol: "greet" }
      : mode === "summary" ? {} : { offset: 0, limit: mode === "truncated" ? 1 : 4 };
    const ledger = new FileReadLedger();
    const update = spyOn(Hash.prototype, "update");
    const digest = spyOn(Hash.prototype, "digest");
    const parse = spyOn(treeSitter, "withTreeSitterTree");
    let result;
    try {
      result = await readDefinition.execute({ path, ...options }, makeContext({ readLedger: ledger }));
      expect(input.counts()).toEqual({ streams: 0, snapshots: 1, scanned: 0 });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(bytes);
      expect(digest).toHaveBeenCalledTimes(1);
      if (mode === "complete") expect(parse).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
      digest.mockRestore();
      parse.mockRestore();
    }
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("export function greet()");
    if (mode === "map" || mode === "truncated") {
      expect(result.content).toContain("function greet: [1-3]");
      expect(result.content).toContain("const last: [4-4]");
    } else if (mode === "symbol") {
      expect(result.content).toStartWith("[Symbol: greet (function), lines 1-3 of 4 total]");
      expect(result.content).not.toContain("const last");
    } else {
      expect(result.content).toBe("1|export function greet() {\n2|  return 1;\n3|}\n4|const last = 2;");
    }
    const canonical = canonicalMutationPath(path);
    const end = mode === "truncated" ? 1 : mode === "symbol" ? 3 : 4;
    expect(ledger.staleness(canonical, bytes, { start: 1, end })).toBeUndefined();
    if (end < 4) {
      expect(ledger.staleness(canonical, bytes, { start: end + 1, end: 4 }))
        .toEqual({ kind: "uncovered", lines: { start: end + 1, end: 4 } });
    }
  });
});
