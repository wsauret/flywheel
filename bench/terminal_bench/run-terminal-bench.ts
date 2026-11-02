import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { reconcileDisclosureLedger, type DisclosureLedger } from "./disclosure-ledger.js";
import { analyzeToolOutcomes, TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION, type ToolOutcomeAnalysis } from "./analyze-tool-outcomes.js";
import { resolveTerminalBenchConfig, terminalBenchDisplayModel, type JsonMap, type ResolvedTerminalBenchConfig } from "./terminal-bench-config.js";

const WHEELHOUSE_TARGET = "/opt/flywheel-verifier-wheelhouse";
const CACHE_TARGET = "/opt/flywheel-download-cache";

interface SeedInspection { clean: boolean; revision: string; dirtyPaths?: string[] }
interface PrepareDependencies {
  cwd: string;
  now: () => Date;
  seed: () => string;
  inspectSeed: (cwd: string) => Promise<SeedInspection>;
  resolveCommit: (cwd: string, sha: string) => Promise<string>;
  validateConfig: (path: string) => Promise<void>;
  versionProbe: () => Promise<string>;
  harborPython: () => string;
}

export interface PreparedTerminalBenchRun {
  artifactDirectory: string;
  generatedConfig: string;
  preparationPlan: string;
  manifest: string;
  harborCommand: string[];
  dryRun: boolean;
}
export interface TerminalBenchComparisonManifest {
  version: 2;
  sourceCommit: string;
  sourceArchiveSha256: string;
  controlProfileSha256: string;
  candidateProfileSha256: string;
  controlAnalyzer: Readonly<FinalizedAnalyzerEvidence>;
  candidateAnalyzer: Readonly<FinalizedAnalyzerEvidence>;
  fixedControls: JsonMap;
}

interface FinalizedAnalyzerSummary {
  version: 1;
  contract_version: typeof TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION;
  result_version: typeof TOOL_OUTCOME_ANALYZER_RESULT_VERSION;
  sha256: string;
  infrastructure_valid: true;
  denominator: number;
  failure_counts: Record<string, number>;
}

interface FinalizedAnalyzerEvidence {
  analysis: ToolOutcomeAnalysis;
  summary: FinalizedAnalyzerSummary;
}
function object(value: unknown): JsonMap | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;
}

function isToolOutcomeAnalysis(value: unknown): value is ToolOutcomeAnalysis {
  const candidate = object(value);
  if (!candidate || candidate.version !== TOOL_OUTCOME_ANALYZER_RESULT_VERSION || typeof candidate.infrastructureValid !== "boolean" || typeof candidate.comparisonAvailable !== "boolean" || !Number.isInteger(candidate.denominator) || !Array.isArray(candidate.rows)) return false;
  return candidate.rows.every((row) => {
    const item = object(row);
    if (!item) return false;
    const settlement = object(item.toolSettlement);
    if (!settlement) return false;
    return typeof item.id === "string" && typeof item.task === "string"
      && [item.expected, item.discovered, item.storeValid, item.adapterSettled, item.verifierValid, item.requestAuditValid, item.commandExpected, item.commandObserved].every((field) => typeof field === "boolean")
      && (item.reward === null || typeof item.reward === "number") && (item.failure === null || typeof item.failure === "string")
      && Object.values(settlement).every((count) => Number.isInteger(count) && Number(count) >= 0);
  });
}

interface PreparationPlan {
  artifact_directory: string;
  generated_config: string;
  manifest: string;
  metadata: string;
  harbor_command: string[];
  download_command: string[];
  wheelhouse_command: string[];
  dataset: string;
  task_names: string[];
  prebuild: boolean;
  concurrency: number;
  dry_run: boolean;
  auth_profile: string;
  disabled_tools: string[];
  system_prompt: JsonMap;
  system_prompt_payload?: string;
  trials_directory: string;
  grade: string;
  warning: string;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function command(argv: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

async function defaultSeedInspection(cwd: string): Promise<SeedInspection> {
  const [revision, status] = await Promise.all([
    command(["git", "rev-parse", "HEAD"], cwd).then((value) => value.trim()),
    command(["git", "status", "--porcelain", "--untracked-files=all"], cwd),
  ]);
  const dirtyPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3));
  return { clean: dirtyPaths.length === 0, revision, dirtyPaths };
}

