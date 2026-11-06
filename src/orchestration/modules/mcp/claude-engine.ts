import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Redacted } from "effect";
import { processEngineHost } from "../../../infra/claude-engine.js";
import { Log } from "../../../infra/log.js";
import { osAccount } from "../../../infra/os-account.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { createOrderedLane } from "../../../infra/ordered-lane.js";
import type { ClaudeClientOAuth } from "./clients.js";
import { EngineServerAnswer, launchClaudeEngineSession, type CapturedTool, type ClaudeEngineControl, type ClaudeEngineSession, type EngineServerConfig, type EngineServerStatus } from "./claude-engine-session.js";
import { redactMcpError } from "./config.js";
import type { McpCallResult, McpConnection, McpToolHit } from "./connection.js";
import { McpNeedsAuthError, McpOutcomeUnknownError, McpSignInPortBusyError } from "./errors.js";
import type { McpOAuthAuthorization } from "./oauth.js";

const log = Log.create({ service: "mcp" });

/** One Claude-client server as the manager resolved it: the template-resolved URL and headers, the engine's OAuth
 *  client settings, and every secret its output must not show. */
interface ClaudeServerRequest {
  readonly server: string;
  readonly url: string;
  readonly headers: { readonly [name: string]: string };
  readonly oauth: ClaudeClientOAuth;
  readonly secrets: ReadonlyArray<Redacted.Redacted<string>>;
}

/**
 * The one MCP engine of this process: the bundled Claude engine as the MCP client of every server that uses Claude.
 * It starts when the first such server needs a connection or a sign-in and stops when none remains. It always holds
 * the full set of those servers. Flywheel dispatches and records every tool call; the engine only carries it to the
 * server. An engine that cannot start fails only the servers that need it.
 */
export interface McpClaudeEngine {
  /** Connects one server through the engine and answers once the server is connected and its tools are known.
   *  Rejects with `McpNeedsAuthError` when the server needs a sign-in. */
  connect(request: ClaudeServerRequest & { readonly signal: AbortSignal; readonly deadline: number }): Promise<McpConnection>;
  /** Starts the engine's sign-in for one server. A server that is already signed in, for example by another Flywheel
   *  process on the same account, answers with no URL. */
  authorize(request: ClaudeServerRequest): Promise<McpOAuthAuthorization>;
  dispose(): Promise<void>;
}

export interface McpClaudeEngineOptions {
  readonly launch: () => Promise<ClaudeEngineSession>;
  /** How often a connected server's status is read again, to see a lost connection or changed tools. */
  readonly pollMs?: number;
  /** How long a started sign-in waits for the person. */
  readonly signInTimeoutMs?: number;
}

/** The MCP engine of this process on the account credential directory `authDir`. Its own directory there holds the
 *  sign-ins of the servers that use Claude, for every project and auth profile of the account, and is never the
 *  directory of a Claude login. Every Flywheel process of the account runs its engine on it; the engine locks each
 *  token refresh across processes. */
export function processClaudeEngine(authDir: string, launcher: LauncherScope): McpClaudeEngine {
  return createMcpClaudeEngine({
    launch: () => launchClaudeEngineSession({ host: processEngineHost(osAccount()), configDir: join(authDir, "mcp-claude-engine"), launcher }),
  });
}

const POLL_MS = 5_000;
const SETTLE_POLL_MS = 250;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** One server registered on the engine until `release` runs. */
interface HeldServer {
  readonly engineName: string;
  release(): void;
}

/** One server's tools, and the engine's name of each tool by its Flywheel name. */
export interface EngineTools {
  readonly tools: readonly McpToolHit[];
  readonly qualified: ReadonlyMap<string, string>;
}

/** One holder's config of an engine server. */
interface Holding {
  readonly config: EngineServerConfig;
}

interface LiveConnection {
  readonly engineName: string;
  readonly session: ClaudeEngineSession;
  toolNames: string;
  refresh(status: EngineServerStatus | undefined): Promise<void>;
  lost(): void;
}

/** The engine's name of one server. The engine keys a server's sign-in by its name and URL, so the name stays the
 *  same while the Flywheel server keeps its name and URL: a removed and added server, or one whose client switches
 *  back to Claude, finds its sign-in again. A digest keeps the name inside the characters the engine allows in a
 *  tool name. */
