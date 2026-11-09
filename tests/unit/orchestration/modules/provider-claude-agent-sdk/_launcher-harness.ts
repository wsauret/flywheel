/** Fixtures shared by the query launcher's tests: the launcher configuration of one login on a benchmark host, and queries that stand in for the CLI. */
import type { AccountInfo, ModelInfo, Query, SDKControlInitializeResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import type { StopFiles } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";

export const noLaunch: LauncherScope = {
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
export const SEPARATED = {
  HOME: ENGINE_HOME, USERPROFILE: ENGINE_HOME, LOCALAPPDATA: join(ENGINE_HOME, "AppData", "Local"), APPDATA: join(ENGINE_HOME, "AppData", "Roaming"),
  // The zone that Flywheel's own dates use, not the host's TZ, so the engine states the date that Flywheel states.
  USER: "person", PATH: "/usr/bin", SHELL: "/bin/zsh", TZ: "Asia/Tokyo",
  CLAUDE_CONFIG_DIR: "/home/person/.claude-flywheel", CLAUDE_CODE_TMPDIR: "/scratch/tmp/fw-claude-501",
  DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_AUTO_CONNECT_IDE: "false", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1", CLAUDE_CODE_HARBOR_KITE: "0",
  CLAUDE_CODE_HOOKS_SAME_THREAD: "1",
};

const notCalled = (): never => { throw new Error("the case does not call this method of the query"); };

/** A query that yields no message and whose methods throw, except the ones in `methods`. */
export function stubQuery(methods: Partial<Query> = {}): Query {
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

export function launcherConfig() {
  return {
    enginePath: "/opt/flywheel/native/claude", configDir: "/home/person/.claude-flywheel", account: { home: "/home/person", user: "person" },
    platform: "linux" as const, hostEnvironment: HOST, timeZone: "Asia/Tokyo", temporaryDirectory: "/scratch/tmp/fw-claude-501", launcher: noLaunch,
  };
}

export const OPUS_ROW = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5" };

/** The CLI's initialize reply that offers `models` and names `account`, with no commands, agents, or output styles. */
export function initReply(models: ModelInfo[], account: AccountInfo): SDKControlInitializeResponse {
  return { commands: [], agents: [], output_style: "default", available_output_styles: [], models, account };
}

export const noLock: StopFiles = { refreshLockHeld: () => false, legacyLockLeft: () => false, removeKilledLeftovers: () => {} };
