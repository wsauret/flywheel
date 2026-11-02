import { describe, expect, it, spyOn } from "bun:test";
import { Hash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { bridgeExternalPromise } from "../../../../../src/orchestration/agent-runtime/external-promise-bridge.js";
import { createReadDefinition } from "../../../../../src/orchestration/agent-runtime/tools/read.js";
import { FileReadLedger } from "../../../../../src/orchestration/agent-runtime/tools/file-read-ledger.js";
import { canonicalMutationPath } from "../../../../../src/infra/file-mutation-queue.js";
import * as treeSitter from "../../../../../src/orchestration/agent-runtime/tools/tree-sitter-code.js";
import { makeContext } from "./_fixtures.js";

function source(bytes: Uint8Array, chunkSize = 7, allowSnapshot = false) {
  let streams = 0;
  let snapshots = 0;
  let scanned = 0;
  const file = {
    size: bytes.length,
    async arrayBuffer() {
      snapshots++;
      if (!allowSnapshot) throw new Error("Non-AST reads must not acquire a full snapshot");
      return bytes.slice().buffer;
    },
    stream() {
      streams++;
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const chunk = bytes.subarray(offset, offset + chunkSize);
          offset += chunk.length;
          scanned += chunk.length;
          controller.enqueue(chunk);
        },
      });
    },
  };
  const tool = createReadDefinition({ operations: { readFile: async () => file } });
  return { tool, counts: () => ({ streams, snapshots, scanned }) };
}

const encode = (text: string) => new TextEncoder().encode(text);
const filePath = join(tmpdir(), "flywheel-read-stream.txt");

