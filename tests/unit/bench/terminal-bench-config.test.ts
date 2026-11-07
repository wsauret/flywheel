import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveTerminalBenchConfig } from "../../../bench/terminal_bench/terminal-bench-config.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { terminalBenchAuthArgs as authArgs, terminalBenchProfile as profile } from "../../fixtures/terminal-bench-profile.js";

describe("terminal bench config resolution", () => {
  const temporaryDirectory = temporaryDirectories();

  test("merges profile and CLI and assigns submission grade", async () => {
    const root = temporaryDirectory("tb-config-");
    const path = join(root, "profile.yaml");
    await writeFile(path, profile);
    const config = await resolveTerminalBenchConfig([...authArgs, "--config", path, "--concurrency", "4", "--job-name", "campaign"], { cwd: root });
    expect(config.concurrency).toBe(4);
    expect(config.attempts).toBe(5);
    expect(config.grade).toBe("leaderboard_valid");
    expect(config.expectedTrials).toBe(10);
    expect(config.harborConfig.agents).toEqual([{ name: "FlywheelHeadless", import_path: "bench.terminal_bench.flywheel_agent:FlywheelHeadless", model_name: "flywheel/gpt-6-luna", kwargs: { flywheel_model: "gpt-6-luna", project_root_mode: "task_workspace", evidence_export: "settled_sqlite", persistent_processes: true, profile_sha256: config.profileSha256 } }]);
    expect(config.disabledTools).toEqual(["web"]);
    expect(config.systemPrompt).toBe("literal prompt\nbytes\n");
    expect(config.harborConfig.headless).toBeUndefined();
    expect(config.harborConfig.flywheel).toBeUndefined();
  });

  test("refuses a profile that selects an interaction profile", async () => {
    const root = temporaryDirectory("tb-interaction-profile-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "headless:\n  interaction_profile: luna-native-v1\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("headless contains unknown keys: interaction_profile");
  });

  test("takes the chat model from a validated Flywheel config and hands the trial its bytes", async () => {
    const root = temporaryDirectory("tb-flywheel-config-");
    const configPath = join(root, "arm.toml");
    const configText = 'allow_persistent_processes = true\n[profiles.benchmark.roles.chat]\nmodel = "gpt-6.1-sol"\neffort = "high"\n';
    await writeFile(configPath, configText);
    const path = join(root, "profile.yaml");
    await writeFile(path, `headless: { flywheel_config: '${configPath}' }\ndatasets: [{ task_names: [one] }]\n`);
    const config = await resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root });
    const sha256 = createHash("sha256").update(configText).digest("hex");
    expect(config.model).toBe("gpt-6.1-sol");
    const credentialProviders = config.flywheelConfig?.credentialProviders ?? [];
    expect(credentialProviders).toContain("chatgpt");
    expect(config.flywheelConfig).toEqual({ path: configPath, absolutePath: configPath, sha256, chatEffort: "high", credentialProviders });
    expect(config.harborConfig.agents).toEqual([{ name: "FlywheelHeadless", import_path: "bench.terminal_bench.flywheel_agent:FlywheelHeadless", model_name: "flywheel/gpt-6.1-sol", kwargs: { flywheel_config_path: configPath, flywheel_config_sha256: sha256, trial_auth_profile: "benchmark", credential_providers: credentialProviders, project_root_mode: "task_workspace", evidence_export: "settled_sqlite", persistent_processes: true, profile_sha256: config.profileSha256 } }]);
  });

  test("refuses a Flywheel config that Flywheel would reject or ignore in part, or a second model source", async () => {
    const root = temporaryDirectory("tb-flywheel-config-refusal-");
    const configPath = join(root, "arm.toml");
    const path = join(root, "profile.yaml");
    const pinnedChat = '[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\neffort = "max"\n';
    const resolveWith = async (configText: string, headless = `flywheel_config: '${configPath}'`, extraArgs: string[] = []) => {
      await writeFile(configPath, configText);
      await writeFile(path, `headless: { ${headless} }\ndatasets: [{ task_names: [one] }]\n`);
      return resolveTerminalBenchConfig([...authArgs, "--config", path, ...extraArgs], { cwd: root });
    };
    await expect(resolveWith("allow_persistent_processes = [\n")).rejects.toThrow(`headless.flywheel_config ${configPath} is not a valid Flywheel config: Failed to parse config file`);
    await expect(resolveWith(`interaction_profile = "luna-native-v1"\n${pinnedChat}`)).rejects.toThrow('Unrecognized config key "interaction_profile"');
    await expect(resolveWith(`allow_persistent_processes = "yes"\n${pinnedChat}`)).rejects.toThrow('Invalid config value "allow_persistent_processes"');
    await expect(resolveWith(`disabled_modules = ["no-such-module"]\n${pinnedChat}`)).rejects.toThrow("no-such-module");
    await expect(resolveWith('[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\n')).rejects.toThrow("must pin model and effort in [profiles.benchmark.roles.chat]");
    await expect(resolveWith(pinnedChat, `flywheel_config: '${configPath}', model: gpt-6-luna`)).rejects.toThrow("headless.model conflicts with headless.flywheel_config");
    await expect(resolveWith(pinnedChat, undefined, ["--model", "gpt-6-luna"])).rejects.toThrow("--model conflicts with headless.flywheel_config");
    await expect(resolveWith(pinnedChat, "flywheel_config: bench/terminal_bench/configs/missing.toml")).rejects.toThrow("bench/terminal_bench/configs/missing.toml is not a valid Flywheel config");
  });

  test.each([
    ["OpenAI", "tb-mini-openai.toml", "gpt-6.1-terra", ["chatgpt"]],
    ["Claude", "tb-mini-claude.toml", "claude-sonnet-5.5", ["claude_agent_sdk"]],
  ])("the checked-in %s arm config passes host validation, pins its model at medium effort, and names its one credential provider", async (_arm, file, model, providers) => {
    const root = temporaryDirectory("tb-arm-");
    const path = join(root, "profile.yaml");
    await writeFile(path, `headless: { flywheel_config: bench/terminal_bench/configs/${file} }\ndatasets: [{ task_names: [one] }]\n`);
    const config = await resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root });
    expect(config.model).toBe(model);
    expect(config.flywheelConfig?.chatEffort).toBe("medium");
    expect(config.flywheelConfig?.absolutePath).toBe(resolve(process.cwd(), `bench/terminal_bench/configs/${file}`));
    expect(config.flywheelConfig?.credentialProviders).toEqual(providers);
  });

  test("a hosted run needs an agent repository and a Flywheel config, and refuses launcher-side trial inputs", async () => {
    const root = temporaryDirectory("tb-hosted-config-");
    const armProfile = join(root, "arm.yaml");
    await writeFile(armProfile, "headless: { flywheel_config: bench/terminal_bench/configs/tb-mini-openai.toml }\ndatasets: [{ task_names: [one] }]\n");
    const modelProfile = join(root, "model.yaml");
    await writeFile(modelProfile, "headless: { model: gpt-6-luna }\ndatasets: [{ task_names: [one] }]\n");
    const resolveHosted = (path: string, extra: string[], env: { readonly [name: string]: string } = {}) => resolveTerminalBenchConfig([...authArgs, "--config", path, "--hosted", ...extra], { cwd: root, env });
    expect((await resolveHosted(armProfile, [], { FLYWHEEL_TB_AGENT_REPO: "owner/agent" })).hosted).toEqual({ agentRepository: "owner/agent", claudeTokenKeychainItem: "flywheel-claude-oauth-token" });
    expect((await resolveHosted(armProfile, ["--agent-repo", "owner/agent", "--organization", "org", "--claude-token-keychain-item", "other-item"])).hosted).toEqual({ agentRepository: "owner/agent", organization: "org", claudeTokenKeychainItem: "other-item" });
    await expect(resolveHosted(armProfile, [])).rejects.toThrow("--agent-repo");
    await expect(resolveHosted(armProfile, ["--agent-repo", "owner/agent", "--prebuild"])).rejects.toThrow("--prebuild");
    await expect(resolveHosted(modelProfile, ["--agent-repo", "owner/agent"])).rejects.toThrow("requires headless.flywheel_config");
  });

  test("expects the shell tool of the profile the product selects for the model", async () => {
    const base = [...authArgs, "--task-names", "one"];
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-opus-5-5", "unknown-model"]) {
      expect((await resolveTerminalBenchConfig([...base, "--model", model])).expectedInteraction).toEqual({ profileId: "default", executableToolName: "bash" });
    }
  });

  test("strictly validates profile-owned disabled tools", async () => {
    const root = temporaryDirectory("tb-tools-");
    const path = join(root, "profile.yaml");
    const resolveProfile = () => resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root });
    await writeFile(path, "headless: { disabled_tools: web }\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveProfile()).rejects.toThrow("canonical tool names");
    await writeFile(path, "headless: { disabled_tools: [web], extra: true }\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveProfile()).rejects.toThrow("unknown keys");
    await writeFile(path, "headless: { disabled_tools: [web, web] }\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveProfile()).rejects.toThrow("duplicates");
    await writeFile(path, "headless: { disabled_tools: [../web] }\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveProfile()).rejects.toThrow("canonical tool names");
    await writeFile(path, "headless: { disabled_tools: [Web] }\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveProfile()).rejects.toThrow("canonical tool names");
  });

  test("accepts only exact lowercase runtime commit pins", async () => {
    const root = temporaryDirectory("tb-runtime-pin-");
    const path = join(root, "profile.yaml");
    const resolveProfile = () => resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root });
    for (const value of ["abc123", "A".repeat(40), `${"a".repeat(40)} `, "refs/heads/main"]) {
      await writeFile(path, `headless: { runtime_source_commit: '${value}' }\ndatasets: [{ task_names: [one] }]\n`);
      await expect(resolveProfile()).rejects.toThrow("exact lowercase 40-hex");
    }
    await writeFile(path, `headless: { runtime_source_commit: '${"a".repeat(40)}' }\ndatasets: [{ task_names: [one] }]\n`);
    expect((await resolveProfile()).runtimeSourceCommit).toBe("a".repeat(40));
    await expect(resolveTerminalBenchConfig([...authArgs, "--task-names", "one", "--runtime-source-commit", "a".repeat(40)])).rejects.toThrow("unsupported");
  });

  test("rejects provider-shaped agent model configuration", async () => {
    const root = temporaryDirectory("tb-agent-model-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "agents: [{ model_name: openai/gpt-6-luna }]\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("use headless.model");
  });

  test("low k needs explicit local admission and is graded", async () => {
    await expect(resolveTerminalBenchConfig([...authArgs, "--attempts", "1"], { cwd: process.cwd() })).rejects.toThrow("--allow-low-k");
    const config = await resolveTerminalBenchConfig([...authArgs, "--attempts", "1", "--allow-low-k", "--task-names", "one"], { cwd: process.cwd() });
    expect(config.grade).toBe("debug_only");
    expect(config.warning).toContain("not leaderboard-valid");
  });

  test("uses separate admissions and defaults to dry-run", async () => {
    const base = [...authArgs, "--task-names", "one"];
    expect((await resolveTerminalBenchConfig(base)).dryRun).toBeTrue();
    expect((await resolveTerminalBenchConfig([...base, "--execute"])).dryRun).toBeFalse();
    await expect(resolveTerminalBenchConfig([...base, "--timeout-multiplier", "2"])).rejects.toThrow("--allow-timeout-multipliers");
    await expect(resolveTerminalBenchConfig([...base, "--resource-overrides", '{"cpu":2}'])).rejects.toThrow("--allow-resource-overrides");
    const admitted = await resolveTerminalBenchConfig([...base, "--timeout-multiplier", "2", "--allow-timeout-multipliers"]);
    expect(admitted.grade).toBe("local_low_k");
  });

  test("pins the r16 smoke and candidate arm controls", async () => {
    const profiles = resolve(process.cwd(), "bench/terminal_bench/profiles");
    const smoke = await resolveTerminalBenchConfig([...authArgs, "--config", join(profiles, "r16-shell-candidate-smoke-1x-20260820.yaml"), "--allow-low-k"]);
    const candidate = await resolveTerminalBenchConfig([...authArgs, "--config", join(profiles, "r16-shell-candidate-5x-20260820.yaml")]);
    expect(smoke.expectedTrials).toBe(1);
    expect(candidate.expectedTrials).toBe(5);
    for (const arm of [smoke, candidate]) {
      expect(arm.model).toBe("gpt-6-luna");
      expect(arm.concurrency).toBe(2);
      expect(arm.taskNames).toEqual(["terminal-bench/protein-assembly"]);
      expect(arm.disabledTools).toEqual(["web", "subagent", "papercut_log", "papercut_dispose"]);
    }
  });

  test("rejects the removed dirty-seed option", async () => {
    await expect(resolveTerminalBenchConfig([...authArgs, "--task-names", "one", "--allow-dirty-seed"])).rejects.toThrow("unsupported Terminal-Bench option");
  });

  test("gates profile-supplied timeout and nested resource overrides", async () => {
    const root = temporaryDirectory("tb-methodology-gates-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "agent_timeout_multiplier: 2\nagents:\n- override_timeout_sec: 7200\ndatasets:\n- task_names: [terminal-bench/one]\nn_attempts: 5\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("--allow-timeout-multipliers");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path, "--allow-timeout-multipliers"], { cwd: root })).rejects.toThrow("--allow-resource-overrides");
    const admitted = await resolveTerminalBenchConfig([...authArgs, "--config", path, "--allow-timeout-multipliers", "--allow-resource-overrides"], { cwd: root });
    expect(admitted.grade).toBe("local_low_k");
    expect(admitted.timeoutMultipliers.agent_timeout_multiplier).toBe(2);
    expect(admitted.resourceOverrides["agent.override_timeout_sec"]).toBe(7200);
  });

  test("rejects profile-supplied host mounts", async () => {
    const root = temporaryDirectory("tb-profile-mount-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "environment:\n  mounts:\n  - type: bind\n    source: /Users/operator/.ssh\n    target: /root/.ssh\n    read_only: true\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("environment.mounts is launcher-owned");
  });

  test("rejects profile-supplied environment variables", async () => {
    const root = temporaryDirectory("tb-profile-env-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "environment:\n  env:\n    PATH: /task/controlled\n    BASH_ENV: /task/bootstrap.sh\n    FLYWHEEL_BUDGET_USD: '999'\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("environment.env is launcher-owned");
  });

  test("rejects profile-supplied verifier environment variables", async () => {
    const root = temporaryDirectory("tb-profile-verifier-env-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "verifier:\n  env:\n    PYTHONPATH: /task/controlled\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("verifier.env is launcher-owned");
  });

  test("requires launcher auth and rejects profile-selected authorization", async () => {
    await expect(resolveTerminalBenchConfig(["--task-names", "one"])).rejects.toThrow("--auth-profile");
    const root = temporaryDirectory("tb-auth-source-");
    const path = join(root, "profile.yaml");
    await writeFile(path, "auth_profile: Copied\ndatasets: [{ task_names: [one] }]\n");
    await expect(resolveTerminalBenchConfig([...authArgs, "--config", path], { cwd: root })).rejects.toThrow("auth_profile is launcher-only");
  });
});
