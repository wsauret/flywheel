import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { errorMessage } from "../../src/infra/error-message.js";
import { decodeCanonicalConfigText } from "../../src/orchestration/config/loader.js";
import { detectModelFamily } from "../../src/infra/llm/model-family.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE, resolveModelInteractionProfile, type ModelInteractionProfileId } from "../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { exposedToolName, type ToolDeclaration } from "../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { bashModule } from "../../src/orchestration/modules/bash/module.js";
import { CREDENTIAL_PROVIDER_MODULES } from "../../src/orchestration/credential-provider-modules.js";
import type { AccessProviderDefinition } from "../../src/infra/llm/access-provider.js";
import { ALL_TASKS, harborBenchmark, type HarborBenchmark } from "./benchmarks.js";
import { command, harborPython } from "./harbor-process.js";
import { roundPath, type RoundRunPurpose } from "./rounds.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
/** The auth profile id a trial with a Flywheel config runs under. The trial's
 *  credentials are exported under this id, so the config's `[profiles.<id>]`
 *  tables name no host profile. */
export const TRIAL_AUTH_PROFILE = "benchmark";
/** The macOS keychain item (service name) that holds a Claude arm's token by default. */
const DEFAULT_CLAUDE_TOKEN_KEYCHAIN_ITEM = "flywheel-claude-oauth-token";
const DEFAULT_CONCURRENCY = 4;

/** The job settings of the harness leaderboard, which a board-matched run
 *  keeps: three attempts per task, and agent setup and environment builds at
 *  three times Harbor's timeouts, because setup time is not agent time. */
const BOARD_ATTEMPTS = 3;
const BOARD_TIMEOUT_MULTIPLIERS = { timeout_multiplier: 1, agent_setup_timeout_multiplier: 3, environment_build_timeout_multiplier: 3 } as const;
type TimeoutMultiplier = keyof typeof BOARD_TIMEOUT_MULTIPLIERS;
const TIMEOUT_FLAGS: Readonly<Record<string, TimeoutMultiplier>> = {
  "--timeout-multiplier": "timeout_multiplier",
  "--agent-setup-timeout-multiplier": "agent_setup_timeout_multiplier",
  "--environment-build-timeout-multiplier": "environment_build_timeout_multiplier",
};

/** The trial resources a local run can override, each of which Harbor's
 *  environment config takes as `override_<key>`. */
const RESOURCE_OVERRIDE_KEYS: readonly string[] = ["cpus", "memory_mb", "storage_mb", "gpus", "tpu"];

/** `leaderboard_valid`: the board's job settings. `local_low_k`: admitted
 *  fewer attempts, other timeouts, or resource overrides. `debug_only`: one attempt. */
type CampaignGrade = "leaderboard_valid" | "local_low_k" | "debug_only";
export type JsonMap = Record<string, unknown>;

/** The interaction profile a run must record in its request audits, and the
 *  shell tool that profile exposes for the command expectation. */
interface HarborInteraction {
  profileId: ModelInteractionProfileId;
  executableToolName: string;
}

/** The round a run joins, and why it belongs there. */
interface HarborRoundSelection {
  name: string;
  purpose: RoundRunPurpose;
}

export interface ResolvedHarborConfig {
  benchmark: HarborBenchmark;
  /** The split a measurement run selects; absent for an explicit task list. */
  split?: string;
  round?: HarborRoundSelection;
  authProfile: string;
  expectedInteraction: HarborInteraction;
  /** The digest of everything that states the run (benchmark, arm, tasks,
   *  attempts, concurrency, timeouts, resources), which the trial records. */
  profileSha256: string;
  flywheelConfig: HarborFlywheelConfig;
  model: string;
  dataset: string;
  /** The dataset ref that the benchmark pins, such as `sha256:<digest>`. */
  datasetRef: string;
  agentPackage: HarborAgentPackage;
  /** Set when the run executes on Harbor Hub instead of local Docker. */
  hosted?: HarborHosting;
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
  timeoutMultipliers: Record<TimeoutMultiplier, number>;
  resourceOverrides: JsonMap;
}

/** The Flywheel config a trial installs as its `flywheel.toml`, validated on
 *  the host. It is the one source of the chat model and effort of its run. */
