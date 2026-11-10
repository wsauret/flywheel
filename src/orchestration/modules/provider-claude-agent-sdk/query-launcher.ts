import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, USAGE_LIMIT_ERROR_PREFIXES, type EffortLevel, type McpSdkServerConfigWithInstance, type ModelInfo, type Options, type Query, type SDKMessage, type SDKUserMessage, type ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Option, Schedule } from "effect";
import { awaitWithAbortSignal } from "../../../infra/abort.js";
import { DebugLog } from "../../../infra/debug-log.js";
import { isProcessAlive } from "../../../infra/process-liveness.js";
import type { ClaudeLoginEngine, ClaudeLoginEngineLaunch } from "../../../infra/claude-engine.js";
import { engineModelId } from "../../agent-runtime/llm/claude-reminders.js";
import { SYSTEM_PROMPT_SEPARATOR } from "../../agent-runtime/llm/system-prompt-tiers.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { TOOL_MCP_SERVER, TOOL_MCP_PREFIX, globalConfigPath, legacyRefreshLockPath, mcpToolAliases, REFRESH_LOCK_BOUND_MS, REFRESH_LOCK_POLL_MS, refreshLockPath, refreshStopHold } from "./names.js";
import { ownedClaudeProcess, type OwnedClaudeProcess } from "../../../infra/claude-engine-process.js";
import { agentHostEnvironment, cliEnvironment, planUsageEnvironment, projectConfigRoot, type CliEnvironmentConfig } from "./cli-environment.js";
import type { BridgeRequest, CliBlock } from "./cli-view.js";
import { serveStepGate, type PluginGateServer, type StepGate, type StepGateEvidence } from "./step-gate.js";
import { countTokensRefusesModel } from "./stderr-signals.js";
import type { CliAssistantMessage } from "./transcript.js";
import { usageReplyWindows, type UsageReply } from "./account-usage.js";

// This file is the only one that imports a value from
// `@anthropic-ai/claude-agent-sdk` (bridge rule 10). Every query therefore
// starts here, always through Flywheel's owned launcher and the engine that ships with Flywheel.

const INTERRUPT_BOUND_MS = 5_000;
/** The SDK's own close waits about 2 s before it kills; this bound covers it. */
const EXIT_BOUND_MS = 5_000;
/** A CLI refuses a rewind for a few milliseconds after a turn result, while it ends the turn. The bridge asks again
 *  this often, at most `REWIND_TRIES` times. */
const REWIND_RETRY_MS = 5;
const REWIND_TRIES = 200;

/** What the host fixes for every query of one bridge. */
export interface QueryLauncherConfig extends CliEnvironmentConfig {
  readonly launcher: LauncherScope;
}

/** A declared tool as the CLI receives it from the `runtime` MCP server. */
interface DeclaredTool {
  /** The MCP tool name, without the `mcp__runtime__` prefix. */
  readonly name: string;
  readonly description: string;
}

/** A user message that the bridge writes to the CLI. A replayed row has `shouldQuery: false`: the CLI adds it to its
 *  conversation, sends no request, and answers it with one turn result. */
export interface CliUserFrame {
  readonly type: "user";
  readonly uuid: string;
  readonly message: { readonly role: "user"; readonly content: readonly CliBlock[] };
  readonly parent_tool_use_id: null;
  readonly shouldQuery?: false;
}

/** An assistant message that the bridge replays. The CLI adds it to its conversation at once and answers nothing. */
interface CliAssistantFrame {
  readonly type: "assistant";
  readonly uuid: string;
  readonly session_id: "";
  readonly parent_tool_use_id: null;
  readonly message: CliAssistantMessage;
}

export type CliFrame = CliUserFrame | CliAssistantFrame;

/** How a rewind ended: the CLI cut its conversation, or it refused with its reason. */
type RewindOutcome = { readonly rewound: true } | { readonly rewound: false; readonly reason: string };

/** What one engine fixes when it starts, whatever conversation it serves: every launch value of `QueryIdentity` apart
 *  from the system prompt and the working directory, and the engine's own gates. A change to any field is a
 *  rotation. */
export interface EngineLaunch {
  readonly prompt: AsyncIterable<CliFrame>;
  /** The in-process `runtime` MCP server, as the SDK hosts it. */
  readonly mcpServer: McpSdkServerConfigWithInstance["instance"];
  /** The query's step admission, which the step gate plugin's hook asks before each model request. */
  readonly stepGate: Pick<StepGate, "ask">;
  readonly tools: readonly DeclaredTool[];
  readonly wireModelId: string;
  readonly contextLimit: number;
  /** The native request's thinking field. The SDK option states the setting, and the CLI environment puts the field in
   *  the body. */
  readonly thinking: BridgeRequest["thinking"];
  readonly effort?: EffortLevel;
  /** The request carries a cache mark. A query without one starts with the engine's switch that turns its marks off. */
  readonly promptCaching: boolean;
  /** Body fields the CLI forwards besides `thinking`: only `tool_choice` and the output clamp. */
  readonly extraBody: { readonly [field: string]: unknown; readonly tool_choice?: unknown; readonly max_tokens?: number };
  /** The tools stream their input as the model writes it, as the native request asks. */
  readonly eagerInputStreaming: boolean;
  /** The engine's `CLAUDE_CODE_MODEL_CAPABILITIES` for a model that the engine does not know (`engineModelCapabilities`). */
  readonly modelCapabilities?: string;
  readonly onStderrLine: (line: string) => void;
}

