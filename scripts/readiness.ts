/** Run the non-publishing deployment-readiness authority for this host. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { dockerRuntimeCommand, readinessPlan, RELEASE_LOGIN_VOLUME, releaseLoginContainerCommand, releaseLoginStatusContainerCommand, type LinuxClaudeLive } from "./readiness-plan.js";
import { engineBump, FRESHNESS_BLOCKED_EXIT, LIVE_AUTH_PROFILE_UNSET, liveAuthProfile, type EngineBump } from "./claude-engine-release.js";
import { parseReleaseLoginStatus, RELEASE_LOGIN_SETTING, WINDOWS_HOST_SETTING, WINDOWS_RELEASE_LOGIN_FOLDER } from "./readiness-login.js";
import { selectStartupDirectories } from "../src/infra/directory-authorities.js";
import { buildExecutable } from "../src/infra/update/build-identity.js";
import { CLAUDE_AGENT_SDK_LOGIN_COMMAND } from "../src/orchestration/modules/provider-claude-agent-sdk/names.js";

type Status = "pass" | "fail" | "blocked" | "skip";
export interface Check { readonly name: string; readonly status: Status; readonly detail: string }
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
/** Variables that one command gets over this process's environment. */
export interface CommandEnvironment { readonly [name: string]: string }
export interface ReadinessDependencies {
  readonly exists: (path: string) => boolean;
  readonly which: (name: string) => string | undefined;
  /** Runs `command` with this process's environment and the variables of `env` over it. */
  readonly run: (command: readonly string[], env?: CommandEnvironment) => CommandResult;
  /** The file's text, or undefined when it cannot be read. */
  readonly readText: (path: string) => string | undefined;
  readonly log: (message: string) => void;
}

const LIVE_QUALIFICATION = "Claude engine live qualification";
const LIVE_LOGIN = "Claude engine live login";
/** The live tier that an engine bump owes: only the Claude engine's live file (scripts/test-integration.ts). */
const LIVE_TIER = "test:integration:claude-engine";

const TOKENIZER_MANIFEST = "crates/tokenizer/tokenizer-prebuilt.json";

/** The manifest as it is read: named fields this script does not model, plus
 *  the compiled bytes it deliberately drops. */
interface TokenizerManifest {
  readonly [field: string]: unknown;
}

/** The manifest without its compiled bytes: the crate source, pinned
 *  toolchain, fixture inventory, and module ABI that every host reproduces. */
function tokenizerIdentity(manifest: string | undefined): string | undefined {
  if (manifest === undefined || manifest.trim() === "") return undefined;
  try {
    const parsed: TokenizerManifest = JSON.parse(manifest);
    const { artifact: _artifact, ...identity } = parsed;
    return JSON.stringify(identity);
  } catch {
    return undefined;
  }
}

/** Why the committed tokenizer no longer matches the source it is built from,
 *  or undefined when it still does. */
export function tokenizerIdentityDrift(committed: string, rebuilt: string | undefined): string | undefined {
  const before = tokenizerIdentity(committed);
  if (before === undefined) return `${TOKENIZER_MANIFEST} could not be read from HEAD`;
  const after = tokenizerIdentity(rebuilt);
  if (after === undefined) return `the rebuilt ${TOKENIZER_MANIFEST} could not be read`;
  return before === after ? undefined : `the committed tokenizer predates its source; rebuild it and commit ${TOKENIZER_MANIFEST} with the artifact`;
}

/** The bound on one command, or undefined for none. Only a hermetic Docker probe, one with no network, is bounded
 *  here. Every other command is a repository script that owns its own duration budgets, hang guards, and failure
 *  report, and an outer deadline would discard that report: the Windows integration tier runs longer than any fixed
 *  bound kept it, and the live Claude engine tier in a Linux container is that same integration script. */
