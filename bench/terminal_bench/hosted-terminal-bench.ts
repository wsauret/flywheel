import { Schema } from "effect";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PUBLIC_REPO, publishedReleaseTags } from "../../scripts/release-repo.js";
import { command, harborPython } from "./harbor-process.js";
import { TRIAL_AUTH_PROFILE, type JsonMap, type ResolvedTerminalBenchConfig } from "./terminal-bench-config.js";

/** The job secret that carries the trial auth snapshot. Its name contains
 *  AUTH, so Harbor redacts its value from the logs it uploads. */
export const SNAPSHOT_SECRET = "FLYWHEEL_AUTH_SNAPSHOT";
/** The agent environment variable that hands the shim the profile digest it records. */
const PROFILE_SHA256_ENV = "FLYWHEEL_TB_PROFILE_SHA256";
/** Harbor Hub refuses a secret value longer than this many characters. */
export const SECRET_VALUE_LIMIT = 16_384;
/** Time a hosted job can wait for sandboxes and agent setup beyond its task
 *  timeouts. The snapshot's access tokens must stay valid for the whole job. */
const QUEUE_MARGIN_SECONDS = 3600;
const STATUS_INTERVAL_MS = 60_000;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const PACKAGE_SCRIPT = join(REPOSITORY_ROOT, "bench/terminal_bench/harbor_agent_package.py");

const TaskTimeoutsSchema = Schema.Struct({ agent_timeout_sec: Schema.Number, verifier_timeout_sec: Schema.Number, build_timeout_sec: Schema.Number });
/** One task's timeouts from its pinned task.toml, as harbor_tasks.py reports them. */
export type TaskTimeouts = typeof TaskTimeoutsSchema.Type;
/** The tasks of a resolution by name, as harbor_tasks.py reports them. */
export const decodeTaskTimeouts = Schema.decodeUnknownSync(Schema.Record(Schema.String, TaskTimeoutsSchema));

const AgentPackageBuildSchema = Schema.Struct({
  build_id: Schema.String,
  flywheel_source: Schema.Struct({ commit: Schema.String, version: Schema.String, release_tag: Schema.NullOr(Schema.String) }),
  runtime_archive: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  flywheel_config: Schema.Struct({ path: Schema.String, source_path: Schema.String, sha256: Schema.String }),
  store_analyzer: Schema.Struct({ path: Schema.String, source_path: Schema.String, sha256: Schema.String }),
});
/** The build record (BUILD.json) of one agent package. */
export type AgentPackageBuild = typeof AgentPackageBuildSchema.Type;

const AgentPackagePublicationSchema = Schema.Struct({ repository: Schema.String, ref: Schema.String, commit: Schema.String, branch: Schema.String, tag: Schema.NullOr(Schema.String) });
/** Where a package was published. `commit` is the arm identity that Hub pins. */
export type AgentPackagePublication = typeof AgentPackagePublicationSchema.Type;

/** Harbor's job status report; only its counts decide settlement. */
const decodeJobStatus = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** The longest a hosted job can run: every wave of trials at the slowest
 *  task's agent, verifier, and build timeouts, scaled by the largest timeout
 *  multiplier, plus the queueing margin. */
export function worstCaseJobSeconds(config: Pick<ResolvedTerminalBenchConfig, "expectedTrials" | "concurrency" | "timeoutMultipliers">, tasks: Readonly<Record<string, TaskTimeouts>>): number {
  const slowest = Math.max(...Object.values(tasks).map((task) => task.agent_timeout_sec + task.verifier_timeout_sec + task.build_timeout_sec));
  const multiplier = Math.max(1, ...Object.values(config.timeoutMultipliers).filter((value): value is number => typeof value === "number"));
  return Math.ceil(Math.ceil(config.expectedTrials / config.concurrency) * slowest * multiplier) + QUEUE_MARGIN_SECONDS;
}

/** The `git ls-remote --tags` listing of the public repository. */
async function publicRepositoryTags(): Promise<string> {
  return command(["git", "ls-remote", "--tags", `https://github.com/${PUBLIC_REPO}.git`], REPOSITORY_ROOT);
}

