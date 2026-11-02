import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCanonicalConfigText } from "../../../../src/orchestration/config/loader.js";
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { migrateModelAssignments, pruneStaleConfig, updateModelAssignment } from "../../../../src/orchestration/config/writer.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

// A config that a release before 2026-10-16 saved: the Workflow Agent as
// `step-agent`, and the brief, persona, and record seats under `step.`.
// Remove with the conversion after 2027-04-30.
const RETIRED = `[workflow]
max_steps = 80

[profiles.Personal.roles.step-agent]
model = "gpt-5.4"
effort = "high"

[profiles.Work.roles."step.fly.implement"]
model = "gpt-5.5"
effort = "medium"

# The quality reviewer under spec-review.
[profiles.Work.roles."step.fly.spec-review.agent.reviewer-quality"]
model = "gpt-5.4"

[profiles.Work.roles."step.debug.fix.at.fix"]
model = "gpt-5.5"

[profiles.Work.roles."step.code-review"]
effort = "high"

[profiles.Work.roles.step-agent]
model = "gpt-5.5"
`;

const CURRENT_PERSONAL = { "workflow-agent": { model: "gpt-5.4", effort: "high" } };
const CURRENT_WORK = {
  "brief.fly.implement": { model: "gpt-5.5", effort: "medium" },
  "brief.fly.spec-review.persona.reviewer-quality": { model: "gpt-5.4" },
  "brief.debug.fix.at.fix": { model: "gpt-5.5" },
  "brief.code-review": { effort: "high" },
  "workflow-agent": { model: "gpt-5.5" },
};

const temporary = temporaryDirectories();
const read = (text: string) => decodeCanonicalConfigText(text, {}).config;

function retiredFile(text = RETIRED): string {
  const configPath = join(temporary("retired-seats-"), "flywheel.toml");
  writeFileSync(configPath, text);
  return configPath;
}

function expectEverySeat(text: string): void {
  const config = read(text);
  expect(config.profiles.Personal?.roles).toEqual(expect.objectContaining(CURRENT_PERSONAL));
  expect(config.profiles["Work"]?.roles).toEqual(expect.objectContaining(CURRENT_WORK));
  expect(config.workflow.max_attempts).toBe(80);
}

