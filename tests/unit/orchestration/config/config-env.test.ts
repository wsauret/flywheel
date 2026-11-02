import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEnvOverrides, profileRoleSettings } from "../../../../src/orchestration/config/env.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporary = temporaryDirectories();

describe("applyEnvOverrides integer boundary", () => {
  it("rejects a negative value at the boundary with the variable named", () => {
    const result = applyEnvOverrides({ FLYWHEEL_BUDGET_MAX_TOKENS: "-1" });
    expect(result.errors).toEqual(["FLYWHEEL_BUDGET_MAX_TOKENS must be a non-negative integer"]);
    expect(result.overrides.budget?.max_tokens).toBeUndefined();
  });

  it("rejects a non-integer with the integer message", () => {
    const result = applyEnvOverrides({ FLYWHEEL_QUEUE_MAX_STEPS: "12.5" });
    expect(result.errors).toEqual(["FLYWHEEL_QUEUE_MAX_STEPS must be an integer"]);
  });

});

describe("FLYWHEEL_DISABLE_AUTOUPDATE", () => {
  it("inverts a documented true value into a disabled auto-install", () => {
    for (const raw of ["1", "true"]) {
      const result = applyEnvOverrides({ FLYWHEEL_DISABLE_AUTOUPDATE: raw });
      expect(result.errors).toEqual([]);
      expect(result.overrides.updates?.auto_install).toBe(false);
    }
  });

  it("leaves the durable setting alone on a false value rather than enabling it", () => {
    for (const raw of ["0", "false"]) {
      const result = applyEnvOverrides({ FLYWHEEL_DISABLE_AUTOUPDATE: raw });
      expect(result.errors).toEqual([]);
      expect(result.overrides.updates?.auto_install).toBeUndefined();
    }
  });

  it("rejects any other value at the boundary with the variable named", () => {
    const result = applyEnvOverrides({ FLYWHEEL_DISABLE_AUTOUPDATE: "yes" });
    expect(result.errors).toEqual(["FLYWHEEL_DISABLE_AUTOUPDATE must be one of 1, 0, true, false"]);
    expect(result.overrides.updates).toBeUndefined();
  });

});

describe("config env role overrides", () => {
  it("supports role-specific model and effort overrides", async () => {
    const env = {
      FLYWHEEL_CHAT_MODEL: "claude-fable-5-1",
      FLYWHEEL_CHAT_EFFORT: "low",
      FLYWHEEL_WORKER_MODEL: "gpt-6-1-sol",
      FLYWHEEL_WORKER_EFFORT: "low",
      FLYWHEEL_PROACTIVE_COMPACTION_THRESHOLD: "300000",
    };
    const { config } = loadConfig(undefined, env);

    const roles = profileRoleSettings(config.profiles.personal?.roles, env);
    expect(roles.chat).toMatchObject({ model: "claude-fable-5.1", effort: "low" });
    expect(roles["workflow-agent"]).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(config.profiles).toEqual({});
    expect(config.proactive_compaction_threshold).toBe(300_000);
  });
});

