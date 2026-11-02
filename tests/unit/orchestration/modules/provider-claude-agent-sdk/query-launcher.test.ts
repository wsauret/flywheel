import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type AccountInfo, type ModelInfo, type Options, type Query, type SDKControlGetUsageResponse, type SDKControlInitializeResponse, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT_SEPARATOR } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { DebugLog, type DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { bridgeSessionId } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/session-id.js";
import { createHostLauncher, createQueryLauncher, describeCliLogin, readCliUsage, type CliFrame, type LaunchedQuery, type QueryFunction, type QueryLaunch, type QueryLauncherConfig, type StopFiles } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { createStepGate, type StepAsk } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/step-gate.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();

const noLaunch: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
  adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
  open: () => noLaunch,
  close: async () => ({ settled: true }),
};

// A benchmark cell runs Flywheel with a HOME and USER of its own. The shell also carries the person's own `claude`
// settings and the folders where `claude` keeps its caches, logs, and data, each of which would point the
// engine at the person's own files.
const HOST = {
  HOME: "/scratch/cell-home", USER: "cell", PATH: "/usr/bin", SHELL: "/bin/zsh", TZ: "Europe/Paris",
  LANG: "fr_FR.UTF-8", LC_ALL: "fr_FR.UTF-8", ANTHROPIC_API_KEY: "host-api-key", ANTHROPIC_AUTH_TOKEN: "host-token",
  ANTHROPIC_BASE_URL: "https://proxy.invalid", CLAUDE_CODE_OAUTH_TOKEN: "host-oauth", AWS_SECRET_ACCESS_KEY: "host-aws", OPENAI_API_KEY: "host-openai",
  CLAUDE_CONFIG_DIR: "/home/person/.claude", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/person/.claude", CLAUDE_CODE_TMPDIR: "/scratch/shared-tmp",
  ANTHROPIC_CONFIG_DIR: "/home/person/.config/anthropic", ANTHROPIC_PROFILE: "work", XDG_RUNTIME_DIR: "/run/user/501", XDG_CONFIG_HOME: "/home/person/.config",
  XDG_CACHE_HOME: "/home/person/.cache", XDG_DATA_HOME: "/home/person/.local/share", XDG_STATE_HOME: "/home/person/.local/state",
  USERPROFILE: "C:\\Users\\person", LOCALAPPDATA: "C:\\Users\\person\\AppData\\Local", APPDATA: "C:\\Users\\person\\AppData\\Roaming",
  CLAUDE_CODE_AUTO_CONNECT_IDE: "true", CLAUDE_CODE_HARBOR_KITE: "1", DISABLE_UPDATES: "0", CLAUDE_CODE_SSE_PORT: "41234",
};

/** The engine's own home in the login's directory of `launcherConfig`. */
const ENGINE_HOME = join("/home/person/.claude-flywheel", "home");

/** What every engine that Flywheel starts carries, whichever login it runs on and whatever the host sets. */
const SEPARATED = {
  HOME: ENGINE_HOME, USERPROFILE: ENGINE_HOME, LOCALAPPDATA: join(ENGINE_HOME, "AppData", "Local"), APPDATA: join(ENGINE_HOME, "AppData", "Roaming"),
  // The zone that Flywheel's own dates use, not the host's TZ, so the engine states the date that Flywheel states.
  USER: "person", PATH: "/usr/bin", SHELL: "/bin/zsh", TZ: "Asia/Tokyo",
  CLAUDE_CONFIG_DIR: "/home/person/.claude-flywheel", CLAUDE_CODE_TMPDIR: "/scratch/tmp/fw-claude-501",
  DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_AUTO_CONNECT_IDE: "false", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", CLAUDE_CODE_HARBOR_KITE: "0",
  CLAUDE_CODE_HOOKS_SAME_THREAD: "1",
};

async function* noInput(): AsyncGenerator<CliFrame> {}

/** Every query launched in a case; each one holds its step gate's socket until it closes. */
const launchedQueries: LaunchedQuery[] = [];
afterEach(async () => {
  for (const launched of launchedQueries.splice(0)) await launched.close();
});

function trackedLauncher(config: QueryLauncherConfig, sdkQuery: QueryFunction): (launch: QueryLaunch) => LaunchedQuery {
  const launch = createQueryLauncher(config, sdkQuery);
  return (input) => {
    const launched = launch(input);
    launchedQueries.push(launched);
    return launched;
  };
}

interface HookStep { readonly turnId: string; readonly index: number; readonly messageCount: number }
type HookSend = (step: HookStep) => AsyncGenerator<never, string>;
type HookHandler = ($: unknown, step: HookStep, send: HookSend) => AsyncGenerator<never, unknown>;

/** The `turn.step` hook of the plugin copy that a query loads, driven as the CLI's mod API drives it: `$.env` reads
 *  the query's environment and `$.http.fetch` posts over a socket path. Each step answers whether the hook sent it. */
