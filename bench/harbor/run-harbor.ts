import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { reconcileDisclosureLedger, type DisclosureLedger } from "./disclosure-ledger.js";
import { analyzeToolOutcomes, TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, TOOL_OUTCOME_ANALYZER_RESULT_VERSION, type ToolOutcomeAnalysis } from "./analyze-tool-outcomes.js";
import { harborDisplayModel, resolveHarborConfig, type JsonMap, type ResolvedHarborConfig } from "./harbor-config.js";
import { harborBenchmark } from "./benchmarks.js";
import { appendRoundRun, requireRoundIdentity, roundPath, type RoundIdentity, type RoundRun, type UnlaunchedOutcome } from "./rounds.js";
import { command, harborPython } from "./harbor-process.js";
import { awaitHostedJob, decodeResolvedTasks, defaultBuildAgentPackage, defaultPublishAgentPackage, defaultValidateHostedConfig, hostedJobConfig, launchedJobId, localJobConfig, offlineAgentHosts, releaseTagFor, repositoryConfigPath, SECRET_VALUE_LIMIT, SNAPSHOT_SECRET, snapshotCommand, snapshotEnvironment, worstCaseJobSeconds, type AgentPackageBuild, type AgentPackagePublication, type ResolvedTask } from "./harbor-jobs.js";

const WHEELHOUSE_TARGET = "/opt/flywheel-verifier-wheelhouse";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");

interface SeedInspection { clean: boolean; revision: string; dirtyPaths?: string[] }
interface PrepareDependencies {
  cwd: string;
  now: () => Date;
  seed: () => string;
  inspectSeed: (cwd: string) => Promise<SeedInspection>;
  validateConfig: (path: string) => Promise<void>;
  versionProbe: () => Promise<string>;
  harborPython: () => string;
  /** Resolves every task name through Harbor's dataset resolution and refuses an unmatched name. */
  resolveTasks: (dataset: string, ref: string, taskNames: readonly string[]) => Promise<Record<string, ResolvedTask>>;
  releaseTagFor: (commit: string) => Promise<string | null>;
  buildAgentPackage: (commit: string, configPath: string, configSha256: string, answerKeyRule: boolean, releaseTag: string | null, output: string) => Promise<AgentPackageBuild>;
  publishAgentPackage: (directory: string, repository: string) => Promise<AgentPackagePublication>;
  validateHostedConfig: (path: string) => Promise<void>;
}

export interface PreparedHarborRun {
  artifactDirectory: string;
  generatedConfig: string;
  preparationPlan: string;
  manifest: string;
  harborCommand: string[];
  dryRun: boolean;
}
export interface HarborComparisonManifest {
  version: 2;
  sourceCommit: string;
  sourceArchiveSha256: string;
  controlProfileSha256: string;
  candidateProfileSha256: string;
  /** Null for an arm that ran without a Flywheel config. Unequal digests mean the arms ran different configs. */
  controlFlywheelConfigSha256: string | null;
  candidateFlywheelConfigSha256: string | null;
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

/** The run's Flywheel config as the manifest and the plan record it. */
interface FlywheelConfigRecord { path: string; sha256: string; chat_effort: string }

interface PreparationPlan {
  artifact_directory: string;
  generated_config: string;
  manifest: string;
  metadata: string;
  execution_mode: "local" | "hosted";
  source_commit: string;
  agent_package: AgentPackagePublication;
  snapshot_command: string[];
  /** The credential providers that the snapshot carries, and the keychain item of a Claude arm's token. */
  snapshot_providers: readonly string[];
  claude_token_keychain_item: string;
  worst_case_seconds: number;
  trials_directory: string;
  // Local Docker execution.
  harbor_command?: string[];
  download_command?: string[];
  /** Absent for a benchmark whose local run seals no verifier wheelhouse. */
  wheelhouse_command?: string[];
  prebuild?: boolean;
  /** The Harbor task cache directory of the benchmark's namespace, which holds each task's Dockerfile. */
  task_cache?: string;
  // Harbor Hub execution.
  launch_command?: string[];
  download_directory?: string;
  dataset: string;
  task_names: string[];
  concurrency: number;
  dry_run: boolean;
  auth_profile: string;
  flywheel_config: FlywheelConfigRecord;
  grade: string;
  warning: string;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function defaultSeedInspection(cwd: string): Promise<SeedInspection> {
  const [revision, status] = await Promise.all([
    command(["git", "rev-parse", "HEAD"], cwd).then((value) => value.trim()),
    command(["git", "status", "--porcelain", "--untracked-files=all"], cwd),
  ]);
  const dirtyPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3));
  return { clean: dirtyPaths.length === 0, revision, dirtyPaths };
}

