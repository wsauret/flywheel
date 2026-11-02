import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../../../infra/atomic-write.js";
import type { OsAccount } from "../../../infra/os-account.js";
import { MAX_TIMER_MS } from "../../../infra/timers.js";
import type { BridgeRequest } from "./cli-view.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "./names.js";
import { STEP_GATE_SOCKET_VARIABLE } from "./step-gate.js";

/** The host variables the engine inherits. `USER` comes from the OS account, the home variables name the engine's
 *  own home, and `TZ` names the zone of Flywheel's own dates where they have one (not on Windows). Everything else,
 *  including `LANG`, `LC_ALL`, every `XDG_*` variable, every `CLAUDE_*` and `ANTHROPIC_*` variable, and every
 *  credential, stays out. The engine finds `security`, `git`, and `ps` on the PATH. */
const INHERITED_VARIABLES = ["PATH", "SHELL"] as const;

/**
 * Fixed toggles of every engine that Flywheel starts: a query, the listing and usage engines, a login, and a logout.
 * With the separation toggles, the engine's home,
 * `CLAUDE_CONFIG_DIR`, and `CLAUDE_CODE_TMPDIR` in directories that Flywheel owns, an engine reads and writes
 * nothing of the person's own `claude` installation, and that installation finds nothing of the engine's. The machine's
 * `claude` policy
 * (managed settings) is the one thing both read: the public engine has no switch that moves it. The usage engine runs
 * with all of them except the switch that stops nonessential traffic (`planUsageEnvironment`).
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
  // reply. Only the usage engine runs without it, on a private copy of the login's settings (`planUsageEnvironment`).
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
  // Without this switch, plugin hooks use a dedicated Worker, about 23 MB of private memory per engine.
  CLAUDE_CODE_HOOKS_SAME_THREAD: "1",
} as const;

/** Documented engine toggles that every query sets. */
const QUERY_TOGGLES = {
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  CLAUDE_CODE_MAX_RETRIES: "0",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
  // Without it the CLI resends an unattributed HTTP 400 once (its server-fallback path), which native Flywheel never does.
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
  // Flywheel's stall watchdog owns stream liveness (bridge rule 8), as on native: 600 s to the first event and 300 s
  // between events. Both engine idle timers are at their maximum, so neither races that watchdog. Without the second,
  // a response that sends nothing for 300 s ends inside the engine as a stall ("Stream idle timeout - no chunks
  // received", CLI 2.1.296), also before its first event, where native's fetch ends it with a timeout. A response
  // that sends nothing still ends inside the engine at 360 s, which no switch moves, and natively at 300 s
  // (sdk-events.ts gives both the native failure).
  CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1800000",
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1800000",
  // A handler waits for Flywheel's dispatcher, however long a tool runs.
  MCP_TOOL_TIMEOUT: String(MAX_TIMER_MS),
  // With its compaction off, the CLI otherwise stops a request locally near its window (about 177k on a 200k
  // model) and sends nothing, which also stops Flywheel's checkpoint request. Native sends every request, so an
  // overflow arrives as the provider's prompt-too-long 400 and becomes ContextLengthExceededError.
  CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "100000000",
  // Native Flywheel never loads the login's claude.ai connectors. The CLI's connector fetch (CLI 2.1.295) stops
  // only for this variable, a setting, safe mode, or a non-OAuth login; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  // does not stop it.
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  // The CLI's internal Anthropic client then logs the status and headers of each response (`response start`,
  // `response error`), from which the bridge rebuilds the native failure with its request id and retry delay
  // (stderr-signals.ts). Never `verbose`: that level also writes the request's authorization.
  ANTHROPIC_LOG: "debug",
} as const;