export function readinessCommandTimeout(command: readonly string[], dockerPath: string | undefined): number | undefined {
  return command[0] === dockerPath && command[1] === "run" && command.includes("--network=none") ? 180_000 : undefined;
}
export interface ReadinessOptions {
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly quick: boolean;
  readonly bunExecutable: string;
  readonly bunVersion: string;
  readonly version: string;
  /** The home of this host's account, whose live auth profile the live tier reads without a release login home. */
  readonly accountHome: string;
  /** The auth profile that `LIVE_AUTH_PROFILE_SETTING` names, whose Claude logins the live tier runs on, or undefined
   *  when the setting is unset. */
  readonly liveAuthProfile: string | undefined;
  /** The release login home that `RELEASE_LOGIN_SETTING` names. Only the live Claude engine tier reads it. */
  readonly releaseLoginHome: string | undefined;
}
export interface ReadinessOutcome { readonly exitCode: 0 | 1; readonly checks: readonly Check[] }

function dockerFailureDetail(result: CommandResult): string {
  const diagnostic = `${result.stderr}\n${result.stdout}`.trim() || `docker info exited ${result.exitCode}`;
  return /cannot connect to (?:the )?docker daemon|is the docker daemon running|docker\.sock.*(?:no such file|connection refused)/i.test(diagnostic)
    ? `${diagnostic}; start Docker Desktop`
    : diagnostic;
}

/** Whether HEAD pins another Agent SDK than the last release tag, from the lockfiles that git holds for both, or why
 *  that cannot be read. */
