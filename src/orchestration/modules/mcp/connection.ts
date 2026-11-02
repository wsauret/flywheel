import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  McpError,
  ResultSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Redacted, Result, Schema } from "effect";
import type { McpServerConfig } from "./config.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { MCP_STARTUP_TIMEOUT_MS, redactMcpError, redactMcpString, redactMcpValue, resolveMcpTemplate } from "./config.js";
import { McpNeedsAuthError, McpOutcomeUnknownError } from "./errors.js";
import { MAX_TIMER_MS } from "../../../infra/timers.js";
import { BunStdioClientTransport } from "../../agent-runtime/mcp-stdio-client-transport.js";
import { runInTaskTurn } from "../../../infra/task-scheduling.js";
import { normalizeMcpCallResult as normalizeMcpResult, type McpCallResult } from "../../agent-runtime/mcp-result.js";

export type { McpCallResult } from "../../agent-runtime/mcp-result.js";

const MCP_PROTOCOL_VERSION: string = "2025-11-25";

type UnknownObject = { [K in string]: unknown };

type Environment = { readonly [K in string]: string | undefined };

type DiagnosticFields = { readonly [K in string]: unknown };

type StringHeaders = { [K in string]: string };

type SecretHeaders = { readonly [K in string]: Redacted.Redacted<string> };

type McpToolArguments = { readonly [K in string]: unknown };

const TolerantListToolsResult = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
});

const McpToolHitSchema = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optionalKey(Schema.Unknown),
  annotations: Schema.optionalKey(Schema.Struct({
    title: Schema.optionalKey(Schema.String),
    readOnlyHint: Schema.optionalKey(Schema.Boolean),
    destructiveHint: Schema.optionalKey(Schema.Boolean),
    idempotentHint: Schema.optionalKey(Schema.Boolean),
    openWorldHint: Schema.optionalKey(Schema.Boolean),
  })),
});

export type McpToolHit = typeof McpToolHitSchema.Type;

