import { Redacted } from "effect";
import type { McpClientChoice } from "../../../protocol/modules/mcp.js";
import { resolveMcpTemplate, type McpServerConfig } from "./config.js";

type Environment = { readonly [K in string]: string | undefined };

/** The OAuth client settings of the Claude engine's MCP client, in the engine's own field names. */
export interface ClaudeClientOAuth {
  readonly clientId?: string;
  readonly callbackPort?: number;
  readonly scopes?: string;
}

/** A server that refuses Flywheel's own client but accepts Claude's, with the client settings that the
 *  server's owner publishes for Claude and the one reason the person reads. */
interface BuiltInClaudeServer {
  readonly url: string;
  readonly service: string;
  readonly reason: string;
  readonly oauth: ClaudeClientOAuth;
}

/** Servers that use Claude as their client unless a person chose otherwise. An entry joins this list only when
 *  the server refuses Flywheel's own sign-in and its owner publishes client settings for Claude. */
const BUILT_IN_CLAUDE_SERVERS: readonly BuiltInClaudeServer[] = [
  // https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/
  { url: "https://mcp.slack.com/mcp", service: "Slack", reason: "Slack only accepts approved apps", oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 } },
];

/** The built-in list as a person reads it: each service with its server URL. */
export const BUILT_IN_CLAUDE_SERVER_NAMES = BUILT_IN_CLAUDE_SERVERS.map((entry) => `${entry.service} (${entry.url})`).join(", ");

/** How one HTTP server connects: Flywheel's own MCP client, or the Claude engine with its OAuth settings. */
export type McpClientResolution =
  | { readonly kind: "flywheel"; readonly choice: McpClientChoice }
  | { readonly kind: "claude"; readonly choice: McpClientChoice; readonly oauth: ClaudeClientOAuth };

/** The client of `config`, or nothing for a stdio server. An explicit `client` wins; else a built-in list entry at the
 *  URL that `env` expands means Claude; else Flywheel. The server's own `oauth` keys win over the list's values for a
 *  Claude-client server. */
export function resolveMcpClient(config: McpServerConfig, env: Environment): McpClientResolution | undefined {
  if (config.url === undefined) return undefined;
  const url = expandedUrl(config.url, env);
  const listed = url === undefined ? undefined : BUILT_IN_CLAUDE_SERVERS.find((entry) => sameServer(entry.url, url));
  if (config.client === "flywheel" || (config.client === undefined && listed === undefined)) return { kind: "flywheel", choice: { kind: "flywheel" } };
  const oauth: ClaudeClientOAuth = {
    ...listed?.oauth,
    ...(config.oauth?.client_id === undefined ? {} : { clientId: config.oauth.client_id }),
    ...(config.oauth?.callback_port === undefined ? {} : { callbackPort: config.oauth.callback_port }),
    ...(config.oauth?.scope === undefined ? {} : { scopes: config.oauth.scope }),
  };
  const choice: McpClientChoice = config.client === "claude" || listed === undefined
    ? { kind: "claude", source: "chosen" }
    : { kind: "claude", source: "built-in", service: listed.service, reason: listed.reason };
  return { kind: "claude", choice, oauth };
}

/** The server URL with its `${VAR}` templates expanded, or nothing when a variable is unset. Such a server fails to
 *  connect with the unset variable's own error, so only an explicit client choice applies to it. */
function expandedUrl(template: string, env: Environment): string | undefined {
  try {
    return Redacted.value(resolveMcpTemplate(template, env));
  } catch {
    return undefined;
  }
}

/** Whether two server URLs name one server: scheme and host compare without case, and a trailing slash of the path
 *  does not count. A URL that does not parse compares as text. */
function sameServer(left: string, right: string): boolean {
  return normalizedUrl(left) === normalizedUrl(right);
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
  } catch {
    return value;
  }
}
