import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { StopHold } from "../../../infra/stop-hold.js";

/** The module's id: its descriptor, its settings row, and its setup all name it. */
export const CLAUDE_AGENT_SDK_MODULE_ID = "provider-claude-agent-sdk";
export const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude_agent_sdk";
/** The `flywheel auth login --<flag>` spelling of the provider. */
export const CLAUDE_AGENT_SDK_CLI_FLAG = "claude-agent-sdk";
/** The command that logs the person in to the provider, which every login failure names. */
export const CLAUDE_AGENT_SDK_LOGIN_COMMAND = `flywheel auth login --${CLAUDE_AGENT_SDK_CLI_FLAG}`;
/** The provider as a person reads it in settings and in errors. */
export const CLAUDE_AGENT_SDK_LABEL = "Anthropic Subscription";
/** The program that owns the provider's login, as a person reads it. */
export const LOGIN_PROGRAM_LABEL = "Claude Code";
/** The directory, in an auth profile's directory, that holds the config directory of each Claude account of that
 *  profile. Each login has its own directory, so the CLI keeps a separate login, and a separate keychain item, for
 *  each. The CLI's default directory, which the person's own `claude` installation uses, is never one of them. The
 *  engine names each keychain item after the full path, so renaming this directory loses every stored login. */
export const LOGIN_ACCOUNTS_DIRECTORY = "claude-code";
/** The CLI's global config for a config directory that `CLAUDE_CONFIG_DIR` names (CLI 2.1.296:
 *  `join(CLAUDE_CONFIG_DIR || homedir(), ".claude.json")`): the login's account details and the CLI's settings and
 *  caches, never its token. */
export function globalConfigPath(configDir: string): string {
  return join(configDir, ".claude.json");
}
/** The engine's plaintext token store in a login's config directory, which it uses where no OS store serves it. */
export function credentialsFilePath(configDir: string): string {
  return join(configDir, ".credentials.json");
}
/** The file the CLI holds while it refreshes the login's token. A CLI that is
 *  signalled or loses its stdin while the file exists can exit before the
 *  refresh is saved, and the next CLI then clears the login (bridge rule 3). */
export function refreshLockPath(configDir: string): string {
  return join(configDir, ".oauth_refresh.lock");
}
/** CLI 2.1.296's token-refresh function takes `<configDir>/.oauth_refresh.lock`, then the legacy
 *  `${realpath(configDir)}.lock` directory, and releases them in reverse order. A CLI that exits before cleanup can
 *  leave the legacy directory behind; no later CLI takes it over until it is 60 s stale.
 *  Returns no path when the config directory cannot be resolved. */
export function legacyRefreshLockPath(configDir: string): string | undefined {
  try {
    return `${realpathSync(configDir)}.lock`;
  } catch {
    return undefined;
  }
}
/** How often the bridge's own wait for the refresh lock reads it again. */
export const REFRESH_LOCK_POLL_MS = 200;
/** A token refresh ends well inside this bound (bridge rule 3). */
export const REFRESH_LOCK_BOUND_MS = 35_000;
/** The stop hold of every CLI on the login in `configDir`: no end of the CLI's
 *  container signals it while the refresh lock exists, within the bound. */
export function refreshStopHold(configDir: string): StopHold {
  return { path: refreshLockPath(configDir), boundMs: REFRESH_LOCK_BOUND_MS };
}
/** The in-process MCP server that serves the runtime's tools to the CLI. The model reads its name inside every tool name. */
export const TOOL_MCP_SERVER = "runtime";
/** The prefix with which the CLI names each tool of that server. */
export const TOOL_MCP_PREFIX = `mcp__${TOOL_MCP_SERVER}__`;

/**
 * The `toolAliases` of a query: each declared tool's bare name maps to its MCP name. Flywheel's own text names each
 * tool by its bare name, and a model that calls a tool that way otherwise gets the CLI's own "No such tool" answer,
 * after which the CLI sends a request of its own. With the alias the CLI hands the call to the tool's handler.
 */
export function mcpToolAliases(names: readonly string[]): { readonly [name: string]: string } {
  return Object.fromEntries(names.map((name) => [name, `${TOOL_MCP_PREFIX}${name}`]));
}
