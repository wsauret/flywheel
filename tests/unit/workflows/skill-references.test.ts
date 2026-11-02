import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillReferences } from "../../../src/workflows/skill-references.js";
import { fileTemporaryDirectory } from "../../helpers/directories.js";

const TMP = fileTemporaryDirectory("skill-references-");

interface ReferenceFiles {
  readonly [name: string]: string;
}

function referenceRoot(name: string, files: ReferenceFiles): string {
  const root = join(TMP, name);
  mkdirSync(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(root, `${file}.md`), content);
  return root;
}

describe("bundled skill references", () => {
  it("keys each markdown reference by its file name", () => {
    const root = referenceRoot("references", { "commit-contract": "Commit reference.", "reviewer-protocol": "Reviewer reference." });

    expect(loadSkillReferences(root)).toEqual(new Map([
      ["commit-contract", "Commit reference."],
      ["reviewer-protocol", "Reviewer reference."],
    ]));
  });

  it("treats absent and readable-empty roots as empty", () => {
    expect(loadSkillReferences(join(TMP, "missing"))).toEqual(new Map());
    expect(loadSkillReferences(referenceRoot("empty", {}))).toEqual(new Map());
  });
});
