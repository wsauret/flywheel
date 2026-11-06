import { createHash } from "node:crypto";
import type { ClaudeLoginEngine, ClaudeLoginHost } from "../../../infra/claude-engine.js";
import { Log } from "../../../infra/log.js";
import { createOrderedLane } from "../../../infra/ordered-lane.js";
import { callThroughEngine, engineToolPart, toolsOf } from "./claude-engine.js";
import { claudeEngineControl, type ClaudeEngineControl, type EngineServerStatus } from "./claude-engine-session.js";
import type { McpConnectorServer } from "./config.js";
import type { McpConnection } from "./connection.js";
import { createDebugToolCapture, ConnectorToolsRefusedError } from "./connector-tools-capture.js";
import { McpConnectorError, McpConnectorLoginError, McpNeedsAuthError } from "./errors.js";

const log = Log.create({ service: "mcp" });

/** How long a call engine may take to fetch the login's connectors and leave `pending`. The engine states no end of
 *  its fetch, so a login with no connector waits all of it. */
const LIST_SETTLE_MS = 15_000;
/** How long a discovery engine may take to connect one connector. */
const CONNECT_SETTLE_MS = 20_000;
const POLL_MS = 250;
const CONNECTOR_TYPE = "claudeai-proxy";

/** One read of the connectors of every login. */
interface McpConnectorRead {
  /** The connectors by server name, and one entry for each login that could not be read, whose connection fails
   *  with `McpConnectorLoginError`. */
  readonly connectors: { readonly [name: string]: McpConnectorServer["connector"] };
  /** The keys of the logins read, in profile order. */
  readonly logins: readonly string[];
  /** Ends the read's hold of the call engines that it started or found. An engine that no connection holds then
   *  stops, so the caller releases once its connections hold what they use. Settles once those engines stopped. */
  release(): Promise<void>;
}

/**
 * The person's claude.ai connectors as MCP servers (PI-CAP-020). Each Claude login of the profile runs one call engine,
 * which fetches the login's connectors, names them, and carries every tool call to them. It runs while a read or a
 * connection holds it. A connector's tool definitions come from a short-lived discovery engine on the same login,
 * which writes its API client's debug log with every credential masked; Flywheel reads that connector's tools from the
 * log of a token count. A connector that several logins have is served by the first login in profile order.
 */
export interface McpConnectors {
  /** Reads the connectors of every login. It stops the call engine of a login that left the profile. */
  read(): Promise<McpConnectorRead>;
  /** Connects one connector of the last read: reads its tools through discovery, then calls through the call engine
   *  of its login. Rejects with `McpNeedsAuthError` when the connector needs a sign-in on claude.ai, with
   *  `McpConnectorError` when its login cannot be reached or its tools cannot be read, and with the abort reason when
   *  `signal` aborts. */
  connect(name: string, signal: AbortSignal): Promise<McpConnection>;
  /** Stops the call engine that serves one connector of the last read, so that the next read or connection starts a
   *  fresh engine, which fetches the connectors' state again. Its connections close. */
  restart(name: string): Promise<void>;
  /** Stops every engine and forgets the last read. A later `read` starts again. */
  stop(): Promise<void>;
}

/** One login's call engine and the connections that it carries. */
interface CallEngine {
  readonly engine: ClaudeLoginEngine;
  readonly control: ClaudeEngineControl;
  readonly connections: Set<() => void>;
}

/** One holder's claim on a login's call engine. */
interface CallEngineHold {
  readonly running: Promise<CallEngine>;
  /** Ends the claim once; the engine stops after its last holder, and this settles when it stopped. */
  release(): Promise<void>;
}

/** The call engine of one login while reads and connections hold it. */
interface CallEngineSlot {
  readonly login: ClaudeLoginHost;
  readonly running: Promise<CallEngine>;
  holders: number;
  /** Set once Flywheel stopped the engine or the engine ended; the slot then serves no new holder. */
  retired: boolean;
}

