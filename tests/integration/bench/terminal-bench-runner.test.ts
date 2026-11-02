import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION } from "../../../bench/terminal_bench/analyze-tool-outcomes.js";
import { createTerminalBenchComparisonManifest, prepareTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { terminalBenchAuthArgs as authArgs, terminalBenchProfile as profile } from "../../fixtures/terminal-bench-profile.js";

/** The launcher these three drive is a shell script, and a shell script is not
 *  a program Windows runs. Everything above them prepares artifacts through the
 *  runner's own module and holds on any host. */
const throughTheLauncher = test.skipIf(process.platform === "win32");

describe("terminal bench launch boundary", () => {
  const temporaryDirectory = temporaryDirectories();

  test("prepares one internally consistent atomic artifact set", async () => {
    const root = temporaryDirectory("tb-run-");
    await mkdir(join(root, "jobs"));
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, "headless:\n  disabled_tools: [web]\n  system_prompt: literal prompt\n");
    const result = await prepareTerminalBenchRun([...authArgs, "--config", profilePath, "--task-names", "one two", "--job-name", "dry", "--dry-run"], {
      cwd: root,
      now: () => new Date("2026-01-02T03:04:05Z"),
      seed: () => "seed-1",
      inspectSeed: async () => ({ clean: true, revision: "abc123" }),
      validateConfig: async () => undefined,
      versionProbe: async () => "0.21.0",
      harborPython: () => "harbor-python",
    });
    const manifest = JSON.parse(await readFile(join(result.artifactDirectory, "run_manifest.json"), "utf8"));
    const metadata = JSON.parse(await readFile(join(result.artifactDirectory, "metadata.yaml"), "utf8"));
    const plan = JSON.parse(await readFile(join(result.artifactDirectory, "preparation-plan.json"), "utf8"));
    const generated = JSON.parse(await readFile(join(result.artifactDirectory, "generated.json"), "utf8"));
    expect(manifest.expected_trials).toBe(10);
    expect(manifest.state).toBe("finalized");
    expect(manifest.outcome).toBe("dry_run");
    expect(manifest.seed).toBe("seed-1");
    expect(metadata.agent).toEqual({ name: "FlywheelHeadless", display_name: "Flywheel Headless", url: "https://github.com/wsauret/flywheel", organization: { display_name: "Flywheel" } });
    expect(metadata.models).toEqual([{ name: "flywheel/gpt-6-luna", role: "primary" }]);
    expect(plan.harbor_command).toEqual(["harbor", "run", "-c", join(result.artifactDirectory, "generated.json")]);
    expect(plan.grade).toBe("leaderboard_valid");
    expect(generated.agents).toEqual([{ name: "FlywheelHeadless", import_path: "bench.terminal_bench.flywheel_agent:FlywheelHeadless", model_name: "flywheel/gpt-6-luna", kwargs: { flywheel_model: "gpt-6-luna", dataset: "terminal-bench/terminal-bench-2-1", project_root_mode: "task_workspace", evidence_export: "settled_sqlite", persistent_processes: true, profile_sha256: manifest.profile_sha256 } }]);
    expect(manifest.auth_profile).toBe("Fixture");
    expect(plan.auth_profile).toBe("Fixture");
    expect(manifest.disabled_tools).toEqual(["web"]);
    expect(plan.disabled_tools).toEqual(["web"]);
    expect(manifest.system_prompt).toEqual({ mode: "override", sha256: "6a538633f3808731f36c4ab23b70dd754b212a78f655ff9eda08ee2458e31e84" });
    expect(plan.system_prompt).toEqual({ mode: "override", sha256: "6a538633f3808731f36c4ab23b70dd754b212a78f655ff9eda08ee2458e31e84" });
    expect(plan.system_prompt_value).toBeUndefined();
    expect(plan.system_prompt_payload).toBe(join(`${result.artifactDirectory}.system-prompt`, "payload"));
    expect(JSON.stringify(manifest)).not.toContain("literal prompt");
    expect(JSON.stringify(plan)).not.toContain("literal prompt");
    expect(await readFile(plan.system_prompt_payload, "utf8")).toBe("literal prompt");
    expect(manifest.disabled_modules).toBeUndefined();
    expect(plan.disabled_modules).toBeUndefined();
    expect(plan.enabled_modules).toBeUndefined();
    expect(generated.flywheel).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("auth_provider_ids");
    expect(JSON.stringify(plan)).not.toContain("auth_provider_ids");
    expect(JSON.stringify(generated)).not.toContain("auth_profile");
    expect(JSON.stringify(generated)).not.toContain("auth_provider_ids");
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
    expect(manifest.execution_contract).toEqual({ project_root: "task_workspace", execution_cwd: "task_workspace", evidence_export: "settled_sqlite", persistent_processes: true });
  });

  test("resolves a pinned runtime before writing artifacts and records it", async () => {
    const root = temporaryDirectory("tb-pinned-run-");
    const sha = "a".repeat(40);
    const path = join(root, "profile.yaml");
    await writeFile(path, `headless: { runtime_source_commit: '${sha}' }\ndatasets: [{ task_names: [one] }]\n`);
    const base = { cwd: root, inspectSeed: async () => ({ clean: true, revision: "dirty-head" }), validateConfig: async () => undefined, versionProbe: async () => "test", harborPython: () => "python" };
    await expect(prepareTerminalBenchRun([...authArgs, "--config", path], { ...base, resolveCommit: async () => "b".repeat(40) })).rejects.toThrow("exact requested SHA");
    expect(await readdir(root)).toEqual(["profile.yaml"]);
    await expect(prepareTerminalBenchRun([...authArgs, "--config", path], { ...base, resolveCommit: async () => { throw new Error("unknown commit"); } })).rejects.toThrow("unknown commit");
    const result = await prepareTerminalBenchRun([...authArgs, "--config", path], { ...base, resolveCommit: async (_cwd, requested) => requested });
    const generated = JSON.parse(await readFile(result.generatedConfig, "utf8"));
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    const metadata = JSON.parse(await readFile(join(result.artifactDirectory, "metadata.yaml"), "utf8"));
    expect(generated.agents[0].kwargs.runtime_source_commit).toBe(sha);
    expect(manifest.runtime_source).toEqual({ mode: "git_commit", requested_sha: sha, resolved_sha: sha });
    expect(metadata.runtime_source).toEqual(manifest.runtime_source);
  });

  test("builds comparison evidence only for identical source and controls", async () => {
    const root = temporaryDirectory("tb-comparison-");
    const source = { mode: "git_commit", requested_sha: "a".repeat(40), resolved_sha: "a".repeat(40) };
    const controls = { model: "gpt-6-luna", dataset: "terminal-bench/terminal-bench-2-1", task_names: ["terminal-bench/protein-assembly"], attempts: 5, concurrency: 2, disabled_tools: ["web"], timeout_multipliers: {}, resource_overrides: {} };
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
    const result = await prepareTerminalBenchRun([...authArgs, "--config", profilePath, "--task-names", "one", "--job-name", "dirty", "--execute"], {
      cwd: root,
      inspectSeed: async () => ({ clean: false, revision: "abc", dirtyPaths: ["src/x.ts"] }),
      validateConfig: async () => { validated = true; },
      versionProbe: async () => "0.21.0",
      harborPython: () => "harbor-python",
    });
    expect(validated).toBeTrue();
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest.state).toBe("prepared");
    expect(manifest.outcome).toBeNull();
    expect(manifest.grade).toBe("leaderboard_valid");
    expect(manifest.warning).toBe("");
    expect(manifest.seed_provenance).toEqual({ revision: "abc", clean: false, dirty_paths: ["src/x.ts"] });
    expect(manifest.allow_dirty_exception).toBeUndefined();
    expect(result.dryRun).toBeFalse();
  });

  test("persists installed-schema refusal evidence", async () => {
    const root = temporaryDirectory("tb-schema-refusal-");
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, profile);
    await expect(prepareTerminalBenchRun([...authArgs, "--config", profilePath, "--task-names", "one", "--job-name", "invalid"], {
      cwd: root,
      inspectSeed: async () => ({ clean: true, revision: "abc" }),
      validateConfig: async () => { throw new Error("schema rejected"); },
      versionProbe: async () => "0.21.0",
      harborPython: () => "harbor-python",
    })).rejects.toThrow("generated Harbor config refused");
    const [artifact] = await readdir(join(root, "jobs"));
    const manifest = JSON.parse(await readFile(join(root, "jobs", artifact ?? "", "run_manifest.json"), "utf8"));
    expect(manifest.state).toBe("refused");
    expect(manifest.outcome).toBe("configuration_refused");
    expect((await readdir(join(root, "jobs"))).some((name) => name.endsWith(".system-prompt"))).toBeFalse();
  });

  test("cleans private prompt payload when jobs directory creation fails", async () => {
    const root = temporaryDirectory("tb-prompt-cleanup-");
    const blockedJobs = join(root, "jobs");
    const profilePath = join(root, "profile.yaml");
    await writeFile(blockedJobs, "not a directory");
    await writeFile(profilePath, "headless:\n  system_prompt: private prompt\ndatasets: [{ task_names: [one] }]\n");

    await expect(prepareTerminalBenchRun([
      ...authArgs,
      "--config", profilePath,
      "--jobs-dir", blockedJobs,
    ], {
      cwd: root,
      inspectSeed: async () => ({ clean: true, revision: "abc" }),
    })).rejects.toThrow();

    expect((await readdir(root)).some((name) => name.endsWith(".system-prompt"))).toBeFalse();
  });

  throughTheLauncher("executes Harbor with only the explicit environment allowlist", async () => {
    const root = temporaryDirectory("tb-harbor-env-");
    const bin = join(root, "bin");
    await mkdir(bin);
    const capture = join(root, "harbor.env");
    const plan = join(root, "plan.json");
    const removedSourceManifest = join(root, "source-manifest.txt");
    const executable = async (name: string, source: string): Promise<string> => {
      const path = join(bin, name);
      await writeFile(path, source);
      await chmod(path, 0o755);
      return path;
    };
    const harbor = await executable("fake-harbor", `#!/bin/sh\nenv | sort > '${capture}'\n`);
    const download = await executable("fake-download", "#!/bin/sh\nexit 0\n");
    const wheelhouse = await executable("fake-wheelhouse", `#!/bin/sh\necho '${root}'\n`);
    await writeFile(plan, JSON.stringify({
      dry_run: false, grade: "debug_only", warning: "test", auth_profile: "Fixture",
      disabled_tools: ["web"], system_prompt: { mode: "production" },
      download_command: [download], prebuild: false, wheelhouse_command: [wheelhouse], harbor_command: [harbor],
      manifest: join(root, "manifest.json"), trials_directory: join(root, "trials"),
    }));
    await executable("bun", `#!/bin/sh\ncase "$*" in *" prepare "*) echo '${plan}' ;; esac\nexit 0\n`);
    const launcher = resolve(process.cwd(), "bench/terminal_bench/run-terminal-bench.sh");
    const runHarbor = async () => {
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        FLYWHEEL_TERMINAL_BENCH_UNTRACKED_SOURCE_MANIFEST: removedSourceManifest,
        OPENAI_API_KEY: "sentinel-openai",
        ANTHROPIC_API_KEY: "sentinel-anthropic",
        DEEPSEEK_API_KEY: "sentinel-deepseek",
        GOOGLE_API_KEY: "sentinel-google",
        GEMINI_API_KEY: "sentinel-gemini",
        OPENROUTER_API_KEY: "sentinel-openrouter",
        UNRELATED_SECRET: "sentinel-unrelated",
      };
      const child = Bun.spawn([launcher, ...authArgs, "--execute"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe", stderr: "pipe",
        windowsHide: true,
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { exitCode, stderr, environment: await readFile(capture, "utf8") };
    };
    const present = await runHarbor();
    expect(present.exitCode, present.stderr).toBe(0);
    expect(present.environment).toContain("FLYWHEEL_TERMINAL_BENCH_AUTH_PROFILE=Fixture\n");
    expect(present.environment).toContain('FLYWHEEL_TERMINAL_BENCH_DISABLED_TOOLS=["web"]\n');
    expect(present.environment).not.toContain("FLYWHEEL_TERMINAL_BENCH_UNTRACKED_SOURCE_MANIFEST=");
    const environmentKeys = present.environment.trim().split("\n").map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(environmentKeys.filter((key) => key.endsWith("_API_KEY") || key === "UNRELATED_SECRET")).toEqual([]);

  });

  throughTheLauncher("dry-run stdout omits prompt bytes and cleans the private payload", async () => {
    const root = temporaryDirectory("tb-prompt-cleanup-");
    const bin = join(root, "bin");
    await mkdir(bin);
    const artifact = join(root, "artifact");
    const payloadDirectory = `${artifact}.system-prompt`;
    await mkdir(artifact);
    await mkdir(payloadDirectory);
    const payload = join(payloadDirectory, "payload");
    await writeFile(payload, "literal prompt", { mode: 0o600 });
    const plan = join(artifact, "preparation-plan.json");
    await writeFile(plan, JSON.stringify({ dry_run: true, grade: "debug_only", warning: "test", auth_profile: "Fixture", disabled_tools: [], system_prompt: { mode: "override", sha256: "0".repeat(64) }, system_prompt_payload: payload }));
    const bun = join(bin, "bun");
    await writeFile(bun, `#!/bin/sh\necho '${plan}'\n`);
    await chmod(bun, 0o755);
    const child = Bun.spawn([resolve(process.cwd(), "bench/terminal_bench/run-terminal-bench.sh")], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).not.toContain("literal prompt");
    await expect(readFile(payload, "utf8")).rejects.toThrow();
  });

  throughTheLauncher("cleans deterministic prompt payload when plan parsing fails", async () => {
    const root = temporaryDirectory("tb-prompt-parse-failure-");
    const bin = join(root, "bin");
    const artifact = join(root, "artifact");
    const payloadDirectory = `${artifact}.system-prompt`;
    await mkdir(bin);
    await mkdir(artifact);
    await mkdir(payloadDirectory);
    await writeFile(join(payloadDirectory, "payload"), "literal prompt", { mode: 0o600 });
    const plan = join(artifact, "preparation-plan.json");
    await writeFile(plan, JSON.stringify({ grade: { invalid: true } }));
    const bun = join(bin, "bun");
    await writeFile(bun, `#!/bin/sh\necho '${plan}'\n`);
    await chmod(bun, 0o755);

    const child = Bun.spawn([resolve(process.cwd(), "bench/terminal_bench/run-terminal-bench.sh")], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe",
      windowsHide: true,
    });
    const [exitCode] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exitCode).not.toBe(0);
    await expect(readFile(join(payloadDirectory, "payload"), "utf8")).rejects.toThrow();
  });
});
