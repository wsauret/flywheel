import { afterAll, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { enginePath } from "../../src/infra/claude-engine.js";
import { osAccount } from "../../src/infra/os-account.js";
import { createLauncherScope, createProcessSupervisor } from "../../src/infra/process-supervisor.js";
import { createMcpClaudeEngine } from "../../src/orchestration/modules/mcp/claude-engine.js";
import { launchClaudeEngineSession } from "../../src/orchestration/modules/mcp/claude-engine-session.js";
import { McpOutcomeUnknownError } from "../../src/orchestration/modules/mcp/errors.js";
import { createMcpManager } from "../../src/orchestration/modules/mcp/manager.js";
import { temporaryDirectories } from "../helpers/directories.js";

// The bundled engine as Flywheel's MCP client, against MCP and OAuth servers on this machine. No credential, no
// Anthropic login, and no request leaves the machine. This test fails when an engine update changes one of the
// undocumented behaviors that Flywheel builds on: `mcp_set_servers` with the engine's `oauth` field, the token count
// that carries each tool's exact definition, `mcp_call`, and `mcp_authenticate`.

const temporary = temporaryDirectories();
const LONG_DESCRIPTION = `ZEBRA-START ${"This tool echoes a message back with a configurable repeat count and style. ".repeat(40)} ZEBRA-END`;
const ECHO_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 3, description: "MARKER-MESSAGE-PROP" },
    repeat: { type: "integer", minimum: 1, maximum: 5 },
    style: { type: "string", enum: ["plain", "shout", "whisper"] },
    options: { type: "object", properties: { prefix: { type: "string" } }, required: ["prefix"], additionalProperties: false },
  },
  required: ["message", "style"],
  additionalProperties: false,
};
const DOTTED_SCHEMA = { type: "object", properties: { values: { type: "array", items: { type: "number" } } }, required: ["values"] };

