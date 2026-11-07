import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { createHash } from "node:crypto";
import { errorMessage } from "../../src/infra/error-message.js";
import { decodeCanonicalConfigText } from "../../src/orchestration/config/loader.js";
import { detectModelFamily } from "../../src/infra/llm/model-family.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE, resolveModelInteractionProfile, type ModelInteractionProfileId } from "../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { exposedToolName, type ToolDeclaration } from "../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { bashModule } from "../../src/orchestration/modules/bash.js";
import { CREDENTIAL_PROVIDER_MODULES } from "../../src/orchestration/credential-provider-modules.js";

const DEFAULT_DATASET = "terminal-bench/terminal-bench-2-1";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
/** The auth profile id a trial with a Flywheel config runs under. The trial's
 *  credentials are exported under this id, so the config's `[profiles.<id>]`
 *  tables name no host profile. */
export const TRIAL_AUTH_PROFILE = "benchmark";
/** The macOS keychain item (service name) that holds a Claude arm's token by default. */
const DEFAULT_CLAUDE_TOKEN_KEYCHAIN_ITEM = "flywheel-claude-oauth-token";

type CampaignGrade = "leaderboard_valid" | "local_low_k" | "debug_only";
export type JsonMap = Record<string, unknown>;

/** The interaction profile a run must record in its request audits, and the
 *  shell tool that profile exposes for the command expectation. */
interface TerminalBenchInteraction {
  profileId: ModelInteractionProfileId;
  executableToolName: string;
}

export interface ResolvedTerminalBenchConfig {
  /** The profile's Harbor settings of a local run, without its agent and environment. */
  harborConfig: JsonMap;
  /** The profile's `override_*` settings of the agent; the launcher owns the rest of the agent entry. */
  agentOverrides: JsonMap;
  /** The profile's Harbor environment settings of a local run. */
  environment: JsonMap;
  authProfile: string;
  expectedInteraction: TerminalBenchInteraction;
  profileSha256?: string;
  flywheelConfig: TerminalBenchFlywheelConfig;
  model: string;
  dataset: string;
  runtimeSourceCommit?: string;
  /** The dataset ref the profile pins, such as `sha256:<digest>`. */
  datasetRef?: string;
  agentPackage: TerminalBenchAgentPackage;
  /** Set when the run executes on Harbor Hub instead of local Docker. */
  hosted?: TerminalBenchHosting;
  taskNames: string[];
  attempts: number;
  concurrency: number;
  expectedTrials: number;
  dryRun: boolean;
  prebuild: boolean;
  grade: CampaignGrade;
  warning?: string;
  jobName: string;
  jobsDirectory: string;
  timeoutMultiplier: number;
  environmentBuildTimeoutMultiplier: number;
  timeoutMultipliers: JsonMap;
  resourceOverrides: JsonMap;
}

/** The Flywheel config a trial installs as its `flywheel.toml`, validated on
 *  the host. It is the one source of the chat model and effort of its run. */
interface TerminalBenchFlywheelConfig {
  /** The path as the profile names it, relative to the repository root. */
  path: string;
  absolutePath: string;
  sha256: string;
  chatEffort: string;
  /** The credential provider ids of the provider modules the config leaves
   *  enabled. A trial's snapshot carries exactly these, because a trial
   *  refuses a snapshot that holds a credential its config disables. */
  credentialProviders: readonly string[];
}

/** Where every run publishes its agent package, which Harbor fetches at its
 *  exact commit, and where a Claude arm's snapshot export finds its token.
 *  The repository has no default: each run names it. */
interface TerminalBenchAgentPackage {
  agentRepository: string;
  /** The macOS keychain item from which the snapshot export of a Claude arm reads the Claude token. */
  claudeTokenKeychainItem: string;
}

/** What only a Harbor Hub run adds. */
interface TerminalBenchHosting {
  /** The Hub organization that owns the job; without one, the job is the signed-in user's own. */
  organization?: string;
}

