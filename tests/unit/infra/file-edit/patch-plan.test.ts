import { describe, expect, it } from "bun:test";

import { FILE_EDIT_LIMITS } from "../../../../src/infra/file-edit/contract.js";
import { PatchPlanningCursor, type FileSnapshot, planPreparedPatch } from "../../../../src/infra/file-edit/patch-plan.js";
import { preparePatch } from "../../../../src/infra/file-edit/patch-parser.js";

function plan(patch: string, snapshots: readonly FileSnapshot[], limits = FILE_EDIT_LIMITS) {
  return planPreparedPatch(preparePatch(patch), snapshots, limits);
}

function updated(path: string, source: string, hunk: string): string {
  const [first] = plan(`*** Begin Patch\n*** Update File: ${path}\n${hunk}\n*** End Patch`, [{ path, content: source }]);
  if (first?.kind !== "update") throw new Error("expected an update plan");
  return first.newContent;
}

describe("patch plan", () => {
  it("exposes the same virtual forward planner used by final planning", () => {
    const cursor = new PatchPlanningCursor([{ path: "a.txt", content: "old\n" }, { path: "b.txt", content: "stale\n" }]);
    const operations = preparePatch("*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+middle\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-middle\n+new\n*** End Patch").operations;
    expect(cursor.append(operations[0]!)).toMatchObject({ kind: "update", newContent: "middle\n" });
    expect(cursor.append(operations[1]!)).toMatchObject({ kind: "update", movePath: "b.txt", newContent: "new\n", overwrittenContent: "stale\n" });
    expect(cursor.plans()).toHaveLength(2);
  });

  it("admits later snapshots once without overwriting virtual changes", () => {
    const cursor = new PatchPlanningCursor([]);
    cursor.admitSnapshot({ path: "a.txt", content: "old\n" });
    cursor.append(preparePatch("*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch").operations[0]!);
    cursor.admitSnapshot({ path: "a.txt", content: "stale\n" });
    cursor.admitSnapshot({ path: "b.txt", content: "other\n" });

    expect(cursor.append(preparePatch("*** Begin Patch\n*** Delete File: a.txt\n*** End Patch").operations[0]!)).toMatchObject({ oldContent: "new\n" });
    expect(cursor.append(preparePatch("*** Begin Patch\n*** Delete File: b.txt\n*** End Patch").operations[0]!)).toMatchObject({ oldContent: "other\n" });
  });

  it("plans an update with byte spans from caller snapshots", () => {
    expect(plan("*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch", [{ path: "a.txt", content: "old\n" }])).toEqual([
      { kind: "update", path: "a.txt", oldContent: "old\n", newContent: "new\n", spans: [{ start: 0, end: 4 }], matchKind: "exact" },
    ]);
    const [eof] = plan("*** Begin Patch\n*** Update File: unicode.txt\n@@\n-old é\n+new é\n*** End of File\n*** End Patch", [{ path: "unicode.txt", content: "old é\n" }]);
    expect(eof).toMatchObject({ kind: "update", spans: [{ start: 0, end: Buffer.byteLength("old é\n") }], matchKind: "exact" });
  });

  it("keeps the context lines' bytes and removes only the deleted lines", () => {
    expect(updated("a.txt", "one\ntwo\nthree\nfour\n", "@@\n one\n-two\n-three\n four")).toBe("one\nfour\n");
  });

  it("preserves mixed line boundaries and file edges", () => {
    const cases: readonly [path: string, source: string, hunk: string, expected: string][] = [
      ["mixed.txt", "﻿one\r\ntwo\nthree\r\n", "@@\n-two\n+changed", "﻿one\r\nchanged\nthree\r\n"],
      ["insert-no-eof.txt", "head\r\nlast", "@@\n+first\n+second", "head\r\nlast\r\nfirst\r\nsecond"],
      ["insert-more-than-removed.txt", "one\r\ntwo\nthree\r\n", "@@\n-two\n+first\n+second\n+third", "one\r\nfirst\nsecond\nthird\nthree\r\n"],
      ["delete.txt", "one\r\ntwo\nthree\r", "@@\n-two", "one\r\nthree\r"],
      ["eof-newline.txt", "one\r\ntwo\n", "@@\n-two\n+changed\n*** End of File", "one\r\nchanged\n"],
      ["eof-no-newline.txt", "one\r\ntwo", "@@\n-two\n+changed\n*** End of File", "one\r\nchanged"],
      ["lone-cr.txt", "one\rtwo\rthree\n", "@@\n-two\n+changed", "one\rchanged\rthree\n"],
      ["corresponding.txt", "one\r\ntwo\nthree\r\nfour\r\n", "@@\n-two\n+changed", "one\r\nchanged\nthree\r\nfour\r\n"],
      ["insert-eof.txt", "head\r\n", "@@\n+first\n+second", "head\r\nfirst\r\nsecond\r\n"],
    ];
    for (const [path, source, hunk, expected] of cases) expect(updated(path, source, hunk)).toBe(expected);
  });

  it("applies each chunk at the first match after the previous chunk", () => {
    expect(updated("dup.txt", "a\nb\nc\nX\na\nb\nc\n", "@@\n a\n b\n-c\n+C1\n@@\n a\n b\n-c\n+C2")).toBe("a\nb\nC1\nX\na\nb\nC2\n");
    expect(updated("repeated.txt", "old\nold\n", "@@\n-old\n+first\n@@\n-old\n+second")).toBe("first\nsecond\n");
    expect(updated("context.txt", "fn a() {\n  x\n}\nfn b() {\n  x\n}\n", "@@ fn b() {\n-  x\n+  y")).toBe("fn a() {\n  x\n}\nfn b() {\n  y\n}\n");
  });

  it("runs every tier at end of file", () => {
    const [eof] = plan("*** Begin Patch\n*** Update File: tail.txt\n@@\n-tail\n+end\n*** End of File\n*** End Patch", [{ path: "tail.txt", content: "first\ntail  \n" }]);
    expect(eof).toMatchObject({ kind: "update", newContent: "first\nend\n", matchKind: "rstrip" });
  });

  it("replaces a uniquely matched partial line and refuses an ambiguous one", () => {
    const [unique] = plan(
      "*** Begin Patch\n*** Update File: notes.md\n@@\n-- server: app-server JSON-RPC\n+- server: complete\n*** End Patch",
      [{ path: "notes.md", content: "- worker: daemon details\n- server: app-server JSON-RPC with more details\n" }],
    );
    expect(unique).toMatchObject({
      newContent: "- worker: daemon details\n- server: complete\n",
      matchKind: "substring",
    });

    expect(() => plan(
      "*** Begin Patch\n*** Update File: notes.md\n@@\n-- repeated\n+- changed\n*** End Patch",
      [{ path: "notes.md", content: "- repeated first\n- repeated second\n" }],
    )).toThrow("Failed to find expected lines");
  });

  it("re-indents replacement lines by a uniform shift and inserts them verbatim otherwise", () => {
    const uniform = plan("*** Begin Patch\n*** Update File: scope.py\n@@\n-if ready:\n-    run()\n+if ready:\n+    safe_run()\n*** End Patch", [{ path: "scope.py", content: "def outer():\n    if ready:\n        run()\n" }]);
    expect(uniform[0]).toMatchObject({ newContent: "def outer():\n    if ready:\n        safe_run()\n", matchKind: "trim" });
    // The trim tier matches these lines by trimmed text and does not re-indent; the shift here is not uniform.
    const mixed = plan("*** Begin Patch\n*** Update File: scope.py\n@@\n-if ready:\n-run()\n+if ready:\n+safe_run()\n*** End Patch", [{ path: "scope.py", content: "def outer():\n    if ready:\n        run()\n" }]);
    expect(mixed[0]).toMatchObject({ newContent: "def outer():\nif ready:\nsafe_run()\n", matchKind: "trim" });
  });

  it("names the path and the expected lines when a chunk does not match", () => {
    expect(() => plan("*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n-lines\n+changed\n*** End Patch", [{ path: "modify.txt", content: "present\n" }]))
      .toThrow("Failed to find expected lines in modify.txt:\nmissing\nlines\nActual file lines near the expected location:\n1|present");
    const source = `${"unrelated\n".repeat(25)}interface Important {\n  value: string;\n}\n`;
    expect(() => plan("*** Begin Patch\n*** Update File: modify.txt\n@@\n-export interface Important {\n+interface Renamed {\n   value: string;\n }\n*** End Patch", [{ path: "modify.txt", content: source }]))
      .toThrow("26|interface Important {\n27|  value: string;\n28|}");
    expect(() => plan("*** Begin Patch\n*** Update File: modify.txt\n@@ nowhere\n-present\n+changed\n*** End Patch", [{ path: "modify.txt", content: "present\n" }]))
      .toThrow("Failed to find context 'nowhere' in modify.txt");
    expect(() => plan("*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch", [{ path: "missing.txt" }])).toThrow("file does not exist: missing.txt");
    expect(() => plan("*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch", [{ path: "missing.txt" }])).toThrow("file does not exist: missing.txt");
  });

  it("threads content through repeated operations and records what a move or add overwrote", () => {
    const plans = plan(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+middle\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-middle\n+new\n*** Add File: c.txt\n+fresh\n*** End Patch",
      [{ path: "a.txt", content: "old\n" }, { path: "b.txt", content: "replaced\n" }, { path: "c.txt", content: "stale\n" }],
    );
    expect(plans).toEqual([
      { kind: "update", path: "a.txt", oldContent: "old\n", newContent: "middle\n", spans: [{ start: 0, end: 4 }], matchKind: "exact" },
      { kind: "update", path: "a.txt", movePath: "b.txt", oldContent: "middle\n", newContent: "new\n", overwrittenContent: "replaced\n", spans: [{ start: 0, end: 7 }], matchKind: "exact" },
      { kind: "add", path: "c.txt", newContent: "fresh\n", overwrittenContent: "stale\n" },
    ]);
    const [deletion] = plan("*** Begin Patch\n*** Delete File: a.txt\n*** End Patch", [{ path: "a.txt", content: "gone\n" }]);
    expect(deletion).toEqual({ kind: "delete", path: "a.txt", oldContent: "gone\n" });
  });

  it("fails closed on cumulative retained bytes and oversized snapshots", () => {
    const limits = { ...FILE_EDIT_LIMITS, maxOutputBytes: 2 };
    expect(() => plan("*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+b\n*** Update File: a.txt\n@@\n-b\n+c\n*** Update File: a.txt\n@@\n-c\n+d\n*** End Patch", [{ path: "a.txt", content: "a\n" }], limits))
      .toThrow("operation exceeds retained plan bytes limit");
    expect(() => plan("*** Begin Patch\n*** Delete File: a.txt\n*** End Patch", [{ path: "a.txt", content: "abc" }], limits)).toThrow("snapshots exceed output bytes limit");
  });
});