/** One connector of the last read: its name in the engine, the login that serves it, and its connector address. */
interface ListedConnector {
  readonly engineName: string;
  readonly login: ClaudeLoginHost;
  readonly url: string;
  readonly id: string;
}

export function createMcpConnectors(logins: () => Promise<readonly ClaudeLoginHost[]>): McpConnectors {
  const slots = new Map<string, CallEngineSlot>();
  const stopping = new Set<Promise<void>>();
  const discoveries = new Map<string, { readonly lane: ReturnType<typeof createOrderedLane>; users: number; engine?: Promise<Discovery> }>();
  let listed = new Map<string, ListedConnector>();
  let unreachable = new Map<string, ClaudeLoginHost>();

  /** Holds the login's call engine, which starts for the first holder. */
  function hold(login: ClaudeLoginHost): CallEngineHold {
    const slot = slots.get(login.key) ?? startSlot(login);
    slot.holders += 1;
    let held = true;
    return {
      running: slot.running,
      release() {
        if (!held) return Promise.resolve();
        held = false;
        slot.holders -= 1;
        return slot.holders === 0 ? retire(slot, "unused") : Promise.resolve();
      },
    };
  }

  function startSlot(login: ClaudeLoginHost): CallEngineSlot {
    const startedAt = Date.now();
    const running = login.start({ connectors: true }).then((engine): CallEngine => {
      log.info("MCP connector engine started", { login: loginDigest(login), purpose: "calls", durationMs: Date.now() - startedAt });
      const call: CallEngine = { engine, control: claudeEngineControl(engine.query), connections: new Set() };
      // The engine released what it ran on at its end; its connections close, and the next holder starts another.
      void engine.ended.then(() => {
        if (slot.retired) return;
        forget(slot);
        log.warn("MCP connector engine ended unexpectedly", { login: loginDigest(login), connections: call.connections.size });
        for (const lost of call.connections) lost();
      });
      return call;
    }, (error: unknown) => {
      forget(slot);
      log.warn("MCP connector engine failed to start", { login: loginDigest(login), purpose: "calls", durationMs: Date.now() - startedAt, errorKind: error instanceof Error ? error.name : typeof error });
      throw new McpConnectorLoginError({ cause: error });
    });
    const slot: CallEngineSlot = { login, running, holders: 0, retired: false };
    slots.set(login.key, slot);
    return slot;
  }

  function forget(slot: CallEngineSlot): void {
    slot.retired = true;
    if (slots.get(slot.login.key) === slot) slots.delete(slot.login.key);
  }

  /** Stops the slot's engine once, closing every connection that it carries. */
  function retire(slot: CallEngineSlot, reason: string): Promise<void> {
    if (slot.retired) return Promise.resolve();
    forget(slot);
    const stopped = (async () => {
      const call = await slot.running.catch(() => undefined);
      if (call === undefined) return;
      for (const lost of call.connections) lost();
      await call.engine.stop();
      log.info("MCP connector engine stopped", { login: loginDigest(slot.login), purpose: "calls", reason });
    })();
    stopping.add(stopped);
    void stopped.finally(() => { stopping.delete(stopped); });
    return stopped;
  }

  /** Runs `work` on the login's discovery engine, which starts for the first waiter and stops after the last. */
  async function withDiscovery<T>(login: ClaudeLoginHost, work: (discovery: Discovery) => Promise<T>): Promise<T> {
    const holder = discoveries.get(login.key) ?? { lane: createOrderedLane(), users: 0 };
    discoveries.set(login.key, holder);
    holder.users += 1;
    try {
      return await holder.lane.run(async () => {
        holder.engine ??= startDiscovery(login);
        return await work(await holder.engine);
      });
    } finally {
      holder.users -= 1;
      if (holder.users === 0) {
        discoveries.delete(login.key);
        const engine = await holder.engine?.catch(() => undefined);
        await engine?.engine.stop();
        if (engine !== undefined) log.info("MCP connector engine stopped", { login: loginDigest(login), purpose: "discovery", reason: "discovery done" });
      }
    }
  }

  async function startDiscovery(login: ClaudeLoginHost): Promise<Discovery> {
    const startedAt = Date.now();
    const capture = createDebugToolCapture();
    try {
      const engine = await login.start({ connectors: false, debugLog: capture.onLine });
      log.info("MCP connector engine started", { login: loginDigest(login), purpose: "discovery", durationMs: Date.now() - startedAt });
      return { engine, control: claudeEngineControl(engine.query), capture };
    } catch (error) {
      log.warn("MCP connector engine failed to start", { login: loginDigest(login), purpose: "discovery", durationMs: Date.now() - startedAt, errorKind: error instanceof Error ? error.name : typeof error });
      throw new McpConnectorLoginError({ cause: error });
    }
  }

  async function read(): Promise<McpConnectorRead> {
    const startedAt = Date.now();
    const current = await logins();
    const keys = new Set(current.map((login) => login.key));
    const holds = current.map(hold);
    const perLogin = await Promise.all(current.map(async (login, index) => {
      try {
        // SAFETY: `holds` has one entry for each login.
        const call = await holds[index]!.running;
        return { login, connectors: await settledConnectors(call.control) };
      } catch {
        return { login, connectors: undefined };
      }
    }));
    const next = new Map<string, ListedConnector>();
    const failed = new Map<string, ClaudeLoginHost>();
    for (const { login, connectors } of perLogin) {
      if (connectors === undefined) failed.set(`claude_ai_login_${engineToolPart(login.identity)}`, login);
      else for (const status of connectors) {
        const engineName = engineToolPart(status.name);
        if (next.has(engineName) || status.config?.url === undefined || status.config.id === undefined) continue;
        next.set(engineName, { engineName, login, url: status.config.url, id: status.config.id });
      }
    }
    listed = next;
    unreachable = failed;
    // A login that left the profile stops once the list names its successor, so its connections reconnect there.
    await Promise.all([...slots.values()].filter((slot) => !keys.has(slot.login.key)).map((slot) => retire(slot, "login left the profile")));
    const found = perLogin.reduce((sum, entry) => sum + (entry.connectors?.length ?? 0), 0);
    log.info("MCP connectors read", { logins: current.length, unreachable: failed.size, connectors: next.size, duplicates: found - next.size, durationMs: Date.now() - startedAt });
    const entries = [...next].map(([name, connector]) => [name, connector.login] as const).concat([...failed]);
    return {
      connectors: Object.fromEntries(entries.map(([name, login]) => [name, { login: login.key, identity: login.identity }])),
      logins: [...keys],
      release: async () => { await Promise.all(holds.map((held) => held.release())); },
    };
  }

  async function connect(name: string, signal: AbortSignal): Promise<McpConnection> {
    if (unreachable.has(name)) throw new McpConnectorLoginError();
    const connector = listed.get(name);
    if (connector === undefined) throw new Error(`claude.ai connector not found: ${name}`);
    const held = hold(connector.login);
    try {
      const call = await held.running;
      const status = (await settledConnectors(call.control)).find((entry) => engineToolPart(entry.name) === name);
      signal.throwIfAborted();
      if (status?.status === "needs-auth") throw new McpNeedsAuthError(name);
      if (status?.status !== "connected") throw new Error(`claude.ai connector '${name}' could not connect`);
      const tools = await readTools(connector, status, signal);
      return connectionOf(call, tools, held.release);
    } catch (error) {
      await held.release();
      throw error;
    }
  }

  /** Reads one connector's tools through its login's discovery engine, and records the outcome once. */
  async function readTools(connector: ListedConnector, status: EngineServerStatus, signal: AbortSignal): Promise<ReturnType<typeof toolsOf>> {
    const startedAt = Date.now();
    try {
      const captured = await withDiscovery(connector.login, (discovery) => discoverTools(discovery, status.name, connector, signal));
      const tools = toolsOf(connector.engineName, connector.engineName, status, captured);
      log.info("MCP connector tools read", { login: loginDigest(connector.login), tools: tools.tools.length, durationMs: Date.now() - startedAt });
      return tools;
    } catch (error) {
      const refusal = signal.aborted ? "aborted" : error instanceof ConnectorToolsRefusedError ? error.kind : error instanceof McpConnectorError ? "login" : "unreadable";
      log.info("MCP connector tools refused", { login: loginDigest(connector.login), refusal, durationMs: Date.now() - startedAt });
      if (signal.aborted || error instanceof McpConnectorError) throw error;
      throw new ConnectorToolsRefusedError("unreadable");
    }
  }

  function connectionOf(call: CallEngine, tools: ReturnType<typeof toolsOf>, release: () => Promise<void>): McpConnection {
    let closeCallback = (): void => {};
    let open = true;
    const end = (): Promise<void> => {
      if (!open) return Promise.resolve();
      open = false;
      call.connections.delete(lost);
      return release();
    };
    const lost = (): void => {
      if (!open) return;
      void end();
      closeCallback();
    };
    call.connections.add(lost);
    return {
      instructions: undefined,
      tools: () => tools.tools,
      // A connector's URL and headers stay inside the engine, so no output of a call holds a secret of Flywheel's.
      callTool: (input) => callThroughEngine(call.control, tools.qualified, input, []),
      onClose(callback) { closeCallback = callback; },
      onToolsChanged() {},
      close: end,
    };
  }

  return {
    read,
    connect,
    async restart(name) {
      const login = listed.get(name)?.login ?? unreachable.get(name);
      const slot = login === undefined ? undefined : slots.get(login.key);
      if (slot !== undefined) await retire(slot, "reconnect");
    },
    async stop() {
      listed = new Map();
      unreachable = new Map();
      await Promise.all([...slots.values()].map((slot) => retire(slot, "connectors off")));
      await Promise.all(stopping);
    },
  };
}