interface McpProgress {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

type McpToolsChanged =
  | { readonly tag: "success"; readonly tools: ReadonlyArray<McpToolHit> }
  | { readonly tag: "failure"; readonly error: Error };

export interface McpConnection {
  readonly instructions: string | undefined;
  tools(): ReadonlyArray<McpToolHit>;
  callTool(input: {
    readonly name: string;
    readonly arguments?: McpToolArguments;
    readonly onProgress?: (progress: McpProgress) => void;
    readonly signal?: AbortSignal;
  }): Promise<McpCallResult>;
  onClose(callback: () => void): void;
  onToolsChanged(callback: (result: McpToolsChanged) => void): void;
  close(): Promise<void>;
}

/** A received JSON response whose `json()` parses the body as one named turn
 *  of the shared task slice. Every other reader, such as `text()` or a body
 *  cancel, reads the received stream unchanged. */
class JsonTurnResponse extends Response {
  constructor(received: Response) {
    super(received.body, received);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: this overrides Response.json(), and the SDK validates the JSON-RPC message it returns.
  override async json(): Promise<unknown> {
    const body = await this.arrayBuffer();
    return runInTaskTurn("mcp:receive", () => JSON.parse(new TextDecoder().decode(body)));
  }
}

/** The fetch of a Streamable HTTP connection. A tool result can be a JSON
 *  body of several megabytes. If the SDK parses it with `Response.json()`,
 *  the parse runs where the body completes, joins the other work of that
 *  event-loop iteration, and no lag probe sees it. The JSON responses of this
 *  fetch read the body bytes natively and parse them as one named turn of the
 *  shared task slice, so each spent slice takes at most one such parse and a
 *  stall names it. The parse runs only when the SDK reads the message: the
 *  SDK cancels the body of a 202 and of a reply to a notification, and such a
 *  body can be empty even when its content type is JSON. */
async function fetchWithJsonTurn(url: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.headers.get("content-type")?.includes("application/json") !== true) return response;
  return new JsonTurnResponse(response);
}

export interface McpConnectionOptions {
  readonly server: string;
  readonly config: McpServerConfig;
  readonly executionCwd: string;
  readonly env?: Environment;
  readonly log?: (message: string, fields?: DiagnosticFields) => void;
  readonly signal: AbortSignal;
  /** Epoch ms shared by every startup request of one connection attempt, so no
   *  single request can extend the attempt past its deadline. */
  readonly startupDeadline: number;
  readonly authProvider?: OAuthClientProvider;
  readonly secrets?: Redacted.Redacted<string>[];
  /** Secret headers from the credential store, merged over config headers at transport construction. */
  readonly storedHeaders?: SecretHeaders;
  /** Launch authority for a stdio server: the generation's launcher, which
   *  admits the server only after the guardian owns its container. Absent for
   *  runtimes with no launch surface, where a stdio server fails closed rather
   *  than starting something nobody owns. */
  readonly spawnOwned?: LauncherScope["spawnOwned"];
}

export async function createMcpConnection(options: McpConnectionOptions): Promise<McpConnection> {
  const config = options.config;
  const env = options.env ?? process.env;
  const secrets = options.secrets ?? [];
  const log = (message: string, fields?: DiagnosticFields): void => {
    const redactedFields = fields === undefined
      ? undefined
      : Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactMcpValue(value, secrets)]));
    options.log?.(redactMcpString(message, secrets), redactedFields);
  };
  let transport: BunStdioClientTransport | StreamableHTTPClientTransport;
  if (config.command === undefined || config.args === undefined || config.env === undefined) {
    if (config.url === undefined || config.headers === undefined) throw new Error(`Invalid MCP config for '${options.server}'`);
    const url = resolveMcpTemplate(config.url, env, secrets);
    const headers = Object.fromEntries(Object.entries(config.headers).map(
      ([name, value]) => [name, Redacted.value(resolveMcpTemplate(value, env, secrets))],
    ));
    for (const [name, value] of Object.entries(options.storedHeaders ?? {})) {
      secrets.push(value);
      headers[name] = Redacted.value(value);
    }
    transport = new StreamableHTTPClientTransport(new URL(Redacted.value(url)), {
      ...(options.authProvider === undefined ? {} : { authProvider: options.authProvider }),
      requestInit: { headers },
      fetch: fetchWithJsonTurn,
    });
  } else {
    const spawnOwned = options.spawnOwned;
    if (spawnOwned === undefined) throw new Error(`MCP server '${options.server}' is a stdio server, but this runtime has no launch authority`);
    const command = resolveMcpTemplate(config.command, env, secrets);
    const args = config.args.map((value) => resolveMcpTemplate(value, env, secrets));
    const configuredEnv = Object.entries(config.env).map(
      ([name, value]) => [name, resolveMcpTemplate(value, env, secrets)] as const,
    );
    const childEnvironment = {
      ...definedEnvironment(env),
      ...Object.fromEntries(configuredEnv.map(([name, value]) => [name, Redacted.value(value)])),
    };
    transport = new BunStdioClientTransport({
      command: Redacted.value(command),
      args: args.map(Redacted.value),
      cwd: options.executionCwd,
      env: childEnvironment,
      signal: options.signal,
      onStderrRecord: (record) => {
        log("MCP server stderr", {
          server: options.server,
          output: record,
        });
      },
      spawnOwned,
    });
  }


  if (LATEST_PROTOCOL_VERSION !== MCP_PROTOCOL_VERSION) {
    throw new Error(`MCP SDK protocol version changed: expected ${MCP_PROTOCOL_VERSION}, got ${LATEST_PROTOCOL_VERSION}`);
  }

  const client = new Client(
    { name: "flywheel", version: "0.0.1" },
    { capabilities: {} },
  );
  client.fallbackNotificationHandler = async (notification) => {
    log("MCP server notification", { server: options.server, method: notification.method });
  };

  let tools: ReadonlyArray<McpToolHit> = [];
  let closeCallback = (): void => {};
  let toolsChangedCallback = (_result: McpToolsChanged): void => {};
  let closed = false;
  let closePromise: Promise<void> | null = null;

  /** Every startup request carries the attempt signal and what remains of the
   *  one attempt deadline. */
  const startupRequest = (): RequestOptions => ({
    timeout: Math.max(1, options.startupDeadline - Date.now()),
    signal: options.signal,
  });

  try {
    await client.connect(transport, startupRequest());
    tools = await listAllTools(client, options.server, startupRequest);
  } catch (error) {
    await client.close().catch(() => {});
    if (error instanceof UnauthorizedError || error instanceof StreamableHTTPError && error.code === 401) {
      throw new McpNeedsAuthError(options.server);
    }
    throw redactMcpError(error, secrets);
  }

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP SDK exposes close as an assignable callback property.
  client.onclose = () => {
    if (closed) return;
    closed = true;
    closeCallback();
  };
  if (client.getServerCapabilities()?.tools?.listChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        // A refresh runs after the startup attempt settled, so it carries its
        // own bound instead of the exhausted attempt deadline.
        tools = await listAllTools(client, options.server, () => ({ timeout: MCP_STARTUP_TIMEOUT_MS }));
        toolsChangedCallback({ tag: "success", tools });
      } catch (cause) {
        toolsChangedCallback({ tag: "failure", error: redactMcpError(cause, secrets) });
      }
    });
  }

  return {
    instructions: redactMcpString(client.getInstructions()?.trim() ?? "", secrets) || undefined,
    tools: () => tools,
    async callTool(input) {
      try {
        const result = await client.request(
          { method: "tools/call", params: { name: input.name, arguments: input.arguments ?? {} } },
          ResultSchema,
          {
            // The SDK has no switch that disables its request timer, which
            // progress does not reset, and a runtime fires a longer delay at
            // once. The caller's signal owns the duration: the dispatcher
            // watchdog, the Code Mode deadline, or an interrupt (ARCH-TOOLS-006).
            timeout: MAX_TIMER_MS,
            signal: input.signal,
            onprogress: input.onProgress === undefined
              ? undefined
              : (progress) => input.onProgress?.({
                progress: progress.progress,
                ...(progress.total === undefined ? {} : { total: progress.total }),
                ...(progress.message === undefined ? {} : { message: redactMcpString(progress.message, secrets) }),
              }),
          },
        );
        return normalizeMcpCallResult(result, secrets);
      } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof StreamableHTTPError && error.code === 401) {
          throw new McpNeedsAuthError(options.server);
        }
        const redacted = redactMcpError(error, secrets);
        if (answeredOrRefused(error, input.signal)) throw redacted;
        throw new McpOutcomeUnknownError(redacted.message);
      }
    },
    onClose(callback) {
      closeCallback = callback;
    },
    onToolsChanged(callback) {
      toolsChangedCallback = callback;
    },
    close() {
      if (closed && !closePromise) return Promise.resolve();
      closePromise ??= (async () => {
        closed = true;
        await client.close();
      })();
      return closePromise;
    },
  };
}

