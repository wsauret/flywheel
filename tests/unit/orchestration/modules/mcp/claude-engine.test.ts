import { describe, expect, it } from "bun:test";
import { createMcpClaudeEngine, engineServerName } from "../../../../../src/orchestration/modules/mcp/claude-engine.js";
import { EngineServerAnswer, type CapturedTool, type ClaudeEngineSession, type EngineServerConfig, type EngineServerStatus } from "../../../../../src/orchestration/modules/mcp/claude-engine-session.js";
import type { McpServerRegistry } from "../../../../../src/orchestration/modules/mcp/config.js";
import type { McpConnectionOptions } from "../../../../../src/orchestration/modules/mcp/connection.js";
import { McpOutcomeUnknownError, McpSignInPortBusyError } from "../../../../../src/orchestration/modules/mcp/errors.js";
import { createMcpManager } from "../../../../../src/orchestration/modules/mcp/manager.js";
import { AUTH_DIR, fakeConnection } from "./_manager-fixtures.js";

const SLACK = "https://mcp.slack.com/mcp";

/** An MCP tool result as the engine answers it. */
interface EngineAnswer {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
}

type HttpServer = Extract<McpServerRegistry[string], { readonly url: string }>;

/** What the fake engine answers for one server URL. */
interface ServerBehavior {
  readonly status: EngineServerStatus["status"];
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly description: string; readonly schema: unknown; readonly annotations?: { readonly readOnly?: boolean } }>;
  /** Tool names whose definitions the token count leaves out. */
  readonly uncaptured?: readonly string[];
}

/** A fake MCP engine over the session seam: it records each full server set and answers status, the token count
 *  capture, calls, and sign-ins from `behaviors`, keyed by server URL. */
function fakeEngine(behaviors: { readonly [url: string]: ServerBehavior }) {
  const sets: Array<{ readonly [name: string]: EngineServerConfig }> = [];
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  let launches = 0;
  let closes = 0;
  let current: { readonly [name: string]: EngineServerConfig } = {};
  let answer: (tool: string, args: unknown, signal: AbortSignal | undefined) => Promise<EngineAnswer> = async () => ({ content: [{ type: "text", text: "ok" }] });
  let authenticate: (server: string) => Promise<{ readonly authUrl: string; readonly callbackPort?: number }> = async () => ({ authUrl: "https://identity.example/authorize", callbackPort: 3118 });
  const ended = Promise.withResolvers<void>();
  const behaviorOf = (name: string) => behaviors[current[name]?.url ?? ""];
  const session: ClaudeEngineSession = {
    async setServers(servers) { current = servers; sets.push(servers); },
    status: async () => Object.keys(current).map((name) => {
      const behavior = behaviorOf(name);
      return { name, status: behavior?.status ?? "failed", ...(behavior?.status === "connected" ? { tools: (behavior.tools ?? []).map((tool) => ({ name: tool.name, ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }) })) } : {}) };
    }),
    captureTools: async () => Object.keys(current).flatMap((name): CapturedTool[] => {
      const behavior = behaviorOf(name);
      if (behavior?.status !== "connected") return [];
      return (behavior.tools ?? []).filter((tool) => !behavior.uncaptured?.includes(tool.name)).map((tool) => ({ name: `mcp__${name}__${tool.name.replace(/[^a-zA-Z0-9_-]/gu, "_")}`, description: tool.description, input_schema: tool.schema }));
    }),
    call: async (tool, args, signal) => { calls.push({ tool, args }); return await answer(tool, args, signal); },
    authenticate: async (server) => await authenticate(server),
    ended: ended.promise,
    async close() { closes += 1; ended.resolve(); },
  };
  return {
    engine: (options: { readonly fail?: boolean } = {}) => createMcpClaudeEngine({
      launch: async () => {
        launches += 1;
        if (options.fail === true) throw new Error("engine missing");
        return session;
      },
      pollMs: 5,
    }),
    sets,
    calls,
    launches: () => launches,
    closes: () => closes,
    answer(next: typeof answer) { answer = next; },
    signIn(next: typeof authenticate) { authenticate = next; },
    end() { ended.resolve(); },
  };
}

function managerOver(servers: McpServerRegistry, engine: ReturnType<ReturnType<typeof fakeEngine>["engine"]>, flywheel: string[] = [], env: { readonly [name: string]: string } = {}) {
  return createMcpManager({
    servers,
    executionCwd: "/scratch",
    authDir: AUTH_DIR,
    env,
    connect: async (options: McpConnectionOptions) => { flywheel.push(options.server); return fakeConnection(); },
    claudeEngine: engine,
  });
}

