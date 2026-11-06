import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileAtomic } from "./atomic-write.js";
import { checkoutProgram, runsThroughBun } from "./cli-subprocess.js";
import { localDateZone } from "./env-detection.js";
import { buildPlatformArch, checkoutClaudeEngine, claudeEngineFile, nativeAssetDir } from "./native-assets.js";
import type { OsAccount } from "./os-account.js";
import { privateTemporaryRoot } from "./private-temporary-root.js";
import type { OwnedCommandRunner } from "./owned-command.js";

// The bundled `claude` engine is a shared primitive: the Claude provider runs it for model requests and the MCP
// module runs it as the MCP client of the servers that use Claude. Neither owns where it lives or how it is kept
// apart from the person's own `claude` installation, so both read that here.

/** The host variables the engine inherits. `USER` comes from the OS account, the home variables name the engine's
 *  own home, and `TZ` names the zone of Flywheel's own dates where they have one (not on Windows). Everything else,
 *  including `LANG`, `LC_ALL`, every `XDG_*` variable, every `CLAUDE_*` and `ANTHROPIC_*` variable, and every
 *  credential, stays out. The engine finds `security`, `git`, and `ps` on the PATH. */
const INHERITED_VARIABLES = ["PATH", "SHELL"] as const;

/**
 * Fixed toggles of every engine that Flywheel starts: a query, the listing and usage engines, a login, a logout, and
 * the MCP engine. With the separation toggles, the engine's home,
 * `CLAUDE_CONFIG_DIR`, and `CLAUDE_CODE_TMPDIR` in directories that Flywheel owns, an engine reads and writes
 * nothing of the person's own `claude` installation, and that installation finds nothing of the engine's. The machine's
 * `claude` policy
 * (managed settings) is the one thing both read: the public engine has no switch that moves it. The usage engine runs
 * with all of them except the switch that stops nonessential traffic.
 */
const ENGINE_TOGGLES = {
  // The engine never checks for an update, downloads one, or installs one, and it refuses `claude update`. The
  // engine is the binary that the build verified; a newer one comes only with a Flywheel release.
  DISABLE_UPDATES: "1",
  // The background updater's own switch. DISABLE_UPDATES already stops it (CLI 2.1.296), and the CLI's own isolated
  // environment sets this one too.
  DISABLE_AUTOUPDATER: "1",
  // Without it, engine 2.1.296 fetches account data at its start (/api/claude_cli/bootstrap and the Grove, guest
  // pass, and fast mode settings) and writes it into the .claude.json of its CLAUDE_CONFIG_DIR. Later engines read
  // those caches: the bootstrap's client data can add request headers, system prompt sections, and output limits to
  // the requests of the model it was fetched for, and its model options change the model list of the initialize
  // reply. Only the usage engine runs without it, on a private copy of the login's settings.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  // No CLAUDE.md of the project or of the account reaches the engine.
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  // The engine never connects to an IDE that the person's own editor extension for `claude` serves, and never installs that
  // extension into an editor.
  CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  // The engine's switch for its cross-session messaging inbox (CLI 2.1.296). Off, the engine opens no inbox socket
  // that another `claude` session can find. On, a socket path longer than 103 bytes moves to `/tmp/cc-socks-<uid>`,
  // which every `claude` session shares, whatever the engine's temporary directory variable names.
  CLAUDE_CODE_HARBOR_KITE: "0",
  // Without this switch, the engine runs hooks in a dedicated Worker, about 23 MB of private memory per engine.
  CLAUDE_CODE_HOOKS_SAME_THREAD: "1",
} as const;