/** The query identity that the bridge fixes at launch. A change to any field
 *  is a rotation. */
export interface QueryLaunch extends EngineLaunch {
  /** The text of each system block, in order: the stable tier first, then the session tier. */
  readonly systemPrompt: readonly string[];
  readonly cwd: string;
  /** A fresh query takes the id; a rotation resumes it at one transcript row. */
  readonly session: { readonly kind: "fresh"; readonly id: string } | { readonly kind: "resume"; readonly id: string; readonly at: string };
}

/** How one stop ended, for the bridge's diagnostics. */
export interface QueryStop {
  readonly interrupted: boolean;
  readonly lockWaitMs: number;
  readonly lockTimedOut: boolean;
  readonly terminated: boolean;
}

/** The parts of a query that the bridge uses: its message stream, and the interrupt and close of the stop
 *  procedure. An effort is a launch value (`QueryIdentity.effort`). */
type BridgeQuery = Pick<Query, typeof Symbol.asyncIterator | "interrupt" | "close">;

export interface LaunchedQuery {
  readonly query: BridgeQuery;
  readonly process: OwnedClaudeProcess;
  /** Replaces the custom system prompt from the next request on: the CLI's internal `set_model` request with the
   *  query's model and `system_prompt`. The CLI takes one text. */
  setSystemPrompt(prompt: string): Effect.Effect<void, Error>;
  /** Cuts the CLI's conversation before the user row `target` with the CLI's internal `rewind_conversation`
   *  request. `lastSeen` is the newest user row that the bridge wrote. A refusal while the CLI ends a turn is asked
   *  again. */
  rewind(target: string, lastSeen: string): Effect.Effect<RewindOutcome, Error>;
  /** Stops the query by bridge rule 3. `turnActive` is the bridge's phase: an
   *  interrupt on an idle CLI never settles, so only an active turn gets one. */
  stop(turnActive: boolean): Effect.Effect<QueryStop>;
  /** What the query's step gate served so far. */
  stepGateEvidence(): StepGateEvidence;
  /** Closes the step gate's socket and the nested launch scope, after the stop. */
  close(): Promise<void>;
}

/** The files the stop procedure reads and removes. Tests replace it. */
export interface StopFiles {
  refreshLockHeld(): boolean;
  legacyLockLeft(): boolean;
  /** Removes the session record and inbox socket that a killed CLI of `sessionId` leaves behind. */
  removeKilledLeftovers(sessionId: string): void;
}

export type QueryFunction = typeof query;

/**
 * The one factory for bridge queries. Each launch opens a nested launcher scope
 * and passes `spawnClaudeCodeProcess` and `pathToClaudeCodeExecutable`, so the
 * SDK never starts a process of its own or a CLI other than the bundled engine. Each
 * launch also serves the query's step gate on a socket of its own and loads its
 * own copy of the gate plugin, whose hook finds that socket in the CLI's
 * environment. A launch that fails releases the gate and the nested scope.
 */