async function defaultResolveCommit(cwd: string, sha: string): Promise<string> {
  const resolved = (await command(["git", "rev-parse", "--verify", `${sha}^{commit}`], cwd)).trim();
  if (resolved !== sha) throw new Error("runtime source commit did not resolve to the exact requested SHA");
  return resolved;
}

function harborPython(): string {
  const binary = Bun.which("harbor");
  if (binary === null) throw new Error("harbor CLI not found");
  return join(dirname(realpathSync(binary)), "python");
}

async function defaultValidateConfig(path: string): Promise<void> {
  const source = "import json,sys\ntry:\n from harbor.models.job.config import JobConfig\nexcept ImportError:\n from harbor.models.job import JobConfig\ndata=json.load(open(sys.argv[1],encoding='utf-8'))\nJobConfig.model_validate(data)\n";
  await command([harborPython(), "-c", source, path], process.cwd());
}

async function defaultVersionProbe(): Promise<string> {
  return command(["harbor", "--version"], process.cwd()).then((value) => value.trim());
}

function cloneMap(value: unknown, label: string): JsonMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...structuredClone(value) };
}

function mergeMounts(config: JsonMap, additions: JsonMap[]): void {
  const environment = cloneMap(config.environment ?? {}, "environment");
  const current = environment.mounts ?? [];
  if (!Array.isArray(current)) throw new Error("environment.mounts must be an array");
  const mounts = current.map((mount) => cloneMap(mount, "mount"));
  for (const addition of additions) {
    const target = addition.target;
    const conflict = mounts.find((mount) => mount.target === target);
    if (conflict !== undefined) {
      if (JSON.stringify(conflict) !== JSON.stringify(addition)) throw new Error(`mount target is reserved: ${String(target)}`);
      continue;
    }
    mounts.push(addition);
  }
  environment.mounts = mounts;
  config.environment = environment;
}

function generatedConfig(config: ResolvedTerminalBenchConfig): JsonMap {
  const generated = cloneMap(config.harborConfig, "Harbor config");
  generated.timeout_multiplier = config.timeoutMultiplier;
  generated.environment_build_timeout_multiplier = config.environmentBuildTimeoutMultiplier;
  const agents = generated.agents;
  if (!Array.isArray(agents) || agents.length !== 1) throw new Error("generated config must contain one named FlywheelHeadless agent");
  const agent = cloneMap(agents[0], "agent");
  const kwargs = cloneMap(agent.kwargs ?? {}, "agent kwargs");
  kwargs.dataset = config.dataset;
  kwargs.flywheel_model = config.model;
  if (config.runtimeSourceCommit !== undefined) kwargs.runtime_source_commit = config.runtimeSourceCommit;
  if (config.profileSha256 !== undefined) kwargs.profile_sha256 = config.profileSha256;
  kwargs.project_root_mode = "task_workspace";
  kwargs.evidence_export = "settled_sqlite";
  kwargs.persistent_processes = true;
  agent.kwargs = kwargs;
  agents[0] = agent;
  if (agent.name !== "FlywheelHeadless" || agent.import_path !== "bench.terminal_bench.flywheel_agent:FlywheelHeadless" || agent.model_name !== terminalBenchDisplayModel(config.model) || kwargs.flywheel_model !== config.model || kwargs.dataset !== config.dataset) {
    throw new Error("generated config agent does not match the resolved run");
  }
  const datasets = generated.datasets;
  if (!Array.isArray(datasets) || datasets.length !== 1) throw new Error("generated config must contain one resolved dataset");
  const dataset = cloneMap(datasets[0], "dataset");
  if (dataset.name !== config.dataset || JSON.stringify(dataset.task_names) !== JSON.stringify(config.taskNames)) throw new Error("generated config dataset does not match the resolved run");
  if (generated.n_attempts !== config.attempts || generated.n_concurrent_trials !== config.concurrency || generated.timeout_multiplier !== config.timeoutMultiplier || generated.environment_build_timeout_multiplier !== config.environmentBuildTimeoutMultiplier) {
    throw new Error("generated config methodology does not match the resolved run");
  }
  const environment = cloneMap(generated.environment ?? {}, "environment");
  const mounts = environment.mounts ?? [];
  if (!Array.isArray(mounts)) throw new Error("generated config mounts must be an array");
  const targets = mounts.map((mount) => cloneMap(mount, "mount").target).filter((target) => typeof target === "string");
  if (new Set(targets).size !== targets.length) throw new Error("generated config contains duplicate mount targets");
  return generated;
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, jsonBytes(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function trialSourceArchiveSha256(trialsDirectory: string, expectedTrials: number): Promise<string> {
  const entries = await readdir(trialsDirectory, { withFileTypes: true });
  const digests = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (entry) => {
    const summary = cloneMap(JSON.parse(await readFile(join(trialsDirectory, entry.name, "agent", "flywheel-run-summary.json"), "utf8")), "trial summary");
    return typeof summary.source_archive_sha256 === "string" ? summary.source_archive_sha256 : "";
  }));
  const unique = new Set(digests);
  if (digests.length !== expectedTrials || unique.size !== 1 || !/^[a-f0-9]{64}$/.test(digests[0] ?? "")) throw new Error("trials do not prove one source archive digest");
  return digests[0] ?? "";
}

