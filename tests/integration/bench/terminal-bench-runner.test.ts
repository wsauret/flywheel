import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION } from "../../../bench/terminal_bench/analyze-tool-outcomes.js";
import type { AgentPackageBuild } from "../../../bench/terminal_bench/harbor-jobs.js";
import { createTerminalBenchComparisonManifest, prepareTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { terminalBenchLaunchArgs as launchArgs, terminalBenchProfile as profile } from "../../fixtures/terminal-bench-profile.js";

/** The launcher these drive is a shell script, and a shell script is not a
 *  program Windows runs. Everything above them prepares artifacts through the
 *  runner's own module and holds on any host. */
const throughTheLauncher = test.skipIf(process.platform === "win32");
const HEAD = "c".repeat(40);
const PUBLICATION = { repository: "owner/agent", ref: "refs/heads/build/abcdef012345", commit: "d".repeat(40), branch: "build/abcdef012345", tag: null };

/** Preparation dependencies that build and publish no real package. `built` collects each packaged commit. */
function packageDependencies(cwd: string, built: string[] = []) {
  return {
    cwd,
    inspectSeed: async () => ({ clean: true, revision: HEAD }),
    validateConfig: async () => undefined,
    versionProbe: async () => "0.25.0",
    harborPython: () => "harbor-python",
    resolveTasks: async (_dataset: string, _ref: string | undefined, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, { agent_timeout_sec: 1, verifier_timeout_sec: 1, build_timeout_sec: 1 }])),
    releaseTagFor: async () => null,
    buildAgentPackage: async (commit: string, configPath: string, configSha256: string, releaseTag: string | null): Promise<AgentPackageBuild> => {
      built.push(commit);
      return { build_id: "abcdef012345", flywheel_source: { commit, version: "1.2.3", release_tag: releaseTag }, runtime_archive: { path: "runtime/source-archive.tar.gz", sha256: "e".repeat(64) }, flywheel_config: { path: "flywheel.toml", source_path: configPath, sha256: configSha256 }, store_analyzer: { path: "store-analysis/trial-store-analysis.js", source_path: "bench/terminal_bench/trial-store-analysis.ts", sha256: "0".repeat(64) } };
    },
    publishAgentPackage: async () => PUBLICATION,
  };
}