export function createQueryLauncher(config: QueryLauncherConfig, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): (launch: QueryLaunch) => LaunchedQuery {
  return (launch) => {
    const asRoot = process.getuid?.() === 0;
    const owned = ownedClaudeProcess(config.launcher, launch.onStderrLine, refreshStopHold(config.configDir));
    const model = engineModelId(launch.wireModelId, launch.contextLimit);
    let gate: PluginGateServer | undefined;
    try {
      const server = serveStepGate(launch.stepGate);
      gate = server;
      const options: Options = {
        cwd: launch.cwd,
        env: cliEnvironment(config, { ...launch, model, controls: { promptCaching: launch.promptCaching, statesEffort: launch.effort !== undefined }, stepGateSocket: server.socketPath }),
        model,
        pathToClaudeCodeExecutable: config.enginePath,
        spawnClaudeCodeProcess: owned.spawn,
        systemPrompt: { type: "custom", prompt: cliSystemPrompt(launch.systemPrompt), snapshot: false },
        tools: [],
        plugins: [{ type: "local", path: server.pluginPath }],
        mcpServers: { [TOOL_MCP_SERVER]: { type: "sdk", name: TOOL_MCP_SERVER, instance: launch.mcpServer } },
        strictMcpConfig: true,
        toolAliases: mcpToolAliases(launch.tools.map(({ name }) => name)),
        settingSources: [],
        // The CLI refuses bypassPermissions as root, so root allows the declared
        // Flywheel tools by name instead.
        ...(asRoot
          ? { permissionMode: "default", allowedTools: launch.tools.map(({ name }) => `${TOOL_MCP_PREFIX}${name}`) }
          : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
        persistSession: false,
        includePartialMessages: true,
        // Without it the CLI answers `/command` text itself and expands `@path`.
        verbatimPrompts: true,
        thinking: sdkThinking(launch.thinking),
        ...(launch.effort === undefined ? {} : { effort: launch.effort }),
        extraArgs: { "debug-to-stderr": null, "project-config-root": projectConfigRoot(config) },
        ...(launch.session.kind === "fresh" ? { sessionId: launch.session.id } : { resume: launch.session.id, resumeSessionAt: launch.session.at }),
      };
      // SAFETY: the SDK writes each prompt item to the CLI unchanged, and the CLI reads assistant frames from the same input.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK types its prompt as user messages only
      const started = sdkQuery({ prompt: launch.prompt as AsyncIterable<SDKUserMessage>, options });
      const internal = internalRequests(started);
      return {
        query: started, process: owned, stop: (turnActive) => stopQuery(started, owned, launch.session.id, files, turnActive),
        setSystemPrompt: (prompt) => internal({ subtype: "set_model", model, system_prompt: prompt }, () => undefined),
        rewind: (target, lastSeen) => internal({ subtype: "rewind_conversation", target_message_uuid: target, last_seen_user_message_uuid: lastSeen }, rewindOutcome).pipe(
          Effect.repeat({ while: (outcome) => !outcome.rewound && (outcome.reason === "turn_running" || outcome.reason === "commands_queued"), schedule: Schedule.spaced(REWIND_RETRY_MS), times: REWIND_TRIES }),
        ),
        stepGateEvidence: server.evidence,
        close: async () => {
          server.close();
          await owned.close();
        },
      };
    } catch (error) {
      // No query owns the gate or the nested launch scope yet, so a failed launch releases both here.
      gate?.close();
      void owned.close();
      throw error;
    }
  };
}

/**
 * The CLI sends a custom prompt as one system block with a cache mark at its end, so two queries that share
 * only the stable tier, such as two agents of a workflow, would share no mark past the CLI's identity line. The
 * documented boundary after the first block makes the CLI send the stable tier and the rest as two marked
 * blocks, as native Anthropic requests do, so the later query reads the tools, the identity, and the stable
 * tier from cache. The CLI gives the stable block the global cache scope, and no option changes that scope.
 * The blocks after the first, the session and the conversation tier, travel as one text joined with the tier
 * separator, as every route without its own breakpoints joins them, so the CLI marks the end of that text only.
 * A single block passes unchanged.
 *
 * The CLI splits at the boundary only on a first-party login that is not a HIPAA organization and does not set
 * CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS (CLI 2.1.293 `Qle`). The CLI environment sets neither that toggle nor
 * a base URL, so only a HIPAA-organization login fails the condition. On that login the CLI drops the boundary
 * and joins the tiers with "\n\n", not the tier separator, into one org-scoped block. A later query then reads
 * only the tools and the identity line from cache.
 */
function cliSystemPrompt(blocks: readonly string[]): string | string[] {
  const [stable = "", ...rest] = blocks;
  return rest.length === 0 ? stable : [stable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, rest.join(SYSTEM_PROMPT_SEPARATOR)];
}

/**
 * The text that the CLI's `set_model` request takes in place of `blocks`, or undefined when an in-place change would
 * not give the request that a new process gives. `set_model.system_prompt` takes one string, and the CLI splits it
 * at the boundary marker only when the marker is on its own line, keeping the newline in both blocks: two tiers sent
 * that way differ from the launch's two blocks by one character each. So only one non-empty tier without the marker
 * changes in place, and its block equals the block of a launch.
 */
export function inPlaceSystemPrompt(blocks: readonly string[]): string | undefined {
  const [only, ...rest] = blocks;
  return only === undefined || only === "" || rest.length > 0 || only.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) ? undefined : only;
}

/**
 * The CLI's internal control requests, sent through the query's own `request` method. The SDK does not declare it,
 * and the CLI's protocol marks the fields `@internal`: a CLI that does not implement one acknowledges it without
 * applying it, so the bridge uses them only on a CLI version whose in-place check passed (in-place-check.ts).
 */
