import { describe, expect, it, spyOn } from "bun:test";

import { PatchPlanningCursor } from "../../../../../src/infra/file-edit/patch-plan.js";
import {
  StreamingEditValidator,
  type StreamingEditValidationResult,
  type StreamingEditSnapshotReader,
} from "../../../../../src/orchestration/agent-runtime/tools/streaming-edit-validator.js";

interface ToolInputBoundary { [key: string]: unknown }

function fragments(input: ToolInputBoundary, size = 7): string[] {
  const json = JSON.stringify(input);
  return Array.from({ length: Math.ceil(json.length / size) }, (_, index) => json.slice(index * size, (index + 1) * size));
}

async function appendAll(validator: StreamingEditValidator, parts: readonly string[]): Promise<StreamingEditValidationResult> {
  let result: StreamingEditValidationResult = { status: "clear" };
  for (const part of parts) result = await validator.append(part);
  return result;
}

describe("StreamingEditValidator", () => {
  it("reports a sealed patch mismatch before the JSON object completes", async () => {
    const rawPatch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-missing\n+replacement\n*** Update File: b.txt\n";
    const json = JSON.stringify({ input: rawPatch, ignored: "still growing" });
    const boundary = json.indexOf("*** Update File: b.txt") + "*** Update File: b.txt\\n".length;
    const validator = new StreamingEditValidator("apply_patch", async path => path === "a.txt" ? { path, content: "present\n" } : { path });

    const result = await validator.append(json.slice(0, boundary));

    expect(result).toEqual({ status: "advisory", message: "Failed to find expected lines in a.txt:" });
  });

  it("keeps incomplete string input clear and matches once when path and old_string close", async () => {
    let reads = 0;
    const reader: StreamingEditSnapshotReader = async path => {
      reads += 1;
      return { path, content: "one target two target" };
    };
    const validator = new StreamingEditValidator("edit", reader);
    const json = JSON.stringify({ path: "a.txt", old_string: "target", new_string: "replacement", replace_all: true });
    const oldComplete = json.indexOf("target") + "target\"".length;

    expect(await validator.append(json.slice(0, oldComplete))).toEqual({ status: "clear" });
    expect(await validator.append(json.slice(oldComplete))).toEqual({ status: "clear" });
    expect(reads).toBe(1);
  });

  it("defers uniqueness until replace_all is authoritative", async () => {
    const validator = new StreamingEditValidator("edit", async path => ({ path, content: "x x" }));
    const json = JSON.stringify({ path: "a", old_string: "x", new_string: "y", replace_all: false });
    const beforeBoolean = json.lastIndexOf("false");

    expect(await validator.append(json.slice(0, beforeBoolean))).toEqual({ status: "clear" });
    expect(await validator.append(json.slice(beforeBoolean))).toEqual({
      status: "advisory",
      message: "string edit refused at exact tier: 2 matches; nearest lines: line 1: x x; line 1: x x",
    });
  });

  it("preserves virtual patch files and reads each initial path once", async () => {
    const reads = new Map<string, number>();
    const validator = new StreamingEditValidator("apply_patch", async path => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return { path, content: path === "a" ? "old\n" : undefined };
    });
    const patch = "*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-old\n+middle\n*** Update File: b\n@@\n-middle\n+new\n*** Delete File: b\n*** End Patch";

    expect(await appendAll(validator, fragments({ input: patch }, 5))).toEqual({ status: "clear" });
    expect(Object.fromEntries(reads)).toEqual({ a: 1, b: 1 });
  });

  it("plans each sealed patch operation once", async () => {
    const append = spyOn(PatchPlanningCursor.prototype, "append");
    const operations = Array.from({ length: 100 }, (_, index) => `*** Add File: ${index}.txt\n+x`).join("\n");
    const validator = new StreamingEditValidator("apply_patch", async path => ({ path }));

    expect(await appendAll(validator, fragments({ input: `*** Begin Patch\n${operations}\n*** End Patch` }, 32))).toEqual({ status: "clear" });
    expect(append).toHaveBeenCalledTimes(100);
    append.mockRestore();
  });

  it("keeps only the diagnostic line for a large context miss", async () => {
    const missing = Array.from({ length: 101 }, (_, index) => `missing ${index}`).join("\n-");
    const patch = `*** Begin Patch\n*** Update File: long.txt\n@@\n-${missing}\n+replacement\n*** Delete File: boundary\n`;
    const validator = new StreamingEditValidator("apply_patch", async path => ({ path, content: path === "long.txt" ? "present\n" : undefined }));

    expect(await appendAll(validator, fragments({ input: patch }, 32))).toEqual({
      status: "advisory",
      message: "Failed to find expected lines in long.txt:",
    });
  });

  it("treats snapshot failures as unavailable and releases state on disposal", async () => {
    const validator = new StreamingEditValidator("edit", async () => { throw new Error("denied"); });

    expect(await appendAll(validator, fragments({ path: "a", old_string: "x", new_string: "y" }))).toEqual({ status: "unavailable" });
    validator.dispose();
    expect(validator.retainedBytes).toBe(0);
    expect(await validator.append("{}")).toEqual({ status: "unavailable" });
  });
});