/** What every engine that this process starts shares, whichever config directory it runs on. */
export interface EngineHost {
  /** The `claude` engine that ships with Flywheel (`enginePath`). */
  readonly enginePath: string;
  /** The account the engine runs on. The engine names its keychain item for `USER`, and on macOS the
   *  system `security` command finds the login keychain through the account's home (`keychainFolder`). */
  readonly account: OsAccount;
  /** The platform the engine runs on, which decides how the engine reaches its keychain (`keychainFolder`). */
  readonly platform: NodeJS.Platform;
  /** The host environment the allowlist reads from. */
  readonly hostEnvironment: { readonly [name: string]: string | undefined };
  /** The time zone of Flywheel's own dates, as an IANA name (`localDateZone`). The engine states the local date in its
   *  date reminder, and Flywheel states it in its shared reminders and its `<env>` block, so both read the one zone.
   *  On Windows there is none: Flywheel's dates follow the system zone, as the engine's own do there. */
  readonly timeZone: string | undefined;
  /** This user's private directory for the engines' temporary files and inbox sockets, `fw-claude-<uid>` in the
   *  temporary directory. The engine's default, `/tmp`, holds the `claude-<uid>` and `cc-socks` directories that
   *  every `claude` session shares, and each session scans `cc-socks` for the sockets of other sessions. */
  readonly temporaryDirectory: string;
  /** Variables added after the allowlist. Only fake-host scripts and tests set
   *  it, to point the engine at a local host with a dummy key. */
  readonly cliEnvironment?: { readonly [name: string]: string };
}

/** This process's engine host on `account`: the bundled engine (`enginePath`), this process's environment for the
 *  allowlist and its time zone, and this user's private engine temporary directory, made on first use. Throws when the
 *  temporary directory's name belongs to another user (`privateTemporaryRoot`). */
export function processEngineHost(account: OsAccount, overrides: Partial<Pick<EngineHost, "enginePath" | "cliEnvironment">> = {}): EngineHost {
  return {
    enginePath: overrides.enginePath ?? enginePath(),
    account,
    platform: process.platform,
    hostEnvironment: process.env,
    timeZone: localDateZone(),
    temporaryDirectory: privateTemporaryRoot(tmpdir(), "fw-claude"),
    ...(overrides.cliEnvironment === undefined ? {} : { cliEnvironment: overrides.cliEnvironment }),
  };
}

/** What every engine on the config directory `configDir` gets: the allowlist, the OS account's user, the engine's own
 *  home, the directories that Flywheel owns, and the separation toggles. `CLAUDE_CONFIG_DIR` is always set, so no
 *  engine that Flywheel starts reads or writes the default directory, which the person's own `claude` installation uses. The
 *  engine names its keychain item after that exact path, so each config directory keeps an item of its own. On macOS it
 *  also places the directory's `security` launcher, which reaches the login keychain of `keychainHome`
 *  (`keychainFolder`). */
export function separatedEngineEnvironment(host: EngineHost, configDir: string, keychainHome: string) {
  const inherited = Object.fromEntries(INHERITED_VARIABLES.flatMap((name) => {
    const value = host.hostEnvironment[name];
    return value === undefined ? [] : [[name, value] as const];
  }));
  const home = join(configDir, "home");
  const hostPath = host.hostEnvironment["PATH"];
  return {
    // The engine's own home, the `home` folder in the config directory, by each name that the engine reads it by:
    // `HOME` and `USERPROFILE`, and `LOCALAPPDATA` and `APPDATA` for its Windows folders. The engine puts every folder
    // that no other variable names in its home, as the person's own `claude` installation does in the person's home: its cache
    // and MCP logs (`claude-cli-nodejs`), the native installer's folders, and the Anthropic profile store
    // (`.config/anthropic`), which is never created. So no engine writes, reads, or cleans up a file of the person's
    // own `claude` installation there, and that installation finds none of the engine's. The process that supervises the engine gets the
    // same environment, so the cache of its Bun runtime is in this home too.
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    USER: host.account.user,
    ...inherited,
    ...(host.timeZone === undefined ? {} : { TZ: host.timeZone }),
    ...(host.platform === "darwin" ? { PATH: hostPath === undefined ? keychainFolder(configDir, keychainHome) : `${keychainFolder(configDir, keychainHome)}:${hostPath}` } : {}),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_TMPDIR: host.temporaryDirectory,
    ...ENGINE_TOGGLES,
  };
}

/**
 * The folder of the config directory's `security` launcher, which the engine on macOS finds first on its PATH. The
 * system command finds the login keychain only through `HOME`, and the engine's `HOME` is its own home, so the launcher
 * runs `/usr/bin/security` in `keychainHome`. Every keychain read, write, and delete of the engine then reaches the
 * login keychain as before, and its items keep their names, which come from `CLAUDE_CONFIG_DIR` and `USER`. The
 * launcher is written whenever its text differs, so a directory that an earlier Flywheel made gets it at its next engine.
 */
