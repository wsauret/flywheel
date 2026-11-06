import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ownedClaudeProcess } from "../../../infra/claude-engine-process.js";
import { separatedEngineEnvironment, type EngineHost } from "../../../infra/claude-engine.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import type { ClaudeClientOAuth } from "./clients.js";

/** One server as the engine takes it in `mcp_set_servers`: an HTTP server that Flywheel configures, or one claude.ai
 *  connector of the engine's login. `oauth` is the engine's own field, which the SDK type does not declare but passes
 *  through unchanged. */
export type EngineServerConfig =
  | { readonly type: "http"; readonly url: string; readonly headers: { readonly [name: string]: string }; readonly oauth?: ClaudeClientOAuth }
  | { readonly type: "claudeai-proxy"; readonly url: string; readonly id: string };

/** One server as `mcp_status` reports it. Tools carry names and annotations only; their definitions come from a
 *  capture. A claude.ai connector also states its config, which names the connector for a later `mcp_set_servers`. */
export interface EngineServerStatus {
  readonly name: string;
  readonly status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  readonly config?: { readonly type?: string; readonly url?: string; readonly id?: string };
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly annotations?: { readonly readOnly?: boolean; readonly destructive?: boolean; readonly openWorld?: boolean } }>;
}

/** One tool definition as the engine sends it to the model API, named `mcp__<server>__<tool>`. */
export interface CapturedTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema: unknown;
}

/** The control requests of one running engine, whichever engine it is. This is the one place that sends the
 *  requests the SDK does not type (`mcp_call`, `mcp_authenticate`) and casts the engine's `oauth` field. Each
 *  request rejects with the engine's own message. */
export interface ClaudeEngineControl {
  /** Replaces the engine's whole server set. */
  setServers(servers: { readonly [name: string]: EngineServerConfig }): Promise<void>;
  status(): Promise<readonly EngineServerStatus[]>;
  /** Calls `tool` (`mcp__<server>__<tool>`) and answers the server's result. A JSON-RPC error answer of the server
   *  rejects with `EngineServerAnswer`. Every other rejection leaves the outcome unknown: the engine rejects an
   *  `isError` result, a gateway or network failure, and a lost connection alike with nothing but a message, so no
   *  other rejection proves that the server answered. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: the server's MCP result, which normalizeMcpCallResult parses.
  call(tool: string, args: { readonly [key: string]: unknown }, signal: AbortSignal | undefined): Promise<unknown>;
  /** Starts the engine's sign-in for one server: the URL the person opens, and the local port the engine listens on
   *  for the callback. */
  authenticate(server: string): Promise<{ readonly authUrl: string; readonly callbackPort?: number }>;
}

/** The MCP engine with no login, as the servers that use Claude as their client share it. */
export interface ClaudeEngineSession extends ClaudeEngineControl {
  /** The full definitions of every connected server's tools, read from the token count request that the engine
   *  sends to Flywheel's local listener. A tool that the count left out, or every tool when no count arrived, is
   *  missing from the list, which the caller checks against the status. */
  captureTools(): Promise<readonly CapturedTool[]>;
  /** Settles when the engine process has ended, for any reason. */
  readonly ended: Promise<void>;
  close(): Promise<void>;
}

export interface ClaudeEngineLaunch {
  readonly host: EngineHost;
  /** The Flywheel-owned, account-global directory of the engine's settings and MCP sign-ins. */
  readonly configDir: string;
  readonly launcher: LauncherScope;
}

/** The answer the local listener gives every request. A success would let the engine cache token counts and send no
 *  tools on the next count, so every count fails and the engine still answers `get_context_usage`. */
const LISTENER_REFUSAL = { type: "error", error: { type: "invalid_request_error", message: "Flywheel MCP engine sends no model requests" } } as const;
/** The engine sends nothing to the model API without a key, and it never sends a model request here: it runs no
 *  turn. This key only lets it send the token count that carries the tool definitions. */
const LISTENER_KEY = "flywheel-mcp-engine";
/** The MCP SDK's `ErrorCode.ConnectionClosed`. The SDK's value module stays off this module's load path. */
const CONNECTION_CLOSED = -32000;

interface RawQuery extends Query {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: the engine's untyped control answer, which each caller parses.
  request(request: { readonly subtype: string; readonly [key: string]: unknown }, options?: { readonly signal?: AbortSignal }): Promise<{ readonly response?: unknown }>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: the engine's untyped sign-in answer, which `authenticate` parses.
  mcpAuthenticate(server: string): Promise<unknown>;
}

/**
 * Starts the bundled engine as Flywheel's MCP client: no Anthropic login, no settings of any project or account
 * (`settingSources: []`, `strictMcpConfig`), no claude.ai connectors, no telemetry or nonessential traffic, and MCP
 * tool descriptions kept whole. Its model API is a listener on this machine that refuses every request and records
 * the tool definitions of each token count. The engine runs no model turn: its prompt never yields.
 */
