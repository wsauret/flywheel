import { Redacted } from "effect";
import { basename, dirname, resolve } from "node:path";
import { separatedEngineEnvironment, type EngineHost } from "../../../infra/claude-engine.js";
import { MAX_TIMER_MS } from "../../../infra/timers.js";
import { inheritsPerTurnEffort } from "../../agent-runtime/llm/model-compat.js";
import type { BridgeRequest } from "./cli-view.js";
import { LOGIN_ACCOUNTS_DIRECTORY, TOKEN_LOGIN_VARIABLE } from "./names.js";
import { STEP_GATE_SOCKET_VARIABLE } from "./step-gate.js";

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

/** What the host fixes in the environment of every engine it runs on one login. */
export interface CliEnvironmentConfig extends EngineHost {
  /** The account's absolute `CLAUDE_CONFIG_DIR`. The engine owns the login there. */
  readonly configDir: string;
  /** The token of a token login, which the engine reads in place of a login in `configDir`. */
  readonly engineToken?: Redacted.Redacted<string>;
}

/** The directory that the engine reads as the project's `claude` configuration (`--project-config-root`): the
 *  login's config directory, which holds no `.claude` directory and no `.mcp.json`. The engine then reads none of
 *  the project's own `.claude` settings, commands, agents, skills, or MCP servers, which belong to the person's
 *  own `claude` installation, while the query still runs in the project. */
export function projectConfigRoot(config: Pick<CliEnvironmentConfig, "configDir">): string {
  return config.configDir;
}

/** The shared separated environment (`separatedEngineEnvironment`) of the login in `config.configDir`, whose
 *  keychain is the one of the home that owns the login. */
function separatedEnvironment(config: CliEnvironmentConfig) {
  return separatedEngineEnvironment(config, config.configDir, loginOwnerHome(config.configDir, config.account.home));
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
  readonly modelCapabilities?: string;
}

/**
 * The value of the engine's `CLAUDE_CODE_MODEL_CAPABILITIES` for a query on `wireModelId`, or undefined when Flywheel
 * knows the model exactly. A model whose per-turn effort Flywheel only inherits from an earlier version of its family
 * (`inheritsPerTurnEffort`) is one that the bundled engine does not know either: the engine then treats it as unknown
 * and leaves per-turn effort off. The variable adds the capabilities, which the engine's catalog gives every model
 * with per-turn effort as a pair (engine 2.1.306), for that model id only; the engine reads it at each start and
 * matches the id without its `[1m]` suffix. Prompt capabilities are never passed.
 */
export function engineModelCapabilities(wireModelId: string): string | undefined {
  return inheritsPerTurnEffort(wireModelId) ? `${wireModelId}=per_turn_effort,per_turn_timing` : undefined;
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
    ...(launch.modelCapabilities === undefined ? {} : { CLAUDE_CODE_MODEL_CAPABILITIES: launch.modelCapabilities }),
    // The one place where the token leaves its redaction: the engine's own environment. Flywheel's environment never
    // holds it, so no tool command that Flywheel runs inherits it.
    ...(config.engineToken === undefined ? {} : { [TOKEN_LOGIN_VARIABLE]: Redacted.value(config.engineToken) }),
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
