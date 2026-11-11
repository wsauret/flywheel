import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION } from "../../../bench/harbor/analyze-tool-outcomes.js";
import { SECRET_VALUE_LIMIT, type AgentPackageBuild } from "../../../bench/harbor/harbor-jobs.js";
import { createHarborComparisonManifest, prepareHarborRun } from "../../../bench/harbor/run-harbor.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { harborLaunchArgs as launchArgs } from "../../fixtures/harbor-run.js";

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
    resolveTasks: async (_dataset: string, _ref: string, names: readonly string[]) => Object.fromEntries(names.map((name) => [name, { agent_timeout_sec: 1, verifier_timeout_sec: 1, build_timeout_sec: 1, agent_network_mode: "public" as const }])),
    releaseTagFor: async () => null,
    buildAgentPackage: async (commit: string, configPath: string, configSha256: string, _answerKeyRule: boolean, releaseTag: string | null): Promise<AgentPackageBuild> => {
      built.push(commit);
      return { build_id: "abcdef012345", flywheel_source: { commit, version: "1.2.3", release_tag: releaseTag }, runtime_archive: { path: "runtime/flywheel-linux-x64.tar.xz", sha256: "e".repeat(64) }, flywheel_config: { path: "flywheel.toml", source_path: configPath, sha256: configSha256 }, store_analyzer: { path: "store-analysis/trial-store-analysis.js", source_path: "bench/harbor/trial-store-analysis.ts", sha256: "0".repeat(64) }, benchmark_rules: null };
    },
    publishAgentPackage: async () => PUBLICATION,
  };
}

