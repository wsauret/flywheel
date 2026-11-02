/**
 * The release login: the one Claude login, in the auth profile that `LIVE_AUTH_PROFILE_SETTING` names, that the live
 * Claude engine tier of readiness runs on, on a host that keeps it in a home of its own. A person logs in once per
 * host, through the Claude engine's own login, and the engine refreshes its own token there. No token is ever read,
 * copied, printed, or moved: each host's login stays in that host's home.
 *
 * - Windows: the folder `%LOCALAPPDATA%\FlywheelReadiness` on a Windows machine that the release machine reaches over
 *   SSH, at the host that `WINDOWS_HOST_SETTING` names. The Windows pass names the folder with the readiness setting
 *   `RELEASE_LOGIN_SETTING`.
 * - Linux: the named Docker volume `RELEASE_LOGIN_VOLUME` on the release machine, the home of the container that runs
 *   the tier.
 *
 * Usage, on the release machine, the arm64 macOS host that runs readiness:
 *
 *   bun run readiness:login windows   log in on the Windows machine over SSH, in its release login folder
 *   bun run readiness:login linux     log in in a container on the release login volume
 *
 * The modes that run where the home is:
 *
 *   bun run readiness:login --in-home <home>   add the profile if it is missing, then run the CLI's own Claude login
 *   bun run readiness:login --status <home>    print the login's status line, which readiness reads
 *
 * The engine's login needs no browser on the machine that runs it. It prints "If the browser didn't open, visit:
 * <url>" and reads the code that the page shows, which `flywheel auth login` asks the person to paste.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIVE_AUTH_PROFILE_SETTING, LIVE_AUTH_PROFILE_UNSET, liveAuthProfile, liveClaudeAccounts } from "./claude-engine-release.js";
import { readinessPlan, releaseLoginContainerCommand } from "./readiness-plan.js";
import { canonicalAccountHome, FLYWHEEL_DIR_NAME } from "../src/infra/directory-authorities.js";
import { keychainUnlocked } from "../src/infra/macos-keychain.js";
import { ownedCommandRunner } from "../src/infra/owned-command.js";
import { osAccount } from "../src/infra/os-account.js";
import { createLauncherScope, createProcessSupervisor } from "../src/infra/process-supervisor.js";
import { AuthProfileManager } from "../src/orchestration/auth/auth-profile-manager.js";
import { CLAUDE_AGENT_SDK_CLI_FLAG } from "../src/orchestration/modules/provider-claude-agent-sdk/names.js";
import { loginToken, type LoginToken, type TokenProbe } from "../src/orchestration/modules/provider-claude-agent-sdk/login-token.js";

/** The readiness setting that names the release login home of this host. Only the live Claude engine tier reads it. */
export const RELEASE_LOGIN_SETTING = "FLYWHEEL_READINESS_CLAUDE_HOME";
/** The variable that names the SSH host of the Windows machine that `readiness:login windows` logs in on. */
export const WINDOWS_HOST_SETTING = "FLYWHEEL_READINESS_WINDOWS_HOST";
/** The folder under `%LOCALAPPDATA%` of the Windows machine's real profile that holds the Windows release login. */
export const WINDOWS_RELEASE_LOGIN_FOLDER = "FlywheelReadiness";
/** The Windows release login home, as PowerShell on the Windows machine expands it. */
const WINDOWS_HOME = `$env:LOCALAPPDATA\\${WINDOWS_RELEASE_LOGIN_FOLDER}`;

/** The release login of the account home `home`: present when a login of its auth profile `profile` has a
 *  stored token, unchecked when the engine can keep the token in a store that this check cannot search, and absent
 *  otherwise, also when the home has no such profile. It reads each login folder's account file and the engine's
 *  token-free store checks (`loginToken`), never a token. */
export async function releaseLoginStatus(home: string, root: string, probe: TokenProbe, profile: string): Promise<LoginToken> {
  const userDataRoot = join(canonicalAccountHome(home), FLYWHEEL_DIR_NAME);
  const tokens = await Promise.all(liveClaudeAccounts(userDataRoot, root, profile).map(({ configDir }) => loginToken(configDir, probe)));
  return tokens.find(({ kind }) => kind === "present") ?? tokens.find(({ kind }) => kind === "unchecked") ?? { kind: "absent" };
}

/** The one line that the status mode prints for `token`. */
function statusLine(token: LoginToken): string {
  switch (token.kind) {
    case "present": return `present ${token.store}`;
    case "absent": return "absent";
    case "unchecked": return `unchecked ${token.reason}`;
  }
}