async function defaultValidateConfig(path: string): Promise<void> {
  const source = "import json,sys\ntry:\n from harbor.models.job.config import JobConfig\nexcept ImportError:\n from harbor.models.job import JobConfig\ndata=json.load(open(sys.argv[1],encoding='utf-8'))\nJobConfig.model_validate(data)\n";
  await command([harborPython(), "-c", source, path], process.cwd());
}

async function defaultResolveTasks(dataset: string, ref: string, taskNames: readonly string[]): Promise<Record<string, ResolvedTask>> {
  const stdout = await command([harborPython(), "-I", resolve(import.meta.dir, "harbor_tasks.py"), dataset, ref, ...taskNames], process.cwd());
  const resolved = cloneMap(JSON.parse(stdout), "task resolution");
  return decodeResolvedTasks(resolved.tasks);
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

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, jsonBytes(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Proves that every run summary names the package's runtime archive digest,
 *  which the manifest recorded at build time. A trial that Harbor stopped at
 *  its agent timeout wrote no summary; the analyzer and the ledger judge it. */
async function requireOneSourceArchive(trialsDirectory: string, manifest: JsonMap): Promise<void> {
  const expected = manifest.source_archive_sha256;
  const entries = await readdir(trialsDirectory, { withFileTypes: true });
  const digests = (await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (entry) => {
    const path = join(trialsDirectory, entry.name, "agent", "flywheel-run-summary.json");
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) return [];
    const summary = cloneMap(JSON.parse(text), "trial summary");
    return [summary.source_archive_sha256];
  }))).flat();
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || digests.some((digest) => digest !== expected)) throw new Error("trials do not prove one source archive digest");
}

function defaultDependencies(overrides: Partial<PrepareDependencies>): PrepareDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    now: overrides.now ?? (() => new Date()),
    seed: overrides.seed ?? (() => crypto.randomUUID()),
    inspectSeed: overrides.inspectSeed ?? defaultSeedInspection,
    validateConfig: overrides.validateConfig ?? defaultValidateConfig,
    versionProbe: overrides.versionProbe ?? defaultVersionProbe,
    harborPython: overrides.harborPython ?? harborPython,
    resolveTasks: overrides.resolveTasks ?? defaultResolveTasks,
    releaseTagFor: overrides.releaseTagFor ?? ((commit) => releaseTagFor(commit)),
    buildAgentPackage: overrides.buildAgentPackage ?? defaultBuildAgentPackage,
    publishAgentPackage: overrides.publishAgentPackage ?? defaultPublishAgentPackage,
    validateHostedConfig: overrides.validateHostedConfig ?? defaultValidateHostedConfig,
  };
}

/** Prepares one run: resolves the command line and every task, builds and
 *  publishes the agent package of HEAD, and writes the generated Harbor
 *  config, the run manifest, the metadata, and the preparation plan into one
 *  artifact directory, which appears whole or not at all. */
