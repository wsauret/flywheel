/**
 * The release logins: the one Claude login and the one Google Antigravity login, in the auth profile that
 * `LIVE_AUTH_PROFILE_SETTING` names, that the live tiers of readiness run on (the Claude engine's and the Antigravity
 * CLI's), on a host that keeps them in a home of its own. A person logs in once per host and engine, through the
 * engine's own login, and the engine refreshes its own token there. No token is ever read, copied, printed, or moved:
 * each host's logins stay in that host's home.
 *
 * - Windows: the folder `%LOCALAPPDATA%\FlywheelReadiness` on a Windows machine that the release machine reaches over
 *   SSH, at the host that `WINDOWS_HOST_SETTING` names. The Windows pass names the folder with the readiness setting
 *   `RELEASE_LOGIN_SETTING`.
 * - Linux: the named Docker volume `RELEASE_LOGIN_VOLUME` on the release machine, the home of the container that runs
 *   the tier.
 *
 * Usage, on the release machine, the arm64 macOS host that runs readiness:
 *
 *   bun run readiness:login windows [engine]   log in on the Windows machine over SSH, in its release login folder
 *   bun run readiness:login linux [engine]     log in in a container on the release login volume
 *
 * The modes that run where the home is:
 *
 *   bun run readiness:login --in-home <home> [engine]   add the profile if it is missing, then run the CLI's own login
 *   bun run readiness:login --status <home> [engine]    print the login's status line, which readiness reads
 *
 * `engine` is `claude`, the default, or `antigravity`.
 *
 * The Claude status mode asks the bundled engine for each login's sign-in (`claude auth status`), which states when
 * the engine stops renewing the login. The engine reads its own token for that; this script reads only the engine's
 * answer, and prints no field of it but the date. The Antigravity status mode reads only Flywheel's token-free account
 * records of the profile's Google Antigravity logins, and starts no program.
 *
 * Neither login needs a browser on the machine that runs it. The Claude engine prints "If the browser didn't open,
 * visit: <url>" and reads the code that the page shows; agy, which finds no display in a container or over SSH, signs
 * in with its pasted-code flow. `flywheel auth login` asks the person to paste the code.
 */
// A standalone process: it loads both module registries before anything reads the catalog.
import "./shipped-modules.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIVE_AUTH_PROFILE_SETTING, LIVE_AUTH_PROFILE_UNSET, liveAuthProfile, liveClaudeAccounts } from "./claude-engine-release.js";
import { readinessPlan, releaseLoginContainerCommand } from "./readiness-plan.js";
import { canonicalAccountHome, FLYWHEEL_DIR_NAME } from "../src/infra/directory-authorities.js";
import { processEngineHost, type EngineHost } from "../src/infra/claude-engine.js";
import { keychainUnlocked } from "../src/infra/macos-keychain.js";
import { ownedCommandRunner } from "../src/infra/owned-command.js";
import { isRecord } from "../src/infra/record.js";
import { osAccount } from "../src/infra/os-account.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../src/infra/process-supervisor.js";
import { authDir } from "../src/infra/paths.js";
import { AuthProfileManager } from "../src/orchestration/auth/auth-profile-manager.js";
import { antigravityAccounts } from "../src/orchestration/modules/provider-google-antigravity/login/login.js";
import { GOOGLE_ANTIGRAVITY_CLI_FLAG } from "../src/orchestration/modules/provider-google-antigravity/names.js";
import { cliLoginEnvironment } from "../src/orchestration/modules/provider-claude-agent-sdk/engine/cli-environment.js";
import { CLAUDE_AGENT_SDK_CLI_FLAG } from "../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { loginToken, type LoginToken, type TokenProbe } from "../src/orchestration/modules/provider-claude-agent-sdk/login/login-token.js";