export function normalizeMcpTools(server: string, value: unknown): McpToolHit[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) throw new Error("Invalid MCP tools/list response");
  return value.tools.map((tool) => {
    if (!isRecord(tool)) throw new Error("Invalid MCP tool definition");
    const candidate = {
      server,
      name: tool.name,
      inputSchema: tool.inputSchema,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    };
    const parsed = Schema.decodeUnknownResult(McpToolHitSchema)(candidate);
    if (Result.isFailure(parsed)) throw new Error("Invalid MCP tool definition", { cause: parsed.failure });
    return parsed.success;
  });
}

export function normalizeMcpCallResult(
  value: unknown,
  secrets: ReadonlyArray<Redacted.Redacted<string>> = [],
): McpCallResult {
  return normalizeMcpResult(redactMcpValue(value, secrets));
}

/** Whether a failed tool call is definite: the server answered it, or refused
 *  the request before processing it (ARCH-TOOLS-050). An interrupt, a closed
 *  connection, a gateway or network failure, and an unreadable response leave
 *  the outcome unknown. The SDK reports a closed connection with the code
 *  -32000, which a server may also send; that answer then reads as unknown,
 *  which only adds a check before a repeat. */
function answeredOrRefused(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return false;
  if (error instanceof McpError) return error.code !== ErrorCode.ConnectionClosed;
  const status = error instanceof StreamableHTTPError ? error.code : undefined;
  return status !== undefined && status >= 400 && status < 500;
}

async function listAllTools(
  client: Client,
  server: string,
  request: () => RequestOptions,
): Promise<McpToolHit[]> {
  const collected: McpToolHit[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const params = cursor === undefined ? undefined : { cursor };
    let result: unknown;
    try {
      result = await client.listTools(params, request());
    } catch (error) {
      if (!(error instanceof Error) || !isOutputSchemaError(error)) throw error;
      result = await client.request({ method: "tools/list", params }, TolerantListToolsResult, request());
    }
    collected.push(...normalizeMcpTools(server, result));
    if (!isRecord(result) || typeof result.nextCursor !== "string") return collected;
    if (seen.has(result.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${result.nextCursor}`);
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}


function definedEnvironment(env: Environment): StringHeaders {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isOutputSchemaError(error: Error): boolean {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(error.message);
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
