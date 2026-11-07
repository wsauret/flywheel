import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { releaseTagFor, worstCaseJobSeconds, type AgentPackageBuild, type AgentPackagePublication } from "../../../bench/terminal_bench/hosted-terminal-bench.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { terminalBenchAuthArgs as authArgs } from "../../fixtures/terminal-bench-profile.js";

const BRINGUP = resolve(process.cwd(), "bench/terminal_bench/profiles/tb-mini-bringup-kv-store-grpc.yaml");
const ARM_CONFIG = "bench/terminal_bench/configs/tb-mini-openai.toml";
const COMMIT = "c".repeat(40);
const KV_TIMEOUTS = { "terminal-bench/kv-store-grpc": { agent_timeout_sec: 900, verifier_timeout_sec: 900, build_timeout_sec: 600 } };
const PUBLICATION: AgentPackagePublication = { repository: "owner/agent", ref: "refs/heads/build/abcdef012345", commit: "d".repeat(40), branch: "build/abcdef012345", tag: null };

function build(commit: string, releaseTag: string | null): AgentPackageBuild {
  return { build_id: "abcdef012345", flywheel_source: { commit, version: "1.2.3", release_tag: releaseTag }, runtime_archive: { path: "runtime/source-archive.tar.gz", sha256: "e".repeat(64) }, flywheel_config: { path: "flywheel.toml", source_path: ARM_CONFIG, sha256: "f".repeat(64) }, store_analyzer: { path: "store-analysis/trial-store-analysis.ts", source_path: "bench/terminal_bench/trial-store-analysis.ts", sha256: "0".repeat(64) } };
}

describe("terminal bench hosted runs", () => {
  const temporaryDirectory = temporaryDirectories();
  const dependencies = (root: string, builds: unknown[][]) => ({
    cwd: root,
    inspectSeed: async () => ({ clean: false, revision: COMMIT, dirtyPaths: ["src/uncommitted.ts"] }),
    validateConfig: async () => undefined,
    validateHostedConfig: async () => undefined,
    versionProbe: async () => "test",
    harborPython: () => "python",
    resolveTasks: async () => KV_TIMEOUTS,
    releaseTagFor: async () => null,
    buildAgentPackage: async (commit: string, configPath: string, configSha256: string, releaseTag: string | null, output: string) => {
      builds.push([commit, configPath, configSha256, releaseTag, output]);
      return build(commit, releaseTag);
    },
    publishAgentPackage: async () => PUBLICATION,
  });

  test("a hosted dry run publishes the package of the exact commit and writes a direct-credential Hub job", async () => {
    const root = temporaryDirectory("tb-hosted-");
    const builds: unknown[][] = [];
    const result = await prepareTerminalBenchRun([...authArgs, "--config", BRINGUP, "--allow-low-k", "--hosted", "--agent-repo", "owner/agent", "--organization", "org"], dependencies(root, builds));
    const generated = JSON.parse(await readFile(result.generatedConfig, "utf8"));
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    const plan = JSON.parse(await readFile(result.preparationPlan, "utf8"));
    // The dirty seed is irrelevant: the package is built from the commit's blobs.
    expect(builds.map((row) => row.slice(0, 4))).toEqual([[COMMIT, ARM_CONFIG, manifest.flywheel_config.sha256, null]]);
    expect(String(builds[0]?.[4])).toEndWith("agent-package");
    expect(generated).toEqual({
      job_name: "flywheel-tb-mini-bringup-kv-store-grpc",
      organization: "org",
      credential_mode: "direct",
      agents: [{ name: "acp", source: { type: "github", repo: "owner/agent", ref: PUBLICATION.commit, path: ".", manifest: "harbor-agent.json" }, secrets: ["FLYWHEEL_AUTH_SNAPSHOT"], env: { FLYWHEEL_TB_PROFILE_SHA256: manifest.profile_sha256 } }],
      job_secrets: { FLYWHEEL_AUTH_SNAPSHOT: { from_env: "FLYWHEEL_AUTH_SNAPSHOT" } },
      datasets: [{ name: "terminal-bench/terminal-bench-2-1", ref: "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a", task_names: ["terminal-bench/kv-store-grpc"] }],
      n_attempts: 1,
      n_concurrent_trials: 1,
      timeout_multiplier: 1,
      environment_build_timeout_multiplier: 1,
    });
    expect(manifest).toMatchObject({ execution_mode: "hosted", grade: "debug_only", source_archive_sha256: "e".repeat(64), runtime_source: { mode: "git_commit", resolved_sha: COMMIT }, agent_package: { ...PUBLICATION, build_id: "abcdef012345", release_tag: null }, exact_command: plan.launch_command });
    expect(plan.snapshot_command).toEqual(expect.arrayContaining(["--auth-profile", "Fixture", "--as-profile", "benchmark", "--provider", "chatgpt", "--min-valid-seconds", "6000"]));
    expect(plan.snapshot_command.filter((argument: string) => argument === "--provider")).toHaveLength(1);
    expect(plan.trials_directory).toBe(join(result.artifactDirectory, "hub", "flywheel-tb-mini-bringup-kv-store-grpc"));
  });

  test("every dry run refuses a task name that Harbor's dataset resolution does not match", async () => {
    for (const mode of [[], ["--hosted", "--agent-repo", "owner/agent", "--organization", "org"]]) {
      const root = temporaryDirectory("tb-unmatched-");
      const refusing = { ...dependencies(root, []), resolveTasks: async () => { throw new Error("task names match no task in terminal-bench/terminal-bench-2-1: terminal-bench/does-not-exist-xyz"); } };
      await expect(prepareTerminalBenchRun([...authArgs, "--config", BRINGUP, "--allow-low-k", ...mode], refusing)).rejects.toThrow("terminal-bench/does-not-exist-xyz");
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

  test("the snapshot outlives every wave of trials at the slowest task's timeouts plus the queueing margin", () => {
    const tasks = { ...KV_TIMEOUTS, "terminal-bench/slow": { agent_timeout_sec: 3600, verifier_timeout_sec: 3600, build_timeout_sec: 600 } };
    expect(worstCaseJobSeconds({ expectedTrials: 60, concurrency: 60, timeoutMultipliers: { timeout_multiplier: 1 } }, tasks)).toBe(7800 + 3600);
    expect(worstCaseJobSeconds({ expectedTrials: 60, concurrency: 30, timeoutMultipliers: { timeout_multiplier: 2 } }, tasks)).toBe(2 * 7800 * 2 + 3600);
  });
});
