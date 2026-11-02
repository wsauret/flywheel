import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalMutationPath } from "../../../../../src/infra/file-mutation-queue.js";
import { createToolConcurrencyGate, type GateAdmission } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { preparedToolAdmission, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { writeDefinition } from "../../../../../src/orchestration/agent-runtime/tools/write.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";

const paths = (...values: string[]): GateAdmission => ({ kind: "paths", paths: values });

async function settled<T>(promise: Promise<T>): Promise<boolean> {
  const marker = Symbol("pending");
  const result = await Promise.race([promise, Promise.resolve(marker)]);
  return result !== marker;
}


// The gate compares reserved paths on the host separator, so a reservation
// names a native path, which is what every production caller passes.
describe("createToolConcurrencyGate no-permit admission", () => {
  test("returns immediately without consuming a permit or entering the FIFO queue", async () => {
    const gate = createToolConcurrencyGate(1);
    const releaseExclusive = await gate.acquire({ kind: "exclusive" });
    const acquireQueued = gate.acquire({ kind: "safe" });

    const releaseNone = await gate.acquire({ kind: "none" });
    expect(await settled(acquireQueued)).toBe(false);
    releaseNone();
    expect(await settled(acquireQueued)).toBe(false);

    releaseExclusive();
    (await acquireQueued)();
  });
});
describe("createToolConcurrencyGate path admission", () => {
  test("writes to disjoint files overlap in time", async () => {
    const gate = createToolConcurrencyGate(10);
    const releaseA = await gate.acquire(paths(resolve("/repo/a.ts")));
    const acquireB = gate.acquire(paths(resolve("/repo/b.ts")));
    expect(await settled(acquireB)).toBe(true);
    releaseA();
    (await acquireB)();
  });

  test("writes to the same path serialize", async () => {
    const gate = createToolConcurrencyGate(10);
    const releaseA = await gate.acquire(paths(resolve("/repo/a.ts")));
    const acquireB = gate.acquire(paths(resolve("/repo/a.ts")));
    expect(await settled(acquireB)).toBe(false);
    releaseA();
    expect(await settled(acquireB)).toBe(true);
    (await acquireB)();
  });

  test("subtree overlap serializes: a directory reservation conflicts with a file inside it", async () => {
    const gate = createToolConcurrencyGate(10);
    const releaseDir = await gate.acquire(paths(resolve("/repo/src")));
    const acquireFile = gate.acquire(paths(resolve("/repo/src/a.ts")));
    expect(await settled(acquireFile)).toBe(false);
    releaseDir();
    expect(await settled(acquireFile)).toBe(true);
    (await acquireFile)();
  });

  test("exclusive remains exclusive against safe and path-scoped calls", async () => {
    const gate = createToolConcurrencyGate(10);
    const releaseWrite = await gate.acquire(paths(resolve("/repo/a.ts")));
    const acquireBash = gate.acquire({ kind: "exclusive" });
    expect(await settled(acquireBash)).toBe(false);
    releaseWrite();
    const releaseBash = await acquireBash;
    const acquireSafe = gate.acquire({ kind: "safe" });
    const acquireOtherWrite = gate.acquire(paths(resolve("/repo/b.ts")));
    expect(await settled(acquireSafe)).toBe(false);
    expect(await settled(acquireOtherWrite)).toBe(false);
    releaseBash();
    expect(await settled(acquireSafe)).toBe(true);
    expect(await settled(acquireOtherWrite)).toBe(true);
    (await acquireSafe)();
    (await acquireOtherWrite)();
  });

  test("arrival order holds: a queued conflicting write is not starved by later safe calls", async () => {
    const gate = createToolConcurrencyGate(10);
    const releaseA = await gate.acquire(paths(resolve("/repo/a.ts")));
    // Conflicts with the running write, so it queues at the head.
    const acquireB = gate.acquire(paths(resolve("/repo/a.ts")));
    // Arrives later: must not overtake the queued write.
    const acquireSafe = gate.acquire({ kind: "safe" });
    expect(await settled(acquireB)).toBe(false);
    expect(await settled(acquireSafe)).toBe(false);
    releaseA();
    expect(await settled(acquireB)).toBe(true);
    expect(await settled(acquireSafe)).toBe(true);
    (await acquireB)();
    (await acquireSafe)();
  });
});

describe("preparedToolAdmission", () => {
  const tools = new Map([["write", writeDefinition]]);

  test("a write with a path is admitted path-scoped; a pathless write stays exclusive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-gate-"));
    try {
      const prepared = prepareToolCall(
        { id: "w1", name: "write", input: { path: "new.ts", content: "x" } },
        tools,
      );
      // The file does not exist yet, so canonicalization keeps the resolved path.
      const admission = await preparedToolAdmission(prepared, { executionCwd: dir });
      expect(admission).toEqual(paths(canonicalMutationPath(join(dir, "new.ts"))));

      const pathless = prepareToolCall({ id: "w2", name: "write", input: { content: "x" } }, tools);
      expect(await preparedToolAdmission(pathless, { executionCwd: dir })).toEqual({ kind: "exclusive" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two writes to the same file via a symlink reserve the same realpath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-gate-"));
    try {
      writeFileSync(join(dir, "real.ts"), "content");
      symlinkSync(join(dir, "real.ts"), join(dir, "alias.ts"));

      const direct = await preparedToolAdmission(
        prepareToolCall({ id: "w1", name: "write", input: { path: "real.ts", content: "x" } }, tools),
        { executionCwd: dir },
      );
      const viaSymlink = await preparedToolAdmission(
        prepareToolCall({ id: "w2", name: "write", input: { path: "alias.ts", content: "x" } }, tools),
        { executionCwd: dir },
      );
      expect(direct).toEqual(viaSymlink);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("derives no-permit admission from metadata and never from the tool name", async () => {
    const outer: RuntimeTool = {
      name: "arbitrary-container",
      action: "shell_exec",
      description: "container",
      inputSchema: { type: "object", properties: {} },
      gateAdmission: "none",
      isConcurrencySafe: false,
      execute: async () => ({ content: "done", outcome: "ok" }),
    };
    const namedCode = { ...outer, name: "code", gateAdmission: undefined };
    expect(await preparedToolAdmission(prepareToolCall({ id: "outer", name: outer.name, input: {} }, new Map([[outer.name, outer]])), { executionCwd: process.cwd() })).toEqual({ kind: "none" });
    expect(await preparedToolAdmission(prepareToolCall({ id: "named", name: namedCode.name, input: {} }, new Map([[namedCode.name, namedCode]])), { executionCwd: process.cwd() })).toEqual({ kind: "exclusive" });
  });
});