function defaultDependencies(overrides: Partial<PrepareDependencies>): PrepareDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    now: overrides.now ?? (() => new Date()),
    seed: overrides.seed ?? (() => crypto.randomUUID()),
    inspectSeed: overrides.inspectSeed ?? defaultSeedInspection,
    resolveCommit: overrides.resolveCommit ?? defaultResolveCommit,
    validateConfig: overrides.validateConfig ?? defaultValidateConfig,
    versionProbe: overrides.versionProbe ?? defaultVersionProbe,
    harborPython: overrides.harborPython ?? harborPython,
  };
}

export async function prepareTerminalBenchRun(args: string[], overrides: Partial<PrepareDependencies> = {}): Promise<PreparedTerminalBenchRun> {
  const dependencies = defaultDependencies(overrides);
  const config = await resolveTerminalBenchConfig(args, { cwd: dependencies.cwd });
  const resolvedRuntimeCommit = config.runtimeSourceCommit === undefined ? undefined : await dependencies.resolveCommit(dependencies.cwd, config.runtimeSourceCommit);
  if (config.runtimeSourceCommit !== undefined && resolvedRuntimeCommit !== config.runtimeSourceCommit) throw new Error("runtime source commit did not resolve to the exact requested SHA");
  const seed = await dependencies.inspectSeed(dependencies.cwd);
  const effectiveGrade = config.grade;
  const warning = config.warning;
  const harborVersion = await dependencies.versionProbe().catch(() => "");
  const selectedHarborPython = dependencies.harborPython();
  const generated = generatedConfig(config);
  const cacheDirectory = process.env.FLYWHEEL_TB_CACHE_DIR;
  if (cacheDirectory !== undefined && cacheDirectory.length > 0) mergeMounts(generated, [{ type: "bind", source: resolve(cacheDirectory), target: CACHE_TARGET, read_only: false, bind: { create_host_path: false } }]);
  const artifactDirectory = join(config.jobsDirectory, `${config.jobName}-${dependencies.now().toISOString().replaceAll(":", "-")}`);
  const stage = `${artifactDirectory}.${crypto.randomUUID()}.tmp`;
  const generatedPath = join(stage, "generated.json");
  const manifestPath = join(stage, "run_manifest.json");
  const metadataPath = join(stage, "metadata.yaml");
  const planPath = join(stage, "preparation-plan.json");
  const finalGeneratedPath = join(artifactDirectory, "generated.json");
  const finalManifestPath = join(artifactDirectory, "run_manifest.json");
  const finalMetadataPath = join(artifactDirectory, "metadata.yaml");
  const harborCommand = ["harbor", "run", "-c", finalGeneratedPath];
  const systemPromptSha256 = config.systemPrompt === undefined ? undefined : createHash("sha256").update(config.systemPrompt).digest("hex");
  const systemPrompt = systemPromptSha256 === undefined ? { mode: "production" } : { mode: "override", sha256: systemPromptSha256 };
  const payloadDirectory = `${artifactDirectory}.system-prompt`;
  const runtimeSource = resolvedRuntimeCommit === undefined
    ? { mode: "worktree" }
    : { mode: "git_commit", requested_sha: config.runtimeSourceCommit, resolved_sha: resolvedRuntimeCommit };
  const manifest: JsonMap = {
    expected_rows: config.taskNames.flatMap((task) => Array.from({ length: config.attempts }, (_, index) => ({ task, attempt: index + 1 }))),
    command_expectation: { version: 1, executable_tool_names: [config.expectedInteraction.executableToolName], minimum_cardinality: 1 },
    expected_interaction_profile: config.expectedInteraction.profileId,
    version: 1,
    state: config.dryRun ? "finalized" : "prepared",
    seed: dependencies.seed(),
    seed_provenance: { revision: seed.revision, clean: seed.clean, dirty_paths: seed.dirtyPaths ?? [] },
    harbor_binary: Bun.which("harbor") ?? "",
    harbor_version: harborVersion,
    exact_command: harborCommand,
    expected_trials: config.expectedTrials,
    requested_tasks: config.taskNames,
    denominator: config.expectedTrials,
    auth_profile: config.authProfile,
    disabled_tools: config.disabledTools,
    system_prompt: systemPrompt,
    runtime_source: runtimeSource,
    profile_sha256: config.profileSha256 ?? null,
    execution_contract: { project_root: "task_workspace", execution_cwd: "task_workspace", evidence_export: "settled_sqlite", persistent_processes: true },
    grade: effectiveGrade,
    warning: warning ?? "",
    model: config.model,
    dataset: config.dataset,
    task_names: config.taskNames,
    attempts: config.attempts,
    concurrency: config.concurrency,
    methodology: { attempts_per_task: config.attempts, task_count: config.taskNames.length, concurrency: config.concurrency },
    timeout_multipliers: config.timeoutMultipliers,
    resource_overrides: config.resourceOverrides,
    outcome: config.dryRun ? "dry_run" : null,
    ledger_summary: null,
    analyzer_result: null,
  };
  const plan: PreparationPlan = {
    artifact_directory: artifactDirectory,
    generated_config: finalGeneratedPath,
    manifest: finalManifestPath,
    metadata: finalMetadataPath,
    harbor_command: harborCommand,
    // Cache mode fills the content-addressed task cache that the wheelhouse
    // step reads. Harbor 0.21 defaults to export mode in the current directory.
    download_command: ["harbor", "download", config.dataset, "--cache"],
    wheelhouse_command: [selectedHarborPython, resolve(dependencies.cwd, "bench/terminal_bench/verifier_wheelhouse.py"), "--dataset", config.dataset, "--task-cache", resolve(process.env.HOME ?? dependencies.cwd, ".cache/harbor/tasks/packages/terminal-bench"), ...config.taskNames.flatMap((name) => ["--task-name", name])],
    dataset: config.dataset,
    auth_profile: config.authProfile,
    disabled_tools: [...config.disabledTools],
    system_prompt: systemPrompt,
    task_names: config.taskNames,
    prebuild: config.prebuild,
    concurrency: config.concurrency,
    dry_run: config.dryRun,
    grade: effectiveGrade,
    warning: warning ?? "",
    trials_directory: join(config.jobsDirectory, config.jobName),
  };
  try {
    await mkdir(config.jobsDirectory, { recursive: true });
    if (config.systemPrompt !== undefined) {
      await mkdir(payloadDirectory, { mode: 0o700 });
      const systemPromptPayload = join(payloadDirectory, "payload");
      await writeFile(systemPromptPayload, config.systemPrompt, { mode: 0o600 });
      plan.system_prompt_payload = systemPromptPayload;
    }
    await mkdir(stage, { mode: 0o700 });
    await Promise.all([
      writeFile(generatedPath, jsonBytes(generated), { mode: 0o600 }),
      writeFile(manifestPath, jsonBytes(manifest), { mode: 0o600 }),
      writeFile(metadataPath, jsonBytes({ agent: { name: "FlywheelHeadless", display_name: "Flywheel Headless", url: "https://github.com/wsauret/flywheel", organization: { display_name: "Flywheel" } }, models: [{ name: terminalBenchDisplayModel(config.model), role: "primary" }], runtime_source: runtimeSource }), { mode: 0o600 }),
      writeFile(planPath, jsonBytes(plan), { mode: 0o600 }),
    ]);
    try {
      await dependencies.validateConfig(generatedPath);
    } catch (error) {
      manifest.state = "refused";
      manifest.outcome = "configuration_refused";
      await writeFile(manifestPath, jsonBytes(manifest), { mode: 0o600 });
      await rename(stage, artifactDirectory);
      throw new Error(`generated Harbor config refused; grade=${effectiveGrade}; warning=${warning ?? "none"}; manifest=${finalManifestPath}; reason=${error instanceof Error ? error.message : String(error)}`);
    }
    await rename(stage, artifactDirectory);
  } catch (error) {
    await Promise.allSettled([
      rm(stage, { recursive: true, force: true }),
      rm(payloadDirectory, { recursive: true, force: true }),
    ]);
    throw error;
  }
  return { artifactDirectory, generatedConfig: finalGeneratedPath, preparationPlan: join(artifactDirectory, "preparation-plan.json"), manifest: finalManifestPath, harborCommand, dryRun: config.dryRun };
}