export function engineServerName(server: string, url: string): string {
  return `fw_${createHash("sha256").update(`${server}\0${url}`).digest("hex").slice(0, 16)}`;
}

/** The engine's name part of a server or tool: every character outside `[a-zA-Z0-9_-]` becomes `_`. */
export function engineToolPart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, "_");
}

export function createMcpClaudeEngine(options: McpClaudeEngineOptions): McpClaudeEngine {
  const pollMs = options.pollMs ?? POLL_MS;
  const signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;
  /** The holders of each engine server, oldest first. The engine has one config per server, and it is the oldest
   *  holder's: a replacement registry that warms beside the live one shares the engine server but never changes the
   *  config that the live registry's calls use. Its config applies when the older holders release, at the handoff. */
  const registrations = new Map<string, Holding[]>();
  const connections = new Set<LiveConnection>();
  const sync = createOrderedLane();
  let session: Promise<ClaudeEngineSession> | undefined;
  let stopping: ClaudeEngineSession | undefined;
  let poller: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function start(): Promise<ClaudeEngineSession> {
    const startedAt = Date.now();
    const started = options.launch().then((running) => {
      log.info("MCP engine started", { servers: registrations.size, durationMs: Date.now() - startedAt });
      void running.ended.then(() => ended(running));
      return running;
    }, (error: unknown) => {
      if (session === started) session = undefined;
      log.warn("MCP engine failed to start", { servers: registrations.size, durationMs: Date.now() - startedAt, errorKind: error instanceof Error ? error.name : typeof error });
      throw new Error("The Claude engine that ships with Flywheel could not start. Reinstall Flywheel, or run bun install in a source checkout.", { cause: error });
    });
    return started;
  }

  async function ended(running: ClaudeEngineSession): Promise<void> {
    const current = session === undefined ? undefined : await session.catch(() => undefined);
    if (current === running) session = undefined;
    if (stopping === running) {
      stopping = undefined;
      return;
    }
    log.warn("MCP engine ended unexpectedly", { connections: connections.size });
    for (const connection of connections) if (connection.session === running) connection.lost();
  }

  /** Sends the full registered set, starting the engine for the first server and stopping it after the last. */
  function apply(): Promise<ClaudeEngineSession | undefined> {
    return sync.run(async () => {
      if (registrations.size === 0) {
        const running = session;
        session = undefined;
        if (running === undefined) return undefined;
        const engine = await running.catch(() => undefined);
        if (engine === undefined) return undefined;
        stopping = engine;
        await engine.close();
        log.info("MCP engine stopped", { reason: disposed ? "disposed" : "no Claude servers" });
        return undefined;
      }
      session ??= start();
      const engine = await session;
      // SAFETY: `release` deletes a server with its last holder, so every list has an oldest holder.
      await engine.setServers(Object.fromEntries(Array.from(registrations, ([name, holders]) => [name, holders[0]!.config])));
      return engine;
    });
  }

  /** Registers one server until the returned release runs. */
  function hold(request: ClaudeServerRequest): HeldServer {
    if (disposed) throw new Error("The MCP engine was disposed");
    const engineName = engineServerName(request.server, request.url);
    const config: EngineServerConfig = {
      type: "http" as const,
      url: request.url,
      headers: request.headers,
      ...(Object.keys(request.oauth).length === 0 ? {} : { oauth: request.oauth }),
    };
    const holding: Holding = { config };
    const holders = registrations.get(engineName) ?? [];
    holders.push(holding);
    registrations.set(engineName, holders);
    let released = false;
    return {
      engineName,
      release() {
        if (released) return;
        released = true;
        const index = holders.indexOf(holding);
        holders.splice(index, 1);
        if (holders.length === 0) registrations.delete(engineName);
        // Only the oldest holder's release changes what the engine holds: the server goes, or the next config applies.
        if (index === 0) void apply().catch(() => {});
      },
    };
  }

  /** Reads the server's status until it leaves `pending`, within `deadline`. */
  async function settled(engine: ClaudeEngineSession, engineName: string, deadline: number, signal?: AbortSignal): Promise<EngineServerStatus> {
    while (true) {
      signal?.throwIfAborted();
      const status = (await engine.status()).find((entry) => entry.name === engineName);
      if (status !== undefined && status.status !== "pending") return status;
      if (Date.now() + SETTLE_POLL_MS > deadline) throw new Error("The server did not connect through Claude in time");
      await Bun.sleep(SETTLE_POLL_MS);
    }
  }

  function schedulePoll(): void {
    if (poller !== undefined || connections.size === 0 || disposed) return;
    poller = setTimeout(() => {
      void poll().finally(() => {
        poller = undefined;
        schedulePoll();
      });
    }, pollMs);
  }

  async function poll(): Promise<void> {
    const engines = new Set([...connections].map((connection) => connection.session));
    for (const engine of engines) {
      let statuses: readonly EngineServerStatus[];
      try {
        statuses = await engine.status();
      } catch {
        // An engine that stopped answering ends; its end reaches every connection.
        continue;
      }
      for (const connection of connections) {
        if (connection.session !== engine) continue;
        await connection.refresh(statuses.find((entry) => entry.name === connection.engineName));
      }
    }
  }

  async function connect(request: ClaudeServerRequest & { readonly signal: AbortSignal; readonly deadline: number }): Promise<McpConnection> {
    const held = hold(request);
    try {
      const engine = await apply();
      // SAFETY: `hold` registered this server, so `apply` started the engine.
      const running = engine!;
      const status = await settled(running, held.engineName, request.deadline, request.signal);
      if (status.status === "needs-auth") throw new McpNeedsAuthError(request.server);
      if (status.status !== "connected") throw new Error(`MCP server '${request.server}' could not connect through Claude`);
      const connection = await connectionOf(running, request, held, status);
      log.debug("MCP engine server connected", { tools: connection.tools().length });
      return connection;
    } catch (error) {
      held.release();
      throw error;
    }
  }

  async function connectionOf(engine: ClaudeEngineSession, request: ClaudeServerRequest, held: HeldServer, status: EngineServerStatus): Promise<McpConnection> {
    let current = toolsOf(request.server, held.engineName, status, await engine.captureTools());
    let closeCallback = (): void => {};
    let toolsCallback: Parameters<McpConnection["onToolsChanged"]>[0] = () => {};
    let open = true;
    const live: LiveConnection = {
      engineName: held.engineName,
      session: engine,
      toolNames: toolNamesOf(status),
      async refresh(next) {
        if (!open) return;
        if (next?.status !== "connected") {
          live.lost();
          return;
        }
        const names = toolNamesOf(next);
        if (names === live.toolNames) return;
        live.toolNames = names;
        try {
          current = toolsOf(request.server, held.engineName, next, await engine.captureTools());
          toolsCallback({ tag: "success", tools: current.tools });
        } catch (error) {
          toolsCallback({ tag: "failure", error: redactMcpError(error, request.secrets) });
        }
      },
      lost() {
        if (!open) return;
        open = false;
        connections.delete(live);
        held.release();
        closeCallback();
      },
    };
    connections.add(live);
    schedulePoll();
    return {
      instructions: undefined,
      tools: () => current.tools,
      callTool: (input) => callThroughEngine(engine, current.qualified, input, request.secrets),
      onClose(callback) { closeCallback = callback; },
      onToolsChanged(callback) { toolsCallback = callback; },
      async close() {
        if (!open) return;
        open = false;
        connections.delete(live);
        held.release();
      },
    };
  }

  async function authorize(request: ClaudeServerRequest): Promise<McpOAuthAuthorization> {
    const held = hold(request);
    const close = async (): Promise<void> => { held.release(); };
    try {
      const engine = await apply();
      // SAFETY: `hold` registered this server, so `apply` started the engine.
      const running = engine!;
      // The server joins the engine afresh here, so a sign-in that another Flywheel process stored in the shared
      // engine directory is read before the person is asked to sign in again.
      const status = await settled(running, held.engineName, Date.now() + 30_000);
      if (status.status === "connected") return { url: undefined, redirectUrl: "", complete: async () => {}, close };
      let started: { readonly authUrl: string; readonly callbackPort?: number };
      try {
        started = await running.authenticate(held.engineName);
      } catch (error) {
        const port = /callback port (\d+) is already in use/u.exec(error instanceof Error ? error.message : String(error))?.[1];
        if (port !== undefined) throw new McpSignInPortBusyError(Number(port));
        throw redactMcpError(error, request.secrets);
      }
      log.info("MCP engine sign-in started", { callbackPort: started.callbackPort ?? null });
      return {
        url: started.authUrl,
        redirectUrl: started.callbackPort === undefined ? "" : `http://localhost:${started.callbackPort}/callback`,
        async complete() {
          const deadline = Date.now() + signInTimeoutMs;
          while (true) {
            const now = (await running.status()).find((entry) => entry.name === held.engineName);
            if (now?.status === "connected") return;
            if (now?.status === "failed") throw new Error(`MCP server '${request.server}' did not connect after the sign-in`);
            if (Date.now() > deadline) throw new Error(`The sign-in of MCP server '${request.server}' did not finish in time`);
            await Bun.sleep(1_000);
          }
        },
        close,
      };
    } catch (error) {
      held.release();
      throw error;
    }
  }

  return {
    connect,
    authorize,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (poller !== undefined) clearTimeout(poller);
      // The manager closed its connections before it disposed the engine; nothing waits for their close callbacks.
      connections.clear();
      registrations.clear();
      await apply();
    },
  };
}