/** The readiness setting that names the release login home of this host. Only the live tiers read it. */
export const RELEASE_LOGIN_SETTING = "FLYWHEEL_READINESS_CLAUDE_HOME";
/** The variable that names the SSH host of the Windows machine that `readiness:login windows` logs in on. */
export const WINDOWS_HOST_SETTING = "FLYWHEEL_READINESS_WINDOWS_HOST";
/** The folder under `%LOCALAPPDATA%` of the Windows machine's real profile that holds the Windows release login. */
export const WINDOWS_RELEASE_LOGIN_FOLDER = "FlywheelReadiness";
/** The Windows release login home, as PowerShell on the Windows machine expands it. */
const WINDOWS_HOME = `$env:LOCALAPPDATA\\${WINDOWS_RELEASE_LOGIN_FOLDER}`;

/** The engine whose release login a mode handles. */
export type ReleaseEngine = "claude" | "antigravity";
const RELEASE_ENGINES: readonly ReleaseEngine[] = ["claude", "antigravity"];

/** A release login: its token (`LoginToken`), `ending` when the engine holds a token that it can stop renewing at
 *  any time, by `endsAt`, an ISO date, or `held` for a Google Antigravity login, whose token agy keeps where Flywheel
 *  reads it never. An ending login can refuse every request of the live tier, with "this login reached its time limit
 *  and cannot be renewed". */
export type ReleaseLogin = LoginToken | { readonly kind: "ending"; readonly endsAt: string } | { readonly kind: "held" };

/** What the status check needs: the token probe, the engine that states each login's sign-in, which runs through
 *  the probe's runner, and the time of the check. */
export interface ReleaseLoginCheck {
  readonly probe: TokenProbe;
  readonly engine: EngineHost;
  readonly nowMs: number;
}

/** `claude auth status` reads the stored login and sends nothing: it answered in 120 to 230 ms (engine 2.1.321). */
const AUTH_STATUS_BOUND_MS = 10_000;
/** The engine can end a sign-in this long before the end date that it states, and warns from then on to sign in
 *  again (engine 2.1.321: "this sign-in can end at any time from now until <date>"). */
const SIGN_IN_END_WINDOW_MS = 3 * 86_400_000;

/** What the engine's `auth status --json` states about the sign-in, or undefined when its output states none. */
interface AuthStatus {
  readonly loggedIn: boolean;
  readonly loginExpiresAt: string | undefined;
}

function authStatus(text: string): AuthStatus | undefined {
  let status: unknown;
  try {
    status = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(status) || typeof status["loggedIn"] !== "boolean") return undefined;
  const expiresAt = status["loginExpiresAt"];
  return { loggedIn: status["loggedIn"], loginExpiresAt: typeof expiresAt === "string" ? expiresAt : undefined };
}

/** The release login in `configDir`: its token (`loginToken`), and for a stored token what the engine's
 *  `auth status` states about the sign-in. The engine names no login when the token holds none (`absent`), and the
 *  date after which it renews the login no more (`loginExpiresAt`, engine 2.1.318 and later). A login without that
 *  date keeps its token's status. An engine that does not answer leaves the login `unchecked`. */
async function releaseLogin(configDir: string, { probe, engine, nowMs }: ReleaseLoginCheck): Promise<ReleaseLogin> {
  const token = await loginToken(configDir, probe);
  if (token.kind !== "present") return token;
  if (probe.run === undefined) return { kind: "unchecked", reason: "this runtime starts no program" };
  const answer = await probe.run([engine.enginePath, "auth", "status", "--json"], { env: cliLoginEnvironment({ ...engine, configDir }), cwd: engine.temporaryDirectory, timeoutMs: AUTH_STATUS_BOUND_MS });
  if (answer.timedOut) return { kind: "unchecked", reason: `the engine did not state the sign-in within ${AUTH_STATUS_BOUND_MS / 1000} s` };
  // The engine exits with code 1 when it names no login, and states that in the same JSON.
  const status = authStatus(answer.stdout);
  if (status === undefined) return { kind: "unchecked", reason: `the engine's auth status exited with code ${String(answer.exitCode)} and stated no sign-in` };
  if (!status.loggedIn) return { kind: "absent" };
  const endsAtMs = status.loginExpiresAt === undefined ? Number.NaN : Date.parse(status.loginExpiresAt);
  return Number.isNaN(endsAtMs) || endsAtMs - SIGN_IN_END_WINDOW_MS > nowMs ? token : { kind: "ending", endsAt: new Date(endsAtMs).toISOString() };
}