describe("streamed read acquisition", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("awaits stream cancellation without EOF or coverage (multi-range=%s, aborted at acquisition=%s)", async (multiRange, abortAtAcquisition) => {
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
    const ledger = new FileReadLedger();
    const recordRead = spyOn(ledger, "recordRead");
    const update = spyOn(Hash.prototype, "update");
    let acquisitions = 0;
    const tool = createReadDefinition({ operations: {
      async readFile() {
        acquisitions++;
        if (abortAtAcquisition) abort.abort(reason);
        return {
          size: bytes.length,
          arrayBuffer: async () => { throw new Error("Streamed reads must not acquire a snapshot"); },
          stream: () => stream,
        };
      },
    } });
    const path = multiRange ? filePath.replace(".txt", ".ts") : filePath;
    const input = multiRange ? { path: `${path}:1-1,3-3` } : { path, offset: 0, limit: 1 };
    const bridge = bridgeExternalPromise((signal) => tool.execute(input, makeContext({
      signal: AbortSignal.any([abort.signal, signal]), readLedger: ledger,
    })));
    let settled = false;
    const owned = Effect.runPromise(bridge.owned).then((result) => {
      settled = true;
      return result;
    });
    try {
      if (!abortAtAcquisition) {
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
      expect(bridge.settlement()).toBeNull();
      expect(recordRead).not.toHaveBeenCalled();
      cancellation.resolve();
      const result = await owned;
      expect(result.outcome).toBe("interrupted");
      expect(result.content).toContain("interrupted");
      expect(result.content).not.toContain("Common causes");
      expect(stream.locked).toBe(false);
      expect(acquisitions).toBe(1);
      expect(recordRead).not.toHaveBeenCalled();
      expect(ledger.staleness(canonicalMutationPath(path), bytes)).toEqual({ kind: "unread" });
    } finally {
      cancellation.resolve();
      // A failing regression must release the pre-fix iterator without manufacturing EOF.
      (await sourceController.promise).error(reason);
      pendingPull.resolve();
      await owned;
      recordRead.mockRestore();
      update.mockRestore();
    }
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
      const result = await acquisition.tool.execute(multiRange ? { path: `${filePath}:1-1,3-3` } : { path: filePath, offset: 0, limit: 1 }, makeContext({ readLedger: ledger }));
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
    const canonical = canonicalMutationPath(filePath);
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
    const result = await input.tool.execute({ path: `${filePath}:raw`, offset: 1, limit: 2 }, makeContext({ readLedger: ledger }));
    expect(result.content).toBe(`(Starting from line 2 of 3 total lines)\n${expected.slice(1).join("\n")}`);
    expect(input.counts().scanned).toBe(bytes.length);
    expect(ledger.staleness(canonicalMutationPath(filePath), bytes, { start: 2, end: 3 })).toBeUndefined();
  });

  it.each(["", "\n", "one\n", "one\r\n", "\uFEFF"])("counts empty and trailing lines in %j", async (text) => {
    const bytes = encode(text);
    const lines = new TextDecoder().decode(bytes).split("\n");
    const ledger = new FileReadLedger();
    const input = source(bytes, 1);
    const result = await input.tool.execute({ path: filePath, offset: 0, limit: 10 }, makeContext({ readLedger: ledger }));
    expect(result.content).toBe(lines.map((line, i) => `${i + 1}|${line}`).join("\n"));
    expect(ledger.staleness(canonicalMutationPath(filePath), bytes, { start: 1, end: 20 })).toBeUndefined();
  });

  it.each([8191, 8192])("detects NUL only within the first 8192 bytes: index %i", async (index) => {
    const bytes = encode(`${"x".repeat(index)}\0\nlast`);
    const input = source(bytes, 3);
    const result = await input.tool.execute({ path: filePath, offset: 1, limit: 1 }, makeContext());
    expect(result.outcome).toBe(index < 8192 ? "error" : "ok");
    if (index < 8192) expect(result.content).toContain("appears to be binary");
    else expect(result.content).toBe("(Starting from line 2 of 2 total lines)\n2|last");
  });

  it.each([false, true])("keeps multi-range order, overlap, open ends, notices, and coverage (raw=%s)", async (raw) => {
    const bytes = encode("one\ntwo\nthree\nfour\n");
    const input = source(bytes, 2);
    const ledger = new FileReadLedger();
    const path = filePath.replace(".txt", ".ts");
    const result = await input.tool.execute({ path: `${path}:2-2,4-5,99-${raw ? ":raw" : ""}` }, makeContext({ readLedger: ledger }));
    const selected = raw ? "two\n\n...\n\nfour\n" : "2|two\n\n...\n\n4|four\n5|";
    expect(result.content).toBe(`${selected}\n[Range 99 is beyond end of file (5 lines total); skipped]`);
    expect(input.counts()).toEqual({ streams: 1, snapshots: 0, scanned: bytes.length });
    const canonical = canonicalMutationPath(path);
    expect(ledger.staleness(canonical, bytes, { start: 2, end: 2 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 4, end: 5 })).toBeUndefined();
    expect(ledger.staleness(canonical, bytes, { start: 3, end: 3 })).toEqual({ kind: "uncovered", lines: { start: 3, end: 3 } });
    expect(ledger.staleness(canonical, bytes, { start: 1, end: 1 })).toEqual({ kind: "uncovered", lines: { start: 1, end: 1 } });
    const open = await input.tool.execute({ path: `${path}:2-2,2-2,4-${raw ? ":raw" : ""}` }, makeContext());
    expect(open.content).toBe(selected);
  });

  it("preserves single-range context and beyond-EOF output", async () => {
    const bytes = encode("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
    const input = source(bytes);
    const context = await input.tool.execute({ path: `${filePath}:3-3` }, makeContext());
    expect(context.content).toBe("(Starting from line 2 of 8 total lines)\n2|two\n3|three\n4|four\n5|five\n6|six\n(2 more lines not shown. Use offset=6 to continue reading.)");
    const beyond = await input.tool.execute({ path: filePath, offset: 99, limit: 1 }, makeContext());
    expect(beyond.content).toBe("(Starting from line 9 of 8 total lines)\n9|");
  });

  it("reads unsupported summary fallback in full and unsupported symbol fallback in a window", async () => {
    const bytes = encode(Array.from({ length: 2002 }, (_, i) => `line ${i + 1}`).join("\n"));
    const input = source(bytes);
    const full = await input.tool.execute({ path: filePath }, makeContext());
    expect(full.content).toContain("2002|line 2002");
    expect(full.content).not.toContain("more lines");
    const symbol = await input.tool.execute({ path: filePath, symbol: "missing" }, makeContext());
    expect(symbol.content).toStartWith("[Warning: structural map not available for this file type. Falling back to normal read.]\n1|line 1");
    expect(symbol.content).toEndWith("(2 more lines not shown. Use offset=2000 to continue reading.)");
    expect(input.counts().snapshots).toBe(0);
  });

  it("reads only the requested decorated Python method", async () => {
    const input = source(encode("LIMIT = 5\nclass Card:\n    @staticmethod\n    def _split(value):\n        return value\n    def _parse_value(self):\n        return LIMIT"), 7, true);
    const result = await input.tool.execute({ path: filePath.replace(".txt", ".py"), symbol: "Card._split" }, makeContext());
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("[Symbol: _split (method), lines 3-5 of 7 total]\n3|    @staticmethod\n4|    def _split(value):\n5|        return value");
  });

  it.each(["map", "symbol", "summary", "truncated", "complete"])("preserves source output and coverage with one acquisition and fingerprint: %s", async (mode) => {
    const bytes = encode("export function greet() {\n  return 1;\n}\nconst last = 2;");
    const input = source(bytes, 2, true);
    const path = filePath.replace(".txt", ".ts");
    const options = mode === "map" ? { map: true } : mode === "symbol" ? { symbol: "greet" }
      : mode === "summary" ? {} : { offset: 0, limit: mode === "truncated" ? 1 : 4 };
    const ledger = new FileReadLedger();
    const update = spyOn(Hash.prototype, "update");
    const digest = spyOn(Hash.prototype, "digest");
    const parse = spyOn(treeSitter, "withTreeSitterTree");
    let result;
    try {
      result = await input.tool.execute({ path, ...options }, makeContext({ readLedger: ledger }));
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