function internalRequests(started: Query): InternalRequests {
  // SAFETY: every SDK query object has `request`, which writes one control request and resolves its response.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK keeps `request` out of its declared Query type
  const withRequest = started as Query & { request(request: InternalRequest): Promise<ControlResponse | undefined> };
  return (request, read) => Effect.tryPromise({
    try: async () => read(await withRequest.request(request)),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
}

type InternalRequests = <A>(request: InternalRequest, read: (response: ControlResponse | undefined) => A) => Effect.Effect<A, Error>;

/** The internal control requests of an in-place rotation, in the CLI's own field names. */
type InternalRequest =
  | { readonly subtype: "set_model"; readonly model: string; readonly system_prompt: string }
  | { readonly subtype: "rewind_conversation"; readonly target_message_uuid: string; readonly last_seen_user_message_uuid: string };

/** The CLI's answer to an internal request. Only a rewind's answer carries fields, and the bridge checks their
 *  types. */
interface ControlResponse {
  readonly response?: { readonly rewound?: unknown; readonly reason?: unknown };
}

/** The rewind result from the CLI's control response. Anything but `rewound: true` is a refusal. */
function rewindOutcome(answer: ControlResponse | undefined): RewindOutcome {
  if (answer?.response?.rewound === true) return { rewound: true };
  const reason = answer?.response?.reason;
  return { rewound: false, reason: typeof reason === "string" ? reason : "no-response" };
}

/** The SDK's thinking option for the native field. The option has no updates display, which only the CLI chooses. */
function sdkThinking(thinking: BridgeRequest["thinking"]): ThinkingConfig {
  if (thinking === undefined || thinking.type === "disabled") return { type: "disabled" };
  const display = thinking.display === "summarized" || thinking.display === "omitted" ? { display: thinking.display } : {};
  return thinking.type === "adaptive" ? { type: "adaptive", ...display } : { type: "enabled", budgetTokens: thinking.budget_tokens, ...display };
}

/** What one shared agent host fixes at its start (agent-host/host.ts): every request value that its dispatcher and
 *  its hosted agents share, its gate, and its dispatcher's prompt. */
export interface HostLaunch {
  readonly prompt: AsyncIterable<CliUserFrame>;
  readonly mcpServer: McpSdkServerConfigWithInstance["instance"];
  /** The host gate's socket and the private copy of its plugin, which also holds the agents' definitions. */
  readonly gate: { readonly socketVariable: string; readonly socketPath: string; readonly pluginPath: string };
  readonly tools: readonly DeclaredTool[];
  /** The engine's launch model, in the engine's spelling (`engineModelId`). Each agent runs on its definition's
   *  model. */
  readonly model: string;
  readonly thinking: BridgeRequest["thinking"];
  readonly promptCaching: boolean;
  /** Whether the host's requests state an effort, which its gate then states for each step. */
  readonly statesEffort: boolean;
  readonly extraBody: EngineLaunch["extraBody"];
  readonly eagerInputStreaming: boolean;
  readonly modelCapabilities?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly dispatcherPrompt: string;
  /** Decides each SendMessage call of the dispatcher from its input before the call runs: the reason that the model
   *  reads as the call's error, or undefined to let the call run unchanged. Returns at once. */
  readonly refuseDispatch: (input: unknown) => string | undefined;
  readonly onStderrLine: (line: string) => void;
}

/** A started agent host. Only its close interrupts nothing and ends the engine; one agent ends by `stopTask`. */
export interface LaunchedHost {
  readonly messages: AsyncIterable<SDKMessage>;
  readonly process: OwnedClaudeProcess;
  /** Stops the background agent `agentId`, and no other. */
  stopTask(agentId: string): Promise<void>;
  /** Loads the agent definitions that the plugin's `agents` folder holds now. */
  reloadPlugins(): Promise<void>;
  /** Cuts the dispatcher's conversation before its user row `target` (`LaunchedQuery.rewind`). Its agents run on. */
  rewind(target: string, lastSeen: string): Effect.Effect<RewindOutcome, Error>;
  /** Ends the engine by bridge rule 3 with no interrupt, after the host's gate closed. */
  stop(): Effect.Effect<QueryStop>;
  close(): Promise<void>;
}

/** The agent definition of a host's main thread. */
const DISPATCHER_AGENT = "dispatcher";

/**
 * The factory for shared agent hosts. The engine's main thread is the dispatcher: a custom prompt and the
 * `SendMessage` tool only. The main thread runs as its own agent definition, whose tool list holds only `SendMessage`,
 * because the engine otherwise offers the main thread every tool of every MCP server, so each dispatcher request
 * would carry every Flywheel tool's schema. Every agent that the host runs reads Flywheel's tools from the `runtime`
 * MCP server through its own definition's tool list, and the
 * engine persists its session, because the agent files are where Flywheel reads each response's signed thinking
 * (agent-host/agent-file.ts). The thinking option names the agents' thinking; the environment puts the field in
 * every request's body (`agentHostEnvironment`). The dispatcher's SendMessage calls pass a PreToolUse hook, the
 * engine's tool gate in every permission mode: `canUseTool` never hears SendMessage, which allows itself, nor any
 * call under bypassPermissions. The hosted agents call only Flywheel's tools, which the hook's matcher leaves out.
 */
export function createHostLauncher(config: QueryLauncherConfig, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): (launch: HostLaunch) => LaunchedHost {
  return (launch) => {
    const asRoot = process.getuid?.() === 0;
    const owned = ownedClaudeProcess(config.launcher, launch.onStderrLine, refreshStopHold(config.configDir));
    // SAFETY: the SDK writes each prompt item to the CLI unchanged.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK types its prompt as user messages only
    const prompt = launch.prompt as AsyncIterable<SDKUserMessage>;
    try {
      const started = sdkQuery({
        prompt,
        options: {
          cwd: launch.cwd,
          env: agentHostEnvironment(config, launch, { name: launch.gate.socketVariable, path: launch.gate.socketPath }),
          model: launch.model,
          pathToClaudeCodeExecutable: config.enginePath,
          spawnClaudeCodeProcess: owned.spawn,
          systemPrompt: { type: "custom", prompt: launch.dispatcherPrompt, snapshot: false },
          tools: ["SendMessage"],
          agents: { [DISPATCHER_AGENT]: { description: "Starts Flywheel agents", prompt: launch.dispatcherPrompt, tools: ["SendMessage"] } },
          agent: DISPATCHER_AGENT,
          plugins: [{ type: "local", path: launch.gate.pluginPath }],
          hooks: { PreToolUse: [{ matcher: "SendMessage", hooks: [async (input) => {
            const reason = input.hook_event_name === "PreToolUse" ? launch.refuseDispatch(input.tool_input) : undefined;
            return reason === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
          }] }] },
          mcpServers: { [TOOL_MCP_SERVER]: { type: "sdk", name: TOOL_MCP_SERVER, instance: launch.mcpServer } },
          strictMcpConfig: true,
          toolAliases: mcpToolAliases(launch.tools.map(({ name }) => name)),
          settingSources: [],
          ...(asRoot
            ? { permissionMode: "default", allowedTools: ["SendMessage", ...launch.tools.map(({ name }) => `${TOOL_MCP_PREFIX}${name}`)] }
            : { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
          persistSession: true,
          includePartialMessages: false,
          verbatimPrompts: true,
          thinking: sdkThinking(launch.thinking),
          sessionId: launch.sessionId,
          extraArgs: { "debug-to-stderr": null, "project-config-root": projectConfigRoot(config) },
        },
      });
      const internal = internalRequests(started);
      return {
        messages: started, process: owned,
        stopTask: (agentId) => started.stopTask(agentId),
        reloadPlugins: async () => { await started.reloadPlugins(); },
        rewind: (target, lastSeen) => internal({ subtype: "rewind_conversation", target_message_uuid: target, last_seen_user_message_uuid: lastSeen }, rewindOutcome).pipe(
          Effect.repeat({ while: (outcome) => !outcome.rewound && (outcome.reason === "turn_running" || outcome.reason === "commands_queued"), schedule: Schedule.spaced(REWIND_RETRY_MS), times: REWIND_TRIES }),
        ),
        stop: () => stopQuery(started, owned, launch.sessionId, files, false),
        close: async () => { await owned.close(); },
      };
    } catch (error) {
      void owned.close();
      throw error;
    }
  };
}

/** What the CLI states about its login when it starts: the model lineup it offers and whether it holds a login. */
export interface CliLoginDescription {
  readonly models: readonly ModelInfo[];
  /** False when the CLI names no token source, which is how a CLI with no login answers. */
  readonly loggedIn: boolean;
  /** The login's plan as the CLI names it, such as "Claude Max". */
  readonly plan?: string;
}

/** The CLI's answer about the usage of its login: its reply to the usage request, which the SDK declares
 *  experimental and the caller reads as data of unknown shape, or no reply when the CLI holds no login. */
export type CliUsage = { readonly loggedIn: false } | { readonly loggedIn: true; readonly reply: unknown; readonly plan?: string };

/** The plan that the CLI's initialize reply names for its login, which it reads from the login's own profile. */
function initPlan(init: Awaited<ReturnType<Query["initializationResult"]>>): { readonly plan?: string } {
  const plan = init.account.subscriptionType;
  return typeof plan === "string" && plan.length > 0 ? { plan } : {};
}

/** Why the caller started an idle CLI, for its stop record. The connector engines run for the MCP module's claude.ai
 *  connectors: one that calls them, and one that reads their tool definitions. */
type IdleCliPurpose = "models" | "usage" | "access-probe" | "connector-calls" | "connector-discovery";

/** How an idle CLI's answer ended, for its stop record. A connector engine ends when its holder releases it, or
 *  `exited` on its own. */
type IdleCliEnd = "reply" | "failed" | "aborted" | "released" | "exited";

type UsageReplyKind = UsageReply["kind"] | "logged-out";

/**
 * Asks the CLI that holds the login in `config.configDir` for its model lineup and whether it holds a login. The
 * initialize reply comes from the CLI's local data: it sends no model request and uses no quota.
 */
export function describeCliLogin(config: QueryLauncherConfig, signal: AbortSignal, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): Promise<CliLoginDescription> {
  return askIdleCli(config, signal, { purpose: "models" }, async (_, init) => ({ models: init.models, loggedIn: init.account.tokenSource !== "none", ...initPlan(init) }), sdkQuery, files);
}

/**
 * Asks the CLI that holds the login in `config.configDir` for the usage of its login, the data of its `/usage`
 * command, without the scan of local transcripts. The CLI reads the plan's usage with its own token, which stays
 * with the CLI, and sends no model request. It runs on a private copy of the login's settings (`idleEngine`), so the
 * account data that it fetches at its start reaches no later engine of the login. A CLI that holds no login is not
 * asked.
 */
export function readCliUsage(config: QueryLauncherConfig, signal: AbortSignal, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): Promise<CliUsage> {
  return askIdleCli(config, signal, { purpose: "usage" }, async (started, init) => init.account.tokenSource === "none"
    ? { loggedIn: false }
    : { loggedIn: true, reply: await started.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), ...initPlan(init) }, sdkQuery, files,
  (usage) => usage.loggedIn ? usageReplyWindows(usage.reply).kind : "logged-out");
}

/** What one access probe of a model observed: the engine's token count for the model, which is 0 when the count
 *  failed, and whether the engine's debug output reported that the service does not serve the model to the login. */
export interface CliModelProbe {
  readonly totalTokens: number;
  readonly refused: boolean;
}

/**
 * Asks the login in `config.configDir` whether it serves `wireModelId` with the engine's free token count, which sends
 * no model request and uses none of the login's usage. The engine starts on the model as its custom model option, so
 * it sends no billed request to validate the model, and its context usage request counts the tokens of an empty
 * conversation for that model at the service's `count_tokens` endpoint (engine 2.1.306). The engine answers a failed
 * count with 0 tokens, so the refusal is read from its debug output (`countTokensRefusesModel`). The answer returns
 * after the engine stopped, so each line that the engine wrote before its reply was read. The stop and the abort are
 * those of every idle CLI (`askIdleCli`); `signal` bounds the wait.
 */
export async function probeCliModel(config: QueryLauncherConfig, wireModelId: string, signal: AbortSignal, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): Promise<CliModelProbe> {
  let refused = false;
  const onStderrLine = (line: string): void => {
    refused ||= countTokensRefusesModel(line, wireModelId);
  };
  const totalTokens = await askIdleCli(config, signal, { purpose: "access-probe", model: wireModelId, onStderrLine }, async (started) => (await started.getContextUsage()).totalTokens, sdkQuery, files);
  return { totalTokens, refused };
}

/** Why the caller starts an idle CLI. The access probe's engine also takes the probed model and reads its own debug
 *  output. */
type IdleCliStart =
  | { readonly purpose: Exclude<IdleCliPurpose, "access-probe"> }
  | { readonly purpose: "access-probe"; readonly model: string; readonly onStderrLine: (line: string) => void };

/**
 * Starts one CLI on the login in `config.configDir`, waits for its initialize reply, and asks it one question with
 * `ask`. The CLI gets no tools, no settings, and a prompt that never yields, so no turn starts.
 *
 * The CLI is stopped by bridge rule 3 once the answer arrives, fails, or `signal` aborts. The answer waits for that
 * stop, so a short-lived owner such as `flywheel auth` does not close its launcher on a CLI that is still stopping.
 * `signal` bounds the wait: an abort rejects at once with its reason, and an answer that arrived returns at once,
 * while the stop goes on in the caller's launcher scope and still waits for a token refresh to end. The prompt stays
 * open throughout that wait and ends immediately before the query's close. Each stop is recorded once.
 */
async function askIdleCli<A>(
  config: QueryLauncherConfig, signal: AbortSignal, start: IdleCliStart,
  ask: (started: Query, init: Awaited<ReturnType<Query["initializationResult"]>>) => Promise<A>, sdkQuery: QueryFunction, files: StopFiles,
  classifyReply?: (value: A) => UsageReplyKind,
): Promise<A> {
  // A caller that already left wants no answer, so no CLI starts for it.
  signal.throwIfAborted();
  const { purpose } = start;
  const probe = start.purpose === "access-probe" ? start : undefined;
  const engine = idleEngine(config, purpose, probe?.model);
  const owned = ownedClaudeProcess(config.launcher, probe?.onStderrLine ?? (() => {}), refreshStopHold(config.configDir));
  const sessionId = randomUUID();
  const released = Promise.withResolvers<undefined>();
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: await released.promise }) }),
  };
  const started = sdkQuery({ prompt, options: {
    // The engine reads no project here. Its private temporary directory exists, and nothing else uses it as a project.
    cwd: config.temporaryDirectory,
    env: engine.env,
    pathToClaudeCodeExecutable: config.enginePath,
    spawnClaudeCodeProcess: owned.spawn,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "default",
    persistSession: false,
    extraArgs: { "project-config-root": engine.projectConfigRoot, ...(probe === undefined ? {} : { "debug-to-stderr": null }) },
    sessionId,
    ...(probe === undefined ? {} : { model: probe.model }),
  } });
  const asked = async () => ask(started, await started.initializationResult());
  const answer = awaitWithAbortSignal(asked(), signal)
    .then((value) => ({ ended: "reply" as const, value, usageReply: classifyReply?.(value) }), (error: unknown) => ({ ended: signal.aborted ? "aborted" as const : "failed" as const, error }));
  const stopped = answer.then((result) => stopIdleCli({
    interrupt: () => started.interrupt(),
    close: () => {
      released.resolve(undefined);
      started.close();
    },
  }, owned, sessionId, files, purpose, result.ended, engine, result.ended === "reply" ? result.usageReply : undefined));
  const settled = await answer;
  if (!signal.aborted) await awaitWithAbortSignal(stopped, signal).catch(() => undefined);
  if (settled.ended !== "reply") throw settled.error;
  return settled.value;
}