/** The status that a line of the status mode states, or undefined for any other output. */
export function parseReleaseLoginStatus(output: string): LoginToken | undefined {
  const line = output.trim();
  if (line === "present file" || line === "present keychain") return { kind: "present", store: line === "present file" ? "file" : "keychain" };
  if (line === "absent") return { kind: "absent" };
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
  /** The auth profile that the login adds the Claude login to. */
  readonly liveAuthProfile: string;
}

/** The login of `target`, run from the release machine. Each host runs the CLI's own Claude login (`inHomeLogin`) in
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
    `bun run scripts/readiness-login.ts --in-home "${WINDOWS_HOME}"`,
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

/** The CLI command that logs in in a home, and the variables that select the home and its profile. */
export interface HomeLogin {
  readonly command: readonly string[];
  readonly env: { readonly HOME: string; readonly FLYWHEEL_AUTH_PROFILE: string };
}

/** Adds the auth profile `profile` to the account home `home` when it has none, and returns the CLI command
 *  that logs in to Claude in that profile: `flywheel auth login`, from this checkout, which runs the engine's own
 *  login in a login folder of the profile. The live tier reads that profile and refuses a home without it. The
 *  profile is found as the live tier finds it (`liveClaudeAccounts`): by the environment selector, whose display name
 *  match ignores case, as the profile store's name conflict check does. */
export async function inHomeLogin(home: string, bunExecutable: string, root: string, profile: string): Promise<HomeLogin> {
  mkdirSync(home, { recursive: true });
  const userDataRoot = join(canonicalAccountHome(home), FLYWHEEL_DIR_NAME);
  const selected = new AuthProfileManager({ userDataRoot, projectRoot: root, env: { FLYWHEEL_AUTH_PROFILE: profile } }).inspect();
  if (!selected.availableProfiles.some(({ id }) => id === selected.id)) {
    await new AuthProfileManager({ userDataRoot, projectRoot: root, env: {} }).create(profile);
  }
  return {
    // bin/flywheel, without its POSIX shell, so the same command runs on Windows.
    command: [bunExecutable, "--conditions=browser", join(root, "scripts", "dev.ts"), "auth", "login", `--${CLAUDE_AGENT_SDK_CLI_FLAG}`],
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

const USAGE = "usage: bun run readiness:login <windows|linux> | --in-home <home> | --status <home>";

async function main(args: readonly string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const [mode, home] = args;
  const profile = liveAuthProfile(process.env);
  const refuse = (reason: string) => { console.error(reason); return 1; };
  if (mode === "--status" && home !== undefined && args.length === 2) {
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    const supervisor = createProcessSupervisor();
    const launcher = createLauncherScope(supervisor);
    try {
      const token = await releaseLoginStatus(home, root, { platform: process.platform, account: osAccount(), run: ownedCommandRunner(launcher), keychainUnlocked }, profile);
      console.log(statusLine(token));
      return 0;
    } finally {
      await launcher.close();
      supervisor.dispose();
    }
  }
  if (mode === "--in-home" && home !== undefined && args.length === 2) {
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    const login = await inHomeLogin(home, process.execPath, root, profile);
    console.log(`Logging in to Claude in the auth profile "${profile}" of ${home}.`);
    return runAttached(login.command, { interactive: true, cwd: root, env: login.env });
  }
  if ((mode === "windows" || mode === "linux") && args.length === 1) {
    const linux = readinessPlan(process.platform, process.arch, false, { tmux: true }).linuxClaudeLive;
    if (linux === undefined) return refuse("readiness:login runs on the arm64 macOS release machine that runs readiness: it holds the Linux release login volume and reaches the Windows machine over SSH.");
    if (profile === undefined) return refuse(LIVE_AUTH_PROFILE_UNSET);
    let target: LoginTarget = { kind: "linux" };
    if (mode === "windows") {
      const sshHost = process.env[WINDOWS_HOST_SETTING];
      if (!sshHost) return refuse(`${WINDOWS_HOST_SETTING} is unset: set it to the SSH host of the Windows machine that holds the Windows release login`);
      target = { kind: "windows", sshHost };
    }
    const scratch = mkdtempSync(join(tmpdir(), "flywheel-readiness-login-"));
    const plan = releaseLoginPlan(target, { candidate: join(scratch, "candidate.tar"), folder: `flywheel-readiness-login-${crypto.randomUUID()}`, bunVersion: Bun.version, dockerPlatform: linux.dockerPlatform, liveAuthProfile: profile });
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
