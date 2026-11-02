import { describe, expect, it } from "bun:test";
import { checkQualification, parseQualification } from "../../../bench/tasks/qualify.js";

const testIds = ["fixture.test.ts > preserves contract", "fixture.test.ts > consumes once"] as const;
const reference = { id: "reference", patches: ["qualification/reference.patch"], expectation: "pass", rationale: "Implements the contract.", expectedFailures: [] } as const;
const mutant = { id: "mutant", patches: ["qualification/reference.patch", "qualification/mutant.patch"], expectation: "fail", rationale: "Leaves consumed samples.", expectedFailures: [testIds[1]] } as const;
const metadata = { schemaVersion: 1, role: "development", contentIdentity: "identity", testIds, cases: [reference, mutant] } as const;
const report = (failure: string | undefined, type = "AssertionError") => `<testsuites tests="2" failures="${failure ? 1 : 0}"><testsuite name="fixture.test.ts">${testIds.map(id => {
  const name = id.slice("fixture.test.ts > ".length);
  return id === failure ? `<testcase name="${name}"><failure type="${type}"/></testcase>` : `<testcase name="${name}"/>`;
}).join("")}</testsuite></testsuites>`;
const evidence = (xml: string | null, exitCode = 0) => ({ xml, exitCode, timedOut: false, output: "", outputTruncated: false });

describe("native fixture qualification", () => {
  it("decodes development and reserved evaluation labels bound to the current task", () => {
    for (const role of ["development", "reserved-evaluation"] as const) {
      expect(parseQualification({ ...metadata, role }, "identity")).toEqual({ ...metadata, role });
    }
    expect(() => parseQualification(metadata, "changed")).toThrow("content identity");
    expect(() => parseQualification({ ...metadata, role: "holdout" }, "identity")).toThrow();
  });

  it("rejects duplicate controls, tests, patches and unsafe answer paths", () => {
    for (const bad of [
      { ...metadata, cases: [reference, reference] },
      { ...metadata, testIds: [...testIds, testIds[0]] },
      { ...metadata, cases: [{ ...reference, patches: [...reference.patches, ...reference.patches] }] },
      ...["../outside.patch", "project/answer.patch", "acceptance/answer.patch", "qualification/../answer.patch", "/answer.patch", "qualification\\answer.patch"].map(patch => ({ ...metadata, cases: [{ ...reference, patches: [patch] }] })),
      { ...metadata, cases: [{ ...mutant, expectedFailures: ["unknown test"] }] },
      { ...metadata, cases: [{ ...reference, expectedFailures: [testIds[0]] }] },
      { ...metadata, cases: [{ ...mutant, expectedFailures: [] }] },
    ]) expect(() => parseQualification(bad, "identity")).toThrow();
  });

  it("qualifies both reference and a valid alternative without judging patch style", () => {
    for (const control of [reference, { ...reference, id: "alternative", patches: ["qualification/alternative.patch"] }]) {
      expect(checkQualification(control, testIds, evidence(report(undefined))).qualified).toBe(true);
    }
  });

  it("requires the exact behavioral failure set and the corresponding exit status", () => {
    expect(checkQualification(mutant, testIds, evidence(report(testIds[1]), 1)).qualified).toBe(true);
    for (const observation of [
      evidence(report(testIds[0]), 1),
      evidence(report(undefined), 1),
      evidence(report(testIds[1]), 0),
      evidence(report(testIds[1], "TypeError"), 1),
      evidence(report(testIds[1]).replace("<failure", "<error").replace("</failure", "</error"), 1),
      { ...evidence(report(testIds[1]), 1), timedOut: true },
      { ...evidence(report(testIds[1]), 1), output: "# Unhandled error between tests\nerror: Cannot find module './missing.ts'" },
      { ...evidence(report(testIds[1]), 1), outputTruncated: true },
    ]) expect(checkQualification(mutant, testIds, observation).qualified).toBe(false);
  });

  it("refuses missing, incomplete, unexpected and skipped test evidence", () => {
    for (const xml of [
      null, "", "<testsuites/>",
      report(undefined).replace('<testcase name="consumes once"/>', ""),
      report(undefined).replace("consumes once", "unexpected test"),
      report(undefined).replace('<testcase name="consumes once"/>', '<testcase name="consumes once"><skipped/></testcase>'),
      report(undefined).replace("</testsuites>", ""),
    ]) expect(checkQualification(reference, testIds, evidence(xml)).qualified).toBe(false);
  });
});