interface Discovery {
  readonly engine: ClaudeLoginEngine;
  readonly control: ClaudeEngineControl;
  readonly capture: ReturnType<typeof createDebugToolCapture>;
}

/** Reads one connector's tools: the discovery engine holds that connector alone, so the token count that its context
 *  usage request sends carries only that connector's tools. */
async function discoverTools(discovery: Discovery, engineServer: string, connector: ListedConnector, signal: AbortSignal) {
  await discovery.control.setServers({ [engineServer]: { type: CONNECTOR_TYPE, url: connector.url, id: connector.id } });
  const deadline = Date.now() + CONNECT_SETTLE_MS;
  while (true) {
    signal.throwIfAborted();
    const status = (await discovery.control.status()).find((entry) => entry.name === engineServer);
    if (status?.status === "connected") break;
    if ((status !== undefined && status.status !== "pending") || Date.now() > deadline) throw new ConnectorToolsRefusedError("no-definitions");
    await Bun.sleep(POLL_MS);
  }
  return await discovery.capture.capture(connector.engineName, async () => { await discovery.engine.query.getContextUsage({ detail: "full" }); });
}

/** The login's connectors once the call engine fetched them and none is still connecting, within the settle bound. */
async function settledConnectors(control: ClaudeEngineControl): Promise<readonly EngineServerStatus[]> {
  const deadline = Date.now() + LIST_SETTLE_MS;
  while (true) {
    const connectors = (await control.status()).filter((entry) => entry.config?.type === CONNECTOR_TYPE);
    if ((connectors.length > 0 && connectors.every((entry) => entry.status !== "pending")) || Date.now() > deadline) return connectors;
    await Bun.sleep(POLL_MS);
  }
}

/** A short stable digest of a login's account id for diagnostics. */
function loginDigest(login: ClaudeLoginHost): string {
  return createHash("sha256").update(login.accountId).digest("hex").slice(0, 12);
}
