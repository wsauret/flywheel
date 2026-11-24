/** The contract of the MCP manager: what its callers, its registry owner, and each per-registry resource share. */
import type { Deferred, Scope } from "effect";
import type { McpConnectionStatusRow } from "../../../protocol/modules/mcp.js";
import type { McpClaudeEngine } from "./claude-engine/claude-engine.js";
import type { McpServerRegistry } from "./config.js";
import type { McpConnectors } from "./claude-engine/connectors.js";
import type { McpCallResult, McpConnection, McpConnectionOptions, McpToolHit } from "./connection.js";
import type { McpCredentialStore } from "./oauth/credentials.js";
import type { McpOAuthAuthorization } from "./oauth/oauth.js";

/** One connection attempt for one server, and the only authority over it: the
 *  cancellation signal every request of the attempt shares, the single startup
 *  deadline, the scope that owns its fiber and its connection finalizers, and
 *  the result every caller awaits. A server in `pending` or `ready` always has
 *  exactly one attempt, so a superseded or timed-out attempt settles its own
 *  waiters but can never publish server state again. */
export interface McpAttempt {
  readonly deferred: Deferred.Deferred<McpConnection, Error>;
  readonly controller: AbortController;
  /** Epoch ms every startup request of this attempt shares. */
  readonly deadline: number;
  readonly scope: Scope.Closeable;
  /** Resolves once the attempt published its result and everything it started
   *  - connect, client close, scope finalizers - has settled. */
  readonly settled: Promise<void>;
  /** Set by the owner that retired this attempt. */
  cancelled: boolean;
}

/** The `tag` values must stay the wire's `McpServerStatus` set: every row
 *  build assigns `state.tag` to that stated union, so a state added here
 *  without a wire counterpart fails to compile at the row builder. */
export type McpServerEntry =
  | { readonly tag: "pending"; readonly kind: "attempt"; readonly attempt: McpAttempt }
  | { readonly tag: "pending"; readonly kind: "transition"; readonly result: Promise<McpConnection> }
  | { readonly tag: "ready"; readonly attempt: McpAttempt; readonly connection: McpConnection }
  | { readonly tag: "failed"; readonly error: Error; readonly retryable: boolean }
  | { readonly tag: "needs_auth" }
  | { readonly tag: "disabled" };

/** One tool call as the code projection makes it: the server beside what the connection's `callTool` takes. */
type McpCallRequest = Parameters<McpConnection["callTool"]>[0] & { readonly server: string };

export interface McpManager {
  /** Every configured server that is not disabled, whatever its connection state. */
  servers(): readonly string[];
  entries(): ReadonlyArray<{ readonly name: string; readonly state: McpServerEntry }>;
  acquire(server: string): Promise<McpConnection>;
  tools(): ReadonlyArray<McpToolHit>;
  /** Calls one tool on one server. A server that needs authentication or
   *  failed refuses with the repair the person can make; the raw failure
   *  never travels, so a credential in it never reaches a model. */
  call(request: McpCallRequest): Promise<McpCallResult>;
  credentialUpdated(server: string): Promise<void>;
  authorize(server: string): Promise<McpOAuthAuthorization>;
  status(): readonly McpConnectionStatusRow[];
  /** Observe status and tool-list changes, including an empty replacement and
   *  the start of a registry handoff, which empties tools(); read the current
   *  lists with status() and tools(). */
  subscribe(listener: () => void): () => void;
  replaceServers(servers: McpServerRegistry): Promise<void>;
  dispose(): Promise<void>;
}

export type McpManagerResource = Omit<McpManager, "replaceServers">;

/** What a runner reaches through the module's handle: the catalog and the call, never a connection. */
export interface McpPorts extends Pick<McpManager, "servers" | "tools" | "call"> {
  /** Advances whenever `servers` or `tools` returns a different list, so a
   *  holder of what they returned reads them again only when it changed. Read
   *  it before the lists it covers. */
  toolsGeneration(): number;
}

type Environment = { readonly [K in string]: string | undefined };

export interface McpManagerOptions {
  readonly servers: McpServerRegistry;
  readonly executionCwd: string;
  /** Account credential directory the OAuth credential store lives in. */
  readonly authDir: string;
  readonly env?: Environment;
  readonly log?: McpConnectionOptions["log"];
  readonly spawnOwned?: McpConnectionOptions["spawnOwned"];
  readonly connect?: (options: McpConnectionOptions) => Promise<McpConnection>;
  readonly startupTimeoutMs?: number;
  readonly credentialStore?: McpCredentialStore;
  /** The process's MCP engine, which connects every server that uses Claude as its client. Absent for a
   *  runtime with no launch authority, where such a server fails closed as a stdio server does. */
  readonly claudeEngine?: McpClaudeEngine;
  /** The person's claude.ai connectors, which connect every connector server of the registry. */
  readonly connectors?: McpConnectors;
}