/** How an idle CLI runs: its environment, the directory it reads as the project's `claude` configuration, and what
 *  its caller removes once it stopped. */
interface IdleEngine {
  readonly env: { readonly [name: string]: string };
  readonly projectConfigRoot: string;
  /** Removes what the engine ran on, after the engine stopped, and states the outcome for the stop record. */
  dispose(): { readonly settingsRemoved?: boolean };
}

/**
 * The listing engine runs on the login's own directory with every separation switch. The usage engine runs on a
 * private copy of the login's settings (`planUsageEnvironment`), which is removed once the engine stopped. The copy is
 * of the CLI's global config only, which holds the login's account details and never its token. A login without that
 * file gets an empty directory, and the engine then reports what it finds in the login's credential store. The probe
 * engine runs like the listing engine, with `probeModel` as its custom model option.
 */
function idleEngine(config: CliEnvironmentConfig, purpose: IdleCliPurpose, probeModel?: string): IdleEngine {
  if (purpose === "models" || purpose === "access-probe") {
    return { env: cliEnvironment(config, { ...(probeModel === undefined ? {} : { model: probeModel }), tools: [], extraBody: {} }), projectConfigRoot: projectConfigRoot(config), dispose: () => ({}) };
  }
  const settingsDir = mkdtempSync(join(config.temporaryDirectory, "usage-"));
  try {
    copyFileSync(globalConfigPath(config.configDir), globalConfigPath(settingsDir));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      rmSync(settingsDir, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    env: planUsageEnvironment(config, settingsDir),
    projectConfigRoot: projectConfigRoot({ configDir: settingsDir }),
    dispose: () => {
      try {
        rmSync(settingsDir, { recursive: true, force: true, maxRetries: 3 });
        return { settingsRemoved: true };
      } catch {
        // The copy holds no token, so a copy that stays leaves nothing secret in this user's private directory.
        return { settingsRemoved: false };
      }
    },
  };
}

/**
 * Starts an engine on the login in `config.configDir` for the MCP module's claude.ai connectors. It runs like the usage
 * engine (`idleEngine`), on a private copy of the login's settings with the login's own credential store, so it never
 * writes to the login's directory, and with no nonessential traffic. It gets no tools, no settings, no project MCP
 * servers, and a prompt that never yields, so it runs no turn; its connector fetch is on only when `launch.connectors`
 * asks for it. A discovery engine (`launch.debugLog`) also writes its API client's debug log, inspected deep enough to
 * hold whole tool schemas, to stderr. The engine stops by bridge rule 3. A stop and the engine's own end run the same
 * release once: the stop procedure, the close of its launch scope, the removal of its settings copy, and one record.
 */
export async function startLoginEngine(config: QueryLauncherConfig, launch: ClaudeLoginEngineLaunch, sdkQuery: QueryFunction = query, files: StopFiles = configDirFiles(config)): Promise<ClaudeLoginEngine> {
  const purpose: IdleCliPurpose = launch.debugLog === undefined ? "connector-calls" : "connector-discovery";
  const engine = idleEngine(config, purpose);
  const { ENABLE_CLAUDEAI_MCP_SERVERS: _connectorFetch, ...usageEnvironment } = engine.env;
  const env = {
    ...usageEnvironment,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // The engine cuts MCP tool descriptions at 2048 characters by default; the model reads Flywheel's copy whole.
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "100000",
    ...(launch.connectors ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "0" }),
    // Bun's console inspection cuts objects past depth 2, which would cut every tool schema in the debug log.
    ...(launch.debugLog === undefined ? {} : { BUN_OPTIONS: "--console-depth=64" }),
  };
  const owned = ownedClaudeProcess(config.launcher, launch.debugLog ?? (() => {}), refreshStopHold(config.configDir));
  const sessionId = randomUUID();
  const released = Promise.withResolvers<undefined>();
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: await released.promise }) }),
  };
  const started = sdkQuery({ prompt, options: {
    cwd: config.temporaryDirectory,
    env,
    pathToClaudeCodeExecutable: config.enginePath,
    spawnClaudeCodeProcess: owned.spawn,
    tools: [],
    settingSources: [],
    // The engine loads claude.ai connectors only without the strict switch; `settingSources` and the project config
    // root still keep every settings file and project MCP server out.
    strictMcpConfig: false,
    permissionMode: "default",
    persistSession: false,
    extraArgs: { "project-config-root": engine.projectConfigRoot, ...(launch.debugLog === undefined ? {} : { "debug-to-stderr": null }) },
    sessionId,
  } });
  let stopping: Promise<void> | undefined;
  const stop = (end: IdleCliEnd): Promise<void> => {
    stopping ??= stopIdleCli({ interrupt: () => started.interrupt(), close: () => { released.resolve(undefined); started.close(); } }, owned, sessionId, files, purpose, end, engine);
    return stopping;
  };
  const ended = (async () => {
    try {
      for await (const _message of started) { /* The engine runs no turn; its messages carry nothing to read. */ }
    } catch {
      // The end is the observation; its cause is the engine's exit, which `owned` records.
    }
    await owned.exited();
    await stop("exited");
  })();
  try {
    const init = await started.initializationResult();
    if (init.account.tokenSource === "none") throw new Error("The Claude login is signed out");
  } catch (error) {
    await stop("failed");
    throw error;
  }
  return { query: started, ended, stop: () => stop("released") };
}

