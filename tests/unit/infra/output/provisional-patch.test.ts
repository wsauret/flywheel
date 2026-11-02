import { describe, expect, it } from "bun:test";

import { preparePatch } from "../../../../src/infra/file-edit/patch-parser.js";
import { ProvisionalPatchParser } from "../../../../src/infra/output/provisional-patch.js";

function rows(parser: ProvisionalPatchParser): Array<[string, string]> {
  return parser.snapshot().files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.map((line): [string, string] => [line.kind, line.text])));
}

describe("incremental provisional patch display", () => {
  it("preserves retained rows when unretained patch lines arrive in split chunks", () => {
    const parser = new ProvisionalPatchParser();
    parser.append("*** Begin Patch\n*** Update File: a.txt\n@@\n");
    parser.append(Array.from({ length: 1000 }, (_, i) => `+line ${i}\n`).join(""));
    const head = rows(parser);
    for (const chunk of ["+un", "retained", "\n", "@@\n", "+next", " tail", "\n", "\n"]) {
      parser.append(chunk);
      expect(rows(parser)).toEqual(head);
    }
    const hunks = parser.snapshot().files[0]!.hunks;
    expect(hunks.reduce((n, h) => n + h.omittedAfter, 0)).toBe(3);
    expect(hunks.every((h) => h.omittedBefore === 0)).toBeTrue();
    parser.append("*** Add File: b.txt\n+fresh");
    expect(rows(parser).at(-1)).toEqual(["add", "fresh"]);
  });
  it("hides split structural lines and exposes partial code tails in authored file order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@ function",
      " old",
      "-gone",
      "+new",
      "*** Move to: moved.txt",
      "*** Add File: b.txt",
      "+added",
      "*** Delete File: c.txt",
      "*** End Patch",
    ].join("\n");
    const parser = new ProvisionalPatchParser();
    for (const char of patch) {
      parser.append(char);
      expect(rows(parser).every(([, text]) => !text.includes("***") && !text.startsWith("@@"))).toBeTrue();
      if (patch.slice(0, parser.acceptedCharacters).endsWith("+ne")) expect(rows(parser).at(-1)).toEqual(["add", "ne"]);
    }
    expect(parser.snapshot().files.map((file) => [file.action, file.path, file.movePath])).toEqual([
      ["update", "a.txt", "moved.txt"],
      ["add", "b.txt", undefined],
      ["delete", "c.txt", undefined],
    ]);
    expect(rows(parser)).toEqual([["context", "old"], ["remove", "gone"], ["add", "new"], ["add", "added"]]);
  });

  it("accepts display grammar variants while strict execution remains strict", () => {
    const patch = "<<'EOF'\r\n *** Begin Patch \r\n*** Environment ID: env\r\n*** Update File: a.txt\r\n@@\r\n+*** End Patch\r\n+@@ literal\r\n marker *** Delete File: no.txt\r\n*** End of File\r\n *** End Patch \r\nEOF\r\n";
    const parser = new ProvisionalPatchParser();
    parser.append(patch);
    expect(rows(parser)).toEqual([
      ["add", "*** End Patch"],
      ["add", "@@ literal"],
      ["context", "marker *** Delete File: no.txt"],
    ]);
    expect(() => preparePatch(patch)).not.toThrow();
  });

  it("shows path-only deletion and move without invented source content", () => {
    const parser = new ProvisionalPatchParser();
    parser.append("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n+new");
    expect(parser.snapshot().files[0]).toMatchObject({ action: "update", path: "old.txt", movePath: "new.txt" });
    expect(parser.snapshot().files[0]?.hunks[0]?.lines[0]).toMatchObject({ kind: "add", text: "new", partial: true });
    expect(() => preparePatch("*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n+new")).toThrow();

    const deletion = new ProvisionalPatchParser();
    deletion.append("*** Begin Patch\n*** Delete File: gone.txt\n");
    expect(deletion.snapshot().files[0]).toMatchObject({ action: "delete", path: "gone.txt", hunks: [] });
  });

  it("retains honest rows and marks malformed syntax without a raw fallback", () => {
    const parser = new ProvisionalPatchParser();
    parser.append("*** Begin Patch\n*** Update File: a.txt\n@@\n+good\nbad\n+hidden");
    expect(rows(parser)).toEqual([["add", "good"]]);
    expect(parser.snapshot().unavailable).toBe("malformed");
  });
});
