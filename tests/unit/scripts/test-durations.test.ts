import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bandWeight, finishedFileDurations, readDurationRecord, recordDurations, writeDurationRecord } from "../../../scripts/test-durations.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { createShardProgress } from "../../../scripts/test-parallel.js";

const temporaryDirectory = temporaryDirectories();

// A root that does not exist: these functions read no file.
const ROOT = join("/scratch", "repo");
const file = (path: string) => join(ROOT, ...path.split("/"));

describe("finishedFileDurations", () => {
  // A band that the hang guard killed still measures what it finished, so
  // the next run plans from those files instead of by size again.
  it("keys each finished file by its POSIX path and leaves out the file a killed band was still running", () => {
    const timings = [
      { file: join("tests", "unit", "a.test.ts"), elapsedMs: 504.342, running: false },
      { file: "tests/unit/b & c.test.ts", elapsedMs: 1_250, running: false },
      { file: "tests/unit/stalled.test.ts", elapsedMs: 9_000, running: true },
    ];
    const measured = finishedFileDurations(timings, ROOT);
    expect(measured).toEqual(new Map([["tests/unit/a.test.ts", 504], ["tests/unit/b & c.test.ts", 1_250]]));
    const files = [file("tests/unit/a.test.ts"), file("tests/unit/b & c.test.ts"), file("tests/unit/stalled.test.ts")];
    expect(recordDurations(new Map([["tests/unit/stalled.test.ts", [700]]]), measured, files, ROOT)).toEqual(new Map([
      ["tests/unit/a.test.ts", [504]],
      ["tests/unit/b & c.test.ts", [1_250]],
      ["tests/unit/stalled.test.ts", [700]],
    ]));
  });
});

describe("bandWeight", () => {
  it("weighs a measured file by its duration and an unmeasured one by its size at the measured rate", () => {
    const files = [file("tests/unit/slow.test.ts"), file("tests/unit/fast.test.ts"), file("tests/unit/new.test.ts")];
    const sizes = new Map([[files[0]!, 1_000], [files[1]!, 3_000], [files[2]!, 2_000]]);
    // Two measured files: 4,000 bytes ran in 2,000 ms, so 0.5 ms per byte.
    const weight = bandWeight(files, new Map([["tests/unit/slow.test.ts", [1_800]], ["tests/unit/fast.test.ts", [200]]]), ROOT, (path) => sizes.get(path)!);
    expect(files.map(weight)).toEqual([1_800, 200, 1_000]);
  });

  // One stalled run must not move a file's work to another band.
  it("weighs a file by the lower median of its runs, so one stalled run does not count", () => {
    const files = [file("tests/unit/three.test.ts"), file("tests/unit/two.test.ts")];
    const weight = bandWeight(files, new Map([["tests/unit/three.test.ts", [300, 8_000, 320]], ["tests/unit/two.test.ts", [6_000, 400]]]), ROOT, () => 1);
    expect(files.map(weight)).toEqual([320, 400]);
  });

  it("weighs every file by its size when no file of the suite was measured", () => {
    const files = [file("tests/unit/a.test.ts"), file("tests/unit/b.test.ts")];
    const weight = bandWeight(files, new Map([["tests/unit/gone.test.ts", [900]]]), ROOT, (path) => path.endsWith("a.test.ts") ? 10 : 30);
    expect(files.map(weight)).toEqual([10, 30]);
  });
});

describe("recordDurations", () => {
  it("preserves a crashed file's old samples while recording the earlier completed file", () => {
    let now = 0;
    const progress = createShardProgress(() => now);
    progress.append("tests/unit/a.test.ts:\n(pass) first\n");
    now = 125;
    progress.append("tests/unit/b.test.ts:\n");
    now = 200;
    progress.finish("error: unexpected crash\n");
    const record = new Map([["tests/unit/a.test.ts", [100]], ["tests/unit/b.test.ts", [300, 310]]]);
    expect(recordDurations(record, finishedFileDurations(progress.snapshot(), ROOT), [file("tests/unit/a.test.ts"), file("tests/unit/b.test.ts")], ROOT)).toEqual(new Map([
      ["tests/unit/a.test.ts", [100, 125]],
      ["tests/unit/b.test.ts", [300, 310]],
    ]));
  });

  it("adds measured runs to the last three, keeps unmeasured files, and drops files the suite no longer has", () => {
    const files = [file("tests/unit/a.test.ts"), file("tests/unit/b.test.ts"), file("tests/unit/c.test.ts")];
    const record = new Map([["tests/unit/a.test.ts", [100, 110, 120]], ["tests/unit/b.test.ts", [200]], ["tests/unit/removed.test.ts", [300]]]);
    const measured = new Map([["tests/unit/a.test.ts", 150], ["tests/unit/c.test.ts", 50]]);
    expect(recordDurations(record, measured, files, ROOT)).toEqual(new Map([["tests/unit/a.test.ts", [110, 120, 150]], ["tests/unit/b.test.ts", [200]], ["tests/unit/c.test.ts", [50]]]));
  });
});

describe("writeDurationRecord", () => {
  it("stores a record that the next run reads back", () => {
    const path = join(temporaryDirectory("durations-"), "cache", "test-durations.json");
    writeDurationRecord(new Map([["tests/unit/a.test.ts", [150, 140]]]), path);
    expect(readDurationRecord(path)).toEqual(new Map([["tests/unit/a.test.ts", [150, 140]]]));
  });

  it("reads a record of one duration per file, as runs before 2026-10-18 wrote it, as one run each", () => {
    const path = join(temporaryDirectory("durations-"), "test-durations.json");
    writeFileSync(path, JSON.stringify({ "tests/unit/a.test.ts": 150, "tests/unit/b.test.ts": 0 }));
    expect(readDurationRecord(path)).toEqual(new Map([["tests/unit/a.test.ts", [150]], ["tests/unit/b.test.ts", [0]]]));
  });

  // The record is a cache. A run whose tests all passed must still report its
  // tally when the cache directory cannot be written, for example a read-only
  // HOME in a container.
  it("warns and leaves no staging file when the record cannot be stored", () => {
    const directory = temporaryDirectory("durations-");
    const blockedPath = join(directory, "not-a-directory", "test-durations.json");
    writeFileSync(join(directory, "not-a-directory"), "");
    const occupiedPath = join(directory, "occupied");
    mkdirSync(join(occupiedPath, "entry"), { recursive: true });
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => writeDurationRecord(new Map([["tests/unit/a.test.ts", [150]]]), blockedPath)).not.toThrow();
      expect(() => writeDurationRecord(new Map([["tests/unit/a.test.ts", [150]]]), occupiedPath)).not.toThrow();
      const warnings = stderr.mock.calls.map(([text]) => String(text));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(blockedPath);
      expect(warnings[1]).toContain(occupiedPath);
    } finally {
      stderr.mockRestore();
    }
    expect(readdirSync(directory).toSorted()).toEqual(["not-a-directory", "occupied"]);
  });
});