/** Stops an idle CLI by bridge rule 3, closes its launch scope, and records the outcome with ids and counts only.
 *  It never rejects: it runs past the answer, where no caller would see a failure. An access probe runs once per
 *  audited model, so its stop has its own record family, which reaches the default level only for a stop that failed,
 *  killed the CLI, or left the CLI's launch scope or lock behind. */
async function stopIdleCli(started: Pick<Query, "interrupt" | "close">, owned: OwnedClaudeProcess, sessionId: string, files: StopFiles, purpose: IdleCliPurpose, ended: IdleCliEnd, engine: IdleEngine, usageReply?: UsageReplyKind): Promise<void> {
  const outcome = await (async () => {
    const stop = await Effect.runPromise(stopQuery(started, owned, sessionId, files, false));
    const closure = await owned.close();
    return { ...stop, settled: closure.settled, ...(files.legacyLockLeft() ? { legacyLockLeft: true } : {}) };
  })().catch((error: unknown) => ({ stopFailed: error instanceof Error ? error.name : typeof error }));
  const payload = { sessionId, purpose, ended, ...(usageReply === undefined ? {} : { usageReply }), ...outcome, ...engine.dispose() };
  if (purpose !== "access-probe") {
    DebugLog.record({ type: "provider.claude_sdk.idle_cli.stopped", payload });
    return;
  }
  const notable = "stopFailed" in outcome || outcome.terminated || !outcome.settled || outcome.legacyLockLeft === true;
  DebugLog.record({ type: "provider.claude_sdk.access_probe.stopped", notable, payload });
}

