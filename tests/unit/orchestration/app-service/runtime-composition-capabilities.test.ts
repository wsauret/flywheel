/** The capability startup every runtime composition root performs before it can
 *  admit optional work.
 *
 *  `composeRuntime` calls `startModulePolicy({ userDataRoot })` and
 *  admits Skills plus Learning before either global-skill reconciliation pass,
 *  so this case exercises that owner through the account-data-root location the
 *  composition actually passes. Building a whole composition belongs to the
 *  integration tier; what is unit-testable here is the decision it makes. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { startModulePolicy } from "../../../../src/orchestration/config/module-policy.js";
import { globalConfigFile } from "../../../../src/infra/paths.js";
import { moduleRequirementsForContribution } from "../../../../src/orchestration/module-requirements.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An account data root the way the CLI publishes it, holding `source` when the
 *  case states one. An absent file is the state of a fresh install. */
function userDataRoot(source?: string): string {
  const home = mkdtempSync(join(tmpdir(), "flywheel-composition-capabilities-"));
  created.push(home);
  const root = join(home, ".flywheel");
  mkdirSync(root, { recursive: true });
  if (source !== undefined) writeFileSync(globalConfigFile(root), source);
  return root;
}

const RECONCILE = { operation: "global skill reconciliation", required: moduleRequirementsForContribution("tools", "skill_manage") } as const;

describe("a runtime composition root's capability startup", () => {
  test("admits global skill reconciliation for a fresh install without materializing a config file", async () => {
    const root = userDataRoot();

    const started = await startModulePolicy({ userDataRoot: root });

    expect((await started.policy.admit(RECONCILE)).ok).toBe(true);
    // Absence is the canonical spelling of the complete catalog: a fresh
    // install states no opt-outs, so migration has nothing to write.
    expect(existsSync(globalConfigFile(root))).toBe(false);
  });

  test("refuses global skill reconciliation for an existing Learning opt-out", async () => {
    const root = userDataRoot("[self_improvement]\nenabled = false\n");

    const started = await startModulePolicy({ userDataRoot: root });
    const admission = await started.policy.admit(RECONCILE);

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("expected a refusal");
    expect(admission.missing).toEqual(["learning"]);
    expect(started.policy.enabled("skills")).toBe(true);
  });

});

/** The runtime capability protocol is the only selected-set source, so no
 *  startup chain may carry a copy of it. */
describe("startup chains carry no capability copy", () => {
  const owners = {
    "runtime launch options": "src/cli/runtime-launch.ts",
    "runtime server options": "src/orchestration/app-service/account-service-runtime.ts",
    "runtime composition": "src/orchestration/app-service/project-execution-runtime.ts",
    "TUI app props": "src/tui/app.tsx",
    "TUI shell props": "src/tui/shell.tsx",
    "Settings store": "src/tui/hooks/create-settings-store.ts",
    "runtime supervisor": "src/orchestration/app-service/runtime-supervisor.ts",
  };

  for (const [owner, file] of Object.entries(owners)) {
    test(`${owner} states no workflow-confirmation copy and no old Learning boolean`, async () => {
      const source = await Bun.file(file).text();
      expect(source.includes("requireWorkflowConfirmation")).toBe(false);
      expect(source.includes("learningReviewEnabled")).toBe(false);
    });
  }

  /** These chains predate the capability domain and must stay outside it: the
   *  selected set reaches the client as a runtime publication, never as a
   *  startup value threaded through them. */
  const capabilityFreeOwners = {
    "runtime launch options": "src/cli/runtime-launch.ts",
    "runtime server options": "src/orchestration/app-service/account-service-runtime.ts",
    "TUI app props": "src/tui/app.tsx",
    "TUI shell props": "src/tui/shell.tsx",
    "Settings store": "src/tui/hooks/create-settings-store.ts",
  };

  for (const [owner, file] of Object.entries(capabilityFreeOwners)) {
    test(`${owner} states no capability selection, preset, or Workflows mode of its own`, async () => {
      const source = await Bun.file(file).text();
      for (const vocabulary of ["capabilit", "features", "workflowsMode", "workflowMode", "setModule"]) {
        expect(source.includes(vocabulary)).toBe(false);
      }
    });
  }

});