interface HarborFlywheelConfig {
  /** The path as the launcher names it, relative to the repository root. */
  path: string;
  absolutePath: string;
  sha256: string;
  chatEffort: string;
  /** The credential provider ids of the provider modules the config leaves
   *  enabled. A trial's snapshot carries exactly these, because a trial
   *  refuses a snapshot that holds a credential its config disables. */
  credentialProviders: readonly string[];
  /** The API hosts that the enabled providers declare, and the enabled
   *  providers that declare none, so an offline agent phase can allow them. */
  providerHosts: { readonly declared: readonly string[]; readonly undeclared: readonly string[] };
}

/** Where every run publishes its agent package, which Harbor fetches at its
 *  exact commit, and where a Claude arm's snapshot export finds its token.
 *  The repository has no default: each run names it. */
interface HarborAgentPackage {
  agentRepository: string;
  /** The macOS keychain item from which the snapshot export of a Claude arm reads the Claude token. */
  claudeTokenKeychainItem: string;
}

/** What only a Harbor Hub run adds. */
interface HarborHosting {
  /** The Hub organization that owns the job; without one, the job is the signed-in user's own. */
  organization?: string;
}

interface ResolveOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Lists every task of a pinned dataset; Harbor's own listing by default. */
  listTasks?: (dataset: string, ref: string) => Promise<readonly string[]>;
}

async function harborDatasetTasks(dataset: string, ref: string): Promise<readonly string[]> {
  const listed = JSON.parse(await command([harborPython(), "-I", resolve(import.meta.dir, "harbor_tasks.py"), "--list", dataset, ref], process.cwd()));
  if (!Array.isArray(listed?.tasks) || !listed.tasks.every((task: unknown) => typeof task === "string")) throw new Error(`Harbor listed no tasks for ${dataset}`);
  return listed.tasks;
}

function map(value: unknown, label: string): JsonMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...value };
}

