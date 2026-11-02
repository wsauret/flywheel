import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { assertStringEditReplaceAll, createEditDefinition } from "../../../../../src/orchestration/agent-runtime/tools/edit.js";
import { FileReadLedger } from "../../../../../src/orchestration/agent-runtime/tools/file-read-ledger.js";
import { readDefinition } from "../../../../../src/orchestration/agent-runtime/tools/read.js";
import { canonicalMutationPath, withMutationQueueKey } from "../../../../../src/infra/file-mutation-queue.js";
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js";

describe("edit tool", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-edit-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("exposes the final replace_all policy without changing its diagnostic", () => {
    expect(() => assertStringEditReplaceAll(true, "trailing-whitespace")).toThrow(
      "replace_all matched only through the trailing-whitespace tier; every occurrence must match exactly. Copy old_string exactly, or edit each occurrence on its own.",
    );
    expect(() => assertStringEditReplaceAll(false, "trailing-whitespace")).not.toThrow();
    expect(() => assertStringEditReplaceAll(true, "line-ending")).not.toThrow();
  });

  it("advertises the exact string replacement contract", () => {
    const definition = createEditDefinition();
    expect(definition.inputSchema).toEqual({
      type: "object",
      properties: {
        path: expect.any(Object),
        old_string: expect.any(Object),
        new_string: expect.any(Object),
        replace_all: expect.any(Object),
      },
      required: ["path", "old_string", "new_string"],
    });
  });

  it("replaces one exact match and records lineage", async () => {
    const target = path.join(tmpDir, "file.txt");
    fs.writeFileSync(target, "before one before");
    const recorder = createRecordingFileMutationStore();
    const result = await createEditDefinition().execute(
      { path: "file.txt", old_string: "one", new_string: "two" },
      makeContext({ executionCwd: tmpDir, toolUseId: "edit-1", sessionEventWriter: recorder.writer }),
    );
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(target, "utf8")).toBe("before two before");
    expect(recorder.changes).toHaveLength(1);
  });

  it("reports identical strings as unchanged after admitting the existing file, without mutation facts", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "one one");
    const recorder = createRecordingFileMutationStore();
    const tool = createEditDefinition();
    const context = makeContext({ executionCwd: tmpDir, toolUseId: "same-edit", sessionEventWriter: recorder.writer });
    const result = await tool.execute({ path: "file.txt", old_string: "one", new_string: "one" }, context);
    expect(result).toMatchObject({ outcome: "ok", content: "Note: old_string and new_string are identical; file.txt is unchanged." });
    expect(fs.readFileSync(path.join(tmpDir, "file.txt"), "utf8")).toBe("one one");
    expect(recorder.facts).toEqual([]);
    expect(recorder.prepared).toEqual([]);
    expect((await tool.execute({ path: "missing.txt", old_string: "one", new_string: "one" }, context)).outcome).toBe("error");
  });

  it("keeps unchanged credentials out of durable previews without changing read or edit bytes", async () => {
    const credential = `ghp_${"SyntheticCredential".repeat(3)}`;
    const before = `TOKEN=${credential}\n${"unchanged\n".repeat(8)}setting=old\n`;
    const after = before.replace("setting=old", "setting=new");
    const target = path.join(tmpDir, "config.env");
    fs.writeFileSync(target, before);
    const recorder = createRecordingFileMutationStore();
    const context = makeContext({ executionCwd: tmpDir, sessionId: "test", toolUseId: "config-edit", sessionEventWriter: recorder.writer, projectionReader: recorder.reader });
    const read = await readDefinition.execute({ path: "config.env" }, context);
    expect(read.content).toContain(credential);
    const result = await createEditDefinition().execute({ path: "config.env", old_string: "setting=old", new_string: "setting=new" }, context);
    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(target)).toEqual(Buffer.from(after));
    expect(result.content).toContain("-setting=old\n+setting=new");
    expect(result.content).not.toContain(credential);
    expect(JSON.stringify(recorder.prepared)).not.toContain(credential);
    expect(JSON.stringify(recorder.facts)).not.toContain(credential);
    expect(recorder.changes[0]).toMatchObject({
      before: { bytes: Buffer.byteLength(before), sha256: createHash("sha256").update(before).digest("hex"), preview: expect.stringContaining("TOKEN=[redacted secret]") },
      after: { bytes: Buffer.byteLength(after), sha256: createHash("sha256").update(after).digest("hex"), preview: expect.stringContaining("TOKEN=[redacted secret]") },
    });
  });

  it.each([
    ["operator", "active = 1 OR verified = 1"],
    ["literal", "active = 1 AND verified = 2"],
  ] as const)("refuses %s differences within matching block boundaries without mutation", async (_kind, condition) => {
    const target = path.join(tmpDir, "query.sql");
    const bytes = Buffer.from("SELECT id\nFROM users\nWHERE active = 1 AND verified = 1\nORDER BY id;\n");
    fs.writeFileSync(target, bytes);
    const recorder = createRecordingFileMutationStore();

    const result = await createEditDefinition().execute(
      {
        path: "query.sql",
        old_string: `SELECT id\nFROM users\nWHERE ${condition}\nORDER BY id;`,
        new_string: "SELECT id\nFROM users\nWHERE verified = 1\nORDER BY id;",
      },
      makeContext({ executionCwd: tmpDir, toolUseId: "edit-mismatch", sessionEventWriter: recorder.writer }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("string edit refused: no match after escape-normalized tier; nearest lines: line 1: SELECT id");
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(recorder.prepared).toEqual([]);
    expect(recorder.facts).toEqual([]);
  });

  it("interrupts an edit aborted while it waits on the mutation queue", async () => {
    const target = path.join(tmpDir, "queued.txt");
    fs.writeFileSync(target, "before");
    const recorder = createRecordingFileMutationStore();
    const controller = new AbortController();
    let releaseQueue!: () => void;
    let queueAcquired!: () => void;
    const held = new Promise<void>(resolve => { releaseQueue = resolve; });
    const acquired = new Promise<void>(resolve => { queueAcquired = resolve; });
    const holder = withMutationQueueKey(canonicalMutationPath(target), async () => {
      queueAcquired();
      await held;
    });
    await acquired;

    const editing = createEditDefinition().execute(
      { path: "queued.txt", old_string: "before", new_string: "after" },
      makeContext({ executionCwd: tmpDir, toolUseId: "queued-edit", sessionEventWriter: recorder.writer, signal: controller.signal }),
    );
    while (recorder.prepared.length === 0) await Bun.sleep(1);
    controller.abort();
    releaseQueue();
    const result = await editing;
    await holder;

    expect(result.outcome).toBe("interrupted");
    expect(result.details).toMatchObject({
      changedFiles: { total: 0, samples: [] }, indeterminateFiles: { total: 0, samples: [] }, remainingFiles: { total: 0, samples: [] },
      mutationEvidence: { applied: 0, notApplied: 1 },
      current: { path: "queued.txt", status: "not_applied", reason: "cancelled" },
    });
    expect(fs.readFileSync(target, "utf8")).toBe("before");
    expect(recorder.prepared.at(-1)?.payload).toBeNull();
  });

  it("refuses invalid UTF-8 without changing the file", async () => {
    const target = path.join(tmpDir, "invalid.txt");
    const bytes = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
    fs.writeFileSync(target, bytes);

    const result = await createEditDefinition().execute(
      { path: "invalid.txt", old_string: "foo", new_string: "bar" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("valid UTF-8");
    expect(fs.readFileSync(target)).toEqual(bytes);
  });

  it("preserves a UTF-8 BOM and untouched mixed line endings", async () => {
    const target = path.join(tmpDir, "mixed.txt");
    fs.writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\nthree\r\n")]));

    const result = await createEditDefinition().execute(
      { path: "mixed.txt", old_string: "two", new_string: "changed" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(fs.readFileSync(target)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\nchanged\nthree\r\n")]));
  });

  it("preserves the target POSIX mode", async () => {
    if (process.platform === "win32") return;
    const target = path.join(tmpDir, "mode.txt");
    fs.writeFileSync(target, "before");
    fs.chmodSync(target, 0o754);

    const result = await createEditDefinition().execute(
      { path: "mode.txt", old_string: "before", new_string: "after" },
      makeContext({ executionCwd: tmpDir }),
    );

    expect(result.outcome).toBe("ok");
    expect(fs.statSync(target).mode & 0o777).toBe(0o754);
  });

  it("warns about unread, stale, and partially read targets and stays quiet after its own publication", async () => {
    const target = path.join(tmpDir, "ledger.txt");
    const tail = Array.from({ length: 40 }, (_, index) => `line ${index + 5}`).join("\n");
    fs.writeFileSync(target, `one\ntwo\nthree\nfour\n${tail}\n`);
    const readLedger = new FileReadLedger();
    const context = makeContext({ executionCwd: tmpDir, readLedger });
    const edit = createEditDefinition();

    const unread = await edit.execute({ path: "ledger.txt", old_string: "one", new_string: "uno" }, context);
    expect(unread.outcome).toBe("ok");
    expect(unread.content).toStartWith("Updated ledger.txt\n@@ -1,4 +1,4 @@\n-one\n+uno\n");
    expect(unread.content).toEndWith("\nWarning: ledger.txt was not read in this session; the change was applied to the current file content.");

    const again = await edit.execute({ path: "ledger.txt", old_string: "uno", new_string: "ONE" }, context);
    expect(again.content).toStartWith("Updated ledger.txt\n@@");
    expect(again.content).not.toContain("Warning:");

    fs.writeFileSync(target, `ONE\ntwo\nthree\nfour\n${tail}\nline 45\n`);
    const stale = await edit.execute({ path: "ledger.txt", old_string: "two", new_string: "dos" }, context);
    expect(stale.content).toEndWith("\nWarning: ledger.txt changed after it was last read; the change was applied to the current content.");

    fs.writeFileSync(target, `ONE\ndos\nthree\nfour\n${tail}\nline 45 external\n`);
    expect((await readDefinition.execute({ path: "ledger.txt:1-2" }, context)).outcome).toBe("ok");
    const partial = await edit.execute({ path: "ledger.txt", old_string: "line 45 external", new_string: "line forty-five" }, context);
    expect(partial.content).toEndWith("\nWarning: the last read of ledger.txt did not cover lines 45-45, which this change replaced.");

    expect((await readDefinition.execute({ path: "ledger.txt" }, context)).outcome).toBe("ok");
    const covered = await edit.execute({ path: "ledger.txt", old_string: "three", new_string: "tres" }, context);
    expect(covered.content).not.toContain("Warning:");
  });

  it("refuses replace_all when only a normalizing tier matched", async () => {
    const target = path.join(tmpDir, "fuzzy.txt");
    fs.writeFileSync(target, "alpha\nbeta\nalpha\n");
    const result = await createEditDefinition().execute(
      { path: "fuzzy.txt", old_string: "alpha  ", new_string: "gamma", replace_all: true },
      makeContext({ executionCwd: tmpDir }),
    );
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("replace_all matched only through the trailing-whitespace tier");
    expect(fs.readFileSync(target, "utf8")).toBe("alpha\nbeta\nalpha\n");
  });

  it("requires a unique match unless replace_all is true", async () => {
    const target = path.join(tmpDir, "file.txt");
    fs.writeFileSync(target, "same same");
    const definition = createEditDefinition();
    const context = makeContext({ executionCwd: tmpDir });
    const refused = await definition.execute({ path: "file.txt", old_string: "same", new_string: "new" }, context);
    expect(refused.outcome).toBe("error");
    expect(fs.readFileSync(target, "utf8")).toBe("same same");
    const applied = await definition.execute({ path: "file.txt", old_string: "same", new_string: "new", replace_all: true }, context);
    expect(applied.outcome).toBe("ok");
    expect(fs.readFileSync(target, "utf8")).toBe("new new");
  });
});
