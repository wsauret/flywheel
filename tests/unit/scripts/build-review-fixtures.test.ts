import { describe, expect, it } from "bun:test";
import { lineageChanges, parseFindings, parseLocations, promptRefusal, reverseApplyPatch } from "../../../scripts/build-review-fixtures.js";

describe("build-review-fixtures", () => {
  it("reverses a recorded mutation patch to the content before it, and refuses a patch that does not match", () => {
    const patch = "Index: /repo/a.ts\n===\n--- /repo/a.ts\n+++ /repo/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -5,1 +5,2 @@\n five\n+six\n";
    expect(reverseApplyPatch("one\nTWO\nthree\nfour\nfive\nsix\n", patch)).toBe("one\ntwo\nthree\nfour\nfive\n");
    expect(reverseApplyPatch("one\ntwo\nthree\nfour\nfive\nsix\n", patch)).toBeUndefined();
  });

  it("reverses the creation of a file to empty content and restores a missing final newline", () => {
    expect(reverseApplyPatch("a\nb\n", "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n")).toBe("");
    expect(reverseApplyPatch("x\ny\n", "--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+y\n")).toBe("x\ny");
  });

  it("reads findings from findings text, a list of finding objects, or the summary", () => {
    const block = "Title: Drift\nSeverity: P1\nLocation: src/a.ts:3-4\nFailure: It drifts.";
    const expected = [{ title: "Drift", severity: "P1", location: "src/a.ts:3-4", failure: "It drifts." }];
    expect(parseFindings(JSON.stringify({ summary: "One finding.", findings: `${block}\n\nTitle: Nit\nSeverity: P3\nLocation: b.ts\nFailure: Small.` })))
      .toEqual([...expected, { title: "Nit", severity: "P3", location: "b.ts", failure: "Small." }]);
    expect(parseFindings(JSON.stringify({ summary: "", findings: [{ Title: "Drift", Severity: "P1", Location: "src/a.ts:3-4", Failure: "It drifts." }] }))).toEqual(expected);
    expect(parseFindings(JSON.stringify({ summary: `Findings:\n\n${block}` }))).toEqual(expected);
    expect(parseFindings(JSON.stringify({ summary: `Findings: 1.\n\n1. ${block}` }))).toEqual(expected);
    expect(parseFindings(JSON.stringify({ summary: "Clean: no actionable findings.", files_modified: [] }))).toEqual([]);
  });

  it("reads each cited file and line range of a location", () => {
    expect(parseLocations("README.md:94; src/budget.ts:32-43,75-91; docs/a.md")).toEqual([
      { path: "README.md", start: 94, end: 94 },
      { path: "src/budget.ts", start: 32, end: 43 },
      { path: "src/budget.ts", start: 75, end: 91 },
      { path: "docs/a.md", start: 1, end: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it("refuses a review whose input is a scratch artifact, however many changed files the prompt names", () => {
    // The opening of recorded review 3c9b971b63db, which named four changed files.
    const prompt = "Review this completed change. It is saved as a patch and is not in the working tree: read /repo/.flywheel/sessions/7a1dc14381c4/scratch/wordcap-lint.patch (apply it in your head against the current scripts/check-intent-corpora.ts, tests/unit/scripts/check-intent-corpora.test.ts, docs/architecture-intent/README.md, docs/product-intent/README.md). Do not apply it or write files.";
    const named = ["docs/architecture-intent/README.md", "docs/product-intent/README.md", "scripts/check-intent-corpora.ts", "tests/unit/scripts/check-intent-corpora.test.ts"];
    expect(promptRefusal(prompt, named)).toBe("review of a scratch artifact");
    expect(promptRefusal("Review the uncommitted change to scripts/a.ts.", ["scripts/a.ts"])).toBeUndefined();
  });

  it("counts only the reviewing lineage's own changes as a fix, mapped to the reviewed lines", () => {
    const otherSession = { mutationId: "other", lineage: false, patch: "--- a\n+++ b\n@@ -0,0 +1,5 @@\n+h1\n+h2\n+h3\n+h4\n+h5\n" };
    // Line 10 after the other session's insertion is line 5 of the reviewed content.
    const fix = { mutationId: "fix", lineage: true, patch: "--- a\n+++ b\n@@ -9,3 +9,3 @@\n four\n-five\n+FIVE\n six\n" };
    expect(lineageChanges([otherSession, fix])).toEqual([{ start: 5, end: 5, added: "FIVE", hunk: "@@ -9,3 +9,3 @@\n four\n-five\n+FIVE\n six", mutationId: "fix" }]);
  });
});
