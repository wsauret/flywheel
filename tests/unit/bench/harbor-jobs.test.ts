import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { prepareHarborRun } from "../../../bench/harbor/run-harbor.js";
import { releaseTagFor, snapshotEnvironment, worstCaseJobSeconds, type AgentPackageBuild, type AgentPackagePublication, type ResolvedTask } from "../../../bench/harbor/harbor-jobs.js";
import { readRound, roundPath } from "../../../bench/harbor/rounds.js";
import { HARBOR_BENCHMARKS } from "../../../bench/harbor/benchmarks.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { ARM_CONFIG, harborLaunchArgs as launchArgs } from "../../fixtures/harbor-run.js";

const BRINGUP = [...launchArgs, "--task-names", "kv-store-grpc", "--attempts", "1", "--allow-low-k"];
const DEEPSEEK_ARM = "bench/harbor/configs/tb-board-deepseek-high.toml";
const CLAUDE_ARM = "bench/harbor/configs/tb-mini-claude.toml";
const DEEP_SWE_TASK = "datacurve/python-statemachine-state-data-scoping";
const COMMIT = "c".repeat(40);
const timeouts = (agent_network_mode: ResolvedTask["agent_network_mode"]) => ({ agent_timeout_sec: 900, verifier_timeout_sec: 900, build_timeout_sec: 600, agent_network_mode });
const PUBLICATION: AgentPackagePublication = { repository: "owner/agent", ref: "refs/heads/build/abcdef012345", commit: "d".repeat(40), branch: "build/abcdef012345", tag: null };

function build(commit: string, releaseTag: string | null): AgentPackageBuild {
  return { build_id: "abcdef012345", flywheel_source: { commit, version: "1.2.3", release_tag: releaseTag }, runtime_archive: { path: "runtime/flywheel-linux-x64.tar.xz", sha256: "e".repeat(64) }, flywheel_config: { path: "flywheel.toml", source_path: ARM_CONFIG, sha256: "f".repeat(64) }, store_analyzer: { path: "store-analysis/trial-store-analysis.js", source_path: "bench/harbor/trial-store-analysis.ts", sha256: "0".repeat(64) }, benchmark_rules: null };
}