describe("Harbor launch boundary", () => {
  const temporaryDirectory = temporaryDirectories();

  test("prepares one internally consistent atomic artifact set", async () => {
    const root = temporaryDirectory("tb-run-");
    await mkdir(join(root, "jobs"));
    const result = await prepareHarborRun([...launchArgs, "--task-names", "one,two", "--attempts", "5", "--concurrency", "4", "--job-name", "dry", "--dry-run"], {
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
    expect(generated.agents).toEqual([{ name: "acp", kwargs: { source: { repo_url: "https://github.com/owner/agent.git", ref: PUBLICATION.commit, source_dir: ".", manifest_path: "harbor-agent.json" } }, env: { FLYWHEEL_HARBOR_PROFILE_SHA256: manifest.profile_sha256 } }]);
    expect(manifest.auth_profile).toBe("Fixture");
    expect(plan.auth_profile).toBe("Fixture");
    expect(JSON.stringify(generated)).not.toContain("auth_profile");
    expect(generated.datasets[0].task_names).toEqual(["terminal-bench/one", "terminal-bench/two"]);
    expect(generated.n_attempts).toBe(5);
    expect(generated.n_concurrent_trials).toBe(4);
    expect(generated.timeout_multiplier).toBe(1);
    expect(generated.environment_build_timeout_multiplier).toBe(3);
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
    const comparison = await createHarborComparisonManifest(controlPath, candidatePath);
    expect(comparison).toMatchObject({ version: 2, sourceCommit: "a".repeat(40), sourceArchiveSha256: "d".repeat(64) });
    expect(JSON.parse(JSON.stringify(comparison))).toMatchObject({ controlAnalyzer, candidateAnalyzer });
    const mismatched = JSON.parse(await readFile(candidatePath, "utf8"));
    mismatched.source_archive_sha256 = "e".repeat(64);
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createHarborComparisonManifest(controlPath, candidatePath)).rejects.toThrow("identical");
    mismatched.source_archive_sha256 = "d".repeat(64);
    mismatched.concurrency = 3;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createHarborComparisonManifest(controlPath, candidatePath)).rejects.toThrow("concurrency");
    mismatched.concurrency = 2;
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.analysis.rows[0].reward = 1;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createHarborComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.summary.sha256 = "0".repeat(64);
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createHarborComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
    mismatched.analyzer_result = structuredClone(candidateAnalyzer);
    mismatched.analyzer_result.summary.denominator = 4;
    await writeFile(candidatePath, JSON.stringify(mismatched));
    await expect(createHarborComparisonManifest(controlPath, candidatePath)).rejects.toThrow("summary");
  });

  test("dirty seed prepares the normal leaderboard-valid path and records provenance", async () => {
    let validated = false;
    const root = temporaryDirectory("tb-dirty-");
    const result = await prepareHarborRun([...launchArgs, "--task-names", "one", "--job-name", "dirty", "--execute"], {
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
    await expect(prepareHarborRun([...launchArgs, "--task-names", "one", "--job-name", "invalid"], {
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
      harbor_command: [harbor], snapshot_command: [exporter], snapshot_providers: ["chatgpt"], claude_token_keychain_items: ["unused"],
      manifest: join(root, "manifest.json"), trials_directory: join(root, "trials"),
    }));
    const child = Bun.spawn([process.execPath, resolve(process.cwd(), "bench/harbor/run-harbor.ts"), "run-local", plan], {
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

  /** A prepared run in `<root>/run` whose Harbor is a fake `harbor` on PATH:
   *  `run --dry-run` exits `dryRunExit`, `run` prints a launched job id or
   *  exits `launchExit`, and `hub job status` and `hub job download` settle
   *  the job, except that `hub job status` fails while `<root>/status-fails`
   *  exists. The fake export writes a snapshot of `snapshotLength`
   *  characters. Every call is logged. */
  async function fakeHostedRun(root: string, { dryRunExit = 0, launchExit = 0, exportExit = 0, snapshotLength = 17 } = {}) {
    const bin = join(root, "bin");
    const directory = join(root, "run");
    await mkdir(bin);
    await mkdir(directory);
    const log = join(root, "harbor.log");
    const write = async (name: string, source: string) => {
      await writeFile(join(bin, name), source);
      await chmod(join(bin, name), 0o755);
    };
    await write("harbor", `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  *--dry-run*) exit ${dryRunExit} ;;
  "run "*) [ ${launchExit} -eq 0 ] || exit ${launchExit}; echo "Launched job 01234567-89ab-cdef-0123-456789abcdef" ;;
  "hub job status"*) [ ! -e '${join(root, "status-fails")}' ] || exit 4; echo '{"status":"completed","pending":0,"running":0,"total":1,"completed":1,"failed":0,"canceled":0}' ;;
  "hub job download"*) mkdir -p "$6/job" ;;
esac
`);
    await write("fake-export", `#!/bin/sh\n[ ${exportExit} -eq 0 ] || exit ${exportExit}\nwhile [ "$1" != --output ]; do shift; done\nhead -c ${snapshotLength} /dev/zero | tr '\\0' s > "$2"\n`);
    const manifest = join(directory, "run_manifest.json");
    await writeFile(manifest, JSON.stringify({ expected_trials: 1, state: "prepared", outcome: null, hosted_job_id: null }));
    await writeFile(join(directory, "preparation-plan.json"), JSON.stringify({
      launch_command: [join(bin, "harbor"), "run", "--launch", "-c", "generated.json", "--yes"], harbor_command: [join(bin, "harbor"), "run", "-c", "generated.json"],
      snapshot_command: [join(bin, "fake-export")], snapshot_providers: ["chatgpt"], claude_token_keychain_items: ["unused"],
      manifest, trials_directory: join(directory, "hub", "job"), download_directory: join(directory, "hub"), worst_case_seconds: 60, dry_run: false,
    }));
    const launcher = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(process.cwd(), "bench/harbor/run-harbor.ts"), ...args], { cwd: process.cwd(), env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      return { exitCode, stderr };
    };
    const state = async () => JSON.parse(await readFile(manifest, "utf8"));
    const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    return { root, directory, plan: join(directory, "preparation-plan.json"), manifest, launcher, state, calls };
  }

  throughTheLauncher.each([
    ["the snapshot export fails", { exportExit: 3 }, "run-hosted", "snapshot_failed", 0],
    ["the snapshot is longer than Hub's secret limit", { snapshotLength: SECRET_VALUE_LIMIT + 1 }, "run-hosted", "snapshot_failed", 0],
    ["Hub refuses its dry run", { dryRunExit: 2 }, "run-hosted", "hub_dry_run_refused", 1],
    ["Hub refuses its launch", { launchExit: 2 }, "run-hosted", "hub_launch_refused", 2],
    ["the local snapshot export fails", { exportExit: 3 }, "run-local", "snapshot_failed", 0],
  ] as const)("a run is recorded as refused with its own outcome when %s before any trial runs", async (_case, fakes, action, outcome, harborCalls) => {
    const run = await fakeHostedRun(temporaryDirectory("tb-unlaunched-"), fakes);
    const { exitCode } = await run.launcher(action, run.plan);
    expect(exitCode).not.toBe(0);
    expect(await run.state()).toMatchObject({ state: "refused", outcome });
    expect(await run.calls()).toHaveLength(harborCalls);
  });

  throughTheLauncher("a hosted run whose job status fails stays launched, and resume-hosted settles it without launching again", async () => {
    const run = await fakeHostedRun(temporaryDirectory("tb-status-lost-"));
    await writeFile(join(run.root, "status-fails"), "");
    const lost = await run.launcher("run-hosted", run.plan);
    expect(lost.exitCode).toBe(1);
    expect(lost.stderr).toContain("hub job status 01234567-89ab-cdef-0123-456789abcdef --json failed");
    expect(await run.state()).toMatchObject({ state: "launched", outcome: null, hosted_job_id: "01234567-89ab-cdef-0123-456789abcdef" });
    await rm(join(run.root, "status-fails"));
    await run.launcher("resume-hosted", run.directory);
    expect((await run.calls()).filter((call) => call.startsWith("run "))).toHaveLength(2);
    expect((await run.calls()).slice(3)).toEqual(["hub job status 01234567-89ab-cdef-0123-456789abcdef --json", `hub job download 01234567-89ab-cdef-0123-456789abcdef -o ${join(run.directory, "hub")}`]);
    expect(await run.state()).toMatchObject({ state: "refused", outcome: "trials_unverified" });
  });

  throughTheLauncher("a hosted launch records its job id, and resume-hosted settles a launched run through the same wait, download, and finalization", async () => {
    const run = await fakeHostedRun(temporaryDirectory("tb-resume-"));
    const settle = ["hub job status 01234567-89ab-cdef-0123-456789abcdef --json", `hub job download 01234567-89ab-cdef-0123-456789abcdef -o ${join(run.directory, "hub")}`];
    expect((await run.launcher("run-hosted", run.plan)).exitCode).toBe(1);
    expect(await run.calls()).toEqual(["run --launch -c generated.json --yes --dry-run", "run --launch -c generated.json --yes", ...settle]);
    // The fake trials prove nothing, so finalization refuses the run.
    const settled = await run.state();
    expect(settled).toMatchObject({ hosted_job_id: "01234567-89ab-cdef-0123-456789abcdef", state: "refused", outcome: "trials_unverified" });
    // A launcher that ended after the launch left the run launched.
    await writeFile(run.manifest, JSON.stringify({ ...settled, state: "launched", outcome: null }));
    expect((await run.launcher("resume-hosted", run.directory)).exitCode).toBe(1);
    expect((await run.calls()).slice(4)).toEqual(settle);
    expect(await run.state()).toMatchObject({ state: "refused", outcome: "trials_unverified" });
    const again = await run.launcher("resume-hosted", run.directory);
    expect(again.stderr).toContain("is refused, not a launched hosted run with a recorded job id");
    expect((await run.calls()).length).toBe(6);
  });
});