function keychainFolder(configDir: string, keychainHome: string): string {
  const folder = join(configDir, "keychain");
  const launcher = join(folder, "security");
  const script = `#!/bin/sh\nHOME=${shellQuoted(keychainHome)} exec /usr/bin/security "$@"\n`;
  if (fileText(launcher) !== script) writeFileAtomic(launcher, script, { mode: 0o755 });
  return folder;
}

/** `text` as one single-quoted word of a POSIX shell. */
function shellQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The text of the file at `path`, or nothing when it cannot be read. */
function fileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The Claude logins of the resolved auth profile, as the Claude provider module offers them to the MCP module for
 *  claude.ai connectors. Each login starts engines that hold it; the login's token stays with those engines, and
 *  nothing here carries it. */
export interface ClaudeLoginEngines {
  /** The logins in profile order, each account once; none while the Claude provider module is off. */
  logins(): Promise<readonly ClaudeLoginHost[]>;
}

export interface ClaudeLoginHost {
  /** An opaque key of this login location, which tells the logins of different auth profiles apart also when they
   *  hold the same account. Engines that run on one key run on one login. */
  readonly key: string;
  /** The login's stable account id, which is no secret. */
  readonly accountId: string;
  /** The login as a person reads it, such as an email address. */
  readonly identity: string;
  /** Starts an engine on the login that runs no model turn. It never writes to the login's directory and stops by
   *  the login's stop procedure. Rejects when the engine cannot start or the login is signed out. */
  start(launch: ClaudeLoginEngineLaunch): Promise<ClaudeLoginEngine>;
}

export interface ClaudeLoginEngineLaunch {
  /** Whether the engine fetches the login's claude.ai connectors and connects them. */
  readonly connectors: boolean;
  /** Receives each stderr line of an engine that writes its API client's debug log there, with every credential
   *  header masked by that client. Without it the engine writes no such log and its stderr is dropped. */
  readonly debugLog?: (line: string) => void;
}

export interface ClaudeLoginEngine {
  readonly query: Query;
  /** Settles when the engine process has ended, for any reason, and what it ran on was removed. */
  readonly ended: Promise<void>;
  /** Stops the engine, after any token refresh of the login ended, and removes what it ran on. */
  stop(): Promise<void>;
}

/** A `--version` call takes about 150 ms. */
const VERSION_BOUND_MS = 10_000;

/**
 * The `claude` engine that ships with Flywheel: the platform binary of the pinned Agent SDK, `claude` or
 * `claude.exe`. A release runs the copy that its build placed in the build's native directory, which the build
 * verified against the SDK's manifest. A source run runs the copy in the SDK's platform package, which `bun install`
 * placed from the lockfile in the checkout. A dev service's source snapshot pins that copy when the snapshot is made,
 * so a service runs the engine it started with until it restarts, whatever a later install places in the checkout.
 * Flywheel never runs a `claude` from the PATH, so the person's own `claude` installation and its updates never change what
 * serves Flywheel. Nothing here runs or reads the engine, so it starts only when a query, a login, or `/doctor` starts
 * it.
 */
export function enginePath(): string {
  const platformArch = buildPlatformArch();
  if (!runsThroughBun(process.execPath)) return join(nativeAssetDir(), claudeEngineFile(platformArch));
  return checkoutProgram(checkoutClaudeEngine(platformArch));
}

/** What `<engine> --version` names, run through the caller's owned-command runner. The call prints the version and
 *  exits: it reads no login, writes no file, and sends nothing. Rejects with the reason that it named none. */
export async function readEngineVersion(engine: string, run: OwnedCommandRunner): Promise<string> {
  const result = await run([engine, "--version"], { timeoutMs: VERSION_BOUND_MS });
  if (result.timedOut) throw new Error(`it did not answer --version within ${VERSION_BOUND_MS / 1000} s`);
  if (result.exitCode !== 0) throw new Error(`its --version call exited with code ${String(result.exitCode)}`);
  const version = /^(\d+\.\d+\.\d+)\b/u.exec(result.stdout.trim())?.[1];
  if (version === undefined) throw new Error("its --version output names no version");
  return version;
}