async function addVerifierWheelhouse(planPath: string, wheelhouse: string, validateConfig: (path: string) => Promise<void> = defaultValidateConfig): Promise<void> {
  const plan = cloneMap(JSON.parse(await readFile(planPath, "utf8")), "preparation plan");
  if (typeof plan.generated_config !== "string") throw new Error("preparation plan has no generated config");
  const generated = cloneMap(JSON.parse(await readFile(plan.generated_config, "utf8")), "generated config");
  mergeMounts(generated, [{ type: "bind", source: resolve(wheelhouse), target: WHEELHOUSE_TARGET, read_only: true, bind: { create_host_path: false } }]);
  const verifier = cloneMap(generated.verifier ?? {}, "verifier");
  verifier.env = {
    PIP_NO_INDEX: "1", PIP_CONFIG_FILE: "/dev/null", PIP_FIND_LINKS: `file://${WHEELHOUSE_TARGET}`,
    UV_DEFAULT_INDEX: `file://${WHEELHOUSE_TARGET}/empty-index`, UV_FIND_LINKS: WHEELHOUSE_TARGET,
    UV_INDEX: "", UV_EXTRA_INDEX_URL: "", UV_NO_CONFIG: "1",
  };
  generated.verifier = verifier;
  await atomicWrite(plan.generated_config, generated);
  await validateConfig(plan.generated_config);
}

