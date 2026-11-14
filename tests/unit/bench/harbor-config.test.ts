import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveHarborConfig } from "../../../bench/harbor/harbor-config.js";
import { HARBOR_BENCHMARKS } from "../../../bench/harbor/benchmarks.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { harborLaunchArgs as launchArgs } from "../../fixtures/harbor-run.js";
import { readFileSync, readdirSync } from "node:fs";
import { decodeCanonicalConfigText } from "../../../src/orchestration/config/loader.js";
import { composeFirstPartyModules, type ModuleId } from "../../../src/orchestration/modules.js";
import { availableAgentTypes, definitionAvailabilityOf } from "../../../src/orchestration/app-service/definition-availability.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { disabledTypesOf } from "../../../src/orchestration/modules/subagents/config.js";

const ACCESS = ["--auth-profile", "Fixture", "--agent-repo", "owner/agent"];
const ONE_TASK = ["--task-names", "one"];

describe("Harbor config resolution", () => {
  const temporaryDirectory = temporaryDirectories();
  const resolveArgs = (args: string[], env: { readonly [name: string]: string } = {}) => resolveHarborConfig(args, { cwd: temporaryDirectory("harbor-config-"), env });
  /** Resolves a one-task Terminal-Bench run of an arm config that holds `text`. */
  const resolveArm = async (text: string, extra: string[] = []) => {
    const path = join(temporaryDirectory("harbor-arm-"), "arm.toml");
    await writeFile(path, text);
    return { path, config: await resolveArgs(["--benchmark", "terminal-bench-2.1", "--arm", path, ...ACCESS, ...ONE_TASK, ...extra]) };
  };

  test("a split run at the defaults matches the harness leaderboard's job settings and needs no admission flag", async () => {
    const config = await resolveArgs([...launchArgs, "--split", "subset"]);
    const subset = HARBOR_BENCHMARKS[0]!.splits.subset!;
    expect(config.taskNames).toEqual(subset.map((name) => `terminal-bench/${name}`));
    expect(config).toMatchObject({ dataset: "terminal-bench/terminal-bench-2-1", datasetRef: HARBOR_BENCHMARKS[0]!.dataset.ref, split: "subset", attempts: 3, concurrency: 4, expectedTrials: subset.length * 3, grade: "leaderboard_valid", dryRun: true, jobName: "flywheel-terminal-bench-2.1-gpt-6.1-terra" });
    expect(config.timeoutMultipliers).toEqual({ timeout_multiplier: 1, agent_setup_timeout_multiplier: 3, environment_build_timeout_multiplier: 3 });
    expect(config.warning).toBeUndefined();
    expect(config.resourceOverrides).toEqual({});
    expect(config.agentPackage).toEqual({ agentRepository: "owner/agent", claudeTokenKeychainItems: ["flywheel-claude-oauth-token"] });
    expect(config.hosted).toBeUndefined();
    expect(config.round).toBeUndefined();
    expect(config.profileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a task list takes the benchmark's namespace for a bare name, and a split must exist", async () => {
    const deepSwe = ["--benchmark", "deep-swe-1.1", "--arm", "bench/harbor/configs/tb-board-deepseek-high.toml", ...ACCESS];
    const listed = await resolveArgs([...deepSwe, "--task-names", "python-statemachine-state-data-scoping,datacurve/kcp-go-multiplexed-kcp-streams"]);
    expect(listed.taskNames).toEqual(["datacurve/python-statemachine-state-data-scoping", "datacurve/kcp-go-multiplexed-kcp-streams"]);
    expect(listed).toMatchObject({ dataset: "datacurve/deep-swe-1-1", datasetRef: HARBOR_BENCHMARKS[1]!.dataset.ref });
    expect(listed.split).toBeUndefined();
    await expect(resolveArgs([...deepSwe, "--split", "holdout2"])).rejects.toThrow("deep-swe-1.1 has no split holdout2; its splits: subset, holdout");
    await expect(resolveArgs([...launchArgs, "--split", "missing"])).rejects.toThrow("its splits: subset, holdout, holdout2");
    for (const inherited of ["constructor", "toString"]) await expect(resolveArgs([...launchArgs, "--split", inherited])).rejects.toThrow(`has no split ${inherited}`);
    await expect(resolveArgs([...launchArgs, "--split", "subset", ...ONE_TASK])).rejects.toThrow("at most one of --split <name> and --task-names");
  });

  test("with no selection a run measures every task of the dataset except the benchmark's exclusions", async () => {
    const dataset = ["adaptive-rejection-sampler", "kv-store-grpc", "qemu-alpine-ssh", "qemu-startup"].map((name) => `terminal-bench/${name}`);
    const listTasks = async (name: string, ref: string) => (name === "terminal-bench/terminal-bench-2-1" && ref === HARBOR_BENCHMARKS[0]!.dataset.ref ? dataset : []);
    const resolveAll = (list: typeof listTasks, extra: string[] = []) => resolveHarborConfig([...launchArgs, ...extra], { cwd: temporaryDirectory("harbor-config-"), env: {}, listTasks: list });
    const all = await resolveAll(listTasks, ["--round", "r1"]);
    expect(all.taskNames).toEqual(["terminal-bench/adaptive-rejection-sampler", "terminal-bench/kv-store-grpc"]);
    // Harbor Hub refuses a job that names too many tasks, so a whole-benchmark job names the exclusions.
    expect(all.datasetFilter).toEqual({ exclude_task_names: ["terminal-bench/qemu-startup", "terminal-bench/qemu-alpine-ssh"] });
    expect(all).toMatchObject({ split: "all", round: "r1", expectedTrials: 6, grade: "leaderboard_valid" });
    // An exclusion that the dataset does not hold means the descriptor no longer names the board's whole benchmark.
    await expect(resolveAll(async () => dataset.slice(0, 3))).rejects.toThrow("holds no excluded task terminal-bench/qemu-startup");
  });

  test("every run names a registered benchmark and an arm config, and the removed profile input is refused", async () => {
    await expect(resolveArgs(["--arm", "bench/harbor/configs/tb-mini-openai.toml", ...ACCESS, ...ONE_TASK])).rejects.toThrow("--benchmark <id>");
    await expect(resolveArgs(["--benchmark", "nope", "--arm", "bench/harbor/configs/tb-mini-openai.toml", ...ACCESS, ...ONE_TASK])).rejects.toThrow("unknown benchmark nope; registered: terminal-bench-2.1, deep-swe-1.1");
    await expect(resolveArgs(["--benchmark", "terminal-bench-2.1", ...ACCESS, ...ONE_TASK])).rejects.toThrow("--arm <Flywheel config>");
    for (const removed of ["--config", "--model", "--runtime-source-commit", "--dataset"]) {
      await expect(resolveArgs([...launchArgs, ...ONE_TASK, removed, "x"])).rejects.toThrow(`unsupported Harbor launcher option: ${removed}`);
    }
  });

  test("takes the chat model from a validated Flywheel config", async () => {
    const text = 'allow_persistent_processes = true\n[profiles.benchmark.roles.chat]\nmodel = "gpt-6.1-sol"\neffort = "high"\n';
    const { path, config } = await resolveArm(text);
    expect(config.model).toBe("gpt-6.1-sol");
    const { credentialProviders, providerHosts } = config.flywheelConfig;
    expect(credentialProviders).toContain("chatgpt");
    expect(config.flywheelConfig).toEqual({ path, absolutePath: path, sha256: createHash("sha256").update(text).digest("hex"), chatEffort: "high", credentialProviders, providerHosts });
  });

  test("refuses a Flywheel config that Flywheel would reject or ignore in part", async () => {
    const pinnedChat = '[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\neffort = "max"\n';
    await expect(resolveArm("allow_persistent_processes = [\n")).rejects.toThrow("is not a valid Flywheel config: Failed to parse config file");
    await expect(resolveArm(`interaction_profile = "luna-native-v1"\n${pinnedChat}`)).rejects.toThrow('Unrecognized config key "interaction_profile"');
    await expect(resolveArm(`allow_persistent_processes = "yes"\n${pinnedChat}`)).rejects.toThrow('Invalid config value "allow_persistent_processes"');
    await expect(resolveArm(`disabled_modules = ["no-such-module"]\n${pinnedChat}`)).rejects.toThrow("no-such-module");
    await expect(resolveArm('[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\n')).rejects.toThrow("must pin model and effort in [profiles.benchmark.roles.chat]");
    await expect(resolveArgs(["--benchmark", "terminal-bench-2.1", "--arm", "bench/harbor/configs/missing.toml", ...ACCESS, ...ONE_TASK])).rejects.toThrow("--arm bench/harbor/configs/missing.toml is not a valid Flywheel config");
  });

  test.each([
    ["OpenAI", "tb-mini-openai.toml", "gpt-6.1-terra", "medium", ["chatgpt"], [], ["chatgpt"]],
    ["Claude", "tb-mini-claude.toml", "claude-sonnet-5.5", "medium", ["claude_agent_sdk"], ["api.anthropic.com"], []],
    ["DeepSeek board", "tb-board-deepseek-high.toml", "deepseek-v4.1-flash", "high", ["openrouter"], ["openrouter.ai"], []],
    ["FrontierHarness DeepSeek 1017", "fh-deepseek-1017-max.toml", "deepseek-v4.1-flash-1017", "max", ["deepseek", "opencode_go", "openrouter"], ["openrouter.ai"], ["deepseek", "opencode_go"]],
  ])("the checked-in %s arm config passes host validation, pins its model and effort, and names its credential providers and their declared hosts", async (_arm, file, model, effort, providers, hosts, undeclared) => {
    const config = await resolveArgs(["--benchmark", "terminal-bench-2.1", "--arm", `bench/harbor/configs/${file}`, ...ACCESS, ...ONE_TASK]);
    expect(config.model).toBe(model);
    expect(config.flywheelConfig.chatEffort).toBe(effort);
    expect(config.flywheelConfig.absolutePath).toBe(resolve(process.cwd(), `bench/harbor/configs/${file}`));
    expect(config.flywheelConfig.credentialProviders).toEqual(providers);
    expect(config.flywheelConfig.providerHosts).toEqual({ declared: hosts, undeclared });
  });

  const ARMS = resolve(import.meta.dir, "../../../bench/harbor/configs");
  test.each(readdirSync(ARMS).filter((file) => file.endsWith(".toml")))("the %s arm offers only the agent types that do the task's work, each on the arm's chat model", (file) => {
    const { config } = decodeCanonicalConfigText(readFileSync(join(ARMS, file), "utf8"), {}, undefined, join(ARMS, file));
    const enabled = new Set<string>(config.modules);
    const modules = composeFirstPartyModules(undefined, composeFirstPartyModules().enabledModuleIds.filter((id): id is ModuleId => !enabled.has(id)));
    const availability = definitionAvailabilityOf(repoDefinitions().captureRevision(), modules.enabledModuleIds, disabledTypesOf(config));
    expect([...availableAgentTypes(availability)].toSorted()).toEqual(["explorer", "general", "implementer"]);
    const roles = config.profiles.benchmark?.roles ?? {};
    for (const role of ["explorer", "implementer", "subagent-summary"]) expect(roles[role]).toEqual(roles.chat);
  });

  test("the profile digest changes with the arm and with the task selection", async () => {
    const digest = async (args: string[]) => (await resolveArgs(["--benchmark", "terminal-bench-2.1", ...ACCESS, ...args])).profileSha256;
    const openai = await digest(["--arm", "bench/harbor/configs/tb-mini-openai.toml", ...ONE_TASK]);
    expect(await digest(["--arm", "bench/harbor/configs/tb-mini-openai.toml", ...ONE_TASK])).toBe(openai);
    expect(await digest(["--arm", "bench/harbor/configs/tb-mini-claude.toml", ...ONE_TASK])).not.toBe(openai);
    expect(await digest(["--arm", "bench/harbor/configs/tb-mini-openai.toml", "--task-names", "two"])).not.toBe(openai);
  });

  test("every run needs an agent repository; a hosted run takes a Hub organization and refuses a local image prebuild", async () => {
    const base = ["--benchmark", "terminal-bench-2.1", "--arm", "bench/harbor/configs/tb-mini-openai.toml", "--auth-profile", "Fixture", ...ONE_TASK];
    expect((await resolveArgs(base, { FLYWHEEL_HARBOR_AGENT_REPO: "owner/agent" })).agentPackage.agentRepository).toBe("owner/agent");
    await expect(resolveArgs(base)).rejects.toThrow("every run requires --agent-repo");
    const hosted = await resolveArgs([...launchArgs, ...ONE_TASK, "--hosted", "--organization", "org", "--claude-token-keychain-item", "other-item", "--claude-token-keychain-item", "second-item"]);
    expect(hosted.hosted).toEqual({ organization: "org" });
    // Each named item is one token and one Claude account, in the order named; a named item replaces the default.
    expect(hosted.agentPackage.claudeTokenKeychainItems).toEqual(["other-item", "second-item"]);
    expect((await resolveArgs([...launchArgs, ...ONE_TASK, "--hosted"], { FLYWHEEL_HARBOR_HUB_ORG: "env-org" })).hosted).toEqual({ organization: "env-org" });
    expect((await resolveArgs([...launchArgs, ...ONE_TASK, "--hosted"])).hosted).toEqual({});
    await expect(resolveArgs([...launchArgs, ...ONE_TASK, "--hosted", "--prebuild"])).rejects.toThrow("--prebuild");
  });

  test("expects the shell tool of the profile the product selects for the model", async () => {
    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-opus-5-5", "unknown-model"]) {
      expect((await resolveArm(`[profiles.benchmark.roles.chat]\nmodel = "${model}"\neffort = "medium"\n`)).config.expectedInteraction).toEqual({ profileId: "default", executableToolName: "bash" });
    }
  });

  test("fewer attempts than the board's need explicit local admission and lower the grade", async () => {
    await expect(resolveArgs([...launchArgs, ...ONE_TASK, "--attempts", "2"])).rejects.toThrow("attempts below 3 require --allow-low-k");
    expect((await resolveArgs([...launchArgs, ...ONE_TASK, "--attempts", "2", "--allow-low-k"])).grade).toBe("local_low_k");
    const debug = await resolveArgs([...launchArgs, ...ONE_TASK, "--attempts", "1", "--allow-low-k"]);
    expect(debug.grade).toBe("debug_only");
    expect(debug.warning).toContain("not leaderboard-valid");
    expect((await resolveArgs([...launchArgs, ...ONE_TASK, "--attempts", "5"])).grade).toBe("leaderboard_valid");
  });

  test("timeouts other than the board's and resource overrides need their own admissions and lower the grade", async () => {
    for (const flag of ["--timeout-multiplier", "--agent-setup-timeout-multiplier", "--environment-build-timeout-multiplier"]) {
      await expect(resolveArgs([...launchArgs, ...ONE_TASK, flag, "2"])).rejects.toThrow("--allow-timeout-multipliers");
    }
    const admitted = await resolveArgs([...launchArgs, ...ONE_TASK, "--environment-build-timeout-multiplier", "1", "--allow-timeout-multipliers"]);
    expect(admitted.grade).toBe("local_low_k");
    expect(admitted.timeoutMultipliers.environment_build_timeout_multiplier).toBe(1);
    await expect(resolveArgs([...launchArgs, ...ONE_TASK, "--resource-overrides", '{"cpus":2}'])).rejects.toThrow("--allow-resource-overrides");
    const resources = await resolveArgs([...launchArgs, ...ONE_TASK, "--resource-overrides", '{"cpus":2}', "--allow-resource-overrides"]);
    expect(resources).toMatchObject({ grade: "local_low_k", resourceOverrides: { cpus: 2 } });
    await expect(resolveArgs([...launchArgs, ...ONE_TASK, "--resource-overrides", '{"cpu":2}', "--allow-resource-overrides"])).rejects.toThrow("unknown: cpu");
  });

  test("defaults to a dry run and requires launcher auth", async () => {
    expect((await resolveArgs([...launchArgs, ...ONE_TASK, "--execute"])).dryRun).toBeFalse();
    await expect(resolveArgs(["--benchmark", "terminal-bench-2.1", "--arm", "bench/harbor/configs/tb-mini-openai.toml", "--agent-repo", "owner/agent", ...ONE_TASK])).rejects.toThrow("--auth-profile");
  });

  test("a run names the round it joins, and a round name must be a slug", async () => {
    expect((await resolveArgs([...launchArgs, "--split", "holdout", "--round", "r3"])).round).toBe("r3");
    await expect(resolveArgs([...launchArgs, ...ONE_TASK, "--round", "R 3"])).rejects.toThrow("must be a lowercase slug");
  });
});