/** What every engine that this process starts shares, whichever login it runs on. */
export interface EngineHost {
  /** The `claude` engine that ships with Flywheel (`enginePath`). */
  readonly enginePath: string;
  /** The account the engine runs on (`cliAccount`). The engine names its keychain item for `USER`, and on macOS the
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

/** What the host fixes in the environment of every engine it runs on one login. */
export interface CliEnvironmentConfig extends EngineHost {
  /** The account's absolute `CLAUDE_CONFIG_DIR`. The engine owns the login there. */
  readonly configDir: string;
}

/** The directory that the engine reads as the project's `claude` configuration (`--project-config-root`): the
 *  login's config directory, which holds no `.claude` directory and no `.mcp.json`. The engine then reads none of
 *  the project's own `.claude` settings, commands, agents, skills, or MCP servers, which belong to the person's
 *  own `claude` installation, while the query still runs in the project. */
export function projectConfigRoot(config: Pick<CliEnvironmentConfig, "configDir">): string {
  return config.configDir;
}

/** What every engine on the login in `config.configDir` gets: the allowlist, the OS account's user, the engine's own
 *  home, the directories that Flywheel owns, and the separation toggles. `CLAUDE_CONFIG_DIR` is always set, so no
 *  engine that Flywheel starts reads or writes the default directory, which the person's own `claude` installation uses. The
 *  engine names its keychain item after that exact path, so each login keeps an item of its own. On macOS it also
 *  places the login's `security` launcher (`keychainFolder`). */
function separatedEnvironment(config: CliEnvironmentConfig) {
  const inherited = Object.fromEntries(INHERITED_VARIABLES.flatMap((name) => {
    const value = config.hostEnvironment[name];
    return value === undefined ? [] : [[name, value] as const];
  }));
  const home = join(config.configDir, "home");
  const hostPath = config.hostEnvironment["PATH"];
  return {
    // The engine's own home, the `home` folder in the login's directory, by each name that the engine reads it by:
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
    USER: config.account.user,
    ...inherited,
    ...(config.timeZone === undefined ? {} : { TZ: config.timeZone }),
    ...(config.platform === "darwin" ? { PATH: hostPath === undefined ? keychainFolder(config) : `${keychainFolder(config)}:${hostPath}` } : {}),
    CLAUDE_CONFIG_DIR: config.configDir,
    CLAUDE_CODE_TMPDIR: config.temporaryDirectory,
    ...ENGINE_TOGGLES,
  };
}

/**
 * The folder of the login's `security` launcher, which the engine on macOS finds first on its PATH. The system command
 * finds the login keychain only through `HOME`, and the engine's `HOME` is its own home, so the launcher runs
 * `/usr/bin/security` in the home that owns the login. Every keychain read, write, and delete of the engine then reaches the
 * login keychain as before, and its items keep their names, which come from `CLAUDE_CONFIG_DIR` and `USER`. The
 * launcher is written whenever its text differs, so a login that an earlier Flywheel made gets it at its next engine.
 */
function keychainFolder(config: CliEnvironmentConfig): string {
  const folder = join(config.configDir, "keychain");
  const launcher = join(folder, "security");
  const script = `#!/bin/sh\nHOME=${shellQuoted(loginOwnerHome(config.configDir, config.account.home))} exec /usr/bin/security "$@"\n`;
  if (fileText(launcher) !== script) writeFileAtomic(launcher, script, { mode: 0o755 });
  return folder;
}

/** The home owning a profile login. Non-profile directories keep the host's home, as existing test and benchmark seams require. */
export function loginOwnerHome(configDir: string, hostHome: string): string {
  const accounts = dirname(resolve(configDir));
  const profile = dirname(accounts);
  const profiles = dirname(profile);
  const auth = dirname(profiles);
  const flywheel = dirname(auth);
  return basename(accounts) === LOGIN_ACCOUNTS_DIRECTORY && basename(profiles) === "profiles" && basename(auth) === "auth" && basename(flywheel) === ".flywheel"
    ? dirname(flywheel)
    : hostHome;
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

/** The environment of the login and logout commands: the separated environment, then the test override. */
export function cliLoginEnvironment(config: CliEnvironmentConfig) {
  return { ...separatedEnvironment(config), ...config.cliEnvironment };
}

/** What one query adds: its model, its declared tools, the native thinking field, the other body fields the CLI
 *  forwards, the request controls that the engine takes only from its environment, and the socket of its step gate.
 *  An engine that runs no turn, such as the listing engine, has no model, no controls, and no gate. */
interface CliEnvironmentLaunch {
  readonly model?: string;
  readonly controls?: RequestControls;
  readonly tools: readonly { readonly description: string }[];
  readonly thinking?: BridgeRequest["thinking"];
  readonly extraBody: { readonly [field: string]: unknown; readonly tool_choice?: unknown; readonly max_tokens?: number };
  readonly stepGateSocket?: string;
  readonly eagerInputStreaming?: boolean;
}

/** The engine child's environment: the separated environment, the query toggles, the values computed for this query
 *  and its step gate's socket, then the test override. The benchmark's isolation probe runs the engine with it too,
 *  so the probe proves the login under the environment a query has. */
export function cliEnvironment(config: CliEnvironmentConfig, launch: CliEnvironmentLaunch) {
  // The default cap (2,048 characters) truncates Flywheel's longest tool
  // descriptions, which would change the declared tool surface.
  const longestDescription = Math.max(0, ...launch.tools.map(({ description }) => description.length));
  return {
    ...separatedEnvironment(config),
    ...QUERY_TOGGLES,
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(longestDescription + 1),
    CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ ...launch.extraBody, ...forwardedThinking(launch.thinking) }),
    // The CLI checks a `set_model` model with one request to the host unless the model is this custom option. The
    // bridge's in-place prompt change sets the query's own model, so the option keeps that change off the wire.
    ...(launch.model === undefined ? {} : { ANTHROPIC_CUSTOM_MODEL_OPTION: launch.model }),
    ...(launch.controls === undefined ? {} : controlSwitches(launch.controls, launch.thinking)),
    ...(launch.stepGateSocket === undefined ? {} : { [STEP_GATE_SOCKET_VARIABLE]: launch.stepGateSocket }),
    // The CLI's switch for `eager_input_streaming` on every tool it declares. With it, the service sends a tool's
    // input as the model writes it, without the check that the input is JSON. The shared adapter reads that text
    // against the tool's schema; the CLI refuses text that is not JSON and answers the call itself, so the bridge
    // stops that query (bridge rule 1) and Flywheel runs the call that it read.
    ...(launch.eagerInputStreaming === true ? { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" } : {}),
    ...config.cliEnvironment,
  };
}

/**
 * The environment of a shared agent host (agent-host/host.ts): a query's environment, whose request values its
 * hosted agents and its dispatcher share, with the host's own switches (spike results, "Concurrency settings"). The
 * engine starts any number of agents, because Flywheel admits each of their steps itself; no watchdog of the engine
 * fails an agent whose step the host's gate holds or whose first byte comes late; and its git status section leaves
 * the agents' system prompts. The engine's default effort stays for a host whose gate states each step's effort,
 * and a host whose requests state no effort (`statesEffort` false) turns it off, as a query does.
 * `thinking` goes into the body even with the updates display: without it the engine sends an agent's request without
 * thinking beside its own thinking context edit, which the service refuses.
 */
export function agentHostEnvironment(config: CliEnvironmentConfig, launch: Omit<CliEnvironmentLaunch, "stepGateSocket" | "controls"> & RequestControls, gateSocket: { readonly name: string; readonly path: string }) {
  return {
    ...cliEnvironment(config, { ...launch, controls: { promptCaching: launch.promptCaching, statesEffort: launch.statesEffort } }),
    CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ ...launch.extraBody, ...(launch.thinking === undefined ? {} : { thinking: launch.thinking }) }),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "1000",
    CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: String(MAX_TIMER_MS),
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    [gateSocket.name]: gateSocket.path,
    ...config.cliEnvironment,
  };
}