/** Calls one tool of a server that an engine connects, by the engine's name of the tool in `qualified`. Only the
 *  server's own JSON-RPC answer is definite. An interrupt, and every other rejection, leaves the outcome unknown,
 *  because the server may have run the call (ARCH-TOOLS-050). No output shows one of `secrets`. */
export async function callThroughEngine(engine: Pick<ClaudeEngineControl, "call">, qualified: ReadonlyMap<string, string>, input: Parameters<McpConnection["callTool"]>[0], secrets: ReadonlyArray<Redacted.Redacted<string>>): Promise<McpCallResult> {
  const tool = qualified.get(input.name);
  if (tool === undefined) throw new Error(`MCP tool not found: ${input.name}`);
  const startedAt = Date.now();
  try {
    const result = await engine.call(tool, input.arguments ?? {}, input.signal);
    log.debug("MCP engine call settled", { outcome: "answered", durationMs: Date.now() - startedAt });
    // connection.ts loads the MCP SDK client, which stays off the service's load path, as in the manager.
    const { normalizeMcpCallResult } = await import("./connection.js");
    return normalizeMcpCallResult(result, secrets);
  } catch (error) {
    const redacted = redactMcpError(error, secrets);
    const answered = error instanceof EngineServerAnswer && input.signal?.aborted !== true;
    log.debug("MCP engine call settled", { outcome: answered ? "refused" : "unknown", durationMs: Date.now() - startedAt });
    if (answered) throw redacted;
    throw new McpOutcomeUnknownError(redacted.message);
  }
}

