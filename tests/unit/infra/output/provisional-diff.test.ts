import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import { MutationDiffSchema } from "../../../../src/infra/mutation-diff.js";
import { ProvisionalDiffSchema } from "../../../../src/infra/output-blocks.js";
import { createProvisionalDiffInput } from "../../../../src/infra/output/provisional-diff-input.js";
import { TopLevelJsonStringDecoder } from "../../../../src/infra/output/partial-json.js";

const decode = Schema.decodeUnknownSync(ProvisionalDiffSchema, { onExcessProperty: "error" });

describe("provisional diff contract", () => {
  it("strictly represents proposals without executable or raw input", () => {
    const proposal = decode({
      files: [
        { id: "file-0", action: "add", hunks: [] },
        { id: "file-1", path: "old.txt", action: "update", movePath: "new.txt", hunks: [] },
        { id: "file-2", path: "gone.txt", action: "delete", hunks: [{ id: "file-2:hunk-0", lines: [{ id: "file-2:line-0", kind: "remove", text: "unfinished", partial: true }], omittedBefore: 0, omittedAfter: 0 }] },
      ],
    });
    expect(proposal.files[2]?.hunks[0]?.oldStart).toBeUndefined();
    expect(proposal.files[2]?.hunks[0]?.newStart).toBeUndefined();
    expect(JSON.stringify(proposal)).not.toContain("Begin Patch");
    expect(() => Schema.decodeUnknownSync(MutationDiffSchema, { onExcessProperty: "error" })(proposal)).toThrow();
    expect(() => decode({ files: [], rawInput: "{}" })).toThrow();
    expect(() => decode({ files: [{ id: "f", action: "add", hunks: [{ id: "h", lines: [{ id: "l", kind: "wrong", text: "x", partial: false }], omittedBefore: -1, omittedAfter: 0 }] }] })).toThrow();
  });
});

