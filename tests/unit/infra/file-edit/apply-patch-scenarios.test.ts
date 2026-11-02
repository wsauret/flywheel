import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { FileEditPlanError } from "../../../../src/infra/file-edit/contract.js";
import { type PatchPlan, planPreparedPatch } from "../../../../src/infra/file-edit/patch-plan.js";
import { type PreparedPatch, preparePatch } from "../../../../src/infra/file-edit/patch-parser.js";

// The apply-patch end-to-end corpus that THIRD-PARTY-NOTICES.md credits, kept
// byte for byte. Each scenario is an input tree, one patch, and the expected
// tree after the patch applied.
const SCENARIOS = resolve(import.meta.dir, "../../../fixtures/apply-patch-scenarios");

function snapshotTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else files.set(relative(root, path).split("\\").join("/"), readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return files;
}

function fold(files: Map<string, string>, plans: readonly PatchPlan[]): void {
  for (const plan of plans) {
    if (plan.kind === "add") files.set(plan.path, plan.newContent);
    else if (plan.kind === "delete") files.delete(plan.path);
    else {
      files.set(plan.movePath ?? plan.path, plan.newContent);
      if (plan.movePath !== undefined && plan.movePath !== plan.path) files.delete(plan.path);
    }
  }
}

function snapshots(files: Map<string, string>, prepared: PreparedPatch) {
  return prepared.paths.map((path) => (files.has(path) ? { path, content: files.get(path) } : { path }));
}

/** The corpus applied hunks one at a time on disk, so a scenario that fails midway keeps its
 *  earlier effects. Flywheel plans the whole patch first and publishes nothing on failure; replaying
 *  the operations one at a time reproduces the corpus's partial state for those scenarios. */
function applyOperationByOperation(files: Map<string, string>, patch: string): Error | undefined {
  let prepared: PreparedPatch;
  try {
    prepared = preparePatch(patch);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  for (const operation of prepared.operations) {
    const single = { operations: [operation], paths: prepared.paths };
    try {
      fold(files, planPreparedPatch(single, snapshots(files, single)));
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  return undefined;
}

describe("apply-patch corpus scenarios", () => {
  const directories = readdirSync(SCENARIOS).filter((entry) => statSync(join(SCENARIOS, entry)).isDirectory()).sort();

  it("covers the whole corpus", () => {
    expect(directories).toHaveLength(25);
  });

  for (const scenario of directories) {
    it(`reproduces ${scenario} byte for byte`, () => {
      const root = join(SCENARIOS, scenario);
      const patch = readFileSync(join(root, "patch.txt"), "utf8");
      const expected = snapshotTree(join(root, "expected"));

      const sequential = snapshotTree(join(root, "input"));
      const failure = applyOperationByOperation(sequential, patch);
      expect(sequential).toEqual(expected);
      if (failure) {
        expect(failure).toBeInstanceOf(FileEditPlanError);
        return;
      }

      // A scenario that completed also plans as one all-or-nothing patch.
      const whole = snapshotTree(join(root, "input"));
      const prepared = preparePatch(patch);
      fold(whole, planPreparedPatch(prepared, snapshots(whole, prepared)));
      expect(whole).toEqual(expected);
    });
  }
});