async function pluginHook(pluginPath: string, env: Options["env"]): Promise<(step: HookStep) => Promise<"sent" | "refused">> {
  const hook: { register(on: (event: string, handler: HookHandler) => { catch(handler: HookHandler): void }): void } = await import(join(pluginPath, "hooks/register.js"));
  let onStep: HookHandler | undefined;
  hook.register((event, handler) => {
    if (event === "turn.step") onStep = handler;
    return { catch: () => {} };
  });
  const $ = {
    env: { get: async (name: string) => env?.[name] },
    http: {
      fetch: async (url: string, init: { readonly method: string; readonly socketPath: string; readonly body: string }) => {
        const response = await fetch(url, { method: init.method, unix: init.socketPath, body: init.body });
        return { ok: response.ok, text: await response.text() };
      },
    },
  };
  return async (step) => {
    if (onStep === undefined) throw new Error("the plugin registered no turn.step hook");
    const run = onStep($, step, async function* () { return "sent"; });
    let next = await run.next();
    while (next.done !== true) next = await run.next();
    return next.value === "sent" ? "sent" : "refused";
  };
}

function launchInput(overrides: Partial<QueryLaunch> = {}): QueryLaunch {
  return {
    prompt: noInput(),
    systemPrompt: ["Flywheel system prompt"],
    mcpServer: new McpServer({ name: "runtime", version: "0.0.0" }),
    stepGate: createStepGate(() => {}),
    tools: [{ name: "read", description: "Reads a file." }, { name: "bash", description: "x".repeat(3_000) }],
    cwd: "/work/project",
    session: { kind: "fresh", id: bridgeSessionId() },
    wireModelId: "claude-sonnet-5-5",
    contextLimit: 1_000_000,
    thinking: { type: "adaptive" },
    effort: "medium",
    promptCaching: true,
    extraBody: { tool_choice: { type: "auto" }, max_tokens: 32_000 },
    eagerInputStreaming: true,
    onStderrLine: () => {},
    ...overrides,
  };
}

/** Records the options of every query the launcher starts. */
interface RecordingQuery {
  readonly sdkQuery: QueryFunction;
  readonly options: Options[];
}

const notCalled = (): never => { throw new Error("the case does not call this method of the query"); };

/** A query that yields no message and whose methods throw, except the ones in `methods`. */
function stubQuery(methods: Partial<Query> = {}): Query {
  async function* messages(): AsyncGenerator<SDKMessage, void> {}
  return Object.assign(messages(), {
    interrupt: notCalled, setPermissionMode: notCalled, setMcpPermissionModeOverride: notCalled, setModel: notCalled, setMaxThinkingTokens: notCalled,
    applyFlagSettings: notCalled, updateSettings: notCalled, initializationResult: notCalled, reinitialize: notCalled, supportedCommands: notCalled,
    supportedModels: notCalled, supportedAgents: notCalled, mcpServerStatus: notCalled, getContextUsage: notCalled,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: notCalled, readFile: notCalled, reloadPlugins: notCalled, reloadSkills: notCalled,
    reloadOutputStyles: notCalled, accountInfo: notCalled, rewindFiles: notCalled, seedReadState: notCalled, reconnectMcpServer: notCalled,
    toggleMcpServer: notCalled, readMcpResource: notCalled, setMcpServers: notCalled, streamInput: notCalled, stopTask: notCalled,
    backgroundTasks: notCalled, close: notCalled,
  }, methods);
}

function recordingQuery(): RecordingQuery {
  const options: Options[] = [];
  const started = stubQuery();
  return { options, sdkQuery: (params) => { options.push(params.options ?? {}); return started; } };
}

function launcherConfig() {
  return {
    enginePath: "/opt/flywheel/native/claude", configDir: "/home/person/.claude-flywheel", account: { home: "/home/person", user: "person" },
    platform: "linux" as const, hostEnvironment: HOST, timeZone: "Asia/Tokyo", temporaryDirectory: "/scratch/tmp/fw-claude-501", launcher: noLaunch,
  };
}