/** The release login of the account home `home`: present when a login of its auth profile `profile` has a
 *  stored token that the engine still renews, unchecked when a token store or the engine could not be asked, ending
 *  when the only stored tokens are ones that the engine can stop renewing at any time, and absent otherwise, also
 *  when the home has no such profile. It reads each login folder's account file, the engine's token-free store
 *  checks, and the engine's own auth status (`releaseLogin`), never a token. */
export async function releaseLoginStatus(home: string, root: string, profile: string, check: ReleaseLoginCheck): Promise<ReleaseLogin> {
  const userDataRoot = join(canonicalAccountHome(home), FLYWHEEL_DIR_NAME);
  const logins = await Promise.all(liveClaudeAccounts(userDataRoot, root, profile).map(({ configDir }) => releaseLogin(configDir, check)));
  return logins.find(({ kind }) => kind === "present") ?? logins.find(({ kind }) => kind === "unchecked") ?? logins.find(({ kind }) => kind === "ending") ?? { kind: "absent" };
}

/** The Google Antigravity release login of the account home `home`: held when its auth profile `profile` holds a
 *  Google Antigravity login, and absent otherwise, also when the home has no such profile. It reads only the
 *  token-free account record of each login directory, and starts no program; the live tier decides whether agy still
 *  holds the sign-in. */
export function antigravityReleaseLoginStatus(home: string, root: string, profile: string): ReleaseLogin {
  const userDataRoot = join(canonicalAccountHome(home), FLYWHEEL_DIR_NAME);
  const { id } = new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: profile } }).inspect();
  return antigravityAccounts(authDir(userDataRoot, id)).length > 0 ? { kind: "held" } : { kind: "absent" };
}

/** The one line that the status mode prints for `login`. */
function statusLine(login: ReleaseLogin): string {
  switch (login.kind) {
    case "present": return `present ${login.store}`;
    case "held": return "held";
    case "absent": return "absent";
    case "unchecked": return `unchecked ${login.reason}`;
    case "ending": return `ending ${login.endsAt}`;
  }
}

/** The status that the last line of the status mode's output states, or undefined for any other output. The lines
 *  before it are the output of what ran before the status mode, such as a container's install. */
export function parseReleaseLoginStatus(output: string): ReleaseLogin | undefined {
  const line = output.trim().split("\n").at(-1)?.trim() ?? "";
  if (line === "present file" || line === "present keychain") return { kind: "present", store: line === "present file" ? "file" : "keychain" };
  if (line === "absent") return { kind: "absent" };
  if (line === "held") return { kind: "held" };
  const endsAt = /^ending (\S+)$/u.exec(line)?.[1];
  if (endsAt !== undefined) return Number.isNaN(Date.parse(endsAt)) ? undefined : { kind: "ending", endsAt };
  const unchecked = /^unchecked (.+)$/u.exec(line)?.[1];
  return unchecked === undefined ? undefined : { kind: "unchecked", reason: unchecked };
}

/** One command of a login: `interactive` gives it the person's terminal input. */
export interface LoginCommand {
  readonly command: readonly string[];
  readonly interactive: boolean;
}

/** The commands of a login from the release machine, in order, and the commands that remove what it placed on another machine,
 *  which run whether the login completed or not. */
export interface LoginPlan {
  readonly steps: readonly LoginCommand[];
  readonly cleanup: readonly LoginCommand[];
}

/** The host that a login runs on: a container of the release machine, or the Windows machine at the SSH host `sshHost`. */
export type LoginTarget = { readonly kind: "linux" } | { readonly kind: "windows"; readonly sshHost: string };

export interface LoginContext {
  /** Where the tar of the candidate's tracked files is written on the release machine. */
  readonly candidate: string;
  /** The name of the Windows machine's temporary folder for the candidate. */
  readonly folder: string;
  readonly bunVersion: string;
  readonly dockerPlatform: string;
  /** The auth profile that the login adds the engine's login to. */
  readonly liveAuthProfile: string;
  readonly engine: ReleaseEngine;
}