const http = (url: string, extra: Partial<HttpServer> = {}): HttpServer => ({ url, headers: {}, enabled: true, ...extra });

describe("MCP servers that use Claude as their client", () => {
  it("resolve the client: an explicit choice wins, a listed server at its expanded URL uses its list settings under its own oauth keys, every other server uses Flywheel, and the engine stops with the last server", async () => {
    const fake = fakeEngine({
      [SLACK]: { status: "connected" },
      [`${SLACK}/`]: { status: "connected" },
      "https://notes.example/mcp": { status: "connected" },
    });
    const engine = fake.engine();
    const flywheel: string[] = [];
    const manager = managerOver({
      slack: http(SLACK),
      slackTemplate: http(`\${SLACK_MCP_URL}`),
      slackOwn: http(`${SLACK}/`, { oauth: { client_id: "own-client" } }),
      slackFlywheel: http(SLACK, { client: "flywheel" }),
      notes: http("https://notes.example/mcp", { client: "claude", oauth: { client_id: "notes-client", callback_port: 4000, scope: "read write" } }),
      plain: http("https://plain.example/mcp"),
    }, engine, flywheel, { SLACK_MCP_URL: SLACK });
    try {
      await Promise.all(["slack", "slackTemplate", "slackOwn", "slackFlywheel", "notes", "plain"].map((name) => manager.acquire(name)));
      expect(flywheel.toSorted()).toEqual(["plain", "slackFlywheel"]);
      expect(fake.sets.at(-1)).toEqual({
        [engineServerName("slack", SLACK)]: { type: "http", url: SLACK, headers: {}, oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 } },
        [engineServerName("slackTemplate", SLACK)]: { type: "http", url: SLACK, headers: {}, oauth: { clientId: "1601185624273.8899143856786", callbackPort: 3118 } },
        [engineServerName("slackOwn", `${SLACK}/`)]: { type: "http", url: `${SLACK}/`, headers: {}, oauth: { clientId: "own-client", callbackPort: 3118 } },
        [engineServerName("notes", "https://notes.example/mcp")]: { type: "http", url: "https://notes.example/mcp", headers: {}, oauth: { clientId: "notes-client", callbackPort: 4000, scopes: "read write" } },
      });
      expect(fake.launches()).toBe(1);
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
    expect(fake.closes()).toBe(1);
  });

  it("lists tools from the captured definitions with the status annotations, and fails a server whose definitions did not arrive", async () => {
    const schema = { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] };
    const fake = fakeEngine({
      [SLACK]: { status: "connected", tools: [{ name: "read.channel", description: "Reads a channel in full.", schema, annotations: { readOnly: true } }] },
      "https://broken.example/mcp": { status: "connected", tools: [{ name: "lost", description: "", schema: {} }], uncaptured: ["lost"] },
    });
    const engine = fake.engine();
    const manager = managerOver({ slack: http(SLACK), broken: http("https://broken.example/mcp", { client: "claude" }) }, engine);
    try {
      await manager.acquire("slack");
      expect(manager.tools()).toEqual([{ server: "slack", name: "read.channel", description: "Reads a channel in full.", inputSchema: schema, annotations: { readOnlyHint: true } }]);
      await expect(manager.acquire("broken")).rejects.toThrow("The Claude engine did not report the definition of tool 'lost' of MCP server 'broken'");
      expect(manager.status().find((row) => row.name === "broken")?.status).toBe("failed");
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });

  it("calls a tool through the engine: an answer normalizes, a JSON-RPC answer is definite, every other failure has an unknown outcome, and no output shows a secret of the URL", async () => {
    const keyed = `https://slack.example/mcp?key=\${SLACK_KEY}`;
    const fake = fakeEngine({ "https://slack.example/mcp?key=sekrit-url-key": { status: "connected", tools: [{ name: "read.channel", description: "d", schema: {} }] } });
    const engine = fake.engine();
    const manager = managerOver({ slack: http(keyed, { client: "claude" }) }, engine, [], { SLACK_KEY: "sekrit-url-key" });
    const engineName = engineServerName("slack", "https://slack.example/mcp?key=sekrit-url-key");
    try {
      await manager.acquire("slack");
      expect(await manager.call({ server: "slack", name: "read.channel", arguments: { channel: "c1" } })).toMatchObject({ content: [{ type: "text", text: "ok" }], isError: false });
      expect(fake.calls).toEqual([{ tool: `mcp__${engineName}__read_channel`, args: { channel: "c1" } }]);

      fake.answer(async () => { throw new EngineServerAnswer("MCP error -32602: channel not found at sekrit-url-key"); });
      const refused = manager.call({ server: "slack", name: "read.channel", arguments: {} });
      await expect(refused).rejects.toThrow("MCP error -32602: channel not found at [REDACTED]");
      await expect(refused).rejects.not.toBeInstanceOf(McpOutcomeUnknownError);

      fake.answer(async () => { throw new Error("Error POSTing to endpoint: gateway broke"); });
      await expect(manager.call({ server: "slack", name: "read.channel", arguments: {} })).rejects.toBeInstanceOf(McpOutcomeUnknownError);

      const controller = new AbortController();
      fake.answer(async (_tool, _args, signal) => { controller.abort(); throw signal?.reason ?? new Error("aborted"); });
      await expect(manager.call({ server: "slack", name: "read.channel", arguments: {}, signal: controller.signal })).rejects.toBeInstanceOf(McpOutcomeUnknownError);
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });

  it("keeps the live server's config on the engine while a replacement warms, and applies the replacement's at the handoff", async () => {
    const fake = fakeEngine({ [SLACK]: { status: "connected" } });
    const engine = fake.engine();
    const manager = managerOver({ slack: http(SLACK, { headers: { "X-Team": "old" } }) }, engine);
    const team = (set: { readonly [name: string]: EngineServerConfig }) => set[engineServerName("slack", SLACK)]?.headers["X-Team"];
    try {
      await manager.acquire("slack");
      const before = fake.sets.length;
      await manager.replaceServers({ slack: http(SLACK, { headers: { "X-Team": "new" } }) });
      // The retired registry's release sends the next set after the handoff settles.
      for (let tick = 0; tick < 100 && team(fake.sets.at(-1)!) !== "new"; tick++) await Bun.sleep(1);
      const during = fake.sets.slice(before, -1);
      expect(during.length).toBeGreaterThan(0);
      expect(during.map(team)).toEqual(during.map(() => "old"));
      expect(team(fake.sets.at(-1)!)).toBe("new");
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });

  it("fails only the servers that need an engine that cannot start", async () => {
    const fake = fakeEngine({});
    const engine = fake.engine({ fail: true });
    const flywheel: string[] = [];
    const manager = managerOver({ slack: http(SLACK), plain: http("https://plain.example/mcp") }, engine, flywheel);
    try {
      await expect(manager.acquire("slack")).rejects.toThrow("The Claude engine that ships with Flywheel could not start. Reinstall Flywheel, or run bun install in a source checkout.");
      await manager.acquire("plain");
      expect(Object.fromEntries(manager.status().map((row) => [row.name, row.status]))).toEqual({ slack: "failed", plain: "ready" });
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });

  it("closes a connection when the engine ends", async () => {
    const fake = fakeEngine({ [SLACK]: { status: "connected" } });
    const engine = fake.engine();
    const manager = managerOver({ slack: http(SLACK) }, engine);
    try {
      const connection = await manager.acquire("slack");
      const closed = Promise.withResolvers<void>();
      connection.onClose(() => closed.resolve());
      fake.end();
      await closed.promise;
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });

  it("signs in through the engine, opens no page for a server that is already signed in, and refuses a sign-in whose port is taken", async () => {
    const fake = fakeEngine({ [SLACK]: { status: "needs-auth" }, "https://ready.example/mcp": { status: "connected" } });
    const engine = fake.engine();
    const manager = managerOver({ slack: http(SLACK), ready: http("https://ready.example/mcp", { client: "claude" }) }, engine);
    try {
      expect(manager.status().find((row) => row.name === "slack")?.status).toBe("pending");
      await expect(manager.acquire("slack")).rejects.toThrow("needs authentication");
      const authorization = await manager.authorize("slack");
      expect(authorization.url).toBe("https://identity.example/authorize");
      expect(authorization.redirectUrl).toBe("http://localhost:3118/callback");
      await authorization.close();

      const signedIn = await manager.authorize("ready");
      expect(signedIn.url).toBeUndefined();
      await signedIn.close();

      fake.signIn(async () => { throw new Error("OAuth callback port 3118 is already in use - another process may be holding it."); });
      const busy = manager.authorize("slack");
      await expect(busy).rejects.toBeInstanceOf(McpSignInPortBusyError);
      await expect(busy).rejects.toThrow("Another sign-in is using local port 3118. Finish or cancel it, then try again.");
    } finally {
      await manager.dispose();
      await engine.dispose();
    }
  });
});