/**
 * Bridge rule 3. Interrupt only an active turn, bounded at 5 s. Wait until the
 * CLI's token-refresh lock is gone, at most 35 s, because the close ends the
 * CLI's stdin and a CLI that exits during a refresh makes the next CLI clear
 * the login. The caller must keep its prompt open throughout this wait.
 * Then close, and if the CLI is still alive after the SDK's grace, end its
 * container and remove what the kill leaves behind. The container's
 * own stop waits for the lock (the launch's stop hold), so a refresh that
 * begins after the close is safe too. A bare close while a handler waits
 * would send one more billed request, which is why an active turn is
 * interrupted first.
 */
export function stopQuery(started: Pick<Query, "interrupt" | "close">, owned: Pick<OwnedClaudeProcess, "exited" | "running" | "terminate">, sessionId: string, files: Pick<StopFiles, "refreshLockHeld" | "removeKilledLeftovers">, turnActive: boolean): Effect.Effect<QueryStop> {
  return Effect.gen(function* () {
    const interrupted = turnActive
      ? Option.isSome(yield* Effect.tryPromise(() => started.interrupt()).pipe(Effect.timeoutOption(INTERRUPT_BOUND_MS), Effect.orElseSucceed(() => Option.none())))
      : false;
    const lockWaitMs = yield* refreshLockReleased(files);
    started.close();
    const exited = yield* Effect.promise(() => owned.exited()).pipe(Effect.timeoutOption(EXIT_BOUND_MS));
    const terminated = Option.isNone(exited) && owned.running();
    if (terminated) {
      yield* Effect.promise(() => owned.terminate());
      files.removeKilledLeftovers(sessionId);
    }
    return { interrupted, lockWaitMs, lockTimedOut: lockWaitMs >= REFRESH_LOCK_BOUND_MS, terminated };
  });
}