function toolNamesOf(status: EngineServerStatus): string {
  return JSON.stringify((status.tools ?? []).map((tool) => tool.name).toSorted());
}

/** The tools of one server: the engine's status names them and gives their annotations, and the captured token count
 *  gives each one's description and input schema. A status tool with no captured definition fails the whole list,
 *  because a tool without its schema cannot be called. */
export function toolsOf(server: string, engineName: string, status: EngineServerStatus, captured: readonly CapturedTool[]): EngineTools {
  const prefix = `mcp__${engineName}__`;
  const definitions = new Map(captured.filter((tool) => tool.name.startsWith(prefix)).map((tool) => [tool.name, tool]));
  const listed = status.tools ?? [...definitions.keys()].map((name) => ({ name: name.slice(prefix.length) }));
  const qualified = new Map<string, string>();
  const tools = listed.map((tool): McpToolHit => {
    const name = `${prefix}${engineToolPart(tool.name)}`;
    const definition = definitions.get(name);
    if (definition === undefined) throw new Error(`The Claude engine did not report the definition of tool '${tool.name}' of MCP server '${server}'`);
    qualified.set(tool.name, name);
    const annotations = "annotations" in tool ? tool.annotations : undefined;
    return {
      server,
      name: tool.name,
      inputSchema: definition.input_schema,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(annotations === undefined ? {} : {
        annotations: {
          ...(annotations.readOnly === undefined ? {} : { readOnlyHint: annotations.readOnly }),
          ...(annotations.destructive === undefined ? {} : { destructiveHint: annotations.destructive }),
          ...(annotations.openWorld === undefined ? {} : { openWorldHint: annotations.openWorld }),
        },
      }),
    };
  });
  return { tools, qualified };
}