describe("terminal bench launch boundary", () => {
  const temporaryDirectory = temporaryDirectories();

  test("prepares one internally consistent atomic artifact set", async () => {
    const root = temporaryDirectory("tb-run-");
    await mkdir(join(root, "jobs"));
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, profile);
    const result = await prepareTerminalBenchRun([...launchArgs, "--config", profilePath, "--concurrency", "4", "--job-name", "dry", "--dry-run"], {
      ...packageDependencies(root),
      now: () => new Date("2026-01-02T03:04:05Z"),
      seed: () => "seed-1",
    });
    const manifest = JSON.parse(await readFile(join(result.artifactDirectory, "run_manifest.json"), "utf8"));
    const metadata = JSON.parse(await readFile(join(result.artifactDirectory, "metadata.yaml"), "utf8"));
    const plan = JSON.parse(await readFile(join(result.artifactDirectory, "preparation-plan.json"), "utf8"));
    const generated = JSON.parse(await readFile(join(result.artifactDirectory, "generated.json"), "utf8"));
    expect(manifest.expected_trials).toBe(10);
    expect(manifest.state).toBe("finalized");
    expect(manifest.outcome).toBe("dry_run");
    expect(manifest.seed).toBe("seed-1");
    expect(metadata.agent).toEqual({ name: "flywheel", display_name: "Flywheel", url: "https://github.com/wsauret/flywheel", organization: { display_name: "Flywheel" } });
    expect(metadata.models).toEqual([{ name: "flywheel/gpt-6.1-terra", role: "primary" }]);
    expect(plan.harbor_command).toEqual(["harbor", "run", "-c", join(result.artifactDirectory, "generated.json")]);
    expect(plan.grade).toBe("leaderboard_valid");
    expect(generated.agents).toEqual([{ name: "acp", kwargs: { source: { repo_url: "https://github.com/owner/agent.git", ref: PUBLICATION.commit, source_dir: ".", manifest_path: "harbor-agent.json" } }, env: { FLYWHEEL_TB_PROFILE_SHA256: manifest.profile_sha256 } }]);
    expect(manifest.auth_profile).toBe("Fixture");
    expect(plan.auth_profile).toBe("Fixture");
    expect(JSON.stringify(generated)).not.toContain("auth_profile");
    expect(generated.datasets[0].task_names).toEqual(["terminal-bench/one", "terminal-bench/two"]);
    expect(generated.n_attempts).toBe(5);
    expect(generated.n_concurrent_trials).toBe(4);
    expect(generated.timeout_multiplier).toBe(1);
    expect(manifest.requested_tasks).toEqual(["terminal-bench/one", "terminal-bench/two"]);
    expect(manifest.expected_rows).toHaveLength(10);
    expect(manifest.expected_rows[0]).toEqual({ task: "terminal-bench/one", attempt: 1 });
    expect(manifest.command_expectation).toEqual({ version: 1, executable_tool_names: ["bash"], minimum_cardinality: 1 });
    expect(manifest.expected_interaction_profile).toBe("default");
    expect(manifest.resource_overrides).toEqual({});
    expect(manifest.profile_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.runtime_source).toEqual({ mode: "git_commit", requested_sha: HEAD, resolved_sha: HEAD });
    expect(manifest.execution_contract).toEqual({ project_root: "task_workspace", execution_cwd: "task_workspace", evidence_export: "store_analysis", persistent_processes: true });
  });

  test("resolves a pinned runtime before writing artifacts and packages it", async () => {
    const root = temporaryDirectory("tb-pinned-run-");
    const sha = "a".repeat(40);
    const path = join(root, "profile.yaml");
    await writeFile(path, `headless: { flywheel_config: bench/terminal_bench/configs/tb-mini-openai.toml, runtime_source_commit: '${sha}' }\ndatasets: [{ task_names: [one] }]\n`);
    const built: string[] = [];
    const base = packageDependencies(root, built);
    await expect(prepareTerminalBenchRun([...launchArgs, "--config", path], { ...base, resolveCommit: async () => "b".repeat(40) })).rejects.toThrow("exact requested SHA");
    expect(await readdir(root)).toEqual(["profile.yaml"]);
    await expect(prepareTerminalBenchRun([...launchArgs, "--config", path], { ...base, resolveCommit: async () => { throw new Error("unknown commit"); } })).rejects.toThrow("unknown commit");
    const result = await prepareTerminalBenchRun([...launchArgs, "--config", path], { ...base, resolveCommit: async (_cwd, requested) => requested });
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    const metadata = JSON.parse(await readFile(join(result.artifactDirectory, "metadata.yaml"), "utf8"));
    expect(built).toEqual([sha]);
    expect(manifest.runtime_source).toEqual({ mode: "git_commit", requested_sha: sha, resolved_sha: sha });
    expect(metadata.runtime_source).toEqual(manifest.runtime_source);
  });

  test("builds comparison evidence only for identical source and controls", async () => {
    const root = temporaryDirectory("tb-comparison-");
    const source = { mode: "git_commit", requested_sha: "a".repeat(40), resolved_sha: "a".repeat(40) };
    const controls = { model: "gpt-6-luna", dataset: "terminal-bench/terminal-bench-2-1", task_names: ["terminal-bench/protein-assembly"], attempts: 5, concurrency: 2, timeout_multipliers: {}, resource_overrides: {} };
    const controlPath = join(root, "control.json");
    const candidatePath = join(root, "candidate.json");
    const analyzerEvidence = (failure: string | null) => {
      const rows = Array.from({ length: 5 }, (_, index) => ({ id: `trial-${index + 1}`, task: "terminal-bench/protein-assembly", expected: true, discovered: true, storeValid: true, adapterSettled: true, verifierValid: true, requestAuditValid: true, toolSettlement: { inputs: 1, results: 1, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 }, commandExpected: true, commandObserved: true, reward: failure === null ? 1 : 0, failure }));
      const analysis = { version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, denominator: rows.length, rows, infrastructureValid: true, comparisonAvailable: true };
      const failure_counts = failure === null ? {} : { [failure]: rows.length };
      return { analysis, summary: { version: 1, contract_version: TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, result_version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, sha256: createHash("sha256").update(`${JSON.stringify(analysis, undefined, 2)}\n`).digest("hex"), infrastructure_valid: true, denominator: rows.length, failure_counts } };
    };
    const controlAnalyzer = analyzerEvidence("genuine_model_failure");
    const candidateAnalyzer = analyzerEvidence("genuine_command_failure");
    const evidence = { state: "finalized", outcome: "completed", ledger_summary: { reconciled: true }, expected_trials: 5, source_archive_sha256: "d".repeat(64) };
    await writeFile(controlPath, JSON.stringify({ ...controls, ...evidence, analyzer_result: controlAnalyzer, runtime_source: source, expected_interaction_profile: "default", profile_sha256: "b".repeat(64) }));
    await writeFile(candidatePath, JSON.stringify({ ...controls, ...evidence, analyzer_result: candidateAnalyzer, runtime_source: source, expected_interaction_profile: "default", profile_sha256: "c".repeat(64) }));
    const comparison = await createTerminalBenchComparisonManifest(controlPath, candidatePath);
    expect(comparison).toMatchObject({ version: 2, sourceCommit: "a".repeat(40), sourceArchiveSha256: "d".repeat(64) });
    expect(JSON.parse(JSON.stringify(comparison))).toMatchObject({ controlAnalyzer, candidateAnalyzer });
    const mismatched = JSON.parse(await readFile(candidatePath, "utf8"));
    mismatched.source_archive_sha256 = "e".repeat(64);
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createTerminalBenchComparisonManifest(controlPath, candidatePath)).rejects.toThrow("identical");
    mismatched.source_archive_sha256 = "d".repeat(64);
    mismatched.concurrency = 3;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createTerminalBenchComparisonManifest(controlPath, candidatePath)).rejects.toThrow("concurrency");
    mismatched.concurrency = 2;
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.analysis.rows[0].reward = 1;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createTerminalBenchComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.summary.sha256 = "0".repeat(64);
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createTerminalBenchComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.summary.denominator = 4;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createTerminalBenchComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
  });

  test("dirty seed prepares the normal leaderboard-valid path and records provenance", async () => {
    let validated = false;
    const root = temporaryDirectory("tb-dirty-");
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, profile);
    const result = await prepareTerminalBenchRun([...launchArgs, "--config", profilePath, "--task-names", "one", "--job-name", "dirty", "--execute"], {
      ...packageDependencies(root),
      inspectSeed: async () => ({ clean: false, revision: HEAD, dirtyPaths: ["src/x.ts"] }),
      validateConfig: async () => { validated = true; },
    });
    expect(validated).toBeTrue();
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest.state).toBe("prepared");
    expect(manifest.outcome).toBeNull();
    expect(manifest.grade).toBe("leaderboard_valid");
    expect(manifest.warning).toBe("");
    expect(manifest.seed_provenance).toEqual({ revision: HEAD, clean: false, dirty_paths: ["src/x.ts"] });
    expect(manifest.allow_dirty_exception).toBeUndefined();
    expect(result.dryRun).toBeFalse();
  });

  test("persists installed-schema refusal evidence", async () => {
    const root = temporaryDirectory("tb-schema-refusal-");
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, profile);
    await expect(prepareTerminalBenchRun([...launchArgs, "--config", profilePath, "--task-names", "one", "--job-name", "invalid"], {
      ...packageDependencies(root),
      validateConfig: async () => { throw new Error("schema rejected"); },
    })).rejects.toThrow("generated Harbor config refused");
    const [artifact] = await readdir(join(root, "jobs"));
    const manifest = JSON.parse(await readFile(join(root, "jobs", artifact ?? "", "run_manifest.json"), "utf8"));
    expect(manifest.state).toBe("refused");
    expect(manifest.outcome).toBe("configuration_refused");
  });

  throughTheLauncher("a local run hands Harbor the snapshot and only the explicit environment allowlist", async () => {
    const root = temporaryDirectory("tb-harbor-env-");
    const bin = join(root, "bin");
    await mkdir(bin);
    const capture = join(root, "harbor.env");
    const plan = join(root, "plan.json");
    const executable = async (name: string, source: string): Promise<string> => {
      const path = join(bin, name);
      await writeFile(path, source);
      await chmod(path, 0o755);
      return path;
    };
    const harbor = await executable("fake-harbor", `#!/bin/sh\nenv | sort > '${capture}'\n`);
    // The export writes its snapshot to the path after --output, as `flywheel headless snapshot-auth` does.
    const exporter = await executable("fake-export", `#!/bin/sh\nwhile [ "$1" != --output ]; do shift; done\nprintf 'snapshot-sentinel' > "$2"\n`);
    await writeFile(join(root, "manifest.json"), JSON.stringify({ expected_trials: 1 }));
    await writeFile(plan, JSON.stringify({
      harbor_command: [harbor], snapshot_command: [exporter], snapshot_providers: ["chatgpt"], claude_token_keychain_item: "unused",
      manifest: join(root, "manifest.json"), trials_directory: join(root, "trials"),
    }));
    const child = Bun.spawn([process.execPath, resolve(process.cwd(), "bench/terminal_bench/run-terminal-bench.ts"), "run-local", plan], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, OPENAI_API_KEY: "sentinel-openai", ANTHROPIC_API_KEY: "sentinel-anthropic", UNRELATED_SECRET: "sentinel-unrelated" },
      stdout: "pipe", stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const environment = await readFile(capture, "utf8");
    // The fake trials prove nothing, so finalization refuses the run.
    expect(exitCode, stderr).toBe(1);
    expect(environment).toContain("FLYWHEEL_AUTH_SNAPSHOT=snapshot-sentinel\n");
    expect(`${stdout}${stderr}`).not.toContain("snapshot-sentinel");
    const environmentKeys = environment.trim().split("\n").map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(environmentKeys.filter((key) => key.endsWith("_API_KEY") || key === "UNRELATED_SECRET")).toEqual([]);
  });
});
