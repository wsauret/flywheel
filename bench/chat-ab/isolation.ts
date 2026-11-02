// Keeps a chat cell off the operator's machine. A cell is the production chat
// agent with a shell, and it acts like one: on 2026-10-05 a cell found the
// operator's checkout, installed a build of it over the operator's Flywheel,
// and restarted the account service. Two layers stop that.
//
// 1. The cell process gets its own HOME and TMPDIR. The agent's commands
//    inherit them, so `~`, an install, `flywheel kill`, process spools, and
//    tmux sockets name the cell. The cell keeps the operator's account (auth,
//    models, usage) through the official headless subject's account resolution.
// 2. A macOS `sandbox-exec` profile denies what an environment cannot
//    redirect, because the agent can always name a real path:
//    - home data reads except the runtime's source, dependencies, campaign
//      files, and, for Flywheel cells, account inputs, shared skills, and
//      normal login keychains;
//    - home writes except the cell's account store, caches, campaign results,
//      and, for Flywheel cells, normal login keychains for credential refresh.
//      Installed builds, the launcher, and account service state stay protected;
//    - writes to this repository, its main checkout, the package managers'
//      prefixes, and the operator's tmux sockets, apart from the campaign
//      results, the compile cache, and, for a Flywheel cell, the lock folders
//      of the bundled and shared skill roots;
//    - `launchctl`, LaunchServices (`open`), and Apple events, each of which
//      starts a process outside the sandbox. The account service's launchd
//      label is fixed, so an install from any HOME replaces the operator's;
//    - signals to any process outside the sandbox, so `pkill` cannot reach the
//      operator's service, the harness, or another cell;
//    - connections to the account service: its hub ports, its sockets, and the
//      tokens beside them; and to tmux servers outside the cell.
//
// A Claude Code subject uses the operator's normal HOME, configuration, login,
// hooks, and plugins inside the sandbox. The Flywheel and bench stores remain denied.
// Its recorded work stores are unreadable except for the current cell's project and session entries.
//
// A campaign whose cells compare two agents on one task confines each cell
// (`CellIsolation.confine`): the cell reads and writes only its own folders
// of the campaign's results and sandbox copies, so neither agent reads the
// other's report, transcripts, or work in progress.
//
// Flywheel cells use their selected ordinary profile, including native
// program-owned credentials in the operator's login keychains. The runtime
// and agent tools share this sandbox, so both receive keychain-file access;
// OS item-level protections remain. Historical bench credentials stay denied.
// Every Flywheel subject reads the operator's account and its auth store. The cell's
// runtime and its agent's shell share one sandbox, so the profile denies the
// credential file of every profile but the arm's own: a cell still lists the
// profiles and resolves its own, and never reads another arm's key.
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { CONTAINER_MARK_VARIABLE, STRICT_DESCENDANT_SETTLEMENT_VARIABLE } from "../../src/infra/container-mark.js";
import { authDir, globalAgentsFile, sharedAgentsDir } from "../../src/infra/paths.js";
import { BUNDLED_SKILL_DIR } from "../../src/workflows/skill-source-inventory.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The installed and the development hub ports (src/infra/paths.ts). */
const HUB_PORTS = [41000, 40999];

export interface CellIsolation {
  /** The operator's account home, canonical. The cell reads its account from here. */
  readonly accountHome: string;
  /** Creates the cell's home and returns the environment entries that point
   *  the cell at it. The home carries the operator's git identity and nothing
   *  else of the operator's git configuration. */
  prepareHome(cellHome: string): Promise<{ readonly [name: string]: string }>;
  /** The command that runs `command` inside the profile. */
  wrap(command: readonly string[]): string[];
  /** This isolation for one cell, which may read and write only its own folders of the folders that hold every cell's
   *  work. The cell can still stat a path there, but cannot list a folder or read a file that is not its own. Each
   *  path is resolved to its real path, which is the path that the sandbox checks. */
  confine(confinement: CellConfinement): Promise<CellIsolation>;
}

