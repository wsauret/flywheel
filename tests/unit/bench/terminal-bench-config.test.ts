import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveTerminalBenchConfig } from "../../../bench/terminal_bench/terminal-bench-config.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { armProfile, terminalBenchLaunchArgs as launchArgs, terminalBenchProfile as profile } from "../../fixtures/terminal-bench-profile.js";

describe("terminal bench config resolution", () => {
  const temporaryDirectory = temporaryDirectories();
  /** Resolves `args` over a profile file that holds `text`. */
  const resolveProfile = async (text: string, args: string[] = launchArgs, env: { readonly [name: string]: string } = {}) => {
    const root = temporaryDirectory("tb-config-");
    const path = join(root, "profile.yaml");
    await writeFile(path, text);
    return resolveTerminalBenchConfig([...args, "--config", path], { cwd: root, env });
  };

  test("merges profile and CLI and assigns submission grade", async () => {
    const config = await resolveProfile(profile, [...launchArgs, "--concurrency", "4", "--job-name", "campaign"]);
    expect(config.concurrency).toBe(4);
    expect(config.attempts).toBe(5);
    expect(config.grade).toBe("leaderboard_valid");
    expect(config.expectedTrials).toBe(10);
    expect(config.agentPackage).toEqual({ agentRepository: "owner/agent", claudeTokenKeychainItem: "flywheel-claude-oauth-token" });
    expect(config.hosted).toBeUndefined();
    expect(config.agentOverrides).toEqual({});
    expect(config.harborConfig.agents).toBeUndefined();
    expect(config.harborConfig.headless).toBeUndefined();
  });

  test("every run needs a Flywheel config and refuses the removed trial inputs and any other agent source", async () => {
    await expect(resolveProfile("datasets: [{ task_names: [one] }]\n")).rejects.toThrow("the profile must name headless.flywheel_config");
    for (const key of ["interaction_profile: luna-native-v1", "model: gpt-6-luna", "disabled_tools: [web]", "system_prompt: literal"]) {
      await expect(resolveProfile(`headless:\n  flywheel_config: bench/terminal_bench/configs/tb-mini-openai.toml\n  ${key}\ndatasets: [{ task_names: [one] }]\n`)).rejects.toThrow(`headless contains unknown keys: ${key.split(":")[0]}`);
    }
    await expect(resolveProfile(armProfile(), [...launchArgs, "--model", "gpt-6-luna"])).rejects.toThrow("unsupported Terminal-Bench option: --model");
    for (const agent of ["model_name: openai/gpt-6-luna", "import_path: wrong:Agent", "env: { OPENAI_API_KEY: key }"]) {
      await expect(resolveProfile(armProfile(`agents: [{ ${agent} }]\ndatasets: [{ task_names: [one] }]\n`))).rejects.toThrow("is launcher-owned");
    }
  });

  test("takes the chat model from a validated Flywheel config", async () => {
    const root = temporaryDirectory("tb-flywheel-config-");
    const configPath = join(root, "arm.toml");
    const configText = 'allow_persistent_processes = true\n[profiles.benchmark.roles.chat]\nmodel = "gpt-6.1-sol"\neffort = "high"\n';
    await writeFile(configPath, configText);
    const config = await resolveProfile(`headless: { flywheel_config: '${configPath}' }\ndatasets: [{ task_names: [one] }]\n`);
    const sha256 = createHash("sha256").update(configText).digest("hex");
    expect(config.model).toBe("gpt-6.1-sol");
    const credentialProviders = config.flywheelConfig.credentialProviders;
    expect(credentialProviders).toContain("chatgpt");
    expect(config.flywheelConfig).toEqual({ path: configPath, absolutePath: configPath, sha256, chatEffort: "high", credentialProviders });
  });

  test("refuses a Flywheel config that Flywheel would reject or ignore in part", async () => {
    const root = temporaryDirectory("tb-flywheel-config-refusal-");
    const configPath = join(root, "arm.toml");
    const pinnedChat = '[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\neffort = "max"\n';
    const resolveWith = async (configText: string, flywheelConfig = configPath) => {
      await writeFile(configPath, configText);
      return resolveProfile(`headless: { flywheel_config: '${flywheelConfig}' }\ndatasets: [{ task_names: [one] }]\n`);
    };
    await expect(resolveWith("allow_persistent_processes = [\n")).rejects.toThrow(`headless.flywheel_config ${configPath} is not a valid Flywheel config: Failed to parse config file`);
    await expect(resolveWith(`interaction_profile = "luna-native-v1"\n${pinnedChat}`)).rejects.toThrow('Unrecognized config key "interaction_profile"');
    await expect(resolveWith(`allow_persistent_processes = "yes"\n${pinnedChat}`)).rejects.toThrow('Invalid config value "allow_persistent_processes"');
    await expect(resolveWith(`disabled_modules = ["no-such-module"]\n${pinnedChat}`)).rejects.toThrow("no-such-module");
    await expect(resolveWith('[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\n')).rejects.toThrow("must pin model and effort in [profiles.benchmark.roles.chat]");
    await expect(resolveWith(pinnedChat, "bench/terminal_bench/configs/missing.toml")).rejects.toThrow("bench/terminal_bench/configs/missing.toml is not a valid Flywheel config");
  });

  test.each([
    ["OpenAI", "tb-mini-openai.toml", "gpt-6.1-terra", ["chatgpt"]],
    ["Claude", "tb-mini-claude.toml", "claude-sonnet-5.5", ["claude_agent_sdk"]],
  ])("the checked-in %s arm config passes host validation, pins its model at medium effort, and names its one credential provider", async (_arm, file, model, providers) => {
    const config = await resolveProfile(`headless: { flywheel_config: bench/terminal_bench/configs/${file} }\ndatasets: [{ task_names: [one] }]\n`);
    expect(config.model).toBe(model);
    expect(config.flywheelConfig.chatEffort).toBe("medium");
    expect(config.flywheelConfig.absolutePath).toBe(resolve(process.cwd(), `bench/terminal_bench/configs/${file}`));
    expect(config.flywheelConfig.credentialProviders).toEqual(providers);
  });

  test("every run needs an agent repository; a hosted run takes a Hub organization and refuses a local image prebuild", async () => {
    const auth = ["--auth-profile", "Fixture"];
    expect((await resolveProfile(armProfile(), auth, { FLYWHEEL_TB_AGENT_REPO: "owner/agent" })).agentPackage.agentRepository).toBe("owner/agent");
    await expect(resolveProfile(armProfile(), auth)).rejects.toThrow("every run requires --agent-repo");
    const hosted = await resolveProfile(armProfile(), [...launchArgs, "--hosted", "--organization", "org", "--claude-token-keychain-item", "other-item"]);
    expect(hosted.hosted).toEqual({ organization: "org" });
    expect(hosted.agentPackage.claudeTokenKeychainItem).toBe("other-item");
    expect((await resolveProfile(armProfile(), [...launchArgs, "--hosted"])).hosted).toEqual({});
    await expect(resolveProfile(armProfile(), [...launchArgs, "--hosted", "--prebuild"])).rejects.toThrow("--prebuild");
  });

  test("expects the shell tool of the profile the product selects for the model", async () => {
    const root = temporaryDirectory("tb-interaction-");
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-opus-5-5", "unknown-model"]) {
      const configPath = join(root, `${model}.toml`);
      await writeFile(configPath, `[profiles.benchmark.roles.chat]\nmodel = "${model}"\neffort = "medium"\n`);
      expect((await resolveProfile(`headless: { flywheel_config: '${configPath}' }\ndatasets: [{ task_names: [one] }]\n`)).expectedInteraction).toEqual({ profileId: "default", executableToolName: "bash" });
    }
  });

  test("accepts only exact lowercase runtime commit pins", async () => {
    const pinned = (value: string) => `headless: { flywheel_config: bench/terminal_bench/configs/tb-mini-openai.toml, runtime_source_commit: '${value}' }\ndatasets: [{ task_names: [one] }]\n`;
    for (const value of ["abc123", "A".repeat(40), `${"a".repeat(40)} `, "refs/heads/main"]) {
      await expect(resolveProfile(pinned(value))).rejects.toThrow("exact lowercase 40-hex");
    }
    expect((await resolveProfile(pinned("a".repeat(40)))).runtimeSourceCommit).toBe("a".repeat(40));
    await expect(resolveProfile(armProfile(), [...launchArgs, "--runtime-source-commit", "a".repeat(40)])).rejects.toThrow("unsupported");
  });

  test("low k needs explicit local admission and is graded", async () => {
    await expect(resolveProfile(armProfile(), [...launchArgs, "--attempts", "1"])).rejects.toThrow("--allow-low-k");
    const config = await resolveProfile(armProfile(), [...launchArgs, "--attempts", "1", "--allow-low-k"]);
    expect(config.grade).toBe("debug_only");
    expect(config.warning).toContain("not leaderboard-valid");
  });

  test("uses separate admissions and defaults to dry-run", async () => {
    expect((await resolveProfile(armProfile())).dryRun).toBeTrue();
    expect((await resolveProfile(armProfile(), [...launchArgs, "--execute"])).dryRun).toBeFalse();
    await expect(resolveProfile(armProfile(), [...launchArgs, "--timeout-multiplier", "2"])).rejects.toThrow("--allow-timeout-multipliers");
    await expect(resolveProfile(armProfile(), [...launchArgs, "--resource-overrides", '{"cpu":2}'])).rejects.toThrow("--allow-resource-overrides");
    const admitted = await resolveProfile(armProfile(), [...launchArgs, "--timeout-multiplier", "2", "--allow-timeout-multipliers"]);
    expect(admitted.grade).toBe("local_low_k");
  });

  test("rejects the removed dirty-seed option", async () => {
    await expect(resolveTerminalBenchConfig([...launchArgs, "--task-names", "one", "--allow-dirty-seed"])).rejects.toThrow("unsupported Terminal-Bench option");
  });

  test("gates profile-supplied timeout and nested resource overrides", async () => {
    const text = armProfile("agent_timeout_multiplier: 2\nagents:\n- override_timeout_sec: 7200\ndatasets:\n- task_names: [terminal-bench/one]\nn_attempts: 5\n");
    await expect(resolveProfile(text)).rejects.toThrow("--allow-timeout-multipliers");
    await expect(resolveProfile(text, [...launchArgs, "--allow-timeout-multipliers"])).rejects.toThrow("--allow-resource-overrides");
    const admitted = await resolveProfile(text, [...launchArgs, "--allow-timeout-multipliers", "--allow-resource-overrides"]);
    expect(admitted.grade).toBe("local_low_k");
    expect(admitted.timeoutMultipliers.agent_timeout_multiplier).toBe(2);
    expect(admitted.resourceOverrides["agent.override_timeout_sec"]).toBe(7200);
    expect(admitted.agentOverrides).toEqual({ override_timeout_sec: 7200 });
  });

  test("rejects profile-supplied host mounts and environment variables", async () => {
    await expect(resolveProfile(armProfile("environment:\n  mounts:\n  - type: bind\n    source: /Users/operator/.ssh\n    target: /root/.ssh\n    read_only: true\ndatasets: [{ task_names: [one] }]\n"))).rejects.toThrow("environment.mounts is launcher-owned");
    await expect(resolveProfile(armProfile("environment:\n  env:\n    PATH: /task/controlled\n    FLYWHEEL_BUDGET_USD: '999'\ndatasets: [{ task_names: [one] }]\n"))).rejects.toThrow("environment.env is launcher-owned");
    await expect(resolveProfile(armProfile("verifier:\n  env:\n    PYTHONPATH: /task/controlled\ndatasets: [{ task_names: [one] }]\n"))).rejects.toThrow("verifier.env is launcher-owned");
  });

  test("requires launcher auth and rejects profile-selected authorization", async () => {
    await expect(resolveProfile(armProfile(), ["--agent-repo", "owner/agent"])).rejects.toThrow("--auth-profile");
    await expect(resolveProfile(armProfile("auth_profile: Copied\ndatasets: [{ task_names: [one] }]\n"))).rejects.toThrow("auth_profile is launcher-only");
  });
});
