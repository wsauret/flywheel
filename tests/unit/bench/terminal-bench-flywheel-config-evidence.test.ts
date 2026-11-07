import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION } from "../../../bench/terminal_bench/analyze-tool-outcomes.js";
import { createTerminalBenchComparisonManifest, prepareTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { terminalBenchAuthArgs as authArgs } from "../../fixtures/terminal-bench-profile.js";

const CONFIG_TEXT = 'allow_persistent_processes = true\n[profiles.benchmark.roles.chat]\nmodel = "gpt-6-luna"\neffort = "max"\n';
const CONFIG_SHA256 = createHash("sha256").update(CONFIG_TEXT).digest("hex");

describe("terminal bench Flywheel config evidence", () => {
  const temporaryDirectory = temporaryDirectories();

  test("the manifest and the preparation plan record the config path and digest, also in a dry run", async () => {
    const root = temporaryDirectory("tb-config-evidence-");
    const configPath = join(root, "arm.toml");
    await writeFile(configPath, CONFIG_TEXT);
    const profilePath = join(root, "profile.yaml");
    await writeFile(profilePath, `headless: { flywheel_config: '${configPath}' }\ndatasets: [{ task_names: [one] }]\n`);
    const result = await prepareTerminalBenchRun([...authArgs, "--config", profilePath, "--allow-low-k", "--attempts", "1"], {
      cwd: root,
      inspectSeed: async () => ({ clean: true, revision: "abc123" }),
      validateConfig: async () => undefined,
      versionProbe: async () => "test",
      harborPython: () => "python",
    });
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    const plan = JSON.parse(await readFile(result.preparationPlan, "utf8"));
    const metadata = JSON.parse(await readFile(join(result.artifactDirectory, "metadata.yaml"), "utf8"));
    const generated = JSON.parse(await readFile(result.generatedConfig, "utf8"));
    const record = { path: configPath, sha256: CONFIG_SHA256, chat_effort: "max" };
    expect(result.dryRun).toBeTrue();
    expect(manifest.flywheel_config).toEqual(record);
    expect(plan.flywheel_config).toEqual(record);
    expect(manifest.model).toBe("gpt-6-luna");
    expect(metadata.models).toEqual([{ name: "flywheel/gpt-6-luna", role: "primary" }]);
    expect(generated.agents[0].kwargs.flywheel_model).toBeUndefined();
    expect(generated.agents[0].kwargs.flywheel_config_sha256).toBe(CONFIG_SHA256);
  });

  test("a paired comparison shows each arm's config digest", async () => {
    const root = temporaryDirectory("tb-config-comparison-");
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `trial-${index + 1}`, task: "terminal-bench/one", expected: true, discovered: true, storeValid: true, adapterSettled: true, verifierValid: true, requestAuditValid: true, toolSettlement: { inputs: 1, results: 1, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 }, commandExpected: true, commandObserved: true, reward: 1, failure: null }));
    const analysis = { version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, denominator: rows.length, rows, infrastructureValid: true, comparisonAvailable: true };
    const analyzer = { analysis, summary: { version: 1, contract_version: TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, result_version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, sha256: createHash("sha256").update(`${JSON.stringify(analysis, undefined, 2)}\n`).digest("hex"), infrastructure_valid: true, denominator: rows.length, failure_counts: {} } };
    const source = { mode: "git_commit", requested_sha: "a".repeat(40), resolved_sha: "a".repeat(40) };
    const arm = { model: "gpt-6-luna", dataset: "terminal-bench/terminal-bench-2-1", task_names: ["terminal-bench/one"], attempts: 5, concurrency: 2, disabled_tools: [], timeout_multipliers: {}, resource_overrides: {}, state: "finalized", outcome: "completed", expected_trials: 5, source_archive_sha256: "d".repeat(64), analyzer_result: analyzer, runtime_source: source };
    const controlPath = join(root, "control.json");
    const candidatePath = join(root, "candidate.json");
    await writeFile(controlPath, JSON.stringify({ ...arm, profile_sha256: "b".repeat(64), flywheel_config: { path: "control.toml", sha256: CONFIG_SHA256, chat_effort: "max" } }));
    await writeFile(candidatePath, JSON.stringify({ ...arm, profile_sha256: "c".repeat(64), flywheel_config: null }));
    const comparison = await createTerminalBenchComparisonManifest(controlPath, candidatePath);
    expect(comparison.controlFlywheelConfigSha256).toBe(CONFIG_SHA256);
    expect(comparison.candidateFlywheelConfigSha256).toBeNull();
  });
});
