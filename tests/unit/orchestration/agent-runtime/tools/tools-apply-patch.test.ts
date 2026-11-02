import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createApplyPatchDefinition } from "../../../../../src/orchestration/agent-runtime/tools/apply-patch.js";
import { executePreparedTool, prepareToolCall, preparedToolAdmission } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { MAX_FILE_EDIT_BYTES } from "../../../../../src/orchestration/file-edits/retained-file-edit-host.js";
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js";

describe("apply_patch tool", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-apply-patch-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function apply(input: string) {
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "patch-1", name: "apply_patch", input: { input } }, new Map([[tool.name, tool]]));
    return executePreparedTool(prepared, makeContext({ executionCwd: tmpDir }));
  }

  it("prepares once before path admission and updates the captured file", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "old\n");
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "patch-1", name: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch" } }, new Map([[tool.name, tool]]));
    expect(await preparedToolAdmission(prepared, { executionCwd: tmpDir })).toMatchObject({ kind: "paths" });
    expect((await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir }))).outcome).toBe("ok");
    expect(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8")).toBe("new\n");
    const homePath = `~/${path.relative(os.homedir(), path.join(tmpDir, "a.txt")).split(path.sep).join("/")}`;
    const home = await apply(`*** Begin Patch\n*** Update File: ${homePath}\n@@\n-new\n+home\n*** End Patch`);
    expect(home.outcome).toBe("ok");
    expect(String(home.content)).toStartWith(`[Path '${homePath}' was expanded to '`);
    expect(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8")).toBe("home\n");
  });

  it("publishes sequential update sections for one file as one mutation", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "one\ntwo\n");
    const result = await apply("*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** Update File: a.txt\n@@\n-two\n+dos\n*** End Patch");
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8")).toBe("uno\ndos\n");
  });

  it("applies changing files and reports unchanged add and update targets without recording mutations for them", async () => {
    fs.writeFileSync(path.join(tmpDir, "same.txt"), "same\n");
    fs.writeFileSync(path.join(tmpDir, "old.txt"), "old\n");
    const tool = createApplyPatchDefinition();
    const recorder = createRecordingFileMutationStore();
    const patch = "*** Begin Patch\n*** Update File: same.txt\n@@\n-same\n+same\n*** Add File: same.txt\n+same\n*** Update File: old.txt\n@@\n-old\n+new\n*** End Patch";
    const result = await executePreparedTool(prepareToolCall({ id: "mixed", name: tool.name, input: { input: patch } }, new Map([[tool.name, tool]])), makeContext({ executionCwd: tmpDir, toolUseId: "mixed", sessionEventWriter: recorder.writer }));
    expect(result.outcome).toBe("ok");
    expect(String(result.content)).toStartWith("Note: unchanged files: same.txt.");
    expect(fs.readFileSync(path.join(tmpDir, "same.txt"), "utf8")).toBe("same\n");
    expect(fs.readFileSync(path.join(tmpDir, "old.txt"), "utf8")).toBe("new\n");
    expect(recorder.changes.map(change => change.displayPath)).toEqual(["old.txt"]);

    const unchanged = await apply("*** Begin Patch\n*** Update File: same.txt\n*** Move to: same.txt\n@@\n-same\n+same\n*** End Patch");
    expect(unchanged.outcome).toBe("ok");
    expect(unchanged.content).toBe("Note: unchanged files: same.txt.");
    const empty = await apply("*** Begin Patch\n*** End Patch");
    expect(empty).toMatchObject({ outcome: "ok", content: "Note: patch contains no changes." });
    const placeholders = await apply("*** Begin Patch\n*** Update File: absent.txt\n@@\n*** Update File: other-absent.txt\n*** End Patch");
    expect(placeholders.outcome).toBe("ok");
    expect(placeholders.content).toContain("empty");
    expect(placeholders.content).toContain("no changes");
    expect(fs.existsSync(path.join(tmpDir, "absent.txt"))).toBe(false);
    const emptyMove = await apply("*** Begin Patch\n*** Update File: same.txt\n*** Move to: moved.txt\n@@\n*** End Patch");
    expect(emptyMove.outcome).toBe("error");
    expect(emptyMove.content).toContain("move must include a non-empty update hunk");
    expect(fs.existsSync(path.join(tmpDir, "moved.txt"))).toBe(false);
    const withEmpty = await apply("*** Begin Patch\n*** Update File: absent.txt\n*** Update File: old.txt\n@@\n@@\n-new\n+changed\n@@\n*** End Patch");
    expect(withEmpty.outcome).toBe("ok");
    expect(String(withEmpty.content)).toStartWith("Note: ignored");
    expect(fs.readFileSync(path.join(tmpDir, "old.txt"), "utf8")).toBe("changed\n");
    expect(fs.existsSync(path.join(tmpDir, "absent.txt"))).toBe(false);
  });

  it("applies each chunk at the first match after the previous chunk", async () => {
    fs.writeFileSync(path.join(tmpDir, "dup.txt"), "a\nb\nc\nX\na\nb\nc\n");
    const result = await apply("*** Begin Patch\n*** Update File: dup.txt\n@@\n a\n b\n-c\n+C1\n@@\n a\n b\n-c\n+C2\n*** End Patch");
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(path.join(tmpDir, "dup.txt"), "utf8")).toBe("a\nb\nC1\nX\na\nb\nC2\n");
  });

  it("refuses aggregate target snapshots during admission", async () => {
    const content = "x".repeat(Math.floor(MAX_FILE_EDIT_BYTES / 2) + 1);
    fs.writeFileSync(path.join(tmpDir, "a.txt"), content);
    fs.writeFileSync(path.join(tmpDir, "b.txt"), content);

    const result = await apply("*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: b.txt\n*** End Patch");
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("patch target snapshots exceed");
    expect(fs.statSync(path.join(tmpDir, "a.txt")).size).toBe(content.length);
    expect(fs.statSync(path.join(tmpDir, "b.txt")).size).toBe(content.length);
  });

  it("publishes add, delete, and multiple files through the public tool", async () => {
    fs.writeFileSync(path.join(tmpDir, "delete.txt"), "gone\n");
    const result = await apply("*** Begin Patch\n*** Add File: nested/add.txt\n+added\n*** Delete File: delete.txt\n*** Add File: second.txt\n+second\n*** End Patch");
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(path.join(tmpDir, "nested/add.txt"), "utf8")).toBe("added\n");
    expect(fs.existsSync(path.join(tmpDir, "delete.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "second.txt"), "utf8")).toBe("second\n");
  });

  it("publishes a move destination before deleting a lexically earlier source and overwrites its admitted destination", async () => {
    fs.writeFileSync(path.join(tmpDir, "a-source.txt"), "old\n", { mode: 0o754 });
    fs.writeFileSync(path.join(tmpDir, "z-destination.txt"), "replaced\n", { mode: 0o600 });
    const result = await apply("*** Begin Patch\n*** Update File: a-source.txt\n*** Move to: z-destination.txt\n@@\n-old\n+new\n*** End Patch");
    expect(result.outcome).toBe("ok");
    expect(fs.existsSync(path.join(tmpDir, "a-source.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "z-destination.txt"), "utf8")).toBe("new\n");
    if (process.platform !== "win32") expect(fs.statSync(path.join(tmpDir, "z-destination.txt")).mode & 0o777).toBe(0o754);
  });

  it("publishes an update-then-move destination before deleting its previously touched source", async () => {
    const source = path.join(tmpDir, "a.txt");
    const destination = path.join(tmpDir, "b.txt");
    fs.writeFileSync(source, "old\n");
    const recording = createRecordingFileMutationStore();
    const originalTransaction = recording.writer.transaction;
    let settlements = 0;
    recording.writer.transaction = async run => {
      await originalTransaction(run);
      settlements += 1;
      if (settlements === 1 && recording.changes.at(-1)?.displayPath === "a.txt") fs.writeFileSync(destination, "raced\n");
    };
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "sequential-move", name: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+middle\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-middle\n+new\n*** End Patch" } }, new Map([[tool.name, tool]]));

    const result = await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir, toolUseId: "sequential-move", sessionEventWriter: recording.writer }));
    expect(result.outcome).toBe("ok");
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("new\n");
    expect(recording.changes.map(change => change.displayPath)).toEqual(["b.txt", "a.txt"]);
  });

  it("preserves BOM, mixed line endings, and POSIX mode", async () => {
    const target = path.join(tmpDir, "mixed.txt");
    fs.writeFileSync(target, Buffer.from("\uFEFFone\r\ntwo\nthree\r\n"), { mode: 0o751 });
    const result = await apply("*** Begin Patch\n*** Update File: mixed.txt\n@@\n-two\n+changed\n*** End Patch");
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(target)).toEqual(Buffer.from("\uFEFFone\r\nchanged\nthree\r\n"));
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o751);
  });

  it("refuses duplicate physical targets and hard-link aliases before publication", async () => {
    const original = path.join(tmpDir, "original.txt");
    fs.writeFileSync(original, "same\n");
    fs.linkSync(original, path.join(tmpDir, "alias.txt"));
    const result = await apply("*** Begin Patch\n*** Update File: original.txt\n@@\n-same\n+first\n*** Update File: alias.txt\n@@\n-same\n+second\n*** End Patch");
    expect(result.outcome).toBe("error");
    expect(fs.readFileSync(original, "utf8")).toBe("same\n");
  });

  it("reports the destination prefix when source deletion loses its CAS race", async () => {
    const source = path.join(tmpDir, "a-source.txt");
    const destination = path.join(tmpDir, "z-destination.txt");
    fs.writeFileSync(source, "old\n");
    const recording = createRecordingFileMutationStore();
    const originalTransaction = recording.writer.transaction;
    let settlements = 0;
    recording.writer.transaction = async run => {
      await originalTransaction(run);
      settlements += 1;
      if (settlements === 1) fs.writeFileSync(source, "raced\n");
    };
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "move-race", name: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: a-source.txt\n*** Move to: z-destination.txt\n@@\n-old\n+new\n*** Add File: untouched.txt\n+later\n*** End Patch" } }, new Map([[tool.name, tool]]));
    const result = await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir, toolUseId: "move-race", sessionEventWriter: recording.writer }));
    expect(result).toMatchObject({ outcome: "error", details: {
      changedFiles: { total: 1, samples: ["z-destination.txt"] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 1, samples: ["untouched.txt"] },
      current: { path: "a-source.txt", status: "not_applied", reason: "publication" },
    } });
    expect(result.content).toContain("Durably committed: z-destination.txt");
    expect(result.content).toContain("Untouched: untouched.txt");
    expect(result.content).toContain("the change was not applied");
    expect(fs.existsSync(path.join(tmpDir, "untouched.txt"))).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("new\n");
    expect(fs.readFileSync(source, "utf8")).toBe("raced\n");
    expect(recording.changes.map(change => change.displayPath)).toEqual(["z-destination.txt"]);
    expect(recording.prepared.at(-1)).toMatchObject({ key: "move-race", payload: null });
  });

  it("reports cancellation and checkpoint retirement failure without claiming the file may have changed", async () => {
    const recording = createRecordingFileMutationStore();
    const controller = new AbortController();
    const swap = recording.writer.swapInFlight!;
    recording.writer.swapInFlight = async (...args) => { const stored = await swap(...args); controller.abort(); return stored; };
    recording.writer.transaction = async () => { throw new Error("retirement storage failed"); };
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "retirement-failure", name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch" } }, new Map([[tool.name, tool]]));
    const result = await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir, toolUseId: "retirement-failure", signal: controller.signal, sessionEventWriter: recording.writer }));
    expect(result).toMatchObject({ outcome: "error", details: {
      changedFiles: { total: 0, samples: [] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 1, samples: ["second.txt"] },
      current: { path: "first.txt", status: "not_applied", reason: "cancelled", retirementError: "retirement storage failed" },
    } });
    expect(result.content).toContain("the file was not changed");
    expect(result.content).toContain("Checkpoint retirement failed: retirement storage failed");
    expect(result.content).toContain("Untouched: second.txt");
    expect(result.content).not.toContain("may have changed");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(recording.prepared.at(-1)?.payload).toMatchObject({ cursor: 0 });
  });

  it("reports an applied but unsettled publication separately from the durable prefix and untouched suffix", async () => {
    const recording = createRecordingFileMutationStore();
    const transaction = recording.writer.transaction;
    let settlements = 0;
    recording.writer.transaction = async run => {
      if (++settlements === 2) throw new Error("settlement storage failed");
      await transaction(run);
    };
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "settlement-failure", name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** Add File: third.txt\n+third\n*** End Patch" } }, new Map([[tool.name, tool]]));
    const result = await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir, toolUseId: "settlement-failure", sessionEventWriter: recording.writer }));
    expect(result).toMatchObject({ outcome: "error", details: {
      changedFiles: { total: 1, samples: ["first.txt"] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 1, samples: ["third.txt"] },
      current: { path: "second.txt", status: "uncertain", stage: "settlement", publication: "applied", settlement: "pending", error: "settlement storage failed" },
    } });
    expect(result.content).toContain("the change was applied but is not durably settled");
    expect(result.content).toContain("Durably committed: first.txt");
    expect(result.content).toContain("Untouched: third.txt");
    expect(result.content).not.toContain("may have changed");
    expect(fs.readFileSync(path.join(tmpDir, "second.txt"), "utf8")).toBe("second\n");
    expect(fs.existsSync(path.join(tmpDir, "third.txt"))).toBe(false);
    expect(recording.changes.map(change => change.displayPath)).toEqual(["first.txt"]);
    expect(recording.prepared.at(-1)?.payload).toMatchObject({ cursor: 1 });
    expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
  });

  it.skipIf(process.platform === "win32")("reports a renamed file as indeterminate when parent fsync fails", async () => {
    const original = fs.fsyncSync;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("parent fsync failed");
      return original(fd);
    });
    try {
      const result = await apply("*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** End Patch");
      expect(result).toMatchObject({
        outcome: "error",
        details: { changedFiles: { total: 0, samples: [] }, indeterminateFiles: { total: 1, samples: ["first.txt"] }, remainingFiles: { total: 1, samples: ["second.txt"] } },
      });
      expect(fs.readFileSync(path.join(tmpDir, "first.txt"), "utf8")).toBe("first\n");
      expect(fs.existsSync(path.join(tmpDir, "second.txt"))).toBe(false);
    } finally {
      fsync.mockRestore();
    }
  });

  it("leaves no files or parent directories when a later plan fails", async () => {
    fs.writeFileSync(path.join(tmpDir, "existing.txt"), "actual\n");
    const result = await apply("*** Begin Patch\n*** Add File: missing/nested.txt\n+new\n*** Update File: existing.txt\n@@\n-not-present\n+changed\n*** End Patch");
    expect(result.outcome).toBe("error");
    expect(fs.existsSync(path.join(tmpDir, "missing"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "existing.txt"), "utf8")).toBe("actual\n");
    expect(result.content).toContain("1|actual");
  });

  it("changes no filesystem entries for malformed or cancelled preparation", async () => {
    const malformed = await apply("not a patch");
    expect(malformed.outcome).toBe("error");
    const controller = new AbortController();
    controller.abort();
    const tool = createApplyPatchDefinition();
    const prepared = prepareToolCall({ id: "cancel", name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" } }, new Map([[tool.name, tool]]));
    const cancelled = await executePreparedTool(prepared, makeContext({ executionCwd: tmpDir, signal: controller.signal }));
    expect(cancelled.outcome).toBe("interrupted");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});