describe("the bridge query launcher", () => {
  test("starts a fresh query on the engine that ships with Flywheel through the owned spawn seam with the fixed options, and reads the project's `claude` settings from the login's directory, never from the project", () => {
    const recorded = recordingQuery();
    const launch = launchInput();
    trackedLauncher(launcherConfig(), recorded.sdkQuery)(launch);

    const [options] = recorded.options;
    expect(typeof options?.spawnClaudeCodeProcess).toBe("function");
    expect(options).toMatchObject({
      cwd: "/work/project",
      pathToClaudeCodeExecutable: "/opt/flywheel/native/claude",
      systemPrompt: { type: "custom", prompt: "Flywheel system prompt", snapshot: false },
      tools: [],
      mcpServers: { runtime: { type: "sdk", name: "runtime", instance: launch.mcpServer } },
      strictMcpConfig: true,
      toolAliases: { read: "mcp__runtime__read", bash: "mcp__runtime__bash" },
      settingSources: [],
      permissionMode: "bypassPermissions",
      persistSession: false,
      includePartialMessages: true,
      verbatimPrompts: true,
      thinking: { type: "adaptive" },
      effort: "medium",
      extraArgs: { "debug-to-stderr": null, "project-config-root": "/home/person/.claude-flywheel" },
      sessionId: launch.session.id,
    });
    expect(options?.resume).toBeUndefined();
    expect(options?.sessionStore).toBeUndefined();
  });

  test("loads its own copy of the step gate plugin through the documented plugins option, and the hook reaches the query's gate on a private socket until the query closes", async () => {
    const recorded = recordingQuery();
    const asks: StepAsk[] = [];
    const stepGate = createStepGate((step) => { asks.push(step); });
    stepGate.arm("turn-start");
    const launched = trackedLauncher(launcherConfig(), recorded.sdkQuery)(launchInput({ stepGate }));
    const [options] = recorded.options;
    const socket = options?.env?.STEP_GATE_SOCKET ?? "";
    const pluginPath = join(dirname(socket), "plugin");
    expect(options?.plugins).toEqual([{ type: "local", path: pluginPath }]);
    // Windows has no mode bits: the directory sits in the account's own temporary folder, which only the account can open.
    if (process.platform !== "win32") expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);

    // The plugin's own hook finds the socket through the query's environment.
    const hookStep = await pluginHook(pluginPath, options?.env);
    expect(await hookStep({ turnId: "turn-1", index: 0, messageCount: 1 })).toBe("sent");
    expect(await hookStep({ turnId: "turn-1", index: 1, messageCount: 2 })).toBe("refused");
    // A request that the hook never sends gets no admission and no ask.
    const ask = async (body: string) => {
      const response = await fetch("http://localhost/step", { method: "POST", unix: socket, body });
      return { status: response.status, body: await response.json() };
    };
    expect(await ask(JSON.stringify({ index: 2, messageCount: 3 }))).toEqual({ status: 400, body: { admit: false } });
    expect(await ask("not json")).toEqual({ status: 400, body: { admit: false } });
    expect(asks).toEqual([{ turnId: "turn-1", index: 1, messageCount: 2 }]);

    await launched.close();
    expect(existsSync(dirname(socket))).toBe(false);
  });

  test("a launch that fails releases its step gate and closes its nested launch scope", () => {
    let closed = 0;
    let socket = "";
    const nested: LauncherScope = { ...noLaunch, close: async () => { closed += 1; return { settled: true }; } };
    const launcher: LauncherScope = { ...noLaunch, open: () => nested };
    const failing: QueryFunction = (params) => {
      socket = params.options?.env?.STEP_GATE_SOCKET ?? "";
      throw new Error("the SDK refused the options");
    };
    expect(() => createQueryLauncher({ ...launcherConfig(), launcher }, failing)(launchInput())).toThrow("the SDK refused the options");
    expect(socket).not.toBe("");
    expect(existsSync(dirname(socket))).toBe(false);
    expect(closed).toBe(1);
  });

  test("the stable tier ends at the CLI's cache boundary, so queries that share it read it from cache as native Anthropic requests do", () => {
    const recorded = recordingQuery();
    const launch = trackedLauncher(launcherConfig(), recorded.sdkQuery);
    launch(launchInput({ systemPrompt: ["Stable tier.", "Session tier."] }));
    launch(launchInput({ systemPrompt: ["Stable tier.", "Session tier.", "Conversation tier."] }));
    launch(launchInput({ systemPrompt: ["Stable tier only."] }));
    launch(launchInput({ systemPrompt: [] }));

    expect(recorded.options.map(({ systemPrompt }) => systemPrompt)).toEqual([
      { type: "custom", prompt: ["Stable tier.", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, "Session tier."], snapshot: false },
      { type: "custom", prompt: ["Stable tier.", SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `Session tier.${SYSTEM_PROMPT_SEPARATOR}Conversation tier.`], snapshot: false },
      { type: "custom", prompt: "Stable tier only.", snapshot: false },
      { type: "custom", prompt: "", snapshot: false },
    ]);
  });

  test("a rotation resumes the same session at the last kept transcript row", () => {
    const recorded = recordingQuery();
    const id = bridgeSessionId();
    trackedLauncher(launcherConfig(), recorded.sdkQuery)(launchInput({ session: { kind: "resume", id, at: "row-uuid" } }));

    expect(recorded.options[0]).toMatchObject({ resume: id, resumeSessionAt: "row-uuid" });
    expect(recorded.options[0]?.sessionId).toBeUndefined();
  });

  test("the engine environment is the login's own home, the OS account's USER, the allowlist, Flywheel's own directories, the separation and query toggles, the query's model option, and the per-query values, never a host credential, locale, `claude` setting, or `claude` folder", () => {
    const recorded = recordingQuery();
    trackedLauncher(launcherConfig(), recorded.sdkQuery)(launchInput());

    expect(recorded.options[0]?.env).toEqual({
      ...SEPARATED,
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
      CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1", CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1", CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "1800000", MCP_TOOL_TIMEOUT: "2147483647",
      // The engine's event-idle timer at its maximum, so a response with bytes and no event waits for Flywheel's own deadline.
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1800000",
      // The CLI sends every request, so an overflow arrives as the provider's prompt-too-long 400, as on native.
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "100000000",
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      // The engine's Anthropic client logs each response's status and headers, never the authorization (not verbose).
      ANTHROPIC_LOG: "debug",
      CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "3001",
      CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ tool_choice: { type: "auto" }, max_tokens: 32_000, thinking: { type: "adaptive" } }),
      // The query's own model, so an in-place prompt change sends no model check to the service.
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-sonnet-5-5[1m]",
      STEP_GATE_SOCKET: expect.any(String),
      // The query's tools stream their input as the model writes it, as the native request asks.
      CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1",
    });
    trackedLauncher(launcherConfig(), recorded.sdkQuery)(launchInput({ eagerInputStreaming: false }));
    expect(recorded.options[1]?.env).not.toHaveProperty("CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING");
    // On Windows Flywheel's dates have no zone to give: they follow the system zone, as the engine's own do.
    trackedLauncher({ ...launcherConfig(), timeZone: undefined }, recorded.sdkQuery)(launchInput());
    expect(recorded.options[2]?.env).not.toHaveProperty("TZ");
  });

  test("on macOS the engine finds `security` first in the login's keychain folder, where it runs the system command in the OS account's home, so the engine keeps its login keychain while its own home is the login's", () => {
    const configDir = temporaryDirectory("claude-keychain-");
    const recorded = recordingQuery();
    trackedLauncher({ ...launcherConfig(), configDir, platform: "darwin", account: { home: "/Users/o'brien", user: "person" } }, recorded.sdkQuery)(launchInput());

    const keychain = join(configDir, "keychain");
    expect(recorded.options[0]?.env).toMatchObject({ HOME: join(configDir, "home"), PATH: `${keychain}:/usr/bin` });
    const launcher = join(keychain, "security");
    expect(readFileSync(launcher, "utf8")).toBe(`#!/bin/sh\nHOME='/Users/o'\\''brien' exec /usr/bin/security "$@"\n`);
    if (process.platform !== "win32") expect(statSync(launcher).mode & 0o777).toBe(0o755);
    const owner = temporaryDirectory("claude-keychain-owner-");
    const profileLogin = join(owner, ".flywheel", "auth", "profiles", "work", LOGIN_ACCOUNTS_DIRECTORY, "shared");
    trackedLauncher({ ...launcherConfig(), configDir: profileLogin, platform: "darwin", account: { home: "/scratch/sandbox", user: "person" } }, recorded.sdkQuery)(launchInput());
    expect(readFileSync(join(profileLogin, "keychain", "security"), "utf8")).toBe(`#!/bin/sh\nHOME='${owner}' exec /usr/bin/security "$@"\n`);
    expect(recorded.options[1]?.env?.CLAUDE_CONFIG_DIR).toBe(profileLogin);
    expect(recorded.options[1]?.env?.HOME).toBe(join(profileLogin, "home"));
  });

  test("a query whose request carries no cache mark, no effort, or no thinking starts with the engine's switch for each, so the engine adds none of them", () => {
    const recorded = recordingQuery();
    const launch = trackedLauncher(launcherConfig(), recorded.sdkQuery);
    launch(launchInput({ promptCaching: false }));
    launch(launchInput({ effort: undefined }));
    launch(launchInput({ wireModelId: "claude-haiku-5-5", contextLimit: 200_000, effort: undefined, thinking: { type: "disabled" } }));
    launch(launchInput({ wireModelId: "claude-fable-5-1", effort: undefined, thinking: undefined }));
    launch(launchInput({ thinking: { type: "enabled", budget_tokens: 8_000 } }));

    const [uncached, unset, disabled, omitted, enabled] = recorded.options;
    // Effort off disables thinking (Haiku 5.5) or omits it (Fable 5.1). Without the switch the engine still adds its
    // thinking context edit, which the service refuses beside disabled thinking.
    expect(disabled?.env).toMatchObject({ CLAUDE_CODE_DISABLE_THINKING: "1" });
    expect(omitted?.env).toMatchObject({ CLAUDE_CODE_DISABLE_THINKING: "1" });
    expect(uncached?.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_THINKING");
    expect(enabled?.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_THINKING");
    // The 5-minute lifetime keeps the one-hour cache beta, which a login adds, off an uncached request.
    expect(uncached?.env).toMatchObject({ DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1" });
    expect(uncached?.env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
    expect(uncached?.effort).toBe("medium");
    // Without the switch the engine sends its own default effort, which native never sends.
    expect(unset?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: "unset" });
    expect(unset?.env).not.toHaveProperty("DISABLE_PROMPT_CACHING");
    expect(unset?.env).not.toHaveProperty("FORCE_PROMPT_CACHING_5M");
    expect(unset?.effort).toBeUndefined();
  });

  test("an agent host whose requests state no effort starts with the engine's effort switch, so its agents send none, and one whose gate states each step's effort keeps the engine's default", async () => {
    const recorded = recordingQuery();
    const launch = createHostLauncher(launcherConfig(), recorded.sdkQuery);
    for (const statesEffort of [true, false]) {
      const launched = launch({
        prompt: (async function* () {})(), mcpServer: new McpServer({ name: "runtime", version: "0.0.0" }),
        gate: { socketVariable: "AGENT_HOST_SOCKET", socketPath: "/scratch/gate.sock", pluginPath: "/scratch/plugin" },
        tools: [{ name: "read", description: "Reads a file." }], model: "claude-haiku-5-5", thinking: { type: "adaptive" },
        promptCaching: true, statesEffort, extraBody: { max_tokens: 32_000 }, eagerInputStreaming: true, cwd: "/work/project", sessionId: bridgeSessionId(),
        dispatcherPrompt: "Dispatch.", refuseDispatch: () => undefined, onStderrLine: () => {},
      });
      await launched.close();
    }
    const [stated, unset] = recorded.options;
    expect(stated?.env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
    expect(unset?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: "unset" });
  });

  test("an in-place prompt change is the CLI's set_model request with the query's own model, and a rewind asks again while the CLI ends its turn", async () => {
    const requests: { readonly [field: string]: unknown }[] = [];
    const rewinds = [{ rewound: false, reason: "turn_running" }, { rewound: false, reason: "turn_running" }, { rewound: true }, { rewound: false, reason: "target_not_found" }];
    // The CLI's internal request method, which the SDK's Query type does not declare.
    const started = Object.assign(stubQuery(), { request: async (body: { readonly [field: string]: unknown }) => {
      requests.push(body);
      return body["subtype"] === "rewind_conversation" ? { subtype: "success", response: rewinds.shift() } : { subtype: "success" };
    } });
    const launched = trackedLauncher(launcherConfig(), () => started)(launchInput({ contextLimit: 1_000_000 }));

    await Effect.runPromise(launched.setSystemPrompt("New prompt."));
    expect(await Effect.runPromise(launched.rewind("row-2", "row-3"))).toEqual({ rewound: true });
    expect(await Effect.runPromise(launched.rewind("row-9", "row-3"))).toEqual({ rewound: false, reason: "target_not_found" });
    expect(requests).toEqual([
      { subtype: "set_model", model: "claude-sonnet-5-5[1m]", system_prompt: "New prompt." },
      ...Array.from({ length: 3 }, () => ({ subtype: "rewind_conversation", target_message_uuid: "row-2", last_seen_user_message_uuid: "row-3" })),
      { subtype: "rewind_conversation", target_message_uuid: "row-9", last_seen_user_message_uuid: "row-3" },
    ]);
  });

  test("the CLI sends the native request's thinking field in its body, and the SDK option states the same setting", () => {
    const recorded = recordingQuery();
    const launch = trackedLauncher(launcherConfig(), recorded.sdkQuery);
    const thinkings: QueryLaunch["thinking"][] = [
      { type: "adaptive", display: "omitted" }, { type: "enabled", budget_tokens: 8_000, display: "summarized" }, { type: "disabled" }, undefined,
      { type: "adaptive", display: "updates" },
    ];
    for (const thinking of thinkings) launch(launchInput({ thinking }));

    expect(recorded.options.map(({ thinking }) => thinking)).toEqual([
      { type: "adaptive", display: "omitted" }, { type: "enabled", budgetTokens: 8_000, display: "summarized" }, { type: "disabled" }, { type: "disabled" },
      { type: "adaptive" },
    ]);
    // A field in the body stops the CLI's unattributed resend of a 400. An absent field stays absent, as natively. Only the
    // CLI can send the updates display, because only the CLI adds its beta header.
    expect(recorded.options.map(({ env }) => JSON.parse(env?.CLAUDE_CODE_EXTRA_BODY ?? "{}").thinking)).toEqual([
      { type: "adaptive", display: "omitted" }, { type: "enabled", budget_tokens: 8_000, display: "summarized" }, { type: "disabled" }, undefined, undefined,
    ]);
  });

  test("every CLI names its login's config directory, so no query falls back to the CLI's default directory of the person's own `claude` installation", () => {
    const recorded = recordingQuery();
    const launch = (configDir: string) => trackedLauncher({ ...launcherConfig(), configDir }, recorded.sdkQuery)(launchInput());
    launch("/home/person/.claude");
    launch(`/home/person/.flywheel/auth/profiles/default/${LOGIN_ACCOUNTS_DIRECTORY}/a`);

    expect(recorded.options.map(({ env }) => env?.CLAUDE_CONFIG_DIR)).toEqual(["/home/person/.claude", `/home/person/.flywheel/auth/profiles/default/${LOGIN_ACCOUNTS_DIRECTORY}/a`]);
  });

  test("asks for the 1M window only when the model's context limit is above 200,000 tokens, with the id that the model reminder names", () => {
    const recorded = recordingQuery();
    const launch = trackedLauncher(launcherConfig(), recorded.sdkQuery);
    launch(launchInput({ contextLimit: 1_000_000 }));
    launch(launchInput({ contextLimit: 200_000 }));
    launch(launchInput({ wireModelId: "claude-sonnet-5-5[1m]", contextLimit: 1_000_000 }));

    expect(recorded.options.map(({ model }) => model)).toEqual(["claude-sonnet-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]);
  });
});

const OPUS_ROW = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5" };

/** The CLI's initialize reply that offers `models` and names `account`, with no commands, agents, or output styles. */
function initReply(models: ModelInfo[], account: AccountInfo): SDKControlInitializeResponse {
  return { commands: [], agents: [], output_style: "default", available_output_styles: [], models, account };
}

/** The CLI's usage reply with `limits` and an empty session. */
function usageReply(limits: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits"> & Partial<SDKControlGetUsageResponse>): SDKControlGetUsageResponse {
  return {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: null, behaviors: null, ...limits,
  };
}

const noLock: StopFiles = { refreshLockHeld: () => false, legacyLockLeft: () => false, removeKilledLeftovers: () => {} };

/** A query whose initialize reply is `reply` and whose usage reply is `usage`; it records the usage request, the
 *  interrupt, and the close. */
function describingQuery(reply: Promise<SDKControlInitializeResponse>, usage = new Promise<SDKControlGetUsageResponse>(() => {})) {
  const options: Options[] = [];
  const events: string[] = [];
  let promptEnded = false;
  const sdkQuery: QueryFunction = (params) => {
    options.push(params.options ?? {});
    if (typeof params.prompt !== "string") {
      void params.prompt[Symbol.asyncIterator]().next().then(() => { promptEnded = true; });
    }
    return stubQuery({
      initializationResult: () => reply, interrupt: async () => { events.push("interrupt"); return undefined; }, close: () => { events.push("close"); },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (request) => {
        events.push(`usage:${JSON.stringify(request)}`);
        return usage;
      },
    });
  };
  return { sdkQuery, options, events, get promptEnded() { return promptEnded; } };
}

describe("describing the CLI login for the model listing", () => {
  test("starts one CLI with no tools, no settings, and no model, reads its initialize reply, and closes it without an interrupt", async () => {
    const query = describingQuery(Promise.resolve(initReply([OPUS_ROW], { subscriptionType: "Claude Max", apiProvider: "firstParty" })));
    const described = await describeCliLogin(launcherConfig(), new AbortController().signal, query.sdkQuery, noLock);

    // The initialize reply names the account's plan, which the auth row shows when the CLI's config records none.
    expect(described).toEqual({ models: [OPUS_ROW], loggedIn: true, plan: "Claude Max" });
    expect(query.events).toEqual(["close"]);
    const [options] = query.options;
    expect(typeof options?.spawnClaudeCodeProcess).toBe("function");
    // It runs in Flywheel's private directory and reads no project's `claude` settings.
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: "/opt/flywheel/native/claude", cwd: "/scratch/tmp/fw-claude-501",
      tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, permissionMode: "default",
      extraArgs: { "project-config-root": "/home/person/.claude-flywheel" },
    });
    // The listing engine keeps every separation switch and the login's own settings.
    expect(options?.env).toMatchObject(SEPARATED);
    expect(options?.env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect([options?.model, options?.mcpServers, options?.env?.ANTHROPIC_API_KEY]).toEqual([undefined, undefined, undefined]);
  });

  test("a CLI that names no token source holds no login", async () => {
    const query = describingQuery(Promise.resolve(initReply([OPUS_ROW], { tokenSource: "none", apiProvider: "firstParty" })));

    expect(await describeCliLogin(launcherConfig(), new AbortController().signal, query.sdkQuery, noLock)).toEqual({ models: [OPUS_ROW], loggedIn: false });
  });

  test("an abort before the CLI answers rejects at once with the abort reason, and the CLI is closed only once no token refresh holds the login", async () => {
    const query = describingQuery(new Promise(() => {}));
    const controller = new AbortController();
    const promptEndedAtPoll: boolean[] = [];
    const described = describeCliLogin(launcherConfig(), controller.signal, query.sdkQuery, {
      ...noLock,
      refreshLockHeld: () => {
        promptEndedAtPoll.push(query.promptEnded);
        return promptEndedAtPoll.length <= 2;
      },
    });
    const reason = new DOMException("Model listing settlement timed out", "TimeoutError");
    controller.abort(reason);

    expect(await described.then(() => undefined, (error: unknown) => error)).toBe(reason);
    expect(query.events).toEqual([]);
    const [stopped] = await stopRecords(1);
    expect(promptEndedAtPoll).toEqual([false, false, false]);
    expect(query.promptEnded).toBe(true);
    expect(query.events).toEqual(["close"]);
    expect(stopped?.payload).toMatchObject({ ended: "aborted", lockTimedOut: false, terminated: false, settled: true });
  });

  test("a signal that aborted before the start still stops the CLI it started", async () => {
    const query = describingQuery(new Promise(() => {}));
    const controller = new AbortController();
    const reason = new DOMException("The caller left", "AbortError");
    controller.abort(reason);

    expect(await describeCliLogin(launcherConfig(), controller.signal, query.sdkQuery, noLock).then(() => undefined, (error: unknown) => error)).toBe(reason);
    const [stopped] = await stopRecords(1);
    expect(query.events).toEqual(["close"]);
    expect(stopped?.payload).toMatchObject({ ended: "aborted" });
  });

  test("a reply returns by the listing deadline while the stop still waits for a token refresh to end", async () => {
    let answer = (_reply: SDKControlInitializeResponse) => {};
    const query = describingQuery(new Promise((resolve) => { answer = resolve; }));
    const controller = new AbortController();
    let refreshing = true;
    const described = describeCliLogin(launcherConfig(), controller.signal, query.sdkQuery, { ...noLock, refreshLockHeld: () => refreshing });
    answer(initReply([OPUS_ROW], { tokenSource: "claude.ai" }));
    await Bun.sleep(0);
    controller.abort(new DOMException("Model listing settlement timed out", "TimeoutError"));

    expect(await described).toEqual({ models: [OPUS_ROW], loggedIn: true });
    expect(query.events).toEqual([]);
    refreshing = false;
    const [stopped] = await stopRecords(1);
    expect(query.events).toEqual(["close"]);
    expect(stopped?.payload).toMatchObject({ ended: "reply" });
  });

  test("each stop of a listing CLI is recorded once with ids and counts only", async () => {
    for (const [index, legacyLockLeft] of [false, true].entries()) {
      const query = describingQuery(Promise.reject(new Error("CLI exited before its reply: /home/person/secret-path")));
      const scope: LauncherScope = { ...noLaunch, close: async () => {
        await Promise.resolve();
        query.events.push("scope-closed");
        return { settled: true };
      } };
      const config = { ...launcherConfig(), launcher: { ...noLaunch, open: () => scope } };
      const files = { ...noLock, legacyLockLeft: () => {
        expect(query.events).toEqual(["close", "scope-closed"]);
        return legacyLockLeft;
      } };
      const failed = await describeCliLogin(config, new AbortController().signal, query.sdkQuery, files).then(() => undefined, (error: unknown) => error);

      expect(failed).toBeInstanceOf(Error);
      const stops = await stopRecords(index + 1);
      expect(stops).toHaveLength(index + 1);
      expect(stops[index]).toEqual({ type: "provider.claude_sdk.idle_cli.stopped", payload: {
        sessionId: query.options[0]?.sessionId, purpose: "models", ended: "failed", interrupted: false, lockWaitMs: 0, lockTimedOut: false, terminated: false, settled: true,
        ...(legacyLockLeft ? { legacyLockLeft: true } : {}),
      } });
    }
  });
});

/** What a usage engine found at its start: its settings directory and the settings there. */
interface EngineStart {
  readonly settingsDir: string;
  readonly settings: string;
}

describe("reading the account's usage from the CLI", () => {
  const REPLY = usageReply({ subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: null } } });
  const LOGIN_SETTINGS = JSON.stringify({ userID: "user-1", oauthAccount: { accountUuid: "uuid-person", organizationUuid: "uuid-org" } });

  /** A login on disk with its settings file, and Flywheel's private temporary directory beside it. */
  function usageConfig() {
    const root = temporaryDirectory("claude-usage-");
    const configDir = join(root, "login");
    const engineTemporary = join(root, "fw-claude");
    mkdirSync(configDir);
    mkdirSync(engineTemporary);
    writeFileSync(join(configDir, ".claude.json"), LOGIN_SETTINGS);
    return { ...launcherConfig(), configDir, temporaryDirectory: engineTemporary };
  }

  test("asks the CLI that holds the login for its plan windows without the transcript scan, then closes it without an interrupt", async () => {
    const query = describingQuery(Promise.resolve(initReply([OPUS_ROW], { tokenSource: "claude.ai" })), Promise.resolve(REPLY));
    const config = usageConfig();

    expect(await readCliUsage(config, new AbortController().signal, query.sdkQuery, noLock)).toEqual({ loggedIn: true, reply: REPLY });
    const [stopped] = await stopRecords(1);
    expect(query.events).toEqual(['usage:{"skipBehaviors":true}', "close"]);
    expect(query.options[0]).toMatchObject({ tools: [], settingSources: [], persistSession: false });
    // Engine 2.1.296 sends its usage request only while it may send nonessential traffic, so the usage engine alone
    // runs without that switch, on a private settings directory of its own in Flywheel's temporary directory. It reaches
    // the login's credentials in the login's own directory. Every other separation switch stays on.
    const env = query.options[0]?.env ?? {};
    const settingsDir = env["CLAUDE_CONFIG_DIR"] ?? "";
    expect(dirname(settingsDir)).toBe(config.temporaryDirectory);
    const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _switch, ...otherSwitches } = SEPARATED;
    const home = join(settingsDir, "home");
    expect(env).toMatchObject({
      ...otherSwitches, CLAUDE_CODE_TMPDIR: config.temporaryDirectory,
      CLAUDE_CONFIG_DIR: settingsDir, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: config.configDir,
    });
    expect(env).not.toHaveProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC");
    expect(stopped?.payload).toMatchObject({ purpose: "usage", ended: "reply", usageReply: "windows", settingsRemoved: true });
  });

  test("usage stops distinguish unusable replies from failed engine calls without recording reply or error content", async () => {
    const cases = [
      { reply: { ...usageReply({ rate_limits_available: true, rate_limits: null }), secret: "private-reply" }, ended: "reply", usageReply: "unreadable" },
      { reply: usageReply({ rate_limits_available: false, rate_limits: null }), ended: "reply", usageReply: "no-plan" },
      { reply: usageReply({ rate_limits_available: true, rate_limits: { five_hour: null } }), ended: "reply", usageReply: "no-windows" },
      { reply: new Error("private-error"), ended: "failed", usageReply: undefined },
    ];
    for (const [index, entry] of cases.entries()) {
      const usage = entry.reply instanceof Error ? Promise.reject(entry.reply) : Promise.resolve(entry.reply);
      const query = describingQuery(Promise.resolve(initReply([], { tokenSource: "claude.ai" })), usage);
      const result = await readCliUsage(usageConfig(), new AbortController().signal, query.sdkQuery, noLock).catch((error: unknown) => error);
      if (entry.reply instanceof Error) expect(result).toBe(entry.reply);
      else expect(result).toEqual({ loggedIn: true, reply: entry.reply });
      const records = await stopRecords(index + 1);
      expect(records).toHaveLength(index + 1);
      expect(records[index]?.payload).toMatchObject({ purpose: "usage", ended: entry.ended, settingsRemoved: true });
      if (entry.usageReply === undefined) expect(records[index]?.payload).not.toHaveProperty("usageReply");
      else expect(records[index]?.payload).toHaveProperty("usageReply", entry.usageReply);
      expect(JSON.stringify(records)).not.toContain("private-reply");
      expect(JSON.stringify(records)).not.toContain("private-error");
    }
  });

  test("the account data that the usage engine fetches at its start lands in its private copy of the login's settings, so the login's own settings stay as they were and the copy is gone once the engine stopped", async () => {
    const config = usageConfig();
    const starts: EngineStart[] = [];
    const query = describingQuery(Promise.resolve(initReply([], { tokenSource: "claude.ai" })), Promise.resolve(REPLY));
    // As engine 2.1.296 does without the switch: it caches the bootstrap's client data and model options in the
    // .claude.json of its CLAUDE_CONFIG_DIR, where every later engine on that directory reads them.
    const fetchingEngine: QueryFunction = (params) => {
      const settingsDir = params.options?.env?.["CLAUDE_CONFIG_DIR"] ?? "";
      const file = join(settingsDir, ".claude.json");
      const settings = readFileSync(file, "utf8");
      starts.push({ settingsDir, settings });
      writeFileSync(file, JSON.stringify({ ...JSON.parse(settings), clientDataCacheSlots: { "bi1-0": { data: { atis: "x" }, at: 1 } }, additionalModelOptionsCache: [] }));
      return query.sdkQuery(params);
    };

    expect(await readCliUsage(config, new AbortController().signal, fetchingEngine, noLock)).toEqual({ loggedIn: true, reply: REPLY });
    await stopRecords(1);
    expect(starts.map(({ settings }) => settings)).toEqual([LOGIN_SETTINGS]);
    expect(readFileSync(join(config.configDir, ".claude.json"), "utf8")).toBe(LOGIN_SETTINGS);
    expect(starts.map(({ settingsDir }) => existsSync(settingsDir))).toEqual([false]);
  });

  test("a CLI that names no token source is not asked, because it holds no login", async () => {
    const query = describingQuery(Promise.resolve(initReply([], { tokenSource: "none" })), Promise.resolve(REPLY));

    expect(await readCliUsage(usageConfig(), new AbortController().signal, query.sdkQuery, noLock)).toEqual({ loggedIn: false });
    const [stopped] = await stopRecords(1);
    expect(stopped?.payload).toMatchObject({ purpose: "usage", ended: "reply", usageReply: "logged-out" });
    expect(query.events).toEqual(["close"]);
  });

  test("an abort while the CLI reads its usage rejects at once with the abort reason, and the CLI is still stopped", async () => {
    const query = describingQuery(Promise.resolve(initReply([], { tokenSource: "claude.ai" })));
    const controller = new AbortController();
    const read = readCliUsage(usageConfig(), controller.signal, query.sdkQuery, noLock);
    await Bun.sleep(0);
    const reason = new DOMException("Usage check aborted", "AbortError");
    controller.abort(reason);

    expect(await read.then(() => undefined, (error: unknown) => error)).toBe(reason);
    const [stopped] = await stopRecords(1);
    expect(query.events).toEqual(['usage:{"skipBehaviors":true}', "close"]);
    expect(stopped?.payload).toMatchObject({ purpose: "usage", ended: "aborted" });
  });
});

const records: DebugLogRecordInput[] = [];
beforeEach(async () => {
  records.length = 0;
  await DebugLog.forward((record) => { records.push(record); });
});
afterEach(async () => { await DebugLog.close(); });

/** The listing stop records, once `count` of them exist. A stop that waits for the refresh lock reads it again
 *  after one poll. */
async function stopRecords(count: number): Promise<readonly DebugLogRecordInput[]> {
  const stops = () => records.filter(({ type }) => type === "provider.claude_sdk.idle_cli.stopped");
  while (stops().length < count) await Bun.sleep(5);
  return stops();
}