function resourceOverridesOf(value: unknown, flag: string): JsonMap {
  const overrides = map(value, flag);
  const unknown = Object.keys(overrides).filter((key) => !RESOURCE_OVERRIDE_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`${flag} supports only ${RESOURCE_OVERRIDE_KEYS.join(", ")}; unknown: ${unknown.join(", ")}`);
  return overrides;
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

function requiredName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a non-empty name`);
  return value;
}

/** Reads and validates the arm's Flywheel config with Flywheel's own config
 *  decoder. Any error or warning refuses the run, so a trial never starts on a
 *  config that Flywheel would ignore in part. The host environment is not
 *  overlaid: the trial reads the file alone. */
async function readFlywheelConfig(path: string): Promise<{ config: HarborFlywheelConfig; model: string }> {
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
  const credentialProviders: string[] = [];
  const declared: string[] = [];
  const undeclared: string[] = [];
  for (const module of CREDENTIAL_PROVIDER_MODULES) {
    if (!enabled.has(module.id)) continue;
    for (const contribution of module.contributions) {
      if (contribution.domain !== "providers" && contribution.domain !== "webAuthProviders") continue;
      credentialProviders.push(contribution.id);
      const definition: AccessProviderDefinition | undefined = contribution.domain === "providers" ? contribution.value.definition : undefined;
      if (definition?.apiHosts === undefined) undeclared.push(contribution.id);
      else declared.push(...definition.apiHosts);
    }
  }
  const config: HarborFlywheelConfig = { path, absolutePath, sha256: createHash("sha256").update(bytes).digest("hex"), chatEffort: chat.effort, credentialProviders, providerHosts: { declared, undeclared } };
  return { config, model: chat.model };
}

function refuseFlywheelConfig(path: string, reason: string): never {
  throw new Error(`--arm ${path} is not a valid Flywheel config: ${reason}`);
}

function harborAgentPackage(agentRepository: string | undefined, claudeTokenKeychainItem: string): HarborAgentPackage {
  if (agentRepository === undefined || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(agentRepository)) throw new Error("every run requires --agent-repo <owner/repo> or FLYWHEEL_HARBOR_AGENT_REPO: Harbor fetches the agent package from it");
  return { agentRepository, claudeTokenKeychainItem: requiredName(claudeTokenKeychainItem, "--claude-token-keychain-item") };
}

/** Validates the Hub selection. Hub builds its own sandboxes, so a local
 *  image prebuild has no meaning there. */
function harborHosting(organization: string | undefined, prebuild: boolean): HarborHosting {
  if (prebuild) throw new Error("--hosted does not support --prebuild");
  return organization === undefined ? {} : { organization: requiredName(organization, "--organization or FLYWHEEL_HARBOR_HUB_ORG") };
}

/** The tasks a run selects: a named split of the benchmark, an explicit list
 *  in which a bare name takes the benchmark's task namespace, or, with
 *  neither, every task of the pinned dataset except the benchmark's
 *  exclusions. An exclusion that the dataset does not hold refuses the run,
 *  because the run would then not be the board's whole benchmark. */
async function selectedTasks(benchmark: HarborBenchmark, split: string | undefined, taskList: string[] | undefined, listTasks: NonNullable<ResolveOptions["listTasks"]>): Promise<string[]> {
  if (split !== undefined && taskList !== undefined) throw new Error("select the tasks with at most one of --split <name> and --task-names <a,b>; give neither to run every task");
  const namespaced = (name: string): string => name.includes("/") ? name : `${benchmark.taskNamespace}/${name}`;
  if (split === undefined && taskList === undefined) {
    const listed = await listTasks(benchmark.dataset.name, benchmark.dataset.ref);
    const excluded = new Set(benchmark.excluded.map(({ task }) => namespaced(task)));
    const missing = [...excluded].filter((task) => !listed.includes(task));
    if (missing.length > 0) throw new Error(`${benchmark.dataset.name} holds no excluded task ${missing.join(", ")}; correct the exclusions of ${benchmark.id}`);
    return listed.filter((task) => !excluded.has(task));
  }
  const names = split === undefined ? taskList! : Object.hasOwn(benchmark.splits, split) ? benchmark.splits[split] : undefined;
  if (names === undefined) {
    const splits = Object.keys(benchmark.splits);
    throw new Error(`${benchmark.id} has no split ${split}; its splits: ${splits.length === 0 ? "none" : splits.join(", ")}; give no --split to run every task`);
  }
  if (names.length === 0) throw new Error("an explicit bounded --task-names selection is required for an exact denominator");
  return names.map(namespaced);
}

export function harborDisplayModel(model: string): string {
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
function harborInteraction(model: string): HarborInteraction {
  const family = detectModelFamily(model);
  const profile = family === null ? DEFAULT_MODEL_INTERACTION_PROFILE : resolveModelInteractionProfile(model, family);
  return { profileId: profile.id, executableToolName: shellToolName() };
}

/** Resolves the launcher's command line into one run. The benchmark, the arm
 *  config, the task selection, and the attempts state the run; the defaults
 *  are the harness leaderboard's job settings, and every departure from them
 *  needs its own admission flag and lowers the grade. */
export async function resolveHarborConfig(args: string[], options: ResolveOptions = { cwd: process.cwd() }): Promise<ResolvedHarborConfig> {
  let benchmarkId: string | undefined;
  let armPath: string | undefined;
  let split: string | undefined;
  let taskList: string[] | undefined;
  let roundName: string | undefined;
  let cliAuthProfile: string | undefined;
  let attempts = BOARD_ATTEMPTS;
  let concurrency = DEFAULT_CONCURRENCY;
  let cliJobName: string | undefined;
  let cliJobsDirectory: string | undefined;
  const timeoutMultipliers: Record<TimeoutMultiplier, number> = { ...BOARD_TIMEOUT_MULTIPLIERS };
  let resourceOverrides: JsonMap = {};
  let dryRun = true;
  let prebuild = false;
  let allowLowK = false;
  let allowTimeoutMultipliers = false;
  let allowResourceOverrides = false;
  let hosted = false;
  const env = options.env ?? process.env;
  let cliAgentRepository = env.FLYWHEEL_HARBOR_AGENT_REPO;
  let cliOrganization = env.FLYWHEEL_HARBOR_HUB_ORG;
  let claudeTokenKeychainItem = DEFAULT_CLAUDE_TOKEN_KEYCHAIN_ITEM;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    const timeout = TIMEOUT_FLAGS[flag];
    if (timeout !== undefined) {
      timeoutMultipliers[timeout] = multiplier(next(args, index), flag);
      index += 1;
      continue;
    }
    switch (flag) {
      case "--benchmark": benchmarkId = next(args, index); index += 1; break;
      case "--arm": armPath = next(args, index); index += 1; break;
      case "--split": split = next(args, index); index += 1; break;
      case "--task-names": taskList = next(args, index).split(/[\s,]+/).filter(Boolean); index += 1; break;
      case "--round": roundName = next(args, index); index += 1; break;
      case "--auth-profile": cliAuthProfile = requiredName(next(args, index), "--auth-profile"); index += 1; break;
      case "--attempts": attempts = positiveInteger(next(args, index), flag); index += 1; break;
      case "--concurrency": concurrency = positiveInteger(next(args, index), flag); index += 1; break;
      case "--job-name": cliJobName = next(args, index); index += 1; break;
      case "--jobs-dir": cliJobsDirectory = next(args, index); index += 1; break;
      case "--resource-overrides": resourceOverrides = resourceOverridesOf(JSON.parse(next(args, index)), flag); index += 1; break;
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
      default: throw new Error(`unsupported Harbor launcher option: ${flag}`);
    }
  }

  if (benchmarkId === undefined) throw new Error("every run requires --benchmark <id>");
  const benchmark = harborBenchmark(benchmarkId);
  if (armPath === undefined) throw new Error("every run requires --arm <Flywheel config>: the agent package ships the arm config");
  const { config: flywheelConfig, model } = await readFlywheelConfig(armPath);
  const agentPackage = harborAgentPackage(cliAgentRepository, claudeTokenKeychainItem);
  const hosting = hosted ? harborHosting(cliOrganization, prebuild) : undefined;
  const authProfile = requiredName(cliAuthProfile, "--auth-profile");
  const taskNames = await selectedTasks(benchmark, split, taskList, options.listTasks ?? harborDatasetTasks);
  // A run of every task measures the reserved split that names the whole benchmark.
  const measured = taskList === undefined ? split ?? ALL_TASKS : undefined;
  const jobsDirectory = resolve(options.cwd, cliJobsDirectory ?? "jobs");
  // A bad round name refuses the run before any artifact exists.
  if (roundName !== undefined) roundPath(jobsDirectory, roundName);

  if (attempts < BOARD_ATTEMPTS && !allowLowK) throw new Error(`attempts below ${BOARD_ATTEMPTS} require --allow-low-k`);
  const hasNonstandardTimeout = Object.values(TIMEOUT_FLAGS).some((key) => timeoutMultipliers[key] !== BOARD_TIMEOUT_MULTIPLIERS[key]);
  if (hasNonstandardTimeout && !allowTimeoutMultipliers) throw new Error("timeout multipliers other than the board's require --allow-timeout-multipliers");
  const hasResourceOverrides = Object.keys(resourceOverrides).length > 0;
  if (hasResourceOverrides && !allowResourceOverrides) throw new Error("resource overrides require --allow-resource-overrides");
  const grade: CampaignGrade = attempts === 1 ? "debug_only" : attempts < BOARD_ATTEMPTS || hasNonstandardTimeout || hasResourceOverrides ? "local_low_k" : "leaderboard_valid";
  const warning = grade === "leaderboard_valid" ? undefined : `${grade} campaign is not leaderboard-valid`;
  const jobName = cliJobName ?? `flywheel-${benchmark.id}-${model}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  const profileSha256 = createHash("sha256").update(JSON.stringify({ benchmark: benchmark.id, dataset: benchmark.dataset, arm: { path: flywheelConfig.path, sha256: flywheelConfig.sha256 }, taskNames, attempts, concurrency, timeoutMultipliers, resourceOverrides })).digest("hex");
  return {
    benchmark,
    ...(measured === undefined ? {} : { split: measured }),
    ...(roundName === undefined ? {} : { round: { name: roundName, purpose: measured === undefined ? "rerun" : "measure" } }),
    authProfile, expectedInteraction: harborInteraction(model), profileSha256, flywheelConfig, model,
    dataset: benchmark.dataset.name, datasetRef: benchmark.dataset.ref, agentPackage,
    ...(hosting ? { hosted: hosting } : {}),
    taskNames, attempts, concurrency, expectedTrials: taskNames.length * attempts, dryRun, prebuild, grade, ...(warning === undefined ? {} : { warning }),
    jobName, jobsDirectory, timeoutMultipliers, resourceOverrides,
  };
}