// Remove with the retired variable spellings after 2027-04-30.
describe("Workflow Agent and attempt-limit variables", () => {
  it("writes the Workflow Agent from the current and every retired spelling", () => {
    for (const [model, effort] of [["FLYWHEEL_WORKFLOW_AGENT_MODEL", "FLYWHEEL_WORKFLOW_AGENT_EFFORT"], ["FLYWHEEL_STEP_AGENT_MODEL", "FLYWHEEL_STEP_AGENT_EFFORT"], ["FLYWHEEL_WORKER_MODEL", "FLYWHEEL_WORKER_EFFORT"]] as const) {
      const result = applyEnvOverrides({ [model]: "gpt-5.5", [effort]: "low" });
      expect(result.errors).toEqual([]);
      expect(result.overrides.roles).toEqual({ "workflow-agent": { model: "gpt-5.5", effort: "low" } });
    }
  });

  it("keeps the current spelling when a retired one is also set", () => {
    const result = applyEnvOverrides({ FLYWHEEL_STEP_AGENT_MODEL: "gpt-5.4", FLYWHEEL_WORKER_EFFORT: "high", FLYWHEEL_WORKFLOW_AGENT_MODEL: "gpt-5.5", FLYWHEEL_WORKFLOW_AGENT_EFFORT: "low" });
    expect(result.overrides.roles).toEqual({ "workflow-agent": { model: "gpt-5.5", effort: "low" } });
  });

  it("writes workflow.max_attempts from the current and both retired spellings, and the current one wins", () => {
    for (const name of ["FLYWHEEL_WORKFLOW_MAX_ATTEMPTS", "FLYWHEEL_WORKFLOW_MAX_STEPS", "FLYWHEEL_QUEUE_MAX_STEPS"]) {
      expect(loadConfig(undefined, { [name]: "80" }).config.workflow.max_attempts).toBe(80);
    }
    expect(loadConfig(undefined, { FLYWHEEL_WORKFLOW_MAX_STEPS: "80", FLYWHEEL_WORKFLOW_MAX_ATTEMPTS: "12" }).config.workflow.max_attempts).toBe(12);
  });

  it("names a role table key under its current id", () => {
    const roles = profileRoleSettings({}, { FLYWHEEL_ROLES: JSON.stringify({ "step-agent": { model: "gpt-6.1-sol" }, "step.fly.implement": { effort: "high" } }) });
    expect(roles).toEqual({ "workflow-agent": { model: "gpt-6.1-sol" }, "brief.fly.implement": { effort: "high" } });
    const mixed = profileRoleSettings({}, { FLYWHEEL_ROLES: JSON.stringify({
      "workflow-agent": { model: "gpt-6.1-sol" }, "step-agent": { model: "gpt-6-luna" },
    }) });
    expect(mixed["workflow-agent"]?.model).toBe("gpt-6.1-sol");
  });
});

describe("FLYWHEEL_ROLES", () => {
  const file = (dir: string) => {
    const path = join(dir, "flywheel.toml");
    writeFileSync(path, [
      "[profiles.personal.roles.step-agent]", "model = \"gpt-6-1-sol\"", "effort = \"high\"",
      "[profiles.personal.roles.reviewer]", "model = \"gpt-6-1-sol\"",
      "[profiles.work.roles.step-agent]", "model = \"claude-fable-5-1\"",
    ].join("\n"));
    return path;
  };

  it("replaces every role setting of the file and leaves unnamed roles on their defaults", async () => {
    const path = file(temporary("roles-env-"));
    const before = readFileSync(path, "utf8");
    const env = { FLYWHEEL_ROLES: JSON.stringify({ "workflow-agent": { model: "claude-opus-5-5", effort: "medium" } }) };
    const { config } = loadConfig(path, env);
    expect(profileRoleSettings(config.profiles.work?.roles, env)).toEqual({ "workflow-agent": { model: "claude-opus-5.5", effort: "medium" } });
    expect(profileRoleSettings(config.profiles.personal?.roles, env)).toEqual({ "workflow-agent": { model: "claude-opus-5.5", effort: "medium" } });
    expect(config.profiles.work?.roles).toEqual({ "workflow-agent": { model: "claude-fable-5.1" } });
    expect(config.profiles.personal?.roles.reviewer?.model).toBe("gpt-6.1-sol");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("keeps the single-role variables over the table", () => {
    const roles = profileRoleSettings({}, { FLYWHEEL_ROLES: JSON.stringify({ chat: { model: "claude-opus-5-5" } }), FLYWHEEL_CHAT_EFFORT: "low" });
    expect(roles.chat).toEqual({ model: "claude-opus-5.5", effort: "low" });
  });

  it.each([
    ["not JSON", "FLYWHEEL_ROLES must be a JSON object"],
    [JSON.stringify({ chat: { model: "claude-sonnet-5-5", temperature: 1 } }), "FLYWHEEL_ROLES must map role ids to objects with only model, effort, and provider_options"],
    [JSON.stringify({ chat: { effort: "extreme" } }), "FLYWHEEL_ROLES must map role ids to objects with only model, effort, and provider_options"],
    [JSON.stringify({ "no-such-role": {} }), "FLYWHEEL_ROLES names unknown role id(s): no-such-role"],
  ])("refuses %s with the variable named", (value, message) => {
    expect(applyEnvOverrides({ FLYWHEEL_ROLES: value }).errors).toEqual([message]);
  });
});