export async function launchClaudeEngineSession(launch: ClaudeEngineLaunch): Promise<ClaudeEngineSession> {
  mkdirSync(launch.configDir, { recursive: true, mode: 0o700 });
  let capture: CapturedTool[] | undefined;
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (capture !== undefined && new URL(request.url).pathname.endsWith("/count_tokens")) {
        const body: unknown = await request.json().catch(() => undefined);
        capture.push(...capturedTools(body));
      }
      return Response.json(LISTENER_REFUSAL, { status: 400 });
    },
  });
  const owned = ownedClaudeProcess(launch.launcher, () => {}, undefined);
  const promptEnd = Promise.withResolvers<undefined>();
  const prompt: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: await promptEnd.promise }) }) };
  const env = {
    ...separatedEngineEnvironment(launch.host, launch.configDir, launch.host.account.home),
    ENABLE_CLAUDEAI_MCP_SERVERS: "0",
    // The engine cuts MCP tool descriptions at 2048 characters by default; the model reads Flywheel's copy whole.
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "100000",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${listener.port}`,
    ANTHROPIC_API_KEY: LISTENER_KEY,
  };
  const options: Options = {
    cwd: launch.configDir,
    env,
    pathToClaudeCodeExecutable: launch.host.enginePath,
    spawnClaudeCodeProcess: owned.spawn,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "default",
    persistSession: false,
    sessionId: randomUUID(),
  };
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const engine = query({ prompt, options });
  // One release of the launch scope and the listener, whichever comes first: the engine's own end or `close`.
  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    released ??= (async () => {
      await owned.close();
      await listener.stop(true);
    })();
    return released;
  };
  const ended = (async () => {
    try {
      for await (const _message of engine) { /* The engine runs no turn; its messages carry nothing Flywheel reads. */ }
    } catch {
      // The end is the observation; its cause is the engine's exit, which `owned` records.
    }
    await owned.exited();
    await release();
  })();
  const close = async (): Promise<void> => {
    promptEnd.resolve(undefined);
    engine.close();
    await release();
    await ended;
  };
  try {
    await engine.initializationResult();
  } catch (error) {
    await close();
    throw error;
  }
  let captures = Promise.resolve<unknown>(undefined);
  return {
    ...claudeEngineControl(engine),
    captureTools() {
      const run = captures.then(async () => {
        capture = [];
        try {
          await engine.getContextUsage({ detail: "full" });
          return capture;
        } finally {
          capture = undefined;
        }
      });
      captures = run.catch(() => undefined);
      return run;
    },
    ended,
    close,
  };
}

/** The control requests of the running engine `query`. */
export function claudeEngineControl(query: Query): ClaudeEngineControl {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the runtime Query has the untyped request and mcpAuthenticate methods that the SDK type omits.
  const engine = query as RawQuery; // SAFETY: Every typed Query method wraps `request` (SDK 0.3.306), and `mcpAuthenticate` exists at runtime; the integration test fails when either stops working.
  return {
    async setServers(servers) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK type omits the engine's oauth field, which it passes through unchanged.
      await engine.setMcpServers(servers as Parameters<Query["setMcpServers"]>[0]); // SAFETY: The engine's schema accepts `oauth` on an http server.
    },
    status: async () => await engine.mcpServerStatus(),
    async call(tool, args, signal) {
      try {
        const answer = await engine.request({ subtype: "mcp_call", tool, arguments: args, result_not_for_model: true }, signal === undefined ? undefined : { signal });
        return answer.response;
      } catch (error) {
        throw serverAnswer(error) ?? error;
      }
    },
    async authenticate(server) {
      const answer = await engine.mcpAuthenticate(server);
      if (!isRecord(answer) || typeof answer.authUrl !== "string") throw new Error("The Claude engine did not start a sign-in");
      return { authUrl: answer.authUrl, ...(typeof answer.callbackPort === "number" ? { callbackPort: answer.callbackPort } : {}) };
    },
  };
}

/** A tool call that the server answered with a JSON-RPC error, so its outcome is definite (ARCH-TOOLS-050). */
export class EngineServerAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineServerAnswer";
  }
}

/** The JSON-RPC error answer in an `mcp_call` rejection, which the engine passes on as the MCP SDK's
 *  `MCP error <code>: <message>`. The SDK also reports a closed connection that way, with the code -32000, which a
 *  server may send too; that answer then reads as unknown, which only adds a check before a repeat, as for
 *  Flywheel's own client. */
function serverAnswer(error: unknown): EngineServerAnswer | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^MCP error (-?\d+):/u.exec(message)?.[1];
  return code === undefined || Number(code) === CONNECTION_CLOSED ? undefined : new EngineServerAnswer(message);
}

function capturedTools(body: unknown): CapturedTool[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool: unknown) => isRecord(tool) && typeof tool.name === "string" && tool.input_schema !== undefined
    ? [{ name: tool.name, input_schema: tool.input_schema, ...(typeof tool.description === "string" ? { description: tool.description } : {}) }]
    : []);
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