function pinnedEngineBump(run: ReadinessDependencies["run"]): EngineBump | Error {
  const describe = run(["git", "describe", "--tags", "--abbrev=0", "--match", "v*"]);
  const tag = describe.exitCode === 0 ? describe.stdout.trim() : undefined;
  try {
    return engineBump(run(["git", "show", "HEAD:bun.lock"]).stdout, tag === undefined ? undefined : { tag, lockText: run(["git", "show", `${tag}:bun.lock`]).stdout });
  } catch (error) {
    return new Error(`the pinned Agent SDK could not be read from the lockfiles: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Where a login check looked, as a person reads it, and the command that adds the login there. */
interface LoginLocation {
  readonly where: string;
  readonly remedy: string;
}

/** The location of this host's live tier login in the auth profile `profile`. A release login home on Windows is
 *  logged in to from the release machine, which reaches the Windows machine over SSH, and the helper logs in to one
 *  folder of the real profile, which the setting must name. */
function hostLoginLocation(options: ReadinessOptions, profile: string): LoginLocation {
  if (options.releaseLoginHome === undefined) return { where: `the account home ${options.accountHome}`, remedy: `\`FLYWHEEL_AUTH_PROFILE=${profile} ${CLAUDE_AGENT_SDK_LOGIN_COMMAND}\`` };
  return {
    where: `the release login home ${options.releaseLoginHome}`,
    remedy: options.platform === "win32"
      ? `\`bun run readiness:login windows\` (run it on the release machine, with ${WINDOWS_HOST_SETTING} naming the SSH host of this machine); it logs in to %LOCALAPPDATA%\\${WINDOWS_RELEASE_LOGIN_FOLDER} of the real profile, so ${RELEASE_LOGIN_SETTING} must name that folder`
      : `\`bun run readiness:login --in-home ${options.releaseLoginHome}\``,
  };
}

/** Where the live tier still runs after its logins were checked: on this host, and in a Linux container through the
 *  Docker CLI that answered the Linux login check. */
interface LiveTiers {
  readonly host: boolean;
  readonly linux: { readonly docker: string; readonly live: LinuxClaudeLive; readonly profile: string } | undefined;
}

const NO_LIVE_TIER: LiveTiers = { host: false, linux: undefined };
const LINUX_LOGIN_LOCATION: LoginLocation = { where: `the Docker volume ${RELEASE_LOGIN_VOLUME}`, remedy: "`bun run readiness:login linux`" };

/** Own the ordered readiness sequence and classify every required result. */
export function runReadiness(options: ReadinessOptions, dependencies: ReadinessDependencies): ReadinessOutcome {
  const checks: Check[] = [];
  const plan = readinessPlan(options.platform, options.arch, options.quick, { tmux: dependencies.which("tmux") !== undefined });
  const dist = join(options.root, "dist");
  const harness = join(options.root, "scripts", "readiness-package-smoke.ts");
  const bun = options.bunExecutable;
  const record = (name: string, status: Status, detail = "") => {
    checks.push({ name, status, detail });
    dependencies.log(`readiness: ${status.padEnd(7)} ${name}${detail ? ` (${detail})` : ""}`);
  };
  const run = (name: string, command: readonly string[], env?: CommandEnvironment) => {
    const result = dependencies.run(command, env);
    if (result.exitCode === 0) { record(name, "pass"); return true; }
    // A test runner names its failures on stdout and its exit on stderr, so a
    // report that keeps one stream loses the name.
    record(name, "fail", `${result.stderr}\n${result.stdout}`.trim() || `exit ${result.exitCode}`);
    return false;
  };
  const withDocker = (command: readonly string[], docker: string) => command.map((part, index) => index === 0 ? docker : part);
  /** Records what one login status read found, and whether the live tier still runs on that login. A missing login
   *  blocks the tier here, before the long gates. */
  const loginReady = (prefix: string, location: LoginLocation, profile: string, bump: EngineBump, result: CommandResult, unanswered: (result: CommandResult) => string): boolean => {
    const token = result.exitCode === 0 ? parseReleaseLoginStatus(result.stdout) : undefined;
    if (token === undefined) {
      record(`${prefix}${LIVE_QUALIFICATION}`, "blocked", `${bump.detail}; the login check of ${location.where} did not answer: ${unanswered(result)}`);
      return false;
    }
    switch (token.kind) {
      case "absent":
        record(`${prefix}${LIVE_QUALIFICATION}`, "blocked", `${bump.detail}; ${location.where} holds no Claude login with a stored token in the auth profile "${profile}": run ${location.remedy}`);
        return false;
      case "present":
        record(`${prefix}${LIVE_LOGIN}`, "pass", `${location.where} holds a Claude login in the auth profile "${profile}", with its token in ${token.store === "file" ? "the credentials file" : "the macOS keychain"}`);
        return true;
      case "unchecked":
        record(`${prefix}${LIVE_LOGIN}`, "skip", `${location.where}: its token was not checked, because ${token.reason}; the live tier decides`);
        return true;
    }
  };
  /** On an engine bump, settles the live tier's logins and returns where the tier still runs. */
  const liveLogins = (): LiveTiers => {
    const bump = pinnedEngineBump(dependencies.run);
    if (bump instanceof Error) { record(LIVE_QUALIFICATION, "fail", bump.message); return NO_LIVE_TIER; }
    if (!bump.bumped) { record(LIVE_QUALIFICATION, "skip", bump.detail); return NO_LIVE_TIER; }
    const profile = options.liveAuthProfile;
    if (profile === undefined) { record(LIVE_QUALIFICATION, "blocked", `${bump.detail}; ${LIVE_AUTH_PROFILE_UNSET}`); return NO_LIVE_TIER; }
    // The status read and the host's live tier inherit the setting from this process; a container is given it.
    const status = dependencies.run([bun, "run", "scripts/readiness-login.ts", "--status", options.releaseLoginHome ?? options.accountHome]);
    const host = loginReady("", hostLoginLocation(options, profile), profile, bump, status, (result) => `${result.stderr}\n${result.stdout}`.trim() || `exit ${result.exitCode}`);
    const live = plan.linuxClaudeLive;
    if (live === undefined) return { host, linux: undefined };
    const prefix = `${live.target} `;
    const docker = dependencies.which("docker");
    if (!docker) {
      record(`${prefix}${LIVE_QUALIFICATION}`, "blocked", `${bump.detail}; Docker CLI is unavailable; install Docker Desktop`);
      return { host, linux: undefined };
    }
    const linuxStatus = dependencies.run(withDocker(releaseLoginStatusContainerCommand({ dockerPlatform: live.dockerPlatform, root: options.root, bunVersion: options.bunVersion, liveAuthProfile: profile }), docker));
    return { host, linux: loginReady(prefix, LINUX_LOGIN_LOCATION, profile, bump, linuxStatus, dockerFailureDetail) ? { docker, live, profile } : undefined };
  };
  /** Runs the live tier in a Linux container on the release login volume. It needs no build of this run, so it runs
   *  beside the host's live tier, before any later stop of the pass can drop its row. The container installs the
   *  candidate's tracked files for Linux: a copy of the checkout would carry the Mac's dependencies and its ignored
   *  project state. The tar lives in a temporary folder of its own, which is removed when the container is done. */
  const runLinuxLive = ({ docker, live, profile }: NonNullable<LiveTiers["linux"]>) => {
    const name = `${live.target} ${LIVE_QUALIFICATION}`;
    const diagnostic = dependencies.run([docker, "info"]);
    if (diagnostic.exitCode !== 0) { record(name, "blocked", dockerFailureDetail(diagnostic)); return; }
    const scratch = mkdtempSync(join(tmpdir(), "flywheel-readiness-candidate-"));
    try {
      const candidate = join(scratch, "candidate.tar");
      const archived = dependencies.run(["git", "archive", "--format=tar", `--output=${candidate}`, "HEAD"]);
      if (archived.exitCode !== 0) record(name, "fail", `the candidate archive was not written: ${`${archived.stderr}\n${archived.stdout}`.trim() || `exit ${archived.exitCode}`}`);
      else run(name, withDocker(releaseLoginContainerCommand({ dockerPlatform: live.dockerPlatform, bunVersion: options.bunVersion, candidate, liveAuthProfile: profile, step: "live" }), docker));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const finish = (): ReadinessOutcome => {
    dependencies.log("\nreadiness: summary");
    for (const check of checks) dependencies.log(`  ${check.status.padEnd(7)} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
    return { exitCode: checks.some(({ status }) => status === "fail" || status === "blocked") ? 1 : 0, checks };
  };

  const tree = dependencies.run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
  const cleanTree = tree.exitCode === 0 && tree.stdout.trim() === "";
  if (tree.exitCode !== 0) record("clean worktree", "fail", tree.stderr || tree.stdout);
  else if (!cleanTree) record("clean worktree", "fail", tree.stdout.trim());
  else record("clean worktree", "pass");
  const commitContract = run("commit contract", [bun, "run", "check:commits", "--upstream", "--head", "HEAD"]);
  if (!cleanTree || !commitContract) return finish();
  // The live tier's logins are read before the long gates, so a missing login is known in seconds.
  const live = options.quick ? NO_LIVE_TIER : liveLogins();
  run("dependencies", [bun, "install", "--frozen-lockfile", "--dry-run"]);
  const freshness = dependencies.run([bun, "run", "check:claude-engine"]);
  // The check states its verdict on stdout; `bun run` echoes the command on stderr.
  const freshnessReport = (freshness.stdout.trim() === "" ? freshness.stderr : freshness.stdout).split("\n").map((line) => line.replace(/^claude engine: /u, "").trim()).filter((line) => line !== "").join("; ");
  record("Claude engine freshness", freshness.exitCode === 0 ? "pass" : freshness.exitCode === FRESHNESS_BLOCKED_EXIT ? "blocked" : "fail", freshnessReport || `exit ${freshness.exitCode}`);
  run("lint", [bun, "run", "lint"]);
  run("boundaries", [bun, "run", "check:boundaries"]);
  run("tracked ripgrep prebuilts", [bun, "run", "scripts/build-native-addon.ts", "--crate=ripgrep", "--verify"]);
  run("unit suite", [bun, "run", "test"]);
  if (options.quick) {
    record("integration suite", "skip", "--quick omits heavyweight and artifact evidence");
    record("release builds", "skip", "--quick omits heavyweight and artifact evidence");
  } else {
    // The no-api suite holds the engine's fake-host tier. A release that ships a new engine also owes the live tier,
    // on this host's Claude login (scripts/claude-engine-release.ts). Only the live tier reads the release login home.
    run("integration suite", [bun, "run", "test:integration:no-api"]);
    if (live.host) run(LIVE_QUALIFICATION, [bun, "run", LIVE_TIER], options.releaseLoginHome === undefined ? undefined : { HOME: options.releaseLoginHome });
    if (live.linux !== undefined) runLinuxLive(live.linux);
    if (!plan.host) record("host release target", "blocked", `${options.platform}-${options.arch} is not in the release target matrix`);
    const tokenizer = dependencies.run([bun, "run", "build:tokenizer"]);
    if (tokenizer.exitCode !== 0) {
      const diagnostic = tokenizer.stderr || tokenizer.stdout || `exit ${tokenizer.exitCode}`;
      const missingPinnedTarget = /(?:target|toolchain).*(?:unavailable|not installed)|can't find crate for [`']core|wasm32-wasip1.*(?:missing|unavailable|not installed)/i.test(diagnostic);
      record("tokenizer rebuild", missingPinnedTarget ? "blocked" : "fail", missingPinnedTarget ? `unavailable rebuild prerequisite: ${diagnostic}` : diagnostic);
      return finish();
    }
    record("tokenizer rebuild", "pass");
    // Identity, not bytes. The manifest pins the crate source, the pinned
    // toolchain, the fixture inventory, and the module ABI separately from the
    // compiled bytes, and a rebuild must reproduce that identity on every host.
    // It cannot reproduce the bytes everywhere: rustc records each panic
    // location's relative source path with the host's own separator, and the
    // linker then orders the resulting string table differently, so two hosts
    // compile one source into two byte strings of equal length. Byte equality
    // is a property of the host that committed the asset. Staleness is a
    // property of the repository, and only staleness is a readiness failure.
    const drift = tokenizerIdentityDrift(
      dependencies.run(["git", "show", `HEAD:${TOKENIZER_MANIFEST}`]).stdout,
      dependencies.readText(join(options.root, TOKENIZER_MANIFEST)),
    );
    if (drift !== undefined) {
      record("committed tokenizer matches its source", "fail", drift);
      return finish();
    }
    record("committed tokenizer matches its source", "pass");
    // Every archive carries the one committed universal asset, so the rebuild
    // above is evidence and never a write.
    if (!run("restore the committed tokenizer", ["git", "checkout", "--", dirname(TOKENIZER_MANIFEST)])) return finish();
    const rebuiltTree = dependencies.run(["git", "status", "--porcelain=v1", "--untracked-files=all"]);
    if (rebuiltTree.exitCode !== 0) {
      record("clean worktree after tokenizer rebuild", "fail", rebuiltTree.stderr || rebuiltTree.stdout);
      return finish();
    }
    if (rebuiltTree.stdout.trim() !== "") {
      record("clean worktree after tokenizer rebuild", "fail", rebuiltTree.stdout.trim());
      return finish();
    }
    record("clean worktree after tokenizer rebuild", "pass");
    if (!run("offline tokenizer verification", [bun, "run", "build:tokenizer", "--verify"])) return finish();
    const built = new Set<string>();
    for (const build of plan.builds) if (run(`build ${build.target} (compilation evidence)`, [bun, ...build.command.slice(1)])) built.add(build.target);
    if (plan.host) {
      const archive = resolve(dist, plan.host.archive);
      if (!built.has(plan.host.target) || !dependencies.exists(archive)) record("host archive", "blocked", `${archive} was not built successfully in this run`);
      else {
        const stage = join(dist, `flywheel-${plan.host.target}`);
        const nativeDir = join(stage, "build", "native", plan.host.target);
        const binary = join(stage, "build", buildExecutable(options.platform));
        run("freshly staged host ripgrep addon", [bun, "run", harness, "--addon", join(nativeDir, `flywheel-ripgrep.${plan.host.target}.node`), "--target", plan.host.target]);
        run("file edit planners", [bun, "run", harness, "--planners", "--target", plan.host.target]);
        run("production composition", [bun, "run", "scripts/verify-production-composition.ts", "--binary", binary]);
        if (plan.performance === "required") run("performance gate", [bun, "run", "test:perf", "--archive", archive]);
        run("host package runtime", [bun, "run", harness, "--archive", archive, "--target", plan.host.target, "--expected-version", options.version]);
      }
    }
    if (plan.linuxRuntime.length > 0) {
      const docker = dependencies.which("docker");
      const containerChecks = plan.linuxRuntime.map((runtime) => `${runtime.target} ${runtime.evidence}`);
      if (!docker) for (const name of containerChecks) record(name, "blocked", "Docker CLI is unavailable; install Docker Desktop");
      else {
        const diagnostic = dependencies.run([docker, "info"]);
        if (diagnostic.exitCode !== 0) for (const name of containerChecks) record(name, "blocked", dockerFailureDetail(diagnostic));
        else {
          for (const runtime of plan.linuxRuntime) {
            const archive = resolve(dist, runtime.archive);
            if (!built.has(runtime.target) || !dependencies.exists(archive)) record(`${runtime.target} ${runtime.evidence}`, "blocked", `${archive} was not built successfully in this run`);
            else run(`${runtime.target} ${runtime.evidence}`, withDocker(dockerRuntimeCommand({ ...runtime, archive, harness, tokenizerManifest: resolve(options.root, "crates", "tokenizer", "tokenizer-prebuilt.json"), version: options.version, bunVersion: options.bunVersion }), docker));
          }
        }
      }
    }
    for (const unavailable of plan.unavailable) record(unavailable.split(":", 1)[0] ?? unavailable, "skip", unavailable);
  }
  record("agent-observed live TUI UAT", "skip", "manual evidence remains required and is not equivalent to scripted automation");
  return finish();
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const metadata: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string") throw new Error("package.json has no version");
  const dockerPath = Bun.which("docker") ?? undefined;
  const releaseLoginHome = process.env[RELEASE_LOGIN_SETTING];
  const readinessResult = runReadiness({
    root, platform: process.platform, arch: process.arch, quick: process.argv.includes("--quick"), bunExecutable: process.execPath, bunVersion: Bun.version, version: metadata.version,
    accountHome: selectStartupDirectories({ cwd: root, env: process.env }).accountHome, liveAuthProfile: liveAuthProfile(process.env),
    releaseLoginHome: releaseLoginHome === undefined || releaseLoginHome === "" ? undefined : resolve(releaseLoginHome),
  }, {
    exists: existsSync, which: (name) => name === "docker" ? dockerPath : Bun.which(name) ?? undefined, log: console.log,
    readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
    run: (command, env) => {
      const timeout = readinessCommandTimeout(command, dockerPath);
      const spawned = Bun.spawnSync([...command], { cwd: root, stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env: { ...process.env, ...env } }), ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" }), windowsHide: true });
      const timedOut = timeout !== undefined && spawned.signalCode === "SIGKILL" && spawned.exitCode === null;
      const stderr = spawned.stderr.toString();
      return { exitCode: spawned.exitCode ?? 1, stdout: spawned.stdout.toString(), stderr: timedOut ? `${stderr}${stderr ? "\n" : ""}command timed out after ${timeout / 1_000}s` : stderr };
    },
  });
  process.exit(readinessResult.exitCode);
}