/** The published release tag that names exactly `commit`, or null. Only a
 *  `vX.Y.Z` tag that the public repository holds on `commit` and also lists
 *  as a release counts. Local tags are never read, so a local tag that
 *  borrows a release name on a trial commit is never a release. */
export async function releaseTagFor(commit: string, listPublished: () => Promise<readonly string[]> = publishedReleaseTags, listRemoteTags: () => Promise<string> = publicRepositoryTags): Promise<string | null> {
  const tagCommits = new Map<string, string>();
  for (const line of (await listRemoteTags()).split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(line);
    if (match === null) continue;
    const [, sha, tag, peeled] = match;
    // An annotated tag lists its tag object and then its peeled commit; a lightweight tag lists only its commit.
    if (peeled !== undefined || !tagCommits.has(tag!)) tagCommits.set(tag!, sha!);
  }
  // Several release tags can name one commit, as the public repository's first
  // commit carries every pre-public release; the newest of them names it.
  const candidates = [...tagCommits].filter(([, sha]) => sha === commit).map(([tag]) => tag).sort((left, right) => Bun.semver.order(right.slice(1), left.slice(1)));
  if (candidates.length === 0) return null;
  const published = new Set(await listPublished());
  return candidates.find((tag) => published.has(tag)) ?? null;
}

/** The arm config path relative to the repository root, the form in which the package builder reads its blob. */
export function repositoryConfigPath(absolutePath: string): string {
  const path = relative(REPOSITORY_ROOT, absolutePath);
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(`--hosted needs an arm config inside the repository: ${absolutePath}`);
  return path;
}

export async function defaultBuildAgentPackage(commit: string, configPath: string, configSha256: string, releaseTag: string | null, output: string): Promise<AgentPackageBuild> {
  const stdout = await command([harborPython(), PACKAGE_SCRIPT, "build", "--commit", commit, "--config-path", configPath, "--config-sha256", configSha256, ...(releaseTag === null ? [] : ["--release-tag", releaseTag]), "--output", output], REPOSITORY_ROOT);
  return Schema.decodeUnknownSync(AgentPackageBuildSchema)(JSON.parse(stdout));
}

export async function defaultPublishAgentPackage(directory: string, repository: string): Promise<AgentPackagePublication> {
  return Schema.decodeUnknownSync(AgentPackagePublicationSchema)(JSON.parse(await command([harborPython(), PACKAGE_SCRIPT, "publish", "--directory", directory, "--repository", repository], REPOSITORY_ROOT)));
}

export async function defaultValidateHostedConfig(path: string): Promise<void> {
  const source = "import json,sys\nfrom harbor.hosted.config import HostedJobConfig\nHostedJobConfig.model_validate(json.load(open(sys.argv[1],encoding='utf-8')))\n";
  await command([harborPython(), "-c", source, path], REPOSITORY_ROOT);
}

/** The Hub job config of a hosted run. The agent is the published package at
 *  its exact commit; its one credential is the snapshot job secret, which
 *  Harbor reads from the launcher's environment and delivers directly. */
export function hostedJobConfig(config: ResolvedTerminalBenchConfig, publication: AgentPackagePublication): JsonMap {
  if (config.hosted === undefined) throw new Error("hosted job config requires a hosted run");
  return {
    job_name: config.jobName,
    ...(config.hosted.organization === undefined ? {} : { organization: config.hosted.organization }),
    credential_mode: "direct",
    agents: [{
      name: "acp",
      source: { type: "github", repo: publication.repository, ref: publication.commit, path: ".", manifest: "harbor-agent.json" },
      secrets: [SNAPSHOT_SECRET],
      ...(config.profileSha256 === undefined ? {} : { env: { [PROFILE_SHA256_ENV]: config.profileSha256 } }),
    }],
    job_secrets: { [SNAPSHOT_SECRET]: { from_env: SNAPSHOT_SECRET } },
    datasets: [{ name: config.dataset, ...(config.datasetRef === undefined ? {} : { ref: config.datasetRef }), task_names: config.taskNames }],
    n_attempts: config.attempts,
    n_concurrent_trials: config.concurrency,
    ...config.timeoutMultipliers,
  };
}