interface ResolveOptions { cwd: string; env?: Record<string, string | undefined> }
interface HeadlessProfile { readonly runtimeSourceCommit?: string; readonly flywheelConfig: string }

function map(value: unknown, label: string): JsonMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...value };
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function multiplier(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be positive`);
  return parsed;
}

function next(args: string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${args[index]} requires a value`);
  return value;
}

function taskNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error("dataset task_names must be strings");
  return value.map((item) => item.includes("/") ? item : `terminal-bench/${item}`);
}

function requiredName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a non-empty name`);
  return value;
}

/** Reads the profile's `headless` table. Every run needs a Flywheel config:
 *  the agent package ships it, and it is the one source of the chat model,
 *  the enabled modules, and so the tools of the trial. */
function headlessProfile(value: unknown): HeadlessProfile {
  const headless = value === undefined ? {} : map(value, "headless");
  const unknownKeys = Object.keys(headless).filter((key) => key !== "runtime_source_commit" && key !== "flywheel_config");
  if (unknownKeys.length > 0) throw new Error(`headless contains unknown keys: ${unknownKeys.join(", ")}`);
  const runtimeSourceCommit = headless.runtime_source_commit;
  if (runtimeSourceCommit !== undefined && (typeof runtimeSourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(runtimeSourceCommit))) throw new Error("headless.runtime_source_commit must be an exact lowercase 40-hex commit SHA");
  if (headless.flywheel_config === undefined) throw new Error("the profile must name headless.flywheel_config: the agent package ships the arm config");
  return { flywheelConfig: requiredName(headless.flywheel_config, "headless.flywheel_config"), ...(typeof runtimeSourceCommit === "string" ? { runtimeSourceCommit } : {}) };
}

/** Reads and validates a profile's Flywheel config with Flywheel's own config
 *  decoder. Any error or warning refuses the run, so a trial never starts on a
 *  config that Flywheel would ignore in part. The host environment is not
 *  overlaid: the trial reads the file alone. */
async function readFlywheelConfig(path: string): Promise<{ config: TerminalBenchFlywheelConfig; model: string }> {
  const absolutePath = resolve(REPOSITORY_ROOT, path);
  const bytes = await readFile(absolutePath).catch((error: unknown) => refuseFlywheelConfig(path, errorMessage(error)));
  const decoded = (() => {
    try {
      return decodeCanonicalConfigText(bytes.toString("utf8"), {}, undefined, absolutePath);
    } catch (error) {
      return refuseFlywheelConfig(path, errorMessage(error));
    }
  })();
  const problems = [...(decoded.moduleError === undefined ? [] : [decoded.moduleError]), ...decoded.warnings];
  if (problems.length > 0) refuseFlywheelConfig(path, problems.join("; "));
  const chat = decoded.config.profiles[TRIAL_AUTH_PROFILE]?.roles.chat;
  if (chat?.model === undefined || chat.effort === undefined) return refuseFlywheelConfig(path, `it must pin model and effort in [profiles.${TRIAL_AUTH_PROFILE}.roles.chat]`);
  const enabled = new Set(decoded.config.modules);
  const credentialProviders = CREDENTIAL_PROVIDER_MODULES.filter((module) => enabled.has(module.id))
    .flatMap((module) => module.contributions.flatMap((contribution) => contribution.domain === "providers" || contribution.domain === "webAuthProviders" ? [contribution.id] : []));
  return { config: { path, absolutePath, sha256: createHash("sha256").update(bytes).digest("hex"), chatEffort: chat.effort, credentialProviders }, model: chat.model };
}

function refuseFlywheelConfig(path: string, reason: string): never {
  throw new Error(`headless.flywheel_config ${path} is not a valid Flywheel config: ${reason}`);
}

function terminalBenchAgentPackage(agentRepository: string | undefined, claudeTokenKeychainItem: string): TerminalBenchAgentPackage {
  if (agentRepository === undefined || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(agentRepository)) throw new Error("every run requires --agent-repo <owner/repo> or FLYWHEEL_TB_AGENT_REPO: Harbor fetches the agent package from it");
  return { agentRepository, claudeTokenKeychainItem: requiredName(claudeTokenKeychainItem, "--claude-token-keychain-item") };
}

/** Validates the Hub selection. Hub builds its own sandboxes, so a local
 *  image prebuild has no meaning there. */
function terminalBenchHosting(organization: string | undefined, prebuild: boolean): TerminalBenchHosting {
  if (prebuild) throw new Error("--hosted does not support --prebuild");
  return organization === undefined ? {} : { organization: requiredName(organization, "--organization or FLYWHEEL_TB_HUB_ORG") };
}

export function terminalBenchDisplayModel(model: string): string {
  return `flywheel/${model}`;
}

/** The provider-visible name of the shell tool, read from the shell module's own registration. */
function shellToolName(): string {
  for (const contribution of bashModule.contributions) {
    if (contribution.domain !== "tools") continue;
    const registrations: ToolDeclaration["registrations"] = contribution.value.declaration.registrations;
    for (const [id, registration] of Object.entries(registrations)) return exposedToolName(id, registration);
  }
  throw new Error("no shell tool is registered");
}

/** Resolves the profile the product selects for a run from the model and its
 *  family. A model whose family is unknown gets the default profile. */
function terminalBenchInteraction(model: string): TerminalBenchInteraction {
  const family = detectModelFamily(model);
  const profile = family === null ? DEFAULT_MODEL_INTERACTION_PROFILE : resolveModelInteractionProfile(model, family);
  return { profileId: profile.id, executableToolName: shellToolName() };
}


export async function resolveTerminalBenchConfig(args: string[], options: ResolveOptions = { cwd: process.cwd() }): Promise<ResolvedTerminalBenchConfig> {
  let profilePath: string | undefined;
  let cliAuthProfile: string | undefined;
  let cliDataset: string | undefined;
  let cliTasks: string[] | undefined;
  let cliAttempts: number | undefined;
  let cliConcurrency: number | undefined;
  let cliJobName: string | undefined;
  let cliJobsDirectory: string | undefined;
  let cliTimeout: number | undefined;
  let cliBuildTimeout: number | undefined;
  let cliResources: JsonMap | undefined;
  let dryRun = true;
  let prebuild = false;
  let allowLowK = false;
  let allowTimeoutMultipliers = false;
  let allowResourceOverrides = false;
  let hosted = false;
  const env = options.env ?? process.env;
  let cliAgentRepository = env.FLYWHEEL_TB_AGENT_REPO;
  let cliOrganization = env.FLYWHEEL_TB_HUB_ORG;
  let claudeTokenKeychainItem = DEFAULT_CLAUDE_TOKEN_KEYCHAIN_ITEM;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    switch (flag) {
      case "--config": case "-c": profilePath = resolve(options.cwd, next(args, index)); index += 1; break;
      case "--auth-profile": cliAuthProfile = requiredName(next(args, index), "--auth-profile"); index += 1; break;
      case "--dataset": cliDataset = next(args, index); index += 1; break;
      case "--task-names": cliTasks = next(args, index).split(/\s+/).filter(Boolean); index += 1; break;
      case "--attempts": cliAttempts = positiveInteger(next(args, index), flag); index += 1; break;
      case "--concurrency": cliConcurrency = positiveInteger(next(args, index), flag); index += 1; break;
      case "--job-name": cliJobName = next(args, index); index += 1; break;
      case "--jobs-dir": cliJobsDirectory = next(args, index); index += 1; break;
      case "--timeout-multiplier": cliTimeout = multiplier(next(args, index), flag); index += 1; break;
      case "--environment-build-timeout-multiplier": cliBuildTimeout = multiplier(next(args, index), flag); index += 1; break;
      case "--resource-overrides": cliResources = map(JSON.parse(next(args, index)), flag); index += 1; break;
      case "--execute": dryRun = false; break;
      case "--dry-run": dryRun = true; break;
      case "--prebuild": prebuild = true; break;
      case "--skip-prebuild": prebuild = false; break;
      case "--allow-low-k": allowLowK = true; break;
      case "--allow-timeout-multipliers": allowTimeoutMultipliers = true; break;
      case "--allow-resource-overrides": allowResourceOverrides = true; break;
      case "--hosted": hosted = true; break;
      case "--agent-repo": cliAgentRepository = next(args, index); index += 1; break;
      case "--organization": cliOrganization = next(args, index); index += 1; break;
      case "--claude-token-keychain-item": claudeTokenKeychainItem = next(args, index); index += 1; break;
      default: throw new Error(`unsupported Terminal-Bench option: ${flag}`);
    }
  }

  let harborConfig: JsonMap = {};
  let profileSha256: string | undefined;
  if (profilePath !== undefined) {
    const profileBytes = await readFile(profilePath);
    profileSha256 = createHash("sha256").update(profileBytes).digest("hex");
    harborConfig = map(load(profileBytes.toString("utf8")), "Harbor profile");
  }
  const headless = headlessProfile(harborConfig.headless);
  delete harborConfig.headless;
  const { config: flywheelConfig, model } = await readFlywheelConfig(headless.flywheelConfig);
  const agentPackage = terminalBenchAgentPackage(cliAgentRepository, claudeTokenKeychainItem);
  const hosting = hosted ? terminalBenchHosting(cliOrganization, prebuild) : undefined;
  const profileAgents = harborConfig.agents === undefined ? [] : harborConfig.agents;
  if (!Array.isArray(profileAgents) || profileAgents.length > 1) throw new Error("Terminal-Bench config must select at most one agent");
  const profileAgent = profileAgents[0] === undefined ? {} : map(profileAgents[0], "agent");
  const launcherOwned = Object.keys(profileAgent).filter((key) => !key.startsWith("override_"));
  if (launcherOwned.length > 0) throw new Error(`agent ${launcherOwned.join(", ")} is launcher-owned: the agent is the arm's package, and its config pins the model`);
  const profileDatasets = harborConfig.datasets === undefined ? [] : harborConfig.datasets;
  if (!Array.isArray(profileDatasets) || profileDatasets.length > 1) throw new Error("Terminal-Bench config must select at most one dataset");
  const profileDataset = profileDatasets[0] === undefined ? {} : map(profileDatasets[0], "dataset");
  const profileEnvironment = map(harborConfig.environment ?? {}, "environment");
  if (profileEnvironment.mounts !== undefined) throw new Error("environment.mounts is launcher-owned");
  if (profileEnvironment.env !== undefined) throw new Error("environment.env is launcher-owned");

  if (harborConfig.auth_profile !== undefined) throw new Error("auth_profile is launcher-only; use --auth-profile");
  const authProfile = requiredName(cliAuthProfile, "--auth-profile");
  const dataset = cliDataset ?? (typeof profileDataset.name === "string" ? profileDataset.name : DEFAULT_DATASET);
  const selectedTasks = (cliTasks ?? taskNames(profileDataset.task_names)).map((item) => item.includes("/") ? item : `terminal-bench/${item}`);
  const attempts = cliAttempts ?? (typeof harborConfig.n_attempts === "number" ? harborConfig.n_attempts : 5);
  const concurrency = cliConcurrency ?? (typeof harborConfig.n_concurrent_trials === "number" ? harborConfig.n_concurrent_trials : 4);
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error("attempts and concurrency must be positive integers");
  if (attempts < 5 && !allowLowK) throw new Error("attempts below 5 require --allow-low-k");
  if (selectedTasks.length === 0) throw new Error("an explicit bounded --task-names selection is required for an exact denominator");

  const timeoutMultiplier = cliTimeout ?? (harborConfig.timeout_multiplier === undefined ? 1 : multiplier(String(harborConfig.timeout_multiplier), "timeout_multiplier"));
  const environmentBuildTimeoutMultiplier = cliBuildTimeout ?? (harborConfig.environment_build_timeout_multiplier === undefined ? 1 : multiplier(String(harborConfig.environment_build_timeout_multiplier), "environment_build_timeout_multiplier"));
  const timeoutMultipliers: JsonMap = {
    ...Object.fromEntries(Object.entries(harborConfig).filter(([key]) => key.endsWith("_timeout_multiplier"))),
    timeout_multiplier: timeoutMultiplier,
    environment_build_timeout_multiplier: environmentBuildTimeoutMultiplier,
  };
  const hasNonstandardTimeout = Object.values(timeoutMultipliers).some((value) => value !== undefined && value !== null && Number(value) !== 1);
  if (hasNonstandardTimeout && !allowTimeoutMultipliers) throw new Error("non-1 timeout multipliers require --allow-timeout-multipliers");

  const profileResources = profileEnvironment.resources === undefined ? {} : map(profileEnvironment.resources, "environment.resources");
  const resourceOverrides: JsonMap = { ...(cliResources ?? profileResources) };
  const profileVerifier = map(harborConfig.verifier ?? {}, "verifier");
  if (profileVerifier.env !== undefined) throw new Error("verifier.env is launcher-owned");
  for (const [owner, record] of [["agent", profileAgent], ["environment", profileEnvironment], ["verifier", profileVerifier]] as const) {
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith("override_") && value !== undefined && value !== null) resourceOverrides[`${owner}.${key}`] = value;
    }
  }
  if (Object.keys(resourceOverrides).length > 0 && !allowResourceOverrides) throw new Error("resource overrides require --allow-resource-overrides");
  profileEnvironment.resources = cliResources ?? profileResources;

  const admittedNonSubmission = attempts < 5 || hasNonstandardTimeout || Object.keys(resourceOverrides).length > 0;
  const grade: CampaignGrade = attempts === 1 ? "debug_only" : admittedNonSubmission ? "local_low_k" : "leaderboard_valid";
  const warning = grade === "leaderboard_valid" ? undefined : `${grade} campaign is not leaderboard-valid`;
  const jobModel = model.replace(/[^A-Za-z0-9._-]+/g, "-");
  const jobName = cliJobName ?? (typeof harborConfig.job_name === "string" ? harborConfig.job_name : `flywheel-${jobModel}`);
  const jobsDirectory = resolve(options.cwd, cliJobsDirectory ?? (typeof harborConfig.jobs_dir === "string" ? harborConfig.jobs_dir : "jobs"));
  const datasetConfig = { ...profileDataset, name: dataset, task_names: selectedTasks };
  delete harborConfig.timeout_multiplier;
  delete harborConfig.environment_build_timeout_multiplier;
  delete harborConfig.agents;
  delete harborConfig.environment;
  harborConfig = { ...harborConfig, datasets: [datasetConfig], n_attempts: attempts, n_concurrent_trials: concurrency, jobs_dir: jobsDirectory, job_name: jobName };
  return { harborConfig, agentOverrides: profileAgent, environment: profileEnvironment, expectedInteraction: terminalBenchInteraction(model), profileSha256, flywheelConfig, runtimeSourceCommit: headless.runtimeSourceCommit, ...(typeof profileDataset.ref === "string" ? { datasetRef: profileDataset.ref } : {}), agentPackage, ...(hosting ? { hosted: hosting } : {}), authProfile, model, dataset, taskNames: selectedTasks, attempts, concurrency, expectedTrials: selectedTasks.length * attempts, dryRun, prebuild, grade, warning, jobName, jobsDirectory, timeoutMultiplier, environmentBuildTimeoutMultiplier, timeoutMultipliers, resourceOverrides };
}
