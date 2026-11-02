import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createModulePolicy,
  startModulePolicy,
} from "../../../../src/orchestration/config/module-policy.js";
import { decodeModuleState, defaultModuleState, type ModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";

import { MODULE_IDS } from "../../../../src/protocol/module-ids.js";
async function withConfig(source: string, run: (configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-capability-policy-"));
  const configPath = join(dir, "flywheel.toml");
  try {
    await writeFile(configPath, source);
    await run(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RECONCILE = { operation: "global skill reconciliation", required: ["skills", "learning"] } as const;
const WORKFLOW_SELECTION = ["skills", "workflows"] as const;


/** The complement fixture: the disabled_modules line whose enabled set is exactly `enabled`. */
function disabledLine(enabled: readonly string[]): string {
  const disabled = MODULE_IDS.filter((id) => !enabled.includes(id));
  return `disabled_modules = [${disabled.map((id) => `"${id}"`).join(", ")}]\n`;
}

describe("catalog-derived harness capability policy", () => {
  test("projects canonical modules, collapses duplicates, and derives workflow mode", async () => {
    const duplicated = disabledLine(WORKFLOW_SELECTION).replace('"learning"', '"learning", "learning"');
    await withConfig(`${duplicated}require_workflow_confirmation = false\n`, async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      expect(policy.state().moduleIds).toEqual(WORKFLOW_SELECTION);
      expect(policy.state().workflowsMode).toBe("on");
      expect(policy.enabled("skills")).toBe(true);
      expect(policy.enabled("learning")).toBe(false);
    });
  });

  test("starts workflows without a question unless the person turns confirmation on", () => {
    expect(defaultModuleState().workflowsMode).toBe("on");
    expect(decodeModuleState("require_workflow_confirmation = true\n").workflowsMode).toBe("ask");
  });

  test("admission reads fresh committed config, not the file an earlier admission read", async () => {
    await withConfig(disabledLine(["skills", "learning"]), async (configPath) => {
      const owner = await createRuntimeConfigOwner({ configPath, watch: false });
      const writer = await createModulePolicy({ configPath }, owner);
      const admitter = await createModulePolicy({ configPath }, owner);
      expect((await admitter.admit(RECONCILE)).ok).toBe(true);

      expect(await writer.select(["skills"])).toEqual({ ok: true });
      expect(admitter.state().moduleIds).toEqual(["learning", "skills"]);

      const admission = await admitter.admit(RECONCILE);
      expect(admission.ok).toBe(false);
      if (admission.ok) throw new Error("expected refusal");
      expect(admission.missing).toEqual(["learning"]);
      expect(admission.reason).toContain("global skill reconciliation");
      expect(admitter.state().moduleIds).toEqual(["skills"]);
    });
  });

  test("an admitted grant survives a later disable", async () => {
    await withConfig(disabledLine(["skills", "learning"]), async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      const admission = await policy.admit(RECONCILE);
      if (!admission.ok) throw new Error(admission.reason);

      expect(await policy.select([])).toEqual({ ok: true });
      expect(admission.grant.moduleIds).toEqual(["learning", "skills"]);
      expect(admission.grant.required).toEqual(["learning", "skills"]);
      expect(admission.grant.operation).toBe("global skill reconciliation");
      expect(Object.isFrozen(admission.grant)).toBe(true);
      expect((await policy.admit(RECONCILE)).ok).toBe(false);
    });
  });

  test("publishes committed selection and refusal state to listeners in observation order", async () => {
    await withConfig(disabledLine(["skills"]), async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      const seen: ModuleState[] = [];
      policy.onChange((state) => seen.push(state));

      expect(await policy.select(["skills", "learning"])).toEqual({ ok: true });
      await writeFile(configPath, 'disabled_modules = ["telepathy"]\n');
      await policy.refresh();
      await policy.refresh();
      await writeFile(configPath, disabledLine(["skills"]));
      await policy.refresh();

      expect(seen.map((state) => state.moduleIds)).toEqual([
        ["learning", "skills"],
        ["learning", "skills"],
        ["skills"],
      ]);
      expect(seen[0]?.error).toBeUndefined();
      expect(seen[1]?.error).toContain("telepathy");
      expect(seen[2]?.error).toBeUndefined();
    });
  });

  test("keeps malformed source text out of errors while preserving CAS identity", () => {
    const first = decodeModuleState('disabled_modules = ["MODULE_SECRET_ONE"\n');
    const second = decodeModuleState('disabled_modules = ["MODULE_SECRET_TWO"\n');

    expect(first.error).toBe("flywheel.toml cannot be parsed");
    expect(first.error).not.toContain("MODULE_SECRET_ONE");
    expect(first.identity).not.toBe(second.identity);
  });

  test("retains the last valid selection through invalid external state and recovers", async () => {
    const rejected = [
      ['disabled_modules = ["unknown-uat"]\n', 'disabled_modules contains unknown id "unknown-uat"'],
      ['disabled_modules = ["skills", 1]\n', "every member must be a registered module id"],
    ] as const;
    for (const [source, message] of rejected) {
      await withConfig(disabledLine(["file-tools", "skills"]), async (configPath) => {
        const policy = await createModulePolicy({ configPath });
        await writeFile(configPath, source);
        await policy.refresh();
        expect(policy.state().moduleIds).toEqual(["file-tools", "skills"]);
        expect(policy.state().error).toContain(message);
        expect(policy.state().error).toContain("Flywheel keeps the last valid module selection until you fix it.");
        await writeFile(configPath, disabledLine(["learning", "skills"]));
        await policy.refresh();
        expect(policy.state().moduleIds).toEqual(["learning", "skills"]);
        expect(policy.state().error).toBeUndefined();
      });
    }
  });

  test("refuses workflow Ask mode without Ask User and retains a hand-edited conflict", async () => {
    await withConfig(`${disabledLine(["ask-user", "skills", "workflows"])}require_workflow_confirmation = true\n`, async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      const withoutAskUser = policy.state().moduleIds.filter((id) => id !== "ask-user");

      const refused = await policy.select(withoutAskUser);
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error("expected a refusal");
      expect(refused.error.message).toContain("Workflows in Ask mode requires the Ask User capability");
      expect(policy.state().moduleIds).toContain("ask-user");

      await writeFile(configPath, `${disabledLine(["skills", "workflows"])}require_workflow_confirmation = true\n`);
      await policy.refresh();
      expect(policy.state().moduleIds).toContain("ask-user");
      expect(policy.state().error).toContain("Workflows in Ask mode requires the Ask User capability");
      expect(policy.state().error).toContain("Flywheel keeps the last valid module selection until you fix it.");
    });
  });

  test("names the key the person wrote and says the defaults apply when no valid selection was read yet", async () => {
    await withConfig('disabled_modules = ["ask-user"]\nrequire_workflow_confirmation = true\n', async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      expect(policy.state().moduleIds).toEqual(defaultModuleState().moduleIds);
      expect(policy.state().error).toBe(
        "flywheel.toml disabled_modules is invalid: Workflows in Ask mode requires the Ask User capability. Enable Ask User, or set Workflows to On or Off. Flywheel uses the default modules until you fix it.",
      );
    });
  });

  test("admission uses the retained selection while current bytes are invalid", async () => {
    await withConfig(disabledLine(["skills", "learning"]), async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      await writeFile(configPath, 'disabled_modules = ["telepathy"]\n');
      const admission = await policy.admit(RECONCILE);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(admission.reason);
      expect(admission.grant.moduleIds).toEqual(["learning", "skills"]);
      expect(admission.grant.error).toContain("telepathy");
      expect(policy.state().moduleIds).toEqual(["learning", "skills"]);
    });
  });

  test("admission uses defaults when no valid selection has been committed", async () => {
    await withConfig('disabled_modules = ["telepathy"]\n', async (configPath) => {
      const policy = await createModulePolicy({ configPath });
      const admission = await policy.admit(RECONCILE);
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(admission.reason);
      expect(admission.grant.moduleIds).toEqual(MODULE_IDS);
      expect(admission.grant.error).toContain("telepathy");
      await policy.dispose();
    });
  });

  test("a run's selection drops the modules it excludes, in its state and its grants", async () => {
    await withConfig(disabledLine(["skills", "learning", "provider-anthropic-api"]), async (configPath) => {
      const policy = await createModulePolicy({ configPath }, undefined, { excluded: ["learning"] });
      expect(policy.state().moduleIds).toEqual(["provider-anthropic-api", "skills"]);
      expect(policy.enabled("provider-anthropic-api")).toBe(true);
      expect(policy.enabled("learning")).toBe(false);

      const granted = await policy.admit({ operation: "an Anthropic API request", required: ["provider-anthropic-api"] });
      if (!granted.ok) throw new Error(granted.reason);
      expect(granted.grant.capabilities).toEqual(["provider-anthropic-api", "skills"]);
      expect((await policy.admit(RECONCILE)).ok).toBe(false);

      // An invalid file keeps the last valid selection, and the run's adjustment still applies to it.
      await writeFile(configPath, 'disabled_modules = ["telepathy"]\n');
      await policy.refresh();
      expect(policy.state().moduleIds).toEqual(["provider-anthropic-api", "skills"]);
      expect(policy.state().error).toContain("telepathy");
    });
  });

  test("refuses a run's selection that the file itself could not state", async () => {
    await withConfig(`${disabledLine(["ask-user", "skills", "workflows"])}require_workflow_confirmation = true\n`, async (configPath) => {
      // A selection policy refuses this file without Ask User, so a run cannot take Ask User out either.
      await expect(createModulePolicy({ configPath }, undefined, { excluded: ["ask-user"] })).rejects.toThrow("The run's module selection is invalid: Workflows in Ask mode requires the Ask User capability");
      const policy = await createModulePolicy({ configPath }, undefined, { excluded: ["learning"] });
      expect(policy.state().moduleIds).toEqual(["ask-user", "skills", "workflows"]);
    });
  });

  test("disposes the one-shot owner it allocates", async () => {
    await withConfig(disabledLine(WORKFLOW_SELECTION), async (configPath) => {
      const policy = await createModulePolicy({ configPath });

      await policy.dispose();
      await expect(policy.admit(RECONCILE)).rejects.toThrow("disposed");
    });
  });

  test("startup reports migration failure, keeps defaults, and follows a repaired selection", async () => {
    const source = "self_improvement = { enabled = false, review_cadence = 3 }\n";
    await withConfig(source, async (configPath) => {
      const started = await startModulePolicy({ configPath });
      const seen: ModuleState[] = [];
      started.policy.onChange((state) => seen.push(state));

      expect(started.migrationError).toContain("self_improvement.enabled");
      expect(started.policy.state().moduleIds).toEqual(MODULE_IDS);
      expect(started.policy.state().error).toContain("self_improvement.enabled");
      expect((await started.policy.admit(RECONCILE)).ok).toBe(true);
      await started.policy.refresh();
      expect(seen).toEqual([]);
      expect(await readFile(configPath, "utf8")).toBe(source);
      await writeFile(configPath, disabledLine(["learning", "skills"]));
      await started.policy.refresh();
      expect(started.policy.state().moduleIds).toEqual(["learning", "skills"]);
      expect(started.policy.state().error).toBeUndefined();
      expect(seen).toHaveLength(1);
      await started.dispose();
    });
  });

  test.each(["before startup", "during startup"] as const)("an unparseable file %s runs defaults and follows the repaired file", async (timing) => {
    const source = "theme = \n";
    await withConfig(timing === "before startup" ? source : "", async (configPath) => {
      const starting = startModulePolicy({ configPath });
      if (timing === "during startup") writeFileSync(configPath, source);
      const started = await starting;
      expect(started.migrationError).toBeUndefined();
      expect(started.policy.state().moduleIds).toEqual(MODULE_IDS);
      expect(started.policy.state().error).toBeUndefined();
      expect((await started.policy.admit(RECONCILE)).ok).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(source);
      await writeFile(configPath, disabledLine(["skills", "learning"]));
      await started.policy.refresh();
      expect(started.policy.state().moduleIds).toEqual(["learning", "skills"]);
      await writeFile(configPath, source);
      await started.policy.refresh();
      expect(started.policy.state().moduleIds).toEqual(["learning", "skills"]);
      await started.dispose();
    });
  });

  test("startup and refresh migrate retired selections before publication", async () => {
    await withConfig('features = ["skills", "learning"]\n', async (configPath) => {
      const started = await startModulePolicy({ configPath });
      expect(started.migrationError).toBeUndefined();
      expect(started.policy.state().moduleIds).toContain("file-tools");
      expect(started.policy.state().moduleIds).toContain("learning");
      expect(await readFile(configPath, "utf8")).not.toContain("features =");
      await writeFile(configPath, 'modules = ["core-tools", "runtime-tools", "skills", "skills"]\n');
      await started.policy.refresh();
      const enabled = (["ask-user", "bash", "definition-overrides", "discovery", "experiments", "file-tools", "mcp", "papercuts", "project-notifications", ...MODULE_IDS.filter((id) => id.startsWith("provider-")), "recall", "side-question", "skills"] as const).toSorted();
      expect(started.policy.state().moduleIds).toEqual(enabled);
      expect(await readFile(configPath, "utf8")).toBe(disabledLine(enabled));
    });
    await withConfig("", async (configPath) => {
      expect((await startModulePolicy({ configPath })).policy.state().moduleIds).toEqual(MODULE_IDS);
    });
  });

});