export async function finalizeTerminalBenchRun(manifestPath: string, trialsDirectory: string, harborExitCode: number): Promise<DisclosureLedger> {
  const manifest = cloneMap(JSON.parse(await readFile(manifestPath, "utf8")), "run manifest");
  if (typeof manifest.expected_trials !== "number") throw new Error("run manifest has no expected trial denominator");
  let ledger: DisclosureLedger;
  let analysis: ToolOutcomeAnalysis | undefined;
  try {
    manifest.source_archive_sha256 = await trialSourceArchiveSha256(trialsDirectory, manifest.expected_trials);
    analysis = await analyzeToolOutcomes(trialsDirectory, manifest);
    const taskNames = Array.isArray(manifest.requested_tasks) && manifest.requested_tasks.every((task) => typeof task === "string") ? manifest.requested_tasks : [];
    const attempts = typeof manifest.attempts === "number" ? manifest.attempts : 0;
    ledger = await reconcileDisclosureLedger({ trialsDirectory, taskNames, attempts, harborExitCode, infrastructureValid: analysis.infrastructureValid });
    await atomicWrite(join(dirname(manifestPath), "disclosure-ledger.json"), ledger);
  } catch {
    const outcome = harborExitCode === 0 ? "trials_unverified" : "harness_nonzero_exit";
    ledger = { denominator: manifest.expected_trials, scoredTrials: 0, rewardDistribution: {}, exceptionHistogram: {}, taskPassRates: {}, totalCost: 0, counts: { provider_infra: 0, cancelled: 0, cost_truncated: 0, genuine: 0, other: 0 }, outcome, exitCode: harborExitCode === 0 ? 1 : harborExitCode, reconciled: false, rows: [] };
  }
  if (analysis?.infrastructureValid === true && analysis.version === TOOL_OUTCOME_ANALYZER_RESULT_VERSION) {
    const failureCounts: Record<string, number> = {};
    for (const row of analysis.rows) if (row.failure !== null) failureCounts[row.failure] = (failureCounts[row.failure] ?? 0) + 1;
    manifest.analyzer_result = {
      analysis,
      summary: {
        version: 1,
        contract_version: TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION,
        result_version: analysis.version,
        sha256: createHash("sha256").update(jsonBytes(analysis)).digest("hex"),
        infrastructure_valid: true,
        denominator: analysis.rows.length,
        failure_counts: failureCounts,
      },
    } satisfies FinalizedAnalyzerEvidence;
  } else {
    manifest.analyzer_result = null;
    if (harborExitCode === 0) ledger = { ...ledger, outcome: "trials_unverified", exitCode: 1, reconciled: false };
  }
  manifest.state = ledger.reconciled && analysis?.infrastructureValid === true ? "finalized" : "refused";
  manifest.outcome = ledger.outcome;
  manifest.ledger_summary = { denominator: ledger.denominator, scored_trials: ledger.scoredTrials, reconciled: ledger.reconciled, counts: ledger.counts, total_cost: ledger.totalCost };
  await atomicWrite(manifestPath, manifest);
  return ledger;
}