describe("Harbor jobs", () => {
  const temporaryDirectory = temporaryDirectories();
  /** Preparation dependencies that resolve every task with `network` and build and publish no real package. */
  const dependencies = (root: string, builds: unknown[][], network: ResolvedTask["agent_network_mode"] = "public") => ({
    cwd: root,
    inspectSeed: async () => ({ clean: false, revision: COMMIT, dirtyPaths: ["src/uncommitted.ts"] }),
    validateConfig: async () => undefined,
    validateHostedConfig: async () => undefined,
    versionProbe: async () => "test",
    harborPython: () => "python",
    resolveTasks: async (_dataset: string, _ref: string, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, timeouts(network)])),
    releaseTagFor: async () => null,
    buildAgentPackage: async (commit: string, configPath: string, configSha256: string, answerKeyRule: boolean, releaseTag: string | null, output: string) => {
      builds.push([commit, configPath, configSha256, answerKeyRule, releaseTag, output]);
      return build(commit, releaseTag);
    },
    publishAgentPackage: async () => PUBLICATION,
  });
  const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  test("a hosted dry run publishes the package of the exact commit and writes a direct-credential Hub job at the board's timeouts", async () => {
    const root = temporaryDirectory("harbor-hosted-");
    const builds: unknown[][] = [];
    const result = await prepareHarborRun([...BRINGUP, "--hosted", "--organization", "org"], dependencies(root, builds));
    const [generated, manifest, plan] = await Promise.all([read(result.generatedConfig), read(result.manifest), read(result.preparationPlan)]);
    // The dirty seed is irrelevant: the package is built from the commit's blobs.
    expect(builds.map((row) => row.slice(0, 5))).toEqual([[COMMIT, ARM_CONFIG, manifest.flywheel_config.sha256, true, null]]);
    expect(String(builds[0]?.[5])).toEndWith("agent-package");
    expect(generated).toEqual({
      job_name: "flywheel-terminal-bench-2.1-gpt-6.1-terra",
      organization: "org",
      credential_mode: "direct",
      agents: [{ name: "acp", source: { type: "github", repo: "owner/agent", ref: PUBLICATION.commit, path: ".", manifest: "harbor-agent.json" }, secrets: ["FLYWHEEL_AUTH_SNAPSHOT"], env: { FLYWHEEL_HARBOR_PROFILE_SHA256: manifest.profile_sha256 } }],
      job_secrets: { FLYWHEEL_AUTH_SNAPSHOT: { from_env: "FLYWHEEL_AUTH_SNAPSHOT" } },
      datasets: [{ name: "terminal-bench/terminal-bench-2-1", ref: "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a", task_names: ["terminal-bench/kv-store-grpc"] }],
      n_attempts: 1,
      n_concurrent_trials: 4,
      timeout_multiplier: 1,
      agent_setup_timeout_multiplier: 3,
      environment_build_timeout_multiplier: 3,
    });
    expect(manifest).toMatchObject({ benchmark: "terminal-bench-2.1", split: null, round: null, execution_mode: "hosted", hosted_job_id: null, grade: "debug_only", agent_allowed_hosts: [], source_archive_sha256: "e".repeat(64), runtime_source: { mode: "git_commit", resolved_sha: COMMIT }, agent_package: { ...PUBLICATION, build_id: "abcdef012345", release_tag: null, benchmark_rules: null }, exact_command: plan.launch_command });
    expect(plan.snapshot_command).toEqual(expect.arrayContaining(["--auth-profile", "Fixture", "--as-profile", "benchmark", "--provider", "chatgpt"]));
    expect(plan.snapshot_command.filter((argument: string) => argument === "--provider")).toHaveLength(1);
    expect(plan.trials_directory).toBe(join(result.artifactDirectory, "hub", "flywheel-terminal-bench-2.1-gpt-6.1-terra"));
    expect(plan).toMatchObject({ snapshot_providers: ["chatgpt"], claude_token_keychain_item: "flywheel-claude-oauth-token" });
  });

  test("a local run publishes the same package and names it with the same agent identity, over Docker with the snapshot overlay", async () => {
    const builds: unknown[][] = [];
    const prepare = (mode: string[]) => prepareHarborRun([...BRINGUP, ...mode], dependencies(temporaryDirectory("harbor-local-"), builds));
    const local = await prepare([]);
    const hosted = await prepare(["--hosted"]);
    const [generated, manifest, plan, hostedGenerated, hostedPlan] = await Promise.all([read(local.generatedConfig), read(local.manifest), read(local.preparationPlan), read(hosted.generatedConfig), read(hosted.preparationPlan)]);
    expect(builds).toHaveLength(2);
    const [agent] = generated.agents;
    const [hostedAgent] = hostedGenerated.agents;
    expect(agent).toEqual({ name: "acp", kwargs: { source: { repo_url: "https://github.com/owner/agent.git", ref: PUBLICATION.commit, source_dir: ".", manifest_path: "harbor-agent.json" } }, env: hostedAgent.env });
    expect(hostedAgent.env).toEqual({ FLYWHEEL_HARBOR_PROFILE_SHA256: manifest.profile_sha256 });
    const overlay = resolve(process.cwd(), "bench/harbor/snapshot-environment.compose.yaml");
    expect(generated.environment).toEqual({ extra_docker_compose: [overlay] });
    const overridden = await prepare(["--resource-overrides", '{"cpus":2,"memory_mb":4096}', "--allow-resource-overrides"]);
    expect((await read(overridden.generatedConfig)).environment).toEqual({ override_cpus: 2, override_memory_mb: 4096, extra_docker_compose: [overlay] });
    expect(load(await readFile(overlay, "utf8"))).toEqual({ services: { main: { environment: ["FLYWHEEL_AUTH_SNAPSHOT"] } } });
    expect(generated.job_secrets).toBeUndefined();
    for (const field of ["datasets", "n_attempts", "n_concurrent_trials", "timeout_multiplier", "agent_setup_timeout_multiplier", "environment_build_timeout_multiplier"]) expect(generated[field]).toEqual(hostedGenerated[field]);
    expect(manifest).toMatchObject({ execution_mode: "local", exact_command: ["harbor", "run", "-c", local.generatedConfig] });
    const shared = ["source_commit", "agent_package", "snapshot_command", "snapshot_providers", "claude_token_keychain_item", "worst_case_seconds"];
    for (const field of shared) expect(plan[field]).toEqual(hostedPlan[field]);
    const taskCache = resolve(process.env.HOME ?? "", ".cache/harbor/tasks/packages/terminal-bench");
    // Each run's Harbor job lies inside its own artifact directory, so a second run of one setup never meets the first's job.
    expect(generated.jobs_dir).toBe(join(local.artifactDirectory, "harbor-jobs"));
    expect(plan).toMatchObject({ execution_mode: "local", harbor_command: local.harborCommand, task_cache: taskCache, trials_directory: join(local.artifactDirectory, "harbor-jobs", "flywheel-terminal-bench-2.1-gpt-6.1-terra") });
    expect(plan.wheelhouse_command).toEqual(expect.arrayContaining(["--task-namespace", "terminal-bench", "--task-cache", taskCache, "--task-name", "terminal-bench/kv-store-grpc"]));
  });

  test.each([
    ["OpenRouter", DEEPSEEK_ARM, ["openrouter.ai", "models.dev"]],
    ["Claude subscription", CLAUDE_ARM, ["api.anthropic.com", "models.dev"]],
  ])("an offline agent phase allows the %s arm's declared provider hosts and models.dev, and a benchmark without a wheelhouse has no wheelhouse step", async (_arm, arm, hosts) => {
    const builds: unknown[][] = [];
    const args = ["--benchmark", "deep-swe-1.1", "--arm", arm, "--auth-profile", "Fixture", "--agent-repo", "owner/agent", "--task-names", DEEP_SWE_TASK, "--attempts", "1", "--allow-low-k"];
    const hosted = await prepareHarborRun([...args, "--hosted"], dependencies(temporaryDirectory("harbor-offline-"), builds, "no-network"));
    const local = await prepareHarborRun(args, dependencies(temporaryDirectory("harbor-offline-local-"), builds, "no-network"));
    const [hostedGenerated, localGenerated, manifest, localPlan] = await Promise.all([read(hosted.generatedConfig), read(local.generatedConfig), read(hosted.manifest), read(local.preparationPlan)]);
    expect(hostedGenerated.agents[0].extra_allowed_hosts).toEqual(hosts);
    expect(localGenerated.agents[0].extra_allowed_hosts).toEqual(hosts);
    expect(hostedGenerated.datasets).toEqual([{ name: "datacurve/deep-swe-1-1", ref: HARBOR_BENCHMARKS[1]!.dataset.ref, task_names: [DEEP_SWE_TASK] }]);
    expect(manifest).toMatchObject({ benchmark: "deep-swe-1.1", agent_allowed_hosts: hosts });
    // DeepSWE's trial home carries no answer-key rule.
    expect(builds.map((row) => row[3])).toEqual([false, false]);
    expect(localPlan.wheelhouse_command).toBeUndefined();
    expect(localPlan.task_cache).toBe(resolve(process.env.HOME ?? "", ".cache/harbor/tasks/packages/datacurve"));
  });

  test("an offline agent phase refuses an arm that enables a provider which declares no hosts, and names it", async () => {
    const args = ["--benchmark", "deep-swe-1.1", "--arm", ARM_CONFIG, "--auth-profile", "Fixture", "--agent-repo", "owner/agent", "--task-names", DEEP_SWE_TASK, "--hosted"];
    await expect(prepareHarborRun(args, dependencies(temporaryDirectory("harbor-offline-refused-"), [], "no-network"))).rejects.toThrow("the arm enables providers that declare no API hosts: chatgpt");
  });

  test("an executing run in a round is recorded in the round at preparation with the round's identity; a dry run is not", async () => {
    const root = temporaryDirectory("harbor-round-");
    const executed = await prepareHarborRun([...launchArgs, "--split", "subset", "--round", "r3", "--execute"], dependencies(root, []));
    const rerun = await prepareHarborRun([...launchArgs, "--task-names", "kv-store-grpc", "--round", "r3", "--execute", "--job-name", "rerun"], dependencies(root, []));
    await prepareHarborRun([...launchArgs, "--task-names", "kv-store-grpc", "--round", "r3", "--job-name", "dry"], dependencies(root, []));
    const round = await readRound(roundPath(join(root, "jobs"), "r3"));
    const manifest = await read(executed.manifest);
    expect(round).toEqual({ name: "r3", benchmark: "terminal-bench-2.1", identity: { sourceCommit: COMMIT, arm: { path: ARM_CONFIG, sha256: manifest.flywheel_config.sha256 }, model: "gpt-6.1-terra", effort: "medium" }, runs: [{ directory: executed.artifactDirectory, purpose: "measure", split: "subset" }, { directory: rerun.artifactDirectory, purpose: "rerun" }] });
    expect(manifest.round).toBe("r3");
  });

  test("a run that would join a round of another commit, arm, or benchmark is refused before any package is built", async () => {
    const root = temporaryDirectory("harbor-round-identity-");
    await prepareHarborRun([...launchArgs, "--split", "subset", "--round", "r3", "--execute"], dependencies(root, []));
    const builds: unknown[][] = [];
    const otherCommit = { ...dependencies(root, builds), inspectSeed: async () => ({ clean: true, revision: "b".repeat(40) }) };
    await expect(prepareHarborRun([...launchArgs, "--split", "holdout", "--round", "r3", "--execute"], otherCommit)).rejects.toThrow(`round r3 holds source commit ${COMMIT}, not ${"b".repeat(40)}`);
    await expect(prepareHarborRun(["--benchmark", "terminal-bench-2.1", "--arm", DEEPSEEK_ARM, "--auth-profile", "Fixture", "--agent-repo", "owner/agent", "--split", "holdout", "--round", "r3", "--execute"], dependencies(root, builds))).rejects.toThrow("round r3 holds arm sha256");
    await expect(prepareHarborRun(["--benchmark", "deep-swe-1.1", "--arm", DEEPSEEK_ARM, "--auth-profile", "Fixture", "--agent-repo", "owner/agent", "--task-names", DEEP_SWE_TASK, "--round", "r3", "--execute"], dependencies(root, builds))).rejects.toThrow("round r3 holds terminal-bench-2.1, not deep-swe-1.1");
    expect(builds).toEqual([]);
  });

  test("the export of a Claude arm alone gets the Claude token, from the keychain item before the launcher's own variable, and refuses without either", async () => {
    const keychain = (held: string | undefined) => async (item: string) => item === "item" ? held : undefined;
    const launcher = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "launcher-token" };
    expect(await snapshotEnvironment(["chatgpt"], "item", { PATH: "/usr/bin" }, keychain("keychain-token"))).toEqual({ PATH: "/usr/bin" });
    expect(await snapshotEnvironment(["claude_agent_sdk"], "item", launcher, keychain("keychain-token"))).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "keychain-token" });
    expect(await snapshotEnvironment(["claude_agent_sdk"], "item", launcher, keychain(undefined))).toEqual(launcher);
    await expect(snapshotEnvironment(["claude_agent_sdk"], "item", { PATH: "/usr/bin" }, keychain(undefined))).rejects.toThrow("store it in the macOS keychain item item or set CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("every dry run refuses a task name that Harbor's dataset resolution does not match", async () => {
    for (const mode of [[], ["--hosted", "--organization", "org"]]) {
      const root = temporaryDirectory("harbor-unmatched-");
      const refusing = { ...dependencies(root, []), resolveTasks: async () => { throw new Error("task names match no task in terminal-bench/terminal-bench-2-1: terminal-bench/does-not-exist-xyz"); } };
      await expect(prepareHarborRun([...BRINGUP, ...mode], refusing)).rejects.toThrow("terminal-bench/does-not-exist-xyz");
    }
  });

  test("only a commit that the public repository tags as a published release is a release", async () => {
    const listed: string[] = [];
    const published = async () => { listed.push("listed"); return ["v1.2.3"]; };
    const other = "0".repeat(40);
    const tagObject = "a".repeat(40);
    expect(await releaseTagFor(COMMIT, published, async () => "")).toBeNull();
    expect(listed).toEqual([]);
    // The public tag of the release name names another commit, as when a trial commit carries a local v1.2.3.
    expect(await releaseTagFor(COMMIT, published, async () => `${other}\trefs/tags/v1.2.3\n`)).toBeNull();
    expect(await releaseTagFor(COMMIT, published, async () => `${tagObject}\trefs/tags/v1.2.3\n${other}\trefs/tags/v1.2.3^{}\n`)).toBeNull();
    expect(await releaseTagFor(COMMIT, published, async () => `${COMMIT}\trefs/tags/v9.9.9\n${COMMIT}\trefs/tags/build-tag\n`)).toBeNull();
    expect(await releaseTagFor(COMMIT, published, async () => `${COMMIT}\trefs/tags/v1.2.3\n`)).toBe("v1.2.3");
    expect(await releaseTagFor(COMMIT, published, async () => `${tagObject}\trefs/tags/v1.2.3\n${COMMIT}\trefs/tags/v1.2.3^{}\n`)).toBe("v1.2.3");
    const releases = async () => ["v1.2.3", "v1.10.0", "v1.9.0"];
    expect(await releaseTagFor(COMMIT, releases, async () => `${COMMIT}\trefs/tags/v1.10.0\n${COMMIT}\trefs/tags/v1.2.3\n${COMMIT}\trefs/tags/v1.9.0\n`)).toBe("v1.10.0");
  });

  test("the snapshot outlives every wave of trials at the slowest task's timeouts, scaled by the largest multiplier, plus the queueing margin", () => {
    const tasks = { kv: timeouts("public"), slow: { agent_timeout_sec: 3600, verifier_timeout_sec: 3600, build_timeout_sec: 600, agent_network_mode: "public" as const } };
    expect(worstCaseJobSeconds({ expectedTrials: 60, concurrency: 60, timeoutMultipliers: { timeout_multiplier: 1, agent_setup_timeout_multiplier: 1, environment_build_timeout_multiplier: 1 } }, tasks)).toBe(7800 + 3600);
    expect(worstCaseJobSeconds({ expectedTrials: 60, concurrency: 30, timeoutMultipliers: { timeout_multiplier: 1, agent_setup_timeout_multiplier: 3, environment_build_timeout_multiplier: 2 } }, tasks)).toBe(2 * 7800 * 3 + 3600);
  });
});