describe("workflow seats that a release before 2026-10-16 saved", () => {
  // Remove with the retired brief conversion after 2027-04-30.
  it("keeps retired brief settings when the model picker no longer lists their briefs or personas", () => {
    const source = `# Keep the person's models for their own briefs.
[profiles.Personal.roles."brief.fly.implement"]
model = "gpt-5.5" # Keep this comment.

[profiles.Personal.roles."brief.qa.review-fixes"]
model = "gpt-5.4"

[profiles.Personal.roles."brief.debug.fix"]
model = "gpt-5.5"

[profiles.Personal.roles."brief.fly.raindrop-audit"]
model = "gpt-5.4"

[profiles.Work.roles."brief.fly.raindrop-audit.persona.reviewer-quality"]
effort = "high"

[profiles.Work.roles."brief.fly.raindrop-audit.at.raindrop-audit"]
model = "gpt-5.5"

[profiles.Work.roles."brief.fly.spec-create.at.spec-create"]
effort = "high"

[profiles.Work.roles."brief.fly.spec-review.persona.reviewer-quality"]
effort = "medium"

[profiles.Work.roles."brief.debug.verify.persona.reviewer-quality"]
effort = "low"

[profiles.Work.roles."brief.fly.spec-review.persona.custom-review"]
model = "gpt-5.4"

[profiles.Work.roles."step.fly.implement.agent.reviewer-quality"]
effort = "low"

[profiles.Work.roles."step.qa.surface-map.agent.reviewer-uat"]
effort = "high"
`;
    const configPath = retiredFile(source);
    const validity = { roleIds: new Set(["custom-review"]) };
    pruneStaleConfig(validity, { configPath, authProfileId: () => "Personal" });
    pruneStaleConfig(validity, { configPath, authProfileId: () => "Work" });
    expect(readFileSync(configPath, "utf8")).toBe(source.replace("step.fly.implement.agent.", "brief.fly.implement.persona.").replace("step.qa.surface-map.agent.", "brief.qa.surface-map.persona."));
    expect(read(readFileSync(configPath, "utf8")).profiles["Work"]?.roles["brief.fly.spec-review.persona.custom-review"]).toEqual({ model: "gpt-5.4" });
    const config = read(readFileSync(configPath, "utf8"));
    expect(config.profiles.Personal?.roles["brief.qa.review-fixes"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles["Work"]?.roles["brief.qa.surface-map.persona.reviewer-uat"]).toEqual({ effort: "high" });
    expect(config.profiles.Personal?.roles["brief.debug.fix"]).toEqual({ model: "gpt-5.5" });
    expect(config.profiles.Personal?.roles["brief.fly.raindrop-audit"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles["Work"]?.roles["brief.fly.raindrop-audit.persona.reviewer-quality"]).toEqual({ effort: "high" });
    expect(config.profiles["Work"]?.roles["brief.fly.raindrop-audit.at.raindrop-audit"]).toEqual({ model: "gpt-5.5" });
    expect(config.profiles["Work"]?.roles["brief.debug.verify.persona.reviewer-quality"]).toEqual({ effort: "low" });
  });

  // Remove with the retired brief conversion after 2027-04-30.
  it("warns once per retired setting in each canonical role table without remapping it", () => {
    const source = `[profiles.Personal.roles."brief.fly.implement"]
model = "gpt-5.5"
effort = "high"

[profiles.Personal.roles."step.fly.implement"]
model = "gpt-5.4"

[profiles.Personal.roles."brief.qa.review-fixes"]
model = "gpt-5.4"

[profiles.Personal.roles."brief.debug.fix"]
model = "gpt-5.5"

[profiles.Personal.roles."brief.fly.raindrop-audit"]
model = "gpt-5.4"

[profiles.Work.roles."brief.fly.spec-create.at.spec-create"]
effort = "high"

[profiles.Work.roles."step.fly.spec-review.agent.reviewer-quality"]
model = "gpt-5.4"

[profiles.Work.roles."step.qa.surface-map.agent.reviewer-uat"]
effort = "high"

[profiles.Work.roles."brief.debug.investigate.persona.reviewer-quality"]
effort = "low"

[profiles.Work.roles."step.debug.verify.at.verify"]
model = "gpt-5.4"

[profiles.Personal.roles."brief.myflow.review"]
model = "gpt-5.4"

[profiles.Work.roles."brief.myflow.review.persona.reviewer"]
effort = "high"
`;
    const { config, warnings } = decodeCanonicalConfigText(source, {});
    expect(warnings).toEqual([
      `The setting for "brief.fly.implement" in [profiles.Personal.roles] is kept. Its brief retired with the implement workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.qa.review-fixes" in [profiles.Personal.roles] is kept. Its brief retired with the qa workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.debug.fix" in [profiles.Personal.roles] is kept. Its brief retired with the debug workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.fly.raindrop-audit" in [profiles.Personal.roles] is kept. Its brief retired with the raindrop-audit workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.myflow.review" in [profiles.Personal.roles] is kept. The default picker no longer lists briefs, and per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.fly.spec-create.at.spec-create" in [profiles.Work.roles] is kept. Its brief retired with the implement workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.debug.investigate.persona.reviewer-quality" in [profiles.Work.roles] is kept. Its brief retired with the debug workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.myflow.review.persona.reviewer" in [profiles.Work.roles] is kept. The default picker no longer lists briefs, and per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.fly.spec-review.persona.reviewer-quality" in [profiles.Work.roles] is kept. Its brief retired with the implement workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.qa.surface-map.persona.reviewer-uat" in [profiles.Work.roles] is kept. Its brief retired with the qa workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
      `The setting for "brief.debug.verify.at.verify" in [profiles.Work.roles] is kept. Its brief retired with the debug workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`,
    ]);
    expect(config.profiles.Personal?.roles["brief.fly.implement"]).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(config.profiles["Work"]?.roles["brief.fly.spec-review.persona.reviewer-quality"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles.Personal?.roles["brief.qa.review-fixes"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles["Work"]?.roles["brief.qa.surface-map.persona.reviewer-uat"]).toEqual({ effort: "high" });
    expect(config.profiles.Personal?.roles["brief.debug.fix"]).toEqual({ model: "gpt-5.5" });
    expect(config.profiles.Personal?.roles["brief.fly.raindrop-audit"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles["Work"]?.roles["brief.debug.investigate.persona.reviewer-quality"]).toEqual({ effort: "low" });
    expect(config.profiles["Work"]?.roles["brief.debug.verify.at.verify"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles.Personal?.roles["brief.myflow.review"]).toEqual({ model: "gpt-5.4" });
    expect(config.profiles["Work"]?.roles["brief.myflow.review.persona.reviewer"]).toEqual({ effort: "high" });
  });

  it("load under their current names with every value", () => {
    const config = read(RETIRED);
    expect<unknown>(config.profiles.Personal?.roles).toEqual(CURRENT_PERSONAL);
    expect<unknown>(config.profiles["Work"]?.roles).toEqual(CURRENT_WORK);
    expect(config.workflow.max_attempts).toBe(80);
  });

  it("survive a model save, which writes every seat under its current name", () => {
    const configPath = retiredFile();
    updateModelAssignment(roleSlot("brief.fly.spec-review"), { model: "gpt-5.4", effort: "low" }, { configPath, authProfileId: () => "Work" });

    const text = readFileSync(configPath, "utf8");
    expectEverySeat(text);
    expect(read(text).profiles["Work"]?.roles["brief.fly.spec-review"]).toEqual({ model: "gpt-5.4", effort: "low" });
    expect(text).not.toMatch(/step[.-]|max_steps/);
  });

  it("survive the startup rewrite, which renames each key in place and keeps every other byte", () => {
    const configPath = retiredFile();
    expect(migrateModelAssignments({ configPath })).toEqual({ ok: true });

    const text = readFileSync(configPath, "utf8");
    expect(text).toBe(RETIRED
      .replace("max_steps", "max_attempts")
      .replaceAll("roles.step-agent]", "roles.workflow-agent]")
      .replaceAll('"step.fly.spec-review.agent.reviewer-quality"', '"brief.fly.spec-review.persona.reviewer-quality"')
      .replaceAll('"step.', '"brief.'));
    expectEverySeat(text);
  });

  it("survive a prune without a brief catalog", () => {
    const configPath = retiredFile();
    pruneStaleConfig({ roleIds: new Set() }, { configPath, authProfileId: () => "Work" });
    expectEverySeat(readFileSync(configPath, "utf8"));
  });

  it("yield to a seat that the file also holds under its current name", () => {
    const both = '[profiles.Personal.roles.step-agent]\nmodel = "gpt-5.4"\n\n[profiles.Personal.roles.workflow-agent]\nmodel = "gpt-5.5"\n\n[workflow]\nmax_steps = 80\nmax_attempts = 12\n';
    expect(read(both).profiles.Personal?.roles).toEqual({ "workflow-agent": { model: "gpt-5.5" } });
    expect(read(both).workflow.max_attempts).toBe(12);

    const configPath = retiredFile(both);
    migrateModelAssignments({ configPath });
    expect(readFileSync(configPath, "utf8")).toBe('\n[profiles.Personal.roles.workflow-agent]\nmodel = "gpt-5.5"\n\n[workflow]\nmax_attempts = 12\n');
  });

  it("rename in dotted and inline tables too", () => {
    const configPath = retiredFile('[profiles.Personal.roles]\n"step.fly.implement" = { model = "gpt-5.5" }\n\n[profiles.Work]\nroles."step.fly.plan.agent.reviewer".effort = "low"\n');
    migrateModelAssignments({ configPath });

    const text = readFileSync(configPath, "utf8");
    expect(text).toBe('[profiles.Personal.roles]\n"brief.fly.implement" = { model = "gpt-5.5" }\n\n[profiles.Work]\nroles."brief.fly.plan.persona.reviewer".effort = "low"\n');
    expect(read(text).profiles.Personal?.roles).toEqual({ "brief.fly.implement": { model: "gpt-5.5" } });
  });
});