export async function createTerminalBenchComparisonManifest(
  controlManifestPath: string,
  candidateManifestPath: string,
): Promise<TerminalBenchComparisonManifest> {
  const control = cloneMap(JSON.parse(await readFile(controlManifestPath, "utf8")), "control manifest");
  const candidate = cloneMap(JSON.parse(await readFile(candidateManifestPath, "utf8")), "candidate manifest");
  if (control.state !== "finalized" || candidate.state !== "finalized" || control.outcome !== "completed" || candidate.outcome !== "completed") throw new Error("comparison requires completed finalized run manifests");
  const requireAnalyzerResult = (manifest: JsonMap, arm: string): FinalizedAnalyzerEvidence => {
    const result = cloneMap(manifest.analyzer_result, `${arm} analyzer result`);
    const analysis: unknown = structuredClone(result.analysis);
    const summary = cloneMap(result.summary, `${arm} analyzer summary`);
    if (!isToolOutcomeAnalysis(analysis)) throw new Error(`${arm} manifest lacks complete analyzer evidence`);
    const typed = analysis;
    if (typed.infrastructureValid !== true || typed.comparisonAvailable !== true || typed.rows.length === 0 || typed.denominator !== typed.rows.length || typed.rows.some((row) => !row.expected)) throw new Error(`${arm} manifest lacks the current valid analyzer contract`);
    const failureCounts: Record<string, number> = {};
    for (const row of typed.rows) if (row.failure !== null) failureCounts[row.failure] = (failureCounts[row.failure] ?? 0) + 1;
    const digest = createHash("sha256").update(jsonBytes(typed)).digest("hex");
    const expectedSummary: FinalizedAnalyzerSummary = { version: 1, contract_version: TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, result_version: TOOL_OUTCOME_ANALYZER_RESULT_VERSION, sha256: digest, infrastructure_valid: true, denominator: typed.rows.length, failure_counts: failureCounts };
    if (JSON.stringify(summary) !== JSON.stringify(expectedSummary) || typed.rows.length !== manifest.expected_trials) throw new Error(`${arm} analyzer summary does not match embedded rows and digest`);
    return { analysis: typed, summary: expectedSummary };
  };
  const controlAnalyzer = requireAnalyzerResult(control, "control");
  const candidateAnalyzer = requireAnalyzerResult(candidate, "candidate");
  if (typeof control.source_archive_sha256 !== "string" || control.source_archive_sha256 !== candidate.source_archive_sha256 || !/^[a-f0-9]{64}$/.test(control.source_archive_sha256)) throw new Error("comparison manifests must prove one identical source archive digest");
  const controlSource = cloneMap(control.runtime_source, "control runtime source");
  const candidateSource = cloneMap(candidate.runtime_source, "candidate runtime source");
  if (controlSource.mode !== "git_commit" || candidateSource.mode !== "git_commit" || controlSource.resolved_sha !== candidateSource.resolved_sha || typeof controlSource.resolved_sha !== "string" || !/^[a-f0-9]{40}$/.test(controlSource.resolved_sha)) throw new Error("comparison requires one exact resolved source commit");
  if (typeof control.profile_sha256 !== "string" || typeof candidate.profile_sha256 !== "string" || control.profile_sha256 === candidate.profile_sha256) throw new Error("comparison requires distinct control and candidate profile digests");
  const fields = ["model", "dataset", "task_names", "attempts", "concurrency", "disabled_tools", "timeout_multipliers", "resource_overrides"] as const;
  const fixedControls: JsonMap = {};
  for (const field of fields) {
    if (JSON.stringify(control[field]) !== JSON.stringify(candidate[field])) throw new Error(`comparison fixed control differs: ${field}`);
    fixedControls[field] = structuredClone(control[field]);
  }
  return { version: 2, sourceCommit: controlSource.resolved_sha, sourceArchiveSha256: control.source_archive_sha256, controlProfileSha256: control.profile_sha256, candidateProfileSha256: candidate.profile_sha256, controlAnalyzer, candidateAnalyzer, fixedControls };
}