/** Waits until no token refresh holds the login, at most `boundMs`, and answers how long it waited. */
function refreshLockReleased(files: Pick<StopFiles, "refreshLockHeld">): Effect.Effect<number> {
  return Effect.gen(function* () {
    let waitedMs = 0;
    while (files.refreshLockHeld() && waitedMs < REFRESH_LOCK_BOUND_MS) {
      yield* Effect.sleep(REFRESH_LOCK_POLL_MS);
      waitedMs += REFRESH_LOCK_POLL_MS;
    }
    return waitedMs;
  });
}

/** The stop procedure's files of one engine host. The engine records `sessions/<pid>.json` with its session id in
 *  the account's config directory and listens on `cc-socks/<pid>.sock` in its temporary directory; a killed engine
 *  removes neither. A record whose engine still runs stays: another engine can hold the same session id, such as the
 *  query of a bridge that a rebuilt client started while this one stopped. */
export function configDirFiles({ configDir, temporaryDirectory }: Pick<CliEnvironmentConfig, "configDir" | "temporaryDirectory">): StopFiles {
  const socketDir = join(temporaryDirectory, "cc-socks");
  return {
    refreshLockHeld: () => existsSync(refreshLockPath(configDir)),
    legacyLockLeft: () => {
      const path = legacyRefreshLockPath(configDir);
      return path !== undefined && existsSync(path);
    },
    removeKilledLeftovers: (sessionId) => {
      const sessions = join(configDir, "sessions");
      let entries: readonly string[];
      try {
        entries = readdirSync(sessions);
      } catch {
        return;
      }
      for (const entry of entries) {
        const pid = /^(\d+)\.json$/u.exec(entry)?.[1];
        if (pid === undefined || isProcessAlive(Number(pid))) continue;
        try {
          if (!readFileSync(join(sessions, entry), "utf8").includes(sessionId)) continue;
          rmSync(join(socketDir, `${pid}.sock`), { force: true });
          rmSync(join(sessions, entry), { force: true });
        } catch {
          // A record the CLI removed meanwhile needs no cleanup.
        }
      }
    },
  };
}

/** Whether CLI error text reports a spent usage allowance, by the SDK's own list of message prefixes. */
export function isUsageLimitText(text: string): boolean {
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}
