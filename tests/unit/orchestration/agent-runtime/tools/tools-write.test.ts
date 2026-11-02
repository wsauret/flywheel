import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Schema } from "effect";
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../src/infra/mutation-evidence-schema.js";
import { parseFileMutationOperationHeader, readFileMutationOperation } from "../../../../../src/orchestration/session/file-mutation-operation.js";

import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { testBaseTools } from "../../../../helpers/request-tool-surface.js";
import { MAX_FILE_EDIT_BYTES } from "../../../../../src/orchestration/file-edits/retained-file-edit-host.js";
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js";

// Compose prepare + execute exactly as the agent loop's dispatcher does.
const runTool = (
  call: Parameters<typeof prepareToolCall>[0],
  ctx: Parameters<typeof executePreparedTool>[1],
  tools: Parameters<typeof prepareToolCall>[1],
  options?: Parameters<typeof executePreparedTool>[2],
) => executePreparedTool(prepareToolCall(call, tools), ctx, options);


describe("write tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-write-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  it("records file lineage when creating a file", async () => {
    const recorder = createRecordingFileMutationStore();
    const ctx = makeContext({
      executionCwd: tmpDir,
      toolUseId: "tool-write",
      modelRequestId: "request-1",
      sessionEventWriter: recorder.writer,
    });

    const result = await runTool({
      id: "tool-write",
      name: "write",
      input: { path: "created.txt", content: "hello\n" },
    }, ctx, testBaseTools());

    expect(result.outcome).toBe("ok");
    expect(recorder.changes).toHaveLength(1);
    expect(recorder.changes[0]).toMatchObject({
      path: path.join(fs.realpathSync(tmpDir), "created.txt"),
      displayPath: "created.txt",
      changeKind: "created",
      before: null,
      origin: { kind: "tool_call", toolUseId: "tool-write", modelRequestId: "request-1" },
    });
    expect(recorder.changes[0]?.after?.preview).toBe("hello");
  });

  it("publishes the canonical mutation artifact in its result details", async () => {
    const recorder = createRecordingFileMutationStore();
    const ctx = makeContext({
      executionCwd: tmpDir,
      toolUseId: "tool-write",
      modelRequestId: "request-1",
      sessionEventWriter: recorder.writer,
    });

    const result = await runTool({
      id: "tool-write",
      name: "write",
      input: { path: "created.txt", content: "hello\n" },
    }, ctx, testBaseTools());

    expect(result.outcome).toBe("ok");
    const { mutationEvidence } = Schema.decodeUnknownSync(Schema.Struct({ mutationEvidence: MutationEvidenceSchema }))(result.details);
    const page = await readMutationEvidenceFiles(mutationEvidence, 0, 128, recorder.readContentNode);
    if (page.kind !== "available") throw new Error("Expected retained write evidence");
    expect(page.files).toMatchObject([{ kind: "applied", file: { path: path.join(fs.realpathSync(tmpDir), "created.txt"), change: "added" } }]);
    expect(page.nextOffset).toBeNull();
  });

  it("prepares durable attribution before publishing file bytes", async () => {
    const target = path.join(tmpDir, "persist-failure.txt");
    const order: string[] = [];
    const recorder = createRecordingFileMutationStore();
    const ctx = makeContext({
      executionCwd: tmpDir,
      toolUseId: "tool-write-failure",
      sessionEventWriter: {
        ...recorder.writer,
        // Preparation is in-flight state, so the ordering runs through both
        // channels: the point of the test is that it lands before any bytes.
        swapInFlight: (kind: string, key: string, expectedRaw: string | null, payload: unknown | null) => {
          order.push(`prepared:${fs.existsSync(target)}`);
          return recorder.writer.swapInFlight!(kind, key, expectedRaw, payload);
        },
        record: async (fact) => {
          order.push(`${fact.type}:${fs.existsSync(target)}`);
          return recorder.writer.record(fact);
        },
      },
    });

    const result = await runTool({
      id: "tool-write-failure",
      name: "write",
      input: { path: "persist-failure.txt", content: "written" },
    }, ctx, testBaseTools());

    expect(result.outcome).toBe("ok");
    expect(order).toEqual([
      "prepared:false",
      "file.changed:true",
      "file.artifact.recorded:true",
    ]);
  });
  it("refuses publication without creating parents when durable preparation is not stored", async () => {
    const target = path.join(tmpDir, "missing", "disposed-writer.txt");
    const ctx = makeContext({
      executionCwd: tmpDir,
      toolUseId: "tool-write-disposed",
      sessionEventWriter: {
        ...createRecordingFileMutationStore().writer,
        record: async () => null,
        recordBatch: async () => null,
        recordGuarded: async () => null,
        swapInFlight: async () => false,
        transaction: async () => {},
        dispose: () => {},
      },
    });

    const result = await runTool({
      id: "tool-write-disposed",
      name: "write",
      input: { path: "missing/disposed-writer.txt", content: "must not publish" },
    }, ctx, testBaseTools());

    expect(result.outcome).toBe("error");
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(result.content).toContain("changed before preparation");
  });

  it("refuses content that is read output with line-number prefixes", async () => {
    const target = path.join(tmpDir, "prefixed.txt");
    const result = await runTool({
      id: "tool-write-prefixed",
      name: "write",
      input: { path: "prefixed.txt", content: "1|const a = 1;\n2|const b = 2;\n" },
    }, makeContext({ executionCwd: tmpDir }), testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("line-number prefix");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("publishes no parents or bytes when the durable preparation write fails", async () => {
    const target = path.join(tmpDir, "missing", "failing-preparation.txt");
    const recorder = createRecordingFileMutationStore();
    const ctx = makeContext({
      executionCwd: tmpDir,
      toolUseId: "tool-write-preparation-fails",
      sessionEventWriter: {
        ...recorder.writer,
        swapInFlight: async () => { throw new Error("database or disk is full"); },
      },
    });

    const result = await runTool({
      id: "tool-write-preparation-fails",
      name: "write",
      input: { path: "missing/failing-preparation.txt", content: "must not publish" },
    }, ctx, testBaseTools());

    expect(result.outcome).toBe("error");
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(result.content).toContain("database or disk is full");
  });

});

describe("write retained authority", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-write-authority-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("rejects an oversized nested write before storing any operation cell or creating parents", async () => {
    const recorder = createRecordingFileMutationStore();
    const result = await runTool({
      id: "oversized", name: "write",
      input: { path: "missing/nested/file.txt", content: "x".repeat(MAX_FILE_EDIT_BYTES + 1) },
    }, makeContext({ executionCwd: tmpDir, toolUseId: "oversized", sessionEventWriter: recorder.writer }), testBaseTools());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("edit limit");
    expect(fs.existsSync(path.join(tmpDir, "missing"))).toBe(false);
    expect(recorder.facts).toEqual([]);
    expect(recorder.prepared).toEqual([]);
  });

  it("keeps an existing file unchanged and preserves the create-only error", async () => {
    const target = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(target, "before");
    const result = await runTool({ id: "existing", name: "write", input: { path: "existing.txt", content: "after" } }, makeContext({ executionCwd: tmpDir }), testBaseTools());
    expect(result).toMatchObject({ outcome: "error", content: "File already exists: existing.txt. Use the edit tool to modify existing files. The write tool is only for creating new files." });
    expect(fs.readFileSync(target, "utf8")).toBe("before");
  });

  it("refuses a final symlink without changing its target", async () => {
    const destination = path.join(tmpDir, "destination.txt");
    fs.writeFileSync(destination, "before");
    fs.symlinkSync(destination, path.join(tmpDir, "link.txt"));
    const result = await runTool({ id: "symlink", name: "write", input: { path: "link.txt", content: "after" } }, makeContext({ executionCwd: tmpDir }), testBaseTools());
    expect(result.content).toBe("File already exists: link.txt. Use the edit tool to modify existing files. The write tool is only for creating new files.");
    expect(fs.readFileSync(destination, "utf8")).toBe("before");
  });

  it("records the canonical physical path through an ancestor alias", async () => {
    if (process.platform === "win32") return;
    const physical = path.join(tmpDir, "physical");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, path.join(tmpDir, "alias"), "dir");
    const recorder = createRecordingFileMutationStore();
    const result = await runTool({ id: "alias", name: "write", input: { path: "alias/nested/file.txt", content: "alias" } }, makeContext({ executionCwd: tmpDir, toolUseId: "alias", sessionEventWriter: recorder.writer }), testBaseTools());
    expect(result.outcome).toBe("ok");
    expect(recorder.changes[0]?.path).toBe(path.join(fs.realpathSync(physical), "nested/file.txt"));
  });

  it("records and verifies a new file's mode as the user's own tools would create it", async () => {
    if (process.platform === "win32") return;
    const recorder = createRecordingFileMutationStore();
    const target = path.join(tmpDir, "mode.txt");
    const mode = 0o666 & ~process.umask();
    const result = await runTool({ id: "mode", name: "write", input: { path: "mode.txt", content: "mode" } }, makeContext({ executionCwd: tmpDir, toolUseId: "mode", sessionEventWriter: recorder.writer }), testBaseTools());
    expect(result.outcome).toBe("ok");
    expect(fs.statSync(target).mode & 0o777).toBe(mode);
    const header = parseFileMutationOperationHeader(recorder.prepared[0]?.payload);
    const operation = await readFileMutationOperation(header, recorder.readContentNode);
    expect(operation).toMatchObject({ items: [{ precondition: { kind: "absent" }, postcondition: { access: { kind: "posix", mode } } }] });
  });
});

describe("write exact input", () => {
  it("preserves line-number-like prefixes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-write-exact-"));
    try {
      const content = "1|literal\r\n2|content\nfinal\r\n";
      const result = await runTool({ id: "exact-write", name: "write", input: { path: "exact.txt", content } }, makeContext({ executionCwd: tmpDir }), testBaseTools());
      expect(result.outcome).toBe("ok");
      expect(fs.readFileSync(path.join(tmpDir, "exact.txt"))).toEqual(Buffer.from(content));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
