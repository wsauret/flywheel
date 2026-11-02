/** The one bounded mutation-diff contract: what it retains, what it omits, and
 *  that what it retains still decodes through its own strict schema. */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  buildMutationDiff,
  MUTATION_DIFF_VERSION,
  MutationDiffSchema,
  type MutationDiff,
} from "../../../src/infra/mutation-diff.js";

function decoded(diff: MutationDiff): MutationDiff {
  return Schema.decodeUnknownSync(MutationDiffSchema, { onExcessProperty: "error" })(JSON.parse(JSON.stringify(diff)));
}

describe("the diff of one mutation", () => {
  it("names an addition, a modification, and a removal with their exact patches", () => {
    const diff = buildMutationDiff([
      { path: "added.md", before: { kind: "absent" }, after: { kind: "text", text: "one\n" } },
      { path: "changed.md", before: { kind: "text", text: "one\n" }, after: { kind: "text", text: "two\n" } },
      { path: "gone.md", before: { kind: "text", text: "one\n" }, after: { kind: "absent" } },
    ]);

    expect(diff.version).toBe(MUTATION_DIFF_VERSION);
    expect(diff.omissions).toEqual([]);
    expect(diff.files.map((file) => [file.path, file.change])).toEqual([
      ["added.md", "added"],
      ["changed.md", "modified"],
      ["gone.md", "removed"],
    ]);
    const changed = diff.files[1];
    if (!changed) throw new Error("expected the modified file");
    expect(changed.unifiedDiff).toContain("-one");
    expect(changed.unifiedDiff).toContain("+two");
    expect(changed.unifiedDiff).toContain("changed.md");
    expect(decoded(diff)).toEqual(diff);
  });

  it("carries nothing for a target whose bytes did not change", () => {
    const diff = buildMutationDiff([
      { path: "same.md", before: { kind: "text", text: "one\n" }, after: { kind: "text", text: "one\n" } },
      { path: "absent.md", before: { kind: "absent" }, after: { kind: "absent" } },
    ]);

    expect(diff.files).toEqual([]);
    expect(diff.omissions).toEqual([]);
  });

  it("distinguishes an absent endpoint from an empty one", () => {
    const created = buildMutationDiff([{ path: "f.md", before: { kind: "absent" }, after: { kind: "text", text: "" } }]);
    const emptied = buildMutationDiff([{ path: "f.md", before: { kind: "text", text: "one\n" }, after: { kind: "text", text: "" } }]);

    expect(created.files.map((file) => file.change)).toEqual(["added"]);
    expect(emptied.files.map((file) => file.change)).toEqual(["modified"]);
  });

  it("omits a target whose text carries a secret, and keeps no bytes of it", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    const diff = buildMutationDiff([
      { path: "poisoned.md", before: { kind: "absent" }, after: { kind: "text", text: `token: ${secret}\n` } },
      { path: "clean.md", before: { kind: "absent" }, after: { kind: "text", text: "clean\n" } },
    ]);

    expect(diff.omissions).toEqual([{ path: "poisoned.md", reason: "sensitive" }]);
    expect(diff.files.map((file) => file.path)).toEqual(["clean.md"]);
    expect(JSON.stringify(diff)).not.toContain(secret);
  });

  it("retains a harmless patch when unchanged content outside it resembles a credential", () => {
    const fixture = `Bearer ${["xai", "listing", "token"].join("-")}`;
    const unchanged = `${"context\n".repeat(4)}fixture: ${fixture}\n`;
    const diff = buildMutationDiff([{
      path: "model-listing-client.test.ts",
      before: { kind: "text", text: `before\n${unchanged}` },
      after: { kind: "text", text: `after\n${unchanged}` },
    }]);

    expect(diff.omissions).toEqual([]);
    expect(diff.files[0]?.unifiedDiff).toContain("-before");
    expect(diff.files[0]?.unifiedDiff).toContain("+after");
    expect(diff.files[0]?.unifiedDiff).not.toContain(fixture);
  });

  it("does not classify unified-diff path metadata as content", () => {
    const credentialLikePath = `Bearer ${["xai", "listing", "token"].join("-")}`;
    const diff = buildMutationDiff([{
      path: credentialLikePath,
      before: { kind: "text", text: "before\n" },
      after: { kind: "text", text: "after\n" },
    }]);

    expect(diff.omissions).toEqual([]);
    expect(diff.files[0]?.unifiedDiff).toContain("-before");
    expect(diff.files[0]?.unifiedDiff).toContain("+after");
  });

  it("retains opaque identifiers with no recognized credential shape", () => {
    const opaque = "aB3dE5fG7hJ9kLmN2pQrS4tUvW6xYz8+";
    const diff = buildMutationDiff([
      { path: "opaque.md", before: { kind: "absent" }, after: { kind: "text", text: `identifier ${opaque}\n` } },
    ]);

    expect(diff.omissions).toEqual([]);
    expect(diff.files.map((file) => file.path)).toEqual(["opaque.md"]);
    expect(diff.files[0]?.unifiedDiff).toContain(opaque);
  });

  it("keeps patches for files and collections above the old source bounds", () => {
    const prefix = `${"x".repeat(30)}\n`.repeat(5_000);
    const targets = Array.from({ length: 8 }, (_, index) => ({
      path: `large-${index}.md`,
      before: { kind: "text" as const, text: `${prefix}before\n` },
      after: { kind: "text" as const, text: `${prefix}after\n` },
    }));

    const diff = buildMutationDiff(targets);

    expect(diff.omissions).toEqual([]);
    expect(diff.files.map((file) => file.path)).toEqual(targets.map((target) => target.path));
    expect(diff.files.every((file) => file.unifiedDiff.includes("-before") && file.unifiedDiff.includes("+after"))).toBe(true);
  });

  it("retains 1,000 rendered lines per file and counts the rest", () => {
    const diff = buildMutationDiff([{
      path: "many.md",
      before: { kind: "absent" },
      after: { kind: "text", text: "line\n".repeat(1_007) },
    }]);

    expect(diff.omissions).toEqual([]);
    expect(diff.files[0]).toMatchObject({ path: "many.md", omittedLines: 7 });
    expect(diff.files[0]?.unifiedDiff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length).toBe(1_000);
    expect(decoded(diff)).toEqual(diff);
  });

  it("retains all bytes of a long single-line edit without applying a source-size bound", () => {
    const before = "a".repeat(300_000);
    const after = "b".repeat(300_000);
    const diff = decoded(buildMutationDiff([{ path: "long.txt", before: { kind: "text", text: before }, after: { kind: "text", text: after } }]));
    expect(diff.omissions).toEqual([]);
    expect(diff.files[0]?.unifiedDiff).toContain(`-${before}\n`);
    expect(diff.files[0]?.unifiedDiff).toContain(`+${after}\n`);
    expect(diff.files[0]?.omittedLines ?? 0).toBe(0);
  });

  it("is refused by its own schema when a field it does not declare appears", () => {
    const strict = Schema.decodeUnknownSync(MutationDiffSchema, { onExcessProperty: "error" });

    expect(() => strict({ version: MUTATION_DIFF_VERSION, files: [], omissions: [], extra: 1 })).toThrow();
    expect(() => strict({ version: MUTATION_DIFF_VERSION + 1, files: [], omissions: [] })).toThrow();
    expect(() => strict({ version: MUTATION_DIFF_VERSION, files: [{ path: "f.md", change: "renamed", unifiedDiff: "" }], omissions: [] })).toThrow();
  });
});