export async function prepareHarborRun(args: string[], overrides: Partial<PrepareDependencies> = {}): Promise<PreparedHarborRun> {
  const dependencies = defaultDependencies(overrides);
  const config = await resolveHarborConfig(args, { cwd: dependencies.cwd });
  const seed = await dependencies.inspectSeed(dependencies.cwd);
  // The agent package holds only Git blobs of HEAD.
  const sourceCommit = seed.revision;
  const identity: RoundIdentity = { sourceCommit, arm: { path: config.flywheelConfig.path, sha256: config.flywheelConfig.sha256 }, model: config.model, effort: config.flywheelConfig.chatEffort };
  // Refused before the package is built and published, which costs time and a push.
  if (config.round !== undefined) await requireRoundIdentity(config.jobsDirectory, config.round.name, config.benchmark.id, identity);
  const tasks = await dependencies.resolveTasks(config.dataset, config.datasetRef, config.taskNames);
  const offlineTasks = Object.entries(tasks).filter(([, task]) => task.agent_network_mode !== "public").map(([name]) => name);
  const allowedHosts = offlineTasks.length === 0 ? [] : offlineAgentHosts(config);
  const effectiveGrade = config.grade;
  const warning = config.warning;
  const harborVersion = await dependencies.versionProbe().catch(() => "");
  const artifactDirectory = join(config.jobsDirectory, `${config.jobName}-${dependencies.now().toISOString().replaceAll(":", "-")}`);
  const stage = `${artifactDirectory}.${crypto.randomUUID()}.tmp`;
  const generatedPath = join(stage, "generated.json");
  const manifestPath = join(stage, "run_manifest.json");
  const metadataPath = join(stage, "metadata.yaml");
  const planPath = join(stage, "preparation-plan.json");
  const finalGeneratedPath = join(artifactDirectory, "generated.json");
  const finalManifestPath = join(artifactDirectory, "run_manifest.json");
  const finalMetadataPath = join(artifactDirectory, "metadata.yaml");
  const flywheelConfig: FlywheelConfigRecord = { path: config.flywheelConfig.path, sha256: config.flywheelConfig.sha256, chat_effort: config.flywheelConfig.chatEffort };
  const runtimeSource = { mode: "git_commit", requested_sha: sourceCommit, resolved_sha: sourceCommit };
  try {
    await mkdir(config.jobsDirectory, { recursive: true });
    await mkdir(stage, { mode: 0o700 });
    const packageDirectory = join(stage, "agent-package");
    await mkdir(packageDirectory, { mode: 0o700 });
    // Publication happens also for a dry run: Hub's free dry run validates
    // the published ref, and a local dry run proves the package builds.
    const releaseTag = await dependencies.releaseTagFor(sourceCommit);
    const build = await dependencies.buildAgentPackage(sourceCommit, repositoryConfigPath(config.flywheelConfig.absolutePath), config.flywheelConfig.sha256, config.benchmark.answerKeyRule, releaseTag, packageDirectory);
    const publication = await dependencies.publishAgentPackage(packageDirectory, config.agentPackage.agentRepository);
    const worstCaseSeconds = worstCaseJobSeconds(config, tasks);
    const execution = config.hosted === undefined
      ? localExecution(config, dependencies, publication, allowedHosts, finalGeneratedPath, join(artifactDirectory, "harbor-jobs"))
      : hostedExecution(config, publication, allowedHosts, finalGeneratedPath, join(artifactDirectory, "hub"));
    const manifest: JsonMap = {
      expected_rows: config.taskNames.flatMap((task) => Array.from({ length: config.attempts }, (_, index) => ({ task, attempt: index + 1 }))),
      command_expectation: { version: 1, executable_tool_names: [config.expectedInteraction.executableToolName], minimum_cardinality: 1 },
      expected_interaction_profile: config.expectedInteraction.profileId,
      version: 1,
      benchmark: config.benchmark.id,
      split: config.split ?? null,
      round: config.dryRun ? null : config.round?.name ?? null,
      state: config.dryRun ? "finalized" : "prepared",
      seed: dependencies.seed(),
      seed_provenance: { revision: seed.revision, clean: seed.clean, dirty_paths: seed.dirtyPaths ?? [] },
      harbor_binary: Bun.which("harbor") ?? "",
      harbor_version: harborVersion,
      exact_command: execution.command,
      expected_trials: config.expectedTrials,
      requested_tasks: config.taskNames,
      denominator: config.expectedTrials,
      auth_profile: config.authProfile,
      runtime_source: runtimeSource,
      profile_sha256: config.profileSha256,
      flywheel_config: flywheelConfig,
      source_archive_sha256: build.runtime_archive.sha256,
      agent_package: { ...publication, build_id: build.build_id, release_tag: build.flywheel_source.release_tag, benchmark_rules: build.benchmark_rules },
      agent_allowed_hosts: allowedHosts,
      worst_case_seconds: worstCaseSeconds,
      execution_contract: { project_root: "task_workspace", execution_cwd: "task_workspace", evidence_export: "store_analysis", persistent_processes: true },
      grade: effectiveGrade,
      warning: warning ?? "",
      model: config.model,
      dataset: config.dataset,
      dataset_ref: config.datasetRef,
      task_names: config.taskNames,
      attempts: config.attempts,
      concurrency: config.concurrency,
      methodology: { attempts_per_task: config.attempts, task_count: config.taskNames.length, concurrency: config.concurrency },
      timeout_multipliers: config.timeoutMultipliers,
      resource_overrides: config.resourceOverrides,
      outcome: config.dryRun ? "dry_run" : null,
      ledger_summary: null,
      analyzer_result: null,
      ...execution.manifest,
    };
    const plan: PreparationPlan = {
      artifact_directory: artifactDirectory,
      generated_config: finalGeneratedPath,
      manifest: finalManifestPath,
      metadata: finalMetadataPath,
      dataset: config.dataset,
      auth_profile: config.authProfile,
      flywheel_config: flywheelConfig,
      task_names: config.taskNames,
      concurrency: config.concurrency,
      dry_run: config.dryRun,
      grade: effectiveGrade,
      warning: warning ?? "",
      source_commit: sourceCommit,
      agent_package: publication,
      snapshot_command: snapshotCommand(config, worstCaseSeconds),
      snapshot_providers: config.flywheelConfig.credentialProviders,
      claude_token_keychain_item: config.agentPackage.claudeTokenKeychainItem,
      worst_case_seconds: worstCaseSeconds,
      ...execution.plan,
    };
    await Promise.all([
      writeFile(generatedPath, jsonBytes(execution.generated), { mode: 0o600 }),
      writeFile(manifestPath, jsonBytes(manifest), { mode: 0o600 }),
      writeFile(metadataPath, jsonBytes({ agent: { name: "flywheel", display_name: "Flywheel", url: "https://github.com/wsauret/flywheel", organization: { display_name: "Flywheel" } }, models: [{ name: harborDisplayModel(config.model), role: "primary" }], runtime_source: runtimeSource }), { mode: 0o600 }),
      writeFile(planPath, jsonBytes(plan), { mode: 0o600 }),
    ]);
    try {
      await (config.hosted === undefined ? dependencies.validateConfig : dependencies.validateHostedConfig)(generatedPath);
    } catch (error) {
      manifest.state = "refused";
      manifest.outcome = "configuration_refused";
      await writeFile(manifestPath, jsonBytes(manifest), { mode: 0o600 });
      await rename(stage, artifactDirectory);
      throw new Error(`generated Harbor config refused; grade=${effectiveGrade}; warning=${warning ?? "none"}; manifest=${finalManifestPath}; reason=${error instanceof Error ? error.message : String(error)}`);
    }
    await rename(stage, artifactDirectory);
    // Recorded at preparation, so a run that fails or is interrupted later is
    // still listed in its round; its manifest state tells how far it got.
    // A dry run measures nothing and joins no round.
    if (config.round !== undefined && !config.dryRun) {
      const run: RoundRun = { directory: artifactDirectory, purpose: config.round.purpose, ...(config.split === undefined ? {} : { split: config.split }) };
      await appendRoundRun(config.jobsDirectory, config.round.name, config.benchmark.id, run, identity);
      console.error(`round ${config.round.name}: ${roundPath(config.jobsDirectory, config.round.name)}`);
    }
    return { artifactDirectory, generatedConfig: finalGeneratedPath, preparationPlan: join(artifactDirectory, "preparation-plan.json"), manifest: finalManifestPath, harborCommand: execution.command, dryRun: config.dryRun };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** What one execution mode adds to the shared preparation: the config Harbor
 *  reads, the command that runs it, and the mode's manifest and plan fields. */
interface PreparedExecution { generated: JsonMap; command: string[]; manifest: JsonMap; plan: Pick<PreparationPlan, "execution_mode" | "trials_directory"> & Partial<PreparationPlan> }

/** Writes the local Docker job, whose Harbor jobs directory lies inside the
 *  run's own artifact directory, so no two runs share a Harbor job. */
function localExecution(config: ResolvedHarborConfig, dependencies: PrepareDependencies, publication: AgentPackagePublication, allowedHosts: readonly string[], finalGeneratedPath: string, harborJobsDirectory: string): PreparedExecution {
  const harborCommand = ["harbor", "run", "-c", finalGeneratedPath];
  const taskCache = resolve(process.env.HOME ?? dependencies.cwd, ".cache/harbor/tasks/packages", config.benchmark.taskNamespace);
  return {
    generated: localJobConfig(config, publication, allowedHosts, harborJobsDirectory),
    command: harborCommand,
    manifest: { execution_mode: "local" },
    plan: {
      execution_mode: "local",
      harbor_command: harborCommand,
      // Cache mode fills the content-addressed task cache that the wheelhouse
      // step reads. Harbor 0.21 defaults to export mode in the current directory.
      download_command: ["harbor", "download", config.dataset, "--cache"],
      ...(config.benchmark.localVerifierWheelhouse ? { wheelhouse_command: [dependencies.harborPython(), resolve(dependencies.cwd, "bench/harbor/verifier_wheelhouse.py"), "--dataset", config.dataset, "--task-namespace", config.benchmark.taskNamespace, "--task-cache", taskCache, ...config.taskNames.flatMap((name) => ["--task-name", name])] } : {}),
      prebuild: config.prebuild,
      task_cache: taskCache,
      trials_directory: join(harborJobsDirectory, config.jobName),
    },
  };
}

/** Writes the Hub job that runs the published package. */
function hostedExecution(config: ResolvedHarborConfig, publication: AgentPackagePublication, allowedHosts: readonly string[], finalGeneratedPath: string, downloadDirectory: string): PreparedExecution {
  if (Object.keys(config.resourceOverrides).length > 0) throw new Error("--hosted does not support resource overrides");
  const launchCommand = ["harbor", "run", "--launch", "-c", finalGeneratedPath, "--yes"];
  return {
    generated: hostedJobConfig(config, publication, allowedHosts),
    command: launchCommand,
    manifest: { execution_mode: "hosted", hosted_job_id: null },
    plan: {
      execution_mode: "hosted",
      launch_command: launchCommand,
      download_directory: downloadDirectory,
      trials_directory: join(downloadDirectory, config.jobName),
    },
  };
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

export async function finalizeHarborRun(manifestPath: string, trialsDirectory: string, harborExitCode: number): Promise<DisclosureLedger> {
  const manifest = cloneMap(JSON.parse(await readFile(manifestPath, "utf8")), "run manifest");
  if (typeof manifest.expected_trials !== "number") throw new Error("run manifest has no expected trial denominator");
  let ledger: DisclosureLedger;
  let analysis: ToolOutcomeAnalysis | undefined;
  try {
    await requireOneSourceArchive(trialsDirectory, manifest);
    analysis = await analyzeToolOutcomes(trialsDirectory, manifest);
    const taskNames = Array.isArray(manifest.requested_tasks) && manifest.requested_tasks.every((task) => typeof task === "string") ? manifest.requested_tasks : [];
    const attempts = typeof manifest.attempts === "number" ? manifest.attempts : 0;
    if (typeof manifest.benchmark !== "string") throw new Error("run manifest names no benchmark");
    const { verifierDownloadsFromGithub } = harborBenchmark(manifest.benchmark);
    ledger = await reconcileDisclosureLedger({ trialsDirectory, taskNames, attempts, harborExitCode, infrastructureValid: analysis.infrastructureValid, verifierDownloadsFromGithub });
    await atomicWrite(join(dirname(manifestPath), "disclosure-ledger.json"), ledger);
  } catch {
    const outcome = harborExitCode === 0 ? "trials_unverified" : "harness_nonzero_exit";
    ledger = { denominator: manifest.expected_trials, scoredTrials: 0, rewardDistribution: {}, exceptionHistogram: {}, taskPassRates: {}, totalCost: 0, costLowerBound: true, counts: { provider_refusal: 0, provider_infra: 0, verifier_infra: 0, cancelled: 0, cost_truncated: 0, genuine: 0, other: 0 }, outcome, exitCode: harborExitCode === 0 ? 1 : harborExitCode, reconciled: false, rows: [] };
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
  manifest.ledger_summary = { denominator: ledger.denominator, scored_trials: ledger.scoredTrials, reconciled: ledger.reconciled, counts: ledger.counts, total_cost: ledger.totalCost, cost_lower_bound: ledger.costLowerBound };
  await atomicWrite(manifestPath, manifest);
  return ledger;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} is not a string array`);
  return value;
}

/** Runs one Harbor command with the snapshot in its environment, prints its
 *  stdout, and returns that output with the exit code. */
async function runHarbor(argv: string[], env: Record<string, string | undefined>): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(argv, { cwd: REPOSITORY_ROOT, env, stdout: "pipe", stderr: "inherit", windowsHide: true });
  const output = await new Response(child.stdout).text();
  process.stdout.write(output);
  return { exitCode: await child.exited, output };
}

/** Exports the trial auth snapshot of a prepared run on this host and
 *  returns it. Its private stage is removed in every outcome, so the snapshot
 *  then lives only in this process and in the environment of the Harbor
 *  process that the caller starts. */
async function exportSnapshot(plan: JsonMap): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), "flywheel-auth-bundle-"));
  try {
    await chmod(stage, 0o700);
    if (typeof plan.claude_token_keychain_item !== "string") throw new Error("preparation plan lacks the Claude token keychain item");
    const exportEnvironment = await snapshotEnvironment(stringArray(plan.snapshot_providers, "plan snapshot_providers"), plan.claude_token_keychain_item);
    await command([...stringArray(plan.snapshot_command, "plan snapshot_command"), "--output", join(stage, "auth.json")], REPOSITORY_ROOT, exportEnvironment);
    return await readFile(join(stage, "auth.json"), "utf8");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** The host variables that a local Harbor run keeps. Every other variable,
 *  such as an ambient provider key, stays out of Harbor and so out of the
 *  trial: the snapshot is the trial's one credential. */
const LOCAL_HARBOR_VARIABLES = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_CACHE_HOME", "PIP_CACHE_DIR", "UV_CACHE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "TMPDIR", "TMP", "TEMP"];

/** Records that the run ended before Harbor ran any trial, so that its
 *  round no longer waits for it. */
async function refuseUnlaunched(manifestPath: string, outcome: UnlaunchedOutcome): Promise<void> {
  const manifest = cloneMap(JSON.parse(await readFile(manifestPath, "utf8")), "run manifest");
  await atomicWrite(manifestPath, { ...manifest, state: "refused", outcome });
}

/** The preparation plan of a run that a launcher action runs, with the paths every action needs. */
async function readRunPlan(planPath: string): Promise<JsonMap & { manifest: string; trials_directory: string }> {
  const plan = cloneMap(JSON.parse(await readFile(planPath, "utf8")), "preparation plan");
  const { manifest, trials_directory: trialsDirectory } = plan;
  if (typeof manifest !== "string" || typeof trialsDirectory !== "string") throw new Error("preparation plan lacks the manifest or the trial directory");
  return { ...plan, manifest, trials_directory: trialsDirectory };
}

/** Exports the snapshot of a run, or records the run as `snapshot_failed`
 *  and throws. A Hub run also refuses a snapshot above Hub's secret limit. */
async function runSnapshot(plan: JsonMap & { manifest: string }, limit?: number): Promise<string> {
  let snapshot: string;
  try {
    snapshot = await exportSnapshot(plan);
  } catch (error) {
    await refuseUnlaunched(plan.manifest, "snapshot_failed");
    throw error;
  }
  if (limit !== undefined && snapshot.length > limit) {
    await refuseUnlaunched(plan.manifest, "snapshot_failed");
    throw new Error(`the trial auth snapshot has ${snapshot.length} characters; Harbor Hub accepts at most ${limit}`);
  }
  return snapshot;
}

/** Runs a prepared local campaign whose Docker images, verifier wheelhouse,
 *  and generated config are ready. Harbor gets the snapshot only in its own
 *  environment, from which the snapshot overlay of the generated config
 *  hands it to each agent container. Then it finalizes the trials. */
async function runLocalHarbor(planPath: string): Promise<number> {
  const plan = await readRunPlan(planPath);
  const snapshot = await runSnapshot(plan);
  const environment: Record<string, string> = { [SNAPSHOT_SECRET]: snapshot };
  for (const name of LOCAL_HARBOR_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  const harbor = Bun.spawn(stringArray(plan.harbor_command, "plan harbor_command"), { cwd: REPOSITORY_ROOT, env: environment, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  const ledger = await finalizeHarborRun(plan.manifest, plan.trials_directory, await harbor.exited);
  console.log(JSON.stringify(ledger));
  return ledger.exitCode;
}

/** Runs one Hub command, and records a nonzero exit or a failed start as `outcome`. */
async function runHubCommand(argv: string[], environment: Record<string, string | undefined>, manifestPath: string, outcome: UnlaunchedOutcome): Promise<{ exitCode: number; output: string }> {
  const result = await runHarbor(argv, environment).catch(async (error: unknown) => {
    await refuseUnlaunched(manifestPath, outcome);
    throw error;
  });
  if (result.exitCode !== 0) await refuseUnlaunched(manifestPath, outcome);
  return result;
}

/** Runs a prepared hosted campaign. It exports the trial snapshot, then runs
 *  Hub's free dry run and stops on any problem. Only an executing plan then
 *  launches the job, records its id, and settles it. */
async function runHostedHarbor(planPath: string): Promise<number> {
  const plan = await readRunPlan(planPath);
  const launch = stringArray(plan.launch_command, "plan launch_command");
  const snapshot = await runSnapshot(plan, SECRET_VALUE_LIMIT);
  const environment = { ...process.env, [SNAPSHOT_SECRET]: snapshot };
  const dryRun = await runHubCommand([...launch, "--dry-run"], environment, plan.manifest, "hub_dry_run_refused");
  if (dryRun.exitCode !== 0 || plan.dry_run === true) return dryRun.exitCode;
  const launched = await runHubCommand(launch, environment, plan.manifest, "hub_launch_refused");
  if (launched.exitCode !== 0) return launched.exitCode;
  const jobId = launchedJobId(launched.output);
  const manifest = cloneMap(JSON.parse(await readFile(plan.manifest, "utf8")), "run manifest");
  await atomicWrite(plan.manifest, { ...manifest, hosted_job_id: jobId, state: "launched" });
  return settleHostedJob(plan, jobId);
}

/** Waits for a launched Hub job, downloads its trials, and finalizes them. A
 *  launch and a resume both end here. A failed status call, a deadline
 *  overrun, or a failed download throws and leaves the run `launched`, so
 *  `resume-hosted` can settle the job later. */
async function settleHostedJob(plan: JsonMap & { manifest: string; trials_directory: string }, jobId: string): Promise<number> {
  if (typeof plan.download_directory !== "string" || typeof plan.worst_case_seconds !== "number") throw new Error("preparation plan lacks the hosted download directory or job deadline");
  await awaitHostedJob(jobId, plan.worst_case_seconds);
  await command(["harbor", "hub", "job", "download", jobId, "-o", plan.download_directory], REPOSITORY_ROOT);
  const ledger = await finalizeHarborRun(plan.manifest, plan.trials_directory, 0);
  console.log(JSON.stringify(ledger));
  return ledger.exitCode;
}

/** Settles a hosted run whose launcher ended after the Hub launch, such as
 *  when the host slept or the terminal closed: it waits for the recorded
 *  job, downloads it, and finalizes it. It never launches a job. */
async function resumeHostedHarbor(artifactDirectory: string): Promise<number> {
  const plan = await readRunPlan(join(resolve(artifactDirectory), "preparation-plan.json"));
  const manifest = cloneMap(JSON.parse(await readFile(plan.manifest, "utf8")), "run manifest");
  if (manifest.state !== "launched" || typeof manifest.hosted_job_id !== "string") throw new Error(`${plan.manifest} is ${String(manifest.state)}, not a launched hosted run with a recorded job id`);
  return settleHostedJob(plan, manifest.hosted_job_id);
}

export async function createHarborComparisonManifest(
  controlManifestPath: string,
  candidateManifestPath: string,
): Promise<HarborComparisonManifest> {
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
  const flywheelConfigSha256 = (manifest: JsonMap): string | null => {
    const digest = object(manifest.flywheel_config)?.sha256;
    return typeof digest === "string" ? digest : null;
  };
  const fields = ["benchmark", "model", "dataset", "dataset_ref", "task_names", "attempts", "concurrency", "timeout_multipliers", "resource_overrides"] as const;
  const fixedControls: JsonMap = {};
  for (const field of fields) {
    if (JSON.stringify(control[field]) !== JSON.stringify(candidate[field])) throw new Error(`comparison fixed control differs: ${field}`);
    fixedControls[field] = structuredClone(control[field]);
  }
  return { version: 2, sourceCommit: controlSource.resolved_sha, sourceArchiveSha256: control.source_archive_sha256, controlProfileSha256: control.profile_sha256, candidateProfileSha256: candidate.profile_sha256, controlFlywheelConfigSha256: flywheelConfigSha256(control), candidateFlywheelConfigSha256: flywheelConfigSha256(candidate), controlAnalyzer, candidateAnalyzer, fixedControls };
}

async function main(): Promise<number> {
  const [action, ...args] = process.argv.slice(2);
  if (action === "prepare") {
    const prepared = await prepareHarborRun(args);
    console.log(prepared.preparationPlan);
    return 0;
  }
  if (action === "add-wheelhouse") {
    const [plan, wheelhouse] = args;
    if (plan === undefined || wheelhouse === undefined) throw new Error("add-wheelhouse requires plan and wheelhouse paths");
    await addVerifierWheelhouse(plan, wheelhouse);
    return 0;
  }
  if (action === "run-local") {
    const [plan] = args;
    if (plan === undefined || args.length !== 1) throw new Error("run-local requires a local preparation plan");
    return runLocalHarbor(plan);
  }
  if (action === "run-hosted") {
    const [plan] = args;
    if (plan === undefined || args.length !== 1) throw new Error("run-hosted requires a hosted preparation plan");
    return runHostedHarbor(plan);
  }
  if (action === "resume-hosted") {
    const [directory] = args;
    if (directory === undefined || args.length !== 1) throw new Error("resume-hosted requires the artifact directory of a launched hosted run");
    return resumeHostedHarbor(directory);
  }
  if (action === "compare") {
    const [control, candidate] = args;
    if (!control || !candidate || args.length !== 2) throw new Error("compare requires finalized control and candidate manifests");
    console.log(JSON.stringify(await createHarborComparisonManifest(control, candidate), undefined, 2));
    return 0;
  }
  throw new Error("expected prepare, add-wheelhouse, run-local, run-hosted, resume-hosted, or compare action");
}

if (import.meta.main) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