/** The host command that exports the trial snapshot, without its `--output`
 *  path: the snapshot carries only the arm's enabled credential providers,
 *  under the trial profile id, with access tokens valid for `minValidSeconds`. */
export function snapshotCommand(config: ResolvedTerminalBenchConfig, minValidSeconds: number): string[] {
  const providers = config.flywheelConfig?.credentialProviders ?? [];
  return [
    "bun", "--conditions=browser", join(REPOSITORY_ROOT, "src/cli/index.ts"), "headless", "snapshot-auth",
    "--auth-profile", config.authProfile, "--as-profile", TRIAL_AUTH_PROFILE,
    ...providers.flatMap((provider) => ["--provider", provider]),
    "--min-valid-seconds", String(minValidSeconds),
  ];
}

/** The credential provider of Flywheel's Claude engine route, which takes the
 *  token that the person made with `claude setup-token` from TOKEN_VARIABLE. */
const CLAUDE_TOKEN_PROVIDER = "claude_agent_sdk";
const TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";

/** The environment of the one export process of `snapshotCommand`. When the
 *  arm enables the Claude engine route it adds the Claude token: from the
 *  macOS keychain item `keychainItem` when that holds one, else from the
 *  launcher's own CLAUDE_CODE_OAUTH_TOKEN. Throws, naming both sources and no
 *  token, when neither holds one. No other process receives the token. */
export async function snapshotEnvironment(providers: readonly string[], keychainItem: string, env: Record<string, string | undefined> = process.env, readKeychain: (item: string) => Promise<string | undefined> = macosKeychainSecret): Promise<Record<string, string | undefined>> {
  if (!providers.includes(CLAUDE_TOKEN_PROVIDER)) return env;
  const token = (await readKeychain(keychainItem)) ?? env[TOKEN_VARIABLE];
  if (token === undefined || token.length === 0) throw new Error(`the Claude arm needs the token that \`claude setup-token\` makes: store it in the macOS keychain item ${keychainItem} or set ${TOKEN_VARIABLE}`);
  return { ...env, [TOKEN_VARIABLE]: token };
}

/** The password of the macOS keychain item whose service is `item`, or
 *  undefined off macOS or when no such item exists. */
async function macosKeychainSecret(item: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const child = Bun.spawn(["security", "find-generic-password", "-s", item, "-w"], { stdout: "pipe", stderr: "ignore", windowsHide: true });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return exitCode === 0 && stdout.trim().length > 0 ? stdout.trim() : undefined;
}

/** The Hub job id that `harbor run --launch` printed. */
export function launchedJobId(output: string): string {
  const match = /Launched job\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(output);
  if (match?.[1] === undefined) throw new Error("harbor run --launch printed no job id");
  return match[1];
}

/** Waits for a hosted job to settle through Harbor's own status command,
 *  checking once a minute and giving up after `deadlineSeconds`. */
export async function awaitHostedJob(jobId: string, deadlineSeconds: number): Promise<JsonMap> {
  const deadline = Date.now() + deadlineSeconds * 1000;
  while (true) {
    const status = decodeJobStatus(JSON.parse(await command(["harbor", "hub", "job", "status", jobId, "--json"], REPOSITORY_ROOT)));
    console.error(`hosted job ${jobId}: ${String(status.status)} pending=${String(status.pending)} running=${String(status.running)} completed=${String(status.completed)} failed=${String(status.failed)} canceled=${String(status.canceled)}`);
    if (status.pending === 0 && status.running === 0 && typeof status.total === "number" && status.total > 0) return status;
    if (Date.now() >= deadline) throw new Error(`hosted job ${jobId} did not settle within ${deadlineSeconds} seconds`);
    await Bun.sleep(STATUS_INTERVAL_MS);
  }
}