/**
 * The environment of the usage engine, which reads the plan's usage and runs no turn. Engine 2.1.296 sends its usage
 * request only while it may send nonessential traffic, so this engine runs without that switch and keeps every other
 * one. Its `CLAUDE_CONFIG_DIR`, and with it its home, is `settingsDir`, a private copy of the login's settings that
 * Flywheel removes after the engine stops. The account data that the engine fetches at its start therefore lands in
 * that copy, and no later engine of the login reads it. `CLAUDE_SECURESTORAGE_CONFIG_DIR` names the login's own
 * directory, where the engine finds the login's credentials, their keychain item on macOS, and the lock of a token
 * refresh: the engine reads, refreshes, and saves the login's token where every other engine of the login does, and
 * Flywheel never reads or copies it.
 */
export function planUsageEnvironment(config: CliEnvironmentConfig, settingsDir: string) {
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _usageRequest, ...environment } = cliEnvironment({ ...config, configDir: settingsDir }, { tools: [], extraBody: {} });
  return { ...environment, CLAUDE_SECURESTORAGE_CONFIG_DIR: config.configDir };
}

/** What the native request leaves out, which the engine would otherwise add to every request of its query. */
interface RequestControls {
  /** The request carries a cache mark. */
  readonly promptCaching: boolean;
  /** The request states an effort. */
  readonly statesEffort: boolean;
}

/**
 * The engine's switches for what a native request leaves out (CLI 2.1.296, fake host). Without them, a request that
 * Flywheel keeps uncached gets 3 cache marks and, on a login, the `extended-cache-ttl-2025-04-11` beta, and one with
 * no effort, such as effort off, gets `output_config.effort` "medium". The engine adds that beta whenever its cache
 * lifetime is one hour, also with its marks off, and its 5-minute switch is the one that keeps the lifetime short. The
 * effort switch also drops an effort that the query states, so it is set only when the request states none. A request
 * that does not think, with thinking disabled or omitted (effort off), gets the engine's thinking switch: the engine
 * decides by its own settings and that switch alone whether it thinks, not by the body's thinking field, and while it
 * thinks it adds its `clear_thinking_20251015` context edit, which the service refuses beside disabled thinking (HTTP
 * 400, CLI 2.1.306). A request that thinks never gets the switch, so the engine sends its thinking context edit as
 * before.
 */
function controlSwitches(controls: RequestControls, thinking: BridgeRequest["thinking"]) {
  return {
    ...(controls.promptCaching ? {} : { DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1" }),
    ...(controls.statesEffort ? {} : { CLAUDE_CODE_EFFORT_LEVEL: "unset" }),
    ...(thinking?.type === "adaptive" || thinking?.type === "enabled" ? {} : { CLAUDE_CODE_DISABLE_THINKING: "1" }),
  };
}

/**
 * The thinking field that the body carries. With the field present, the CLI sends native Flywheel's value and
 * arms none of its thinking-display paths, one of which resends any HTTP 400 once. The updates display stays out,
 * because only the CLI's own path adds the beta header that the display needs; the SDK option then leaves the
 * display to the CLI, as before.
 */
function forwardedThinking(thinking: BridgeRequest["thinking"]) {
  return thinking === undefined || (thinking.type !== "disabled" && thinking.display === "updates") ? {} : { thinking };
}