async function main(): Promise<number> {
  const [action, ...args] = process.argv.slice(2);
  if (action === "prepare") {
    const prepared = await prepareTerminalBenchRun(args);
    console.log(prepared.preparationPlan);
    return 0;
  }
  if (action === "add-wheelhouse") {
    const [plan, wheelhouse] = args;
    if (plan === undefined || wheelhouse === undefined) throw new Error("add-wheelhouse requires plan and wheelhouse paths");
    await addVerifierWheelhouse(plan, wheelhouse);
    return 0;
  }
  if (action === "finalize") {
    const [manifest, trials, exitCode] = args;
    if (manifest === undefined || trials === undefined || exitCode === undefined) throw new Error("finalize requires manifest, trials directory, and Harbor exit code");
    const ledger = await finalizeTerminalBenchRun(manifest, trials, Number(exitCode));
    console.log(JSON.stringify(ledger));
    return ledger.exitCode;
  }
  if (action === "compare") {
    const [control, candidate] = args;
    if (!control || !candidate || args.length !== 2) throw new Error("compare requires finalized control and candidate manifests");
    console.log(JSON.stringify(await createTerminalBenchComparisonManifest(control, candidate), undefined, 2));
    return 0;
  }
  throw new Error("expected prepare, add-wheelhouse, finalize, or compare action");
}

if (import.meta.main) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