/** One cell's folders among the folders that hold the work of every cell of a campaign. */
interface CellConfinement {
  /** The folders that hold every cell's work, such as the campaign results and the cells' sandbox copies. */
  readonly hidden: readonly string[];
  /** The cell's own folders inside them. */
  readonly own: readonly string[];
  /** Shared executable inputs remain readable without reopening writes denied by the campaign. */
  readonly readonly?: readonly string[];
  /** Campaigns that execute prepared sources deny the controller's cache and package locks. */
  readonly writeDenied?: readonly string[];
  /** Claude Code's transcript project and globally unique session namespace for this cell. */
  readonly claudeCode?: { readonly projectRoot: string; readonly sessionId: string };
}

function quoted(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function subpaths(paths: readonly string[]): string {
  return paths.map((path) => `(subpath ${quoted(path)})`).join(" ");
}

async function canonical(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

/** The operator's account home, canonical: the HOME the harness runs with. */
export async function operatorAccountHome(): Promise<string> {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set, so the operator's account home is unknown");
  return await canonical(home);
}

/** Inherits only the host inputs used by the SDK engine and ordinary shell
 *  commands, as claudeCodeEnvironment does. The campaign adds its profile and
 *  isolated home afterwards. Operator credentials, runtime overrides, and
 *  tmux routing never enter the cell or its agent's commands. */
export function inheritedCellEnvironment(source: { readonly [name: string]: string | undefined }): CellEnvironment {
  const env: CellEnvironment = {};
  // This raw child remains in its enclosing owned container. Its nested
  // launches must retain that ancestry without inheriting operator secrets.
  for (const key of ["PATH", "SHELL", "TZ", "USER", CONTAINER_MARK_VARIABLE, STRICT_DESCENDANT_SETTLEMENT_VARIABLE]) {
    const value = source[key];
    if (value === undefined) continue;
    env[key] = value;
  }
  return env;
}

/** The environment of a cell process, by variable name. */
export interface CellEnvironment {
  [name: string]: string;
}

/** The credential file of an auth profile (auth-profile-store.ts). Nothing here reads its value. */
const CREDENTIAL_FILE = "auth.json";

/** A path as a sandbox regular expression that matches only that path. */
function regexPath(path: string): string {
  if (path.includes("\"")) throw new Error(`A sandbox pattern cannot name a path with a quote: ${path}`);
  return path.replaceAll(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

/** The sandbox rules that keep a cell from the credential file of every auth
 *  profile in the account store `store` but `ownProfile`, the arm's own. Only
 *  the files' data is denied, so the profile list and each `profile.json`
 *  stay readable and the cell resolves its profile as a product run does.
 *  They name paths and read nothing, so they also cover a profile created
 *  after the campaign starts, and a synthetic default profile that the store
 *  does not hold yet.
 *
 *  The sandbox checks the path an operation names, so a rule on a file holds
 *  only while the file stays at a path the rule names. A pattern covers every
 *  profile folder under any name. A rename of the auth or the profiles folder
 *  would move every file out of the pattern, and a rename onto the own
 *  profile's folder would move another profile's file to the one path the
 *  last rule allows, so writes to those three folders themselves are denied.
 *  Writes inside the own folder stay allowed: a token refresh replaces the
 *  own file there. */
export function profileCredentialRules(store: string, ownProfile: string): string[] {
  const own = authDir(store, ownProfile);
  const profiles = dirname(own);
  return [
    `(deny file-read-data file-write* (regex #"^${regexPath(profiles)}/[^/]+/${regexPath(CREDENTIAL_FILE)}$"))`,
    `(deny file-write* (literal ${quoted(dirname(profiles))}) (literal ${quoted(profiles)}) (literal ${quoted(own)}))`,
    `(allow file-read-data file-write* (literal ${quoted(join(own, CREDENTIAL_FILE))}))`,
  ];
}

/** Allow normal program-owned credential refresh, but never expose historical private-runner credentials. */
export function profileKeychainRules(accountHome: string): string[] {
  const normalLogin = `(allow file-read* file-read-data file-write* ${subpaths([join(accountHome, "Library", "Keychains")])})`;
  const denied = `(deny file-read* file-read-data file-write* ${subpaths([join(accountHome, ".flywheel-bench")])})`;
  return [normalLogin, denied];
}

/** Permit the ordinary Claude Code login and configuration while keeping Flywheel state and the bench home private. */
export function claudeCodeRules(accountHome: string): string[] {
  const recordedWork = [
    "projects", "file-history", "todos", "history.jsonl", "session-env", "plans", "tasks",
    "debug", "paste-cache", "uploads", "feedback", "feedback-bundles", "jobs", "daemon", "daemon.log", "sessions", "teams",
  ];
  // v2.1.299 shell-snapshots capture shell startup configuration and have no session ID.
  // The sandbox checks the path an operation names, so a rename of a store or of ~/.claude itself would move recorded
  // work to a readable path; writes there are denied with the reads. `confine` reopens the cell's own entries.
  const claude = join(accountHome, ".claude");
  return [
    `(allow file-read* file-read-data file-write* ${subpaths([claude, join(accountHome, "Library", "Keychains")])} (regex #"^${regexPath(join(accountHome, ".claude.json"))}[^/]*$"))`,
    `(deny file-read* file-read-data file-write* ${subpaths([join(accountHome, ".flywheel"), join(accountHome, ".flywheel-bench")])})`,
    `(deny file-read-data file-write* ${subpaths(recordedWork.map((name) => join(claude, name)))})`,
    `(deny file-write* (literal ${quoted(claude)}))`,
  ];
}

/** Claude Code v2.1.299 normalizes the real cwd to NFC, sanitizes it, and hashes paths longer than 200 characters. */
function claudeProjectName(realProjectRoot: string): string {
  const projectRoot = realProjectRoot.normalize("NFC");
  const slug = projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  // Int32Array storage reproduces the CLI's 32-bit wrap after each step.
  const hash = new Int32Array(1);
  for (let index = 0; index < projectRoot.length; index++) hash[0] = Math.imul(hash[0]!, 31) + projectRoot.charCodeAt(index);
  return `${slug.slice(0, 200)}-${Math.abs(hash[0]!).toString(36)}`;
}


/** Which agent a cell runs, and so which credentials its profile allows. A
 *  Flywheel cell names the id of its arm's own auth profile, the one profile
 *  whose credential file it reads. It also permits normal login keychain access
 *  (`profileKeychainRules`). A Claude Code subject uses its normal configuration
 *  and native login (`claudeCodeRules`). */
export type CellAgent =
  | {
    readonly kind: "flywheel";
    readonly authProfile: string;
  }
  | { readonly kind: "claude-code" };

/** Reads Git's registered checkout roots, including worktrees outside the main checkout. */
async function registeredWorktreePaths(repoRoot: string, run: OwnedCommandRunner): Promise<string[]> {
  const result = await run(["git", "worktree", "list", "--porcelain", "-z"], { cwd: repoRoot });
  if (result.exitCode !== 0) throw new Error(`git worktree list failed in ${repoRoot}`);
  const paths = result.stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice("worktree ".length));
  return await Promise.all(paths.map(canonical));
}

/** Builds the profile once per campaign. Refuses to run where it cannot
 *  isolate a cell: a cell with the operator's HOME and no profile can replace
 *  the operator's installed Flywheel. */
export async function cellIsolation(repoRoot: string, resultsRoot: string, run: OwnedCommandRunner, agent: CellAgent): Promise<CellIsolation> {
  if (process.platform !== "darwin") throw new Error("chat-ab isolates each cell with macOS sandbox-exec, so it runs on macOS only");
  const accountHome = await operatorAccountHome();
  const commonDir = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot });
  if (commonDir.exitCode !== 0) throw new Error(`git rev-parse --git-common-dir failed in ${repoRoot}`);
  const mainCheckout = await canonical(dirname(commonDir.stdout.trim()));
  const repository = await canonical(repoRoot);
  const siblings = (await registeredWorktreePaths(repoRoot, run)).filter((path) => path !== mainCheckout && path !== repository);
  const ancestors = siblings.filter((path) => repository.startsWith(`${path}${sep}`));
  // Task answers also exist in Git objects, sibling checkouts, and authoring
  // scratch. Hiding only the current checkout's task folders leaves those readable.
  const sharedCheckoutReads = [
    `(deny file-read-data ${subpaths([join(mainCheckout, ".claude"), ...(repository === mainCheckout ? [] : [join(mainCheckout, "bench")]), ...ancestors])})`,
    ...(repository === mainCheckout ? [] : [`(allow file-read-data ${subpaths([repository])})`]),
    `(deny file-read-data ${subpaths([commonDir.stdout.trim(), join(mainCheckout, ".flywheel"), join(repository, ".flywheel"), ...siblings.filter((path) => !ancestors.includes(path))])})`,
  ];
  // The cell compiles helper chunks into the shared node_modules cache.
  const dependencies = await canonical(join(repository, "node_modules"));
  const compileCache = join(dependencies, ".cache");
  // A skill load locks its package in a `.locks` folder beside it
  // (package-directory-lock.ts). A Flywheel cell runs this source tree, so its
  // bundled packages lie in the repository, and shared packages lie under the
  // denied home; without these folders every such load fails with EPERM. An
  // account without shared skills has no shared root to lock.
  const sharedSkills = join(sharedAgentsDir(accountHome), "skills");
  const skillRoots = [BUNDLED_SKILL_DIR, ...(existsSync(sharedSkills) ? [sharedSkills] : [])];
  const skillLocks = agent.kind === "flywheel" ? await Promise.all(skillRoots.map(async (root) => join(await canonical(root), ".locks"))) : [];
  const store = join(accountHome, ".flywheel");
  const serviceState = [join(store, "serve"), join(store, "serve-dev")];
  const tmuxSockets = `/private/tmp/tmux-${process.getuid?.() ?? 0}`;
  // Exact operations outrank wildcard operations, regardless of order. The
  // account and keychain rules name file-read-data explicitly to override the
  // home policy. Within that operation, the protected paths come last.
  const claudeRules = claudeCodeRules(accountHome);
  const agentRules = agent.kind === "claude-code" ? [claudeRules[1]!] : [
    ...profileKeychainRules(accountHome),
    `(deny file-write* ${subpaths([join(store, "versions"), join(store, "current"), join(store, "launcher"), ...serviceState])})`,
    `(deny file-read* file-read-data ${subpaths(serviceState)})`,
    ...profileCredentialRules(store, agent.authProfile),
  ];
  const results = await canonical(resultsRoot);
  // The runtime reads its account and shared skills explicitly. Everything
  // else in the operator's home is data outside the benchmark.
  const accountReads = agent.kind === "flywheel" ? [
    `(allow file-read-data ${subpaths([store, join(sharedAgentsDir(accountHome), "skills")])} (literal ${quoted(globalAgentsFile(accountHome))}))`,
  ] : [];
  // A cell's own folders lie in the results and the temporary folder, so the
  // confinement follows credential allowances so a checkout under .claude/worktrees
  // cannot reopen hidden inputs. Store and service restrictions remain last.
  const profileOf = (confinement: readonly string[]) => [
    "(version 1)",
    "(allow default)",
    `(deny file-read-data ${subpaths([accountHome])})`,
    // canonicalAccountHome calls realpath on this directory, not its contents.
    `(allow file-read-data (literal ${quoted(accountHome)}))`,
    `(allow file-read-data ${subpaths([repository, dependencies, results])})`,
    ...accountReads,
    `(deny file-write* ${subpaths([accountHome])})`,
    ...(agent.kind === "claude-code" ? claudeRules.slice(0, 1) : []),
    `(deny file-write* ${subpaths([repository, mainCheckout, "/opt/homebrew", "/usr/local", tmuxSockets])})`,
    `(allow file-write* ${subpaths([store, join(accountHome, "Library", "Caches"), results, compileCache, ...skillLocks])})`,
    ...sharedCheckoutReads,
    ...(agent.kind === "claude-code" ? claudeRules.slice(2) : []),
    ...confinement,
    ...agentRules,
    "(deny process-exec (literal \"/bin/launchctl\") (literal \"/usr/bin/open\") (literal \"/usr/bin/osascript\"))",
    "(deny appleevent-send)",
    "(deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\") (global-name \"com.apple.lsd.mapdb\") (global-name \"com.apple.lsd.modifydb\"))",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    `(deny network-outbound ${HUB_PORTS.map((port) => `(remote tcp "localhost:${port}")`).join(" ")})`,
    // One `remote` form per path: paths listed in one form must all match.
    `(deny network-outbound ${[...serviceState, tmuxSockets].map((path) => `(remote unix-socket (subpath ${quoted(path)}))`).join(" ")})`,
  ].join("\n");
  const identity: string[] = [];
  for (const key of ["name", "email"]) {
    const value = await run(["git", "config", "--global", `user.${key}`], { cwd: repoRoot });
    if (value.exitCode === 0 && value.stdout.trim()) identity.push(`\t${key} = ${value.stdout.trim()}`);
  }
  const prepareHome: CellIsolation["prepareHome"] = async (cellHome) => {
    const temp = join(cellHome, "tmp");
    await mkdir(temp, { recursive: true });
    await mkdir(join(cellHome, "gh"), { recursive: true });
    if (identity.length > 0) await writeFile(join(cellHome, ".gitconfig"), `[user]\n${identity.join("\n")}\n`);
    // An empty gh config directory leaves the gh CLI unauthenticated in
    // every arm alike.
    return { HOME: cellHome, TMPDIR: temp, TMUX_TMPDIR: temp, GH_CONFIG_DIR: join(cellHome, "gh") };
  };
  const isolationOf = (confinement: readonly string[]): CellIsolation => {
    const profile = profileOf(confinement);
    return {
      accountHome,
      prepareHome,
      wrap: (command) => [SANDBOX_EXEC, "-p", profile, ...command],
      async confine({ hidden, own, readonly = [], writeDenied = [], claudeCode }) {
        const real = async (paths: readonly string[]) => await Promise.all(paths.map(canonical));
        const hiddenPaths = await real(hidden);
        const readablePaths = await real(readonly);
        const protectedInputs = hiddenPaths.filter((path) => readablePaths.some((root) => path === root || path.startsWith(`${root}${sep}`)));
        const claudeRoot = join(accountHome, ".claude");
        const sessionPaths = claudeCode ? [
          join(claudeRoot, "projects", claudeProjectName(await canonical(claudeCode.projectRoot))),
          ...["file-history", "session-env", "tasks", "uploads"].map((name) => join(claudeRoot, name, claudeCode.sessionId)),
        ] : [];
        return isolationOf([
          ...(claudeCode ? [
            `(allow file-read-data file-write* ${subpaths(sessionPaths)} (literal ${quoted(join(claudeRoot, "debug", `${claudeCode.sessionId}.txt`))}) (regex #"^${regexPath(join(claudeRoot, "todos", `${claudeCode.sessionId}-agent-`))}[^/]+\\.json$"))`,
          ] : []),
          `(deny file-read-data file-write* ${subpaths(hiddenPaths)})`,
          ...(writeDenied.length > 0 ? [`(deny file-write* ${subpaths(await real(writeDenied))})`] : []),
          `(allow file-read-data file-write* ${subpaths(await real(own))})`,
          ...(readablePaths.length > 0 ? [`(allow file-read-data ${subpaths(readablePaths)})`] : []),
          ...(protectedInputs.length > 0 ? [`(deny file-read-data file-write* ${subpaths(protectedInputs)})`] : []),
        ]);
      },
    };
  };
  return isolationOf([]);
}