/** The login of `target`, run from the release machine. Each host runs the CLI's own login of the engine (`inHomeLogin`) in
 *  its release login home, from a fresh install of the candidate: Windows in a temporary folder over SSH, which the
 *  cleanup removes, and Linux in a container whose home is the release login volume. */
export function releaseLoginPlan(target: LoginTarget, context: LoginContext): LoginPlan {
  const archive = { command: ["git", "archive", "--format=tar", `--output=${context.candidate}`, "HEAD"], interactive: false };
  if (target.kind === "linux") {
    return { steps: [archive, { command: releaseLoginContainerCommand({ ...context, step: "login" }), interactive: true }], cleanup: [] };
  }
  const { sshHost } = target;
  // scp resolves a relative path from the user's profile folder, so both sides name the folder from there.
  const remote = `$env:USERPROFILE\\AppData\\Local\\Temp\\${context.folder}`;
  const login = [
    `Set-Location -LiteralPath "${remote}"`,
    // System32 holds bsdtar. A GNU tar that a POSIX shell puts on PATH cannot read a Windows path.
    String.raw`& "$env:SystemRoot\System32\tar.exe" -xf candidate.tar`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "bun install --frozen-lockfile",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    // A single-quoted PowerShell string is literal; a quote inside it is doubled.
    `$env:${LIVE_AUTH_PROFILE_SETTING} = '${context.liveAuthProfile.replaceAll("'", "''")}'`,
    `bun run scripts/readiness-login.ts --in-home "${WINDOWS_HOME}"${context.engine === "claude" ? "" : ` ${context.engine}`}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  return {
    steps: [
      archive,
      { command: ["ssh", sshHost, `New-Item -ItemType Directory -Force -Path "${remote}" | Out-Null`], interactive: false },
      { command: ["scp", "-q", context.candidate, `${sshHost}:AppData/Local/Temp/${context.folder}/candidate.tar`], interactive: false },
      // -t gives the remote login a terminal, where the CLI asks for the pasted code.
      { command: ["ssh", "-t", sshHost, login], interactive: true },
    ],
    cleanup: [{ command: ["ssh", sshHost, `Remove-Item -Recurse -Force -LiteralPath "${remote}"`], interactive: false }],
  };
}

/** The CLI command that logs in in a home, the variables that select the home and its profile, and the command that
 *  must succeed before it: a fresh candidate holds no Antigravity CLI, because the checkout's verified copy is not in
 *  git, so the Antigravity login first prepares the pinned copy for this host. */
export interface HomeLogin {
  readonly prepare?: readonly string[];
  readonly command: readonly string[];
  readonly env: { readonly HOME: string; readonly FLYWHEEL_AUTH_PROFILE: string };
}

/** Adds the auth profile `profile` to the account home `home` when it has none, and returns the CLI command
 *  that logs in to `engine` in that profile: `flywheel auth login`, from this checkout, which runs the engine's own
 *  login in a login folder of the profile. The live tier reads that profile and refuses a home without it. The
 *  profile is found as the live tier finds it (`liveClaudeAccounts`): by the environment selector, whose display name
 *  match ignores case, as the profile store's name conflict check does. */
export async function inHomeLogin(home: string, bunExecutable: string, root: string, profile: string, engine: ReleaseEngine): Promise<HomeLogin> {
  mkdirSync(home, { recursive: true });
  const userDataRoot = join(canonicalAccountHome(home), FLYWHEEL_DIR_NAME);
  const selected = new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: profile } }).inspect();
  if (!selected.availableProfiles.some(({ id }) => id === selected.id)) {
    await new AuthProfileManager({ userDataRoot, projectRoot: root, env: {} }).create(profile);
  }
  return {
    ...(engine === "antigravity" ? { prepare: [bunExecutable, "run", join(root, "scripts", "antigravity-engine-asset.ts"), "prepare"] } : {}),
    // bin/flywheel, without its POSIX shell, so the same command runs on Windows.
    command: [bunExecutable, "--conditions=browser", join(root, "scripts", "dev.ts"), "auth", "login", `--${engine === "claude" ? CLAUDE_AGENT_SDK_CLI_FLAG : GOOGLE_ANTIGRAVITY_CLI_FLAG}`],
    env: { HOME: home, FLYWHEEL_AUTH_PROFILE: profile },
  };
}

/** The exit code of a command that ran with the person's terminal. */
function runAttached(command: readonly string[], options: { readonly interactive: boolean; readonly cwd: string; readonly env?: HomeLogin["env"] }): number {
  const spawned = Bun.spawnSync([...command], {
    cwd: options.cwd, stdin: options.interactive ? "inherit" : "ignore", stdout: "inherit", stderr: "inherit",
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }), windowsHide: true,
  });
  return spawned.exitCode ?? 1;
}

const USAGE = "usage: bun run readiness:login <windows|linux> [claude|antigravity] | --in-home <home> [claude|antigravity] | --status <home> [claude|antigravity]";

/** The engine that the optional last argument names, `claude` without one, or undefined for any other word. */
function releaseEngine(word: string | undefined): ReleaseEngine | undefined {
  return word === undefined ? "claude" : RELEASE_ENGINES.find((engine) => engine === word);
}

async function main(args: readonly string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const [mode, home] = args;
  const profile = liveAuthProfile(process.env);
  const refuse = (reason: string) => { console.error(reason); return 1; };
  const withHome = mode === "--status" || mode === "--in-home";
  const engine = releaseEngine(withHome ? args[2] : args[1]);
  if (engine === undefined || args.length > (withHome ? 3 : 2)) {
    console.error(USAGE);
    return 2;
  }
  if (mode === "--status" && home !== undefined) {
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    if (engine === "antigravity") {
      console.log(statusLine(antigravityReleaseLoginStatus(home, root, profile)));
      return 0;
    }
    const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
    const launcher = createLauncherScope(supervisor);
    try {
      const account = osAccount();
      const login = await releaseLoginStatus(home, root, profile, {
        probe: { platform: process.platform, account, run: ownedCommandRunner(launcher), keychainUnlocked }, engine: processEngineHost(account), nowMs: Date.now(),
      });
      console.log(statusLine(login));
      return 0;
    } finally {
      await launcher.close();
      supervisor.dispose();
    }
  }
  if (mode === "--in-home" && home !== undefined) {
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    const login = await inHomeLogin(home, process.execPath, root, profile, engine);
    if (login.prepare !== undefined) {
      const prepared = runAttached(login.prepare, { interactive: false, cwd: root });
      if (prepared !== 0) return prepared;
    }
    console.log(`Logging in to ${engine === "claude" ? "Claude" : "Google Antigravity"} in the auth profile "${profile}" of ${home}.`);
    return runAttached(login.command, { interactive: true, cwd: root, env: login.env });
  }
  if (mode === "windows" || mode === "linux") {
    const linux = readinessPlan(process.platform, process.arch, false, { tmux: true }).linuxLive;
    if (linux === undefined) return refuse("readiness:login runs on the arm64 macOS release machine that runs readiness: it holds the Linux release login volume and reaches the Windows machine over SSH.");
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    let target: LoginTarget = { kind: "linux" };
    if (mode === "windows") {
      const sshHost = process.env[WINDOWS_HOST_SETTING];
      if (!sshHost) return refuse(`${WINDOWS_HOST_SETTING} is unset: set it to the SSH host of the Windows machine that holds the Windows release login`);
      target = { kind: "windows", sshHost };
    }
    const scratch = mkdtempSync(join(tmpdir(), "flywheel-readiness-login-"));
    const plan = releaseLoginPlan(target, { candidate: join(scratch, "candidate.tar"), folder: `flywheel-readiness-login-${crypto.randomUUID()}`, bunVersion: Bun.version, dockerPlatform: linux.dockerPlatform, liveAuthProfile: profile, engine });
    try {
      for (const step of plan.steps) {
        const exitCode = runAttached(step.command, { interactive: step.interactive, cwd: root });
        if (exitCode !== 0) return exitCode;
      }
      return 0;
    } finally {
      for (const step of plan.cleanup) runAttached(step.command, { interactive: step.interactive, cwd: root });
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