function echoServer(): Server {
  const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "echo_long", description: LONG_DESCRIPTION, inputSchema: ECHO_SCHEMA, annotations: { readOnlyHint: true } },
      { name: "sum.numbers", description: "Adds numbers.", inputSchema: DOTTED_SCHEMA },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    if (request.params.name === "echo_long") {
      if (args["style"] === undefined) return { isError: true, content: [{ type: "text", text: "echo_long: style is required" }] };
      const echoed = String(args["message"]).repeat(Number(args["repeat"] ?? 1));
      return { content: [{ type: "text", text: echoed }], structuredContent: { echoed } };
    }
    const values: unknown = args["values"];
    if (request.params.name === "sum.numbers" && Array.isArray(values)) return { content: [{ type: "text", text: String(values.reduce((sum: number, value) => sum + Number(value), 0)) }] };
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${request.params.name}`);
  });
  return server;
}

/** A server with no tools, which connects with an empty tool list. */
function emptyServer(): Server {
  const server = new Server({ name: "empty", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

/** `/mcp` serves the echo tools with no sign-in, and `/empty/mcp` serves no tools. `/secure/mcp` asks for OAuth, and the authorization server
 *  metadata on this listener has no registration endpoint, as a server that accepts only approved apps. */
const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const base = url.origin;
    if (url.pathname === "/mcp" || url.pathname === "/empty/mcp") {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await (url.pathname === "/mcp" ? echoServer() : emptyServer()).connect(transport);
      return await transport.handleRequest(request);
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${base}/secure/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"] });
    }
    if (url.pathname === "/secure/mcp") {
      return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/secure/mcp"` } });
    }
    return new Response("not found", { status: 404 });
  },
});
const supervisor = createProcessSupervisor();
const launcher = createLauncherScope(supervisor);
afterAll(async () => {
  await listener.stop(true);
  await launcher.close();
  await supervisor.dispose();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("The port probe did not bind");
  return address.port;
}

/** The engine names the keychain item of its MCP sign-ins after its config directory; a sign-in start writes it. */
function removeKeychainItem(configDir: string): void {
  if (process.platform !== "darwin") return;
  const service = `Claude Code-credentials-${new Bun.CryptoHasher("sha256").update(configDir).digest("hex").slice(0, 8)}`;
  Bun.spawnSync(["/usr/bin/security", "delete-generic-password", "-s", service], { stdout: "ignore", stderr: "ignore", windowsHide: true });
}

describe("the bundled Claude engine as an MCP client", () => {
  it("connects the servers it is given, reports each tool's exact definition, calls a tool, and starts a sign-in", async () => {
    const root = temporary("flywheel-mcp-engine-");
    const configDir = join(root, "engine");
    const base = `http://127.0.0.1:${listener.port}`;
    const callbackPort = await freePort();
    const engine = createMcpClaudeEngine({
      launch: () => launchClaudeEngineSession({
        host: { enginePath: enginePath(), account: osAccount(), platform: process.platform, hostEnvironment: process.env, timeZone: undefined, temporaryDirectory: join(root, "tmp") },
        configDir,
        launcher,
      }),
    });
    const manager = createMcpManager({
      servers: {
        echo: { url: `${base}/mcp`, headers: {}, client: "claude", enabled: true },
        secure: { url: `${base}/secure/mcp`, headers: {}, client: "claude", oauth: { client_id: "approved-app", callback_port: callbackPort }, enabled: true },
      },
      executionCwd: root,
      authDir: join(root, "auth"),
      claudeEngine: engine,
    });
    try {
      await manager.acquire("echo");
      const tools = manager.tools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(["echo_long", "sum.numbers"]);
      const echo = tools.find((tool) => tool.name === "echo_long");
      expect(echo?.inputSchema).toEqual(ECHO_SCHEMA);
      expect(echo?.description).toBe(LONG_DESCRIPTION);
      expect(echo?.annotations).toEqual({ readOnlyHint: true });
      expect(tools.find((tool) => tool.name === "sum.numbers")?.inputSchema).toEqual(DOTTED_SCHEMA);

      expect(await manager.call({ server: "echo", name: "echo_long", arguments: { message: "hey", style: "plain", repeat: 2 } })).toMatchObject({ content: [{ type: "text", text: "heyhey" }], structuredContent: { echoed: "heyhey" } });
      expect(await manager.call({ server: "echo", name: "sum.numbers", arguments: { values: [2, 3] } })).toMatchObject({ content: [{ type: "text", text: "5" }] });
      // The engine passes a JSON-RPC error on as `MCP error <code>: <message>`, the one failure that proves the server
      // answered. It rejects an `isError` result with nothing but the server's text, as it does a network failure.
      const refused = manager.call({ server: "echo", name: "sum.numbers", arguments: { values: "none" } });
      await expect(refused).rejects.toThrow("MCP error -32601: unknown tool sum.numbers");
      await expect(refused).rejects.not.toBeInstanceOf(McpOutcomeUnknownError);
      const failed = manager.call({ server: "echo", name: "echo_long", arguments: { message: "hey" } });
      await expect(failed).rejects.toThrow("style is required");
      await expect(failed).rejects.toBeInstanceOf(McpOutcomeUnknownError);

      await expect(manager.acquire("secure")).rejects.toThrow("needs authentication");
      const authorization = await manager.authorize("secure");
      try {
        const page = new URL(authorization.url ?? "");
        expect(page.origin + page.pathname).toBe(`${base}/authorize`);
        expect(page.searchParams.get("client_id")).toBe("approved-app");
        expect(page.searchParams.get("redirect_uri")).toBe(`http://localhost:${callbackPort}/callback`);
      } finally {
        await authorization.close();
      }

      // Alone on the engine, a server with no tools connects with an empty list: the token count then carries no tool.
      await manager.dispose();
      const lone = createMcpManager({ servers: { empty: { url: `${base}/empty/mcp`, headers: {}, client: "claude", enabled: true } }, executionCwd: root, authDir: join(root, "auth"), claudeEngine: engine });
      try {
        expect((await lone.acquire("empty")).tools()).toEqual([]);
      } finally {
        await lone.dispose();
      }
    } finally {
      await manager.dispose();
      await engine.dispose();
      removeKeychainItem(configDir);
    }
  }, 120_000);
});