describe("provisional create and replace normalization", () => {
  it("reuses sealed rows across character snapshots", () => {
    const input = createProvisionalDiffInput("create");
    input.append({ content: "sealed\np" }, []);
    const first = input.snapshot().files[0]!.hunks[0]!.lines[0];
    input.append({ content: "artial" }, []);
    expect(input.snapshot().files[0]!.hunks[0]!.lines[0]).toBe(first);
  });

  it("shares the retained row budget across separated replacement hunks", () => {
    const old = Array.from({ length: 2200 }, (_, i) => `line ${i}`);
    const changed = old.map((line, i) => i % 10 === 0 ? `changed ${i}` : line);
    const input = createProvisionalDiffInput("replace");
    input.complete({ old_string: old.join("\n"), new_string: changed.join("\n") });
    const hunks = input.snapshot().files[0]!.hunks;
    expect(hunks.reduce((n, h) => n + h.lines.length, 0)).toBe(1000);
    expect(hunks.reduce((n, h) => n + h.lines.length + h.omittedBefore + h.omittedAfter, 0)).toBe(1757);
    expect(hunks[0]?.lines[0]?.text).toBe("line 0");
    expect(hunks.every((hunk) => hunk.omittedBefore === 0)).toBeTrue();
    expect(hunks.reduce((n, h) => n + h.omittedAfter, 0)).toBe(757);
    const prefix = createProvisionalDiffInput("replace");
    prefix.complete({ old_string: old.slice(0, 200).join("\n"), new_string: changed.slice(0, 200).join("\n") });
    expect(hunks.flatMap((hunk) => hunk.lines).slice(0, 20)).toEqual(
      prefix.snapshot().files[0]!.hunks.flatMap((hunk) => hunk.lines).slice(0, 20),
    );
  });

  it("sanitizes split patch controls without delaying printable code", () => {
    const input = createProvisionalDiffInput("patch");
    for (const char of "*** Begin Patch\r\n*** Add File: a\u001b[31m.txt\r\n+A\u001b]title\u001b\\B") input.append({ input: char }, []);
    expect(input.snapshot().files[0]?.path).toBe("a.txt");
    expect(input.snapshot().files[0]?.hunks[0]?.lines[0]?.text).toBe("AB");
    expect(JSON.stringify(input.snapshot())).not.toContain("\\u001b");
  });
  it("shows each decoded creation character immediately without fabricating an empty row", () => {
    const empty = createProvisionalDiffInput("create");
    empty.append({ path: "empty.txt" }, ["path", "content"]);
    expect(empty.snapshot().files[0]).toMatchObject({ path: "empty.txt", action: "add", hunks: [] });

    const input = createProvisionalDiffInput("create");
    input.append({ path: "new.txt" }, ["path"]);
    for (const [index, char] of [..."one\ntwo"].entries()) {
      input.append({ content: char }, []);
      if (index < 3) expect(input.snapshot().files[0]?.hunks[0]?.lines[0]).toMatchObject({
        text: "one".slice(0, index + 1), partial: true,
      });
    }
    const file = input.snapshot().files[0];
    expect(file?.hunks[0]?.lines.map((line) => [line.kind, line.text, line.partial])).toEqual([
      ["add", "one", false],
      ["add", "two", true],
    ]);
  });

  it("keeps replacement sides in logical order and aligns exactly once after both complete", () => {
    let alignments = 0;
    const input = createProvisionalDiffInput("replace", { onAlign: () => { alignments += 1; } });
    for (const char of "keep\nnew") input.append({ new_string: char }, []);
    expect(input.snapshot().files[0]?.hunks[0]?.lines.map((line) => line.kind)).toEqual(["add", "add"]);
    for (const char of "keep\nold") input.append({ old_string: char }, []);
    input.append({}, ["new_string"]);
    expect(alignments).toBe(0);
    input.append({ path: "a.txt" }, ["old_string", "path"]);
    expect(alignments).toBe(1);
    expect(input.snapshot().files[0]?.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.kind, line.text])).toEqual([
      ["context", "keep"],
      ["remove", "old"],
      ["add", "new"],
    ]);
    input.complete({ path: "a.txt", old_string: "keep\nold", new_string: "keep\nnew", replace_all: true });
    expect(alignments).toBe(1);
  });

  it("streams each edits entry as its own replacement and aligns each once both sides complete", () => {
    const decoder = new TopLevelJsonStringDecoder(["path", "edits.*.old_string", "edits.*.new_string"]);
    const input = createProvisionalDiffInput("replace");
    const call = { path: "a.txt", edits: [{ old_string: "keep\nold", new_string: "keep\nnew" }, { old_string: "tail", new_string: "end" }] };
    const kinds = () => input.snapshot().files[0]?.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text]));
    for (const char of JSON.stringify(call)) {
      const decoded = decoder.append(char);
      input.append(decoded.additions, decoded.completedFields);
      if (decoded.completedFields.includes("edits.1.old_string")) expect(kinds()).toEqual([[["context", "keep"], ["remove", "old"], ["add", "new"]], [["remove", "tail"]]]);
    }
    const settled = kinds();
    expect(settled).toEqual([[["context", "keep"], ["remove", "old"], ["add", "new"]], [["remove", "tail"], ["add", "end"]]]);
    input.complete(call);
    expect(kinds()).toEqual(settled);
    const recorded = createProvisionalDiffInput("replace");
    recorded.complete({ path: "a.txt", old_string: "keep\nold", new_string: "keep\nnew" });
    expect(recorded.snapshot().files[0]?.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text]))).toEqual(settled?.slice(0, 1));
    const asText = createProvisionalDiffInput("replace");
    asText.complete({ path: "a.txt", edits: JSON.stringify(call.edits) });
    expect(asText.snapshot().files[0]?.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text]))).toEqual(settled);
    const entriesAsText = createProvisionalDiffInput("replace");
    entriesAsText.complete({ path: "a.txt", edits: call.edits.map((entry) => JSON.stringify(entry)) });
    expect(entriesAsText.snapshot().files[0]?.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text]))).toEqual(settled);
    const bareEntry = createProvisionalDiffInput("replace");
    bareEntry.complete({ path: "a.txt", edits: call.edits[0] });
    expect(bareEntry.snapshot().files[0]?.hunks.map((hunk) => hunk.lines.map((line) => [line.kind, line.text]))).toEqual(settled?.slice(0, 1));
  });

  it("decodes split escapes and recovers once from different authoritative input", () => {
    const decoder = new TopLevelJsonStringDecoder(["path", "content"]);
    const input = createProvisionalDiffInput("create");
    const json = JSON.stringify({ path: "unicode.txt", content: "a\r\n😀\t\"tail" });
    for (const char of json) {
      const decoded = decoder.append(char);
      input.append(decoded.additions, decoded.completedFields);
    }
    expect(input.snapshot().files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual(["a", "😀\t\"tail"]);
    input.complete({ path: "unicode.txt", content: "authoritative" });
    expect(input.snapshot().files[0]?.hunks[0]?.lines[0]?.text).toBe("authoritative");
  });

  it("bounds retained rows, preserves the head, and reports unavailable input", () => {
    const input = createProvisionalDiffInput("create");
    input.append({ content: `${Array.from({ length: 1_100 }, (_, index) => `line-${index}`).join("\n")}\ntail` }, []);
    const hunk = input.snapshot().files[0]?.hunks[0];
    expect(hunk?.lines).toHaveLength(1_000);
    expect(hunk?.lines[0]?.text).toBe("line-0");
    expect(hunk?.lines.at(-1)?.text).toBe("line-999");
    expect(hunk?.omittedBefore).toBe(0);
    expect(hunk?.omittedAfter).toBe(101);
    input.append({ content: " extended\nanother" }, []);
    expect(input.snapshot().files[0]?.hunks[0]).toMatchObject({ lines: hunk?.lines, omittedAfter: 102 });
    input.markUnavailable("malformed");
    expect(input.snapshot().unavailable).toBe("malformed");
  });
  it("extends the last retained row but counts split unretained rows only once", () => {
    const input = createProvisionalDiffInput("create");
    input.append({ content: `${"sealed\n".repeat(999)}ret` }, []);
    input.append({ content: "ained" }, []);
    expect(input.snapshot().files[0]?.hunks[0]?.lines.at(-1)).toMatchObject({ text: "retained", partial: true });
    input.append({ content: "\nun" }, []);
    const retained = input.snapshot().files[0]!.hunks[0]!.lines;
    for (const content of ["retained", "\n", "next", " tail"]) input.append({ content }, []);
    expect(input.snapshot().files[0]?.hunks[0]).toMatchObject({ lines: retained, omittedBefore: 0, omittedAfter: 2 });
    expect(retained.at(-1)).toMatchObject({ text: "retained", partial: false });
  });
});
