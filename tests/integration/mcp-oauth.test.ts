import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { join } from "node:path";
import { windowsDirectoryIsOwnerOnly } from "../../src/infra/windows-private-directory-acl.js";
import { createMcpManager } from "../../src/orchestration/modules/mcp/manager.js";
import { temporaryDirectories } from "../helpers/directories.js";

const CLIENT_SECRET = "fixture-client-secret";
const HEADER_SECRET = "fixture-header-secret";
const temporaryDirectory = temporaryDirectories();

describe("MCP OAuth integration", () => {
  it("authorizes explicitly and reconnects the protected server without restart", async () => {
    let baseUrl = "";
    let registrations = 0;
    let tokenIssues = 0;
    let protectedCalls = 0;
    let currentAccess = "";
    const issuedAccessTokens: string[] = [];
    let rejectRefresh = false;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", baseUrl);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(response, 200, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
        return;
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(response, 200, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (url.pathname === "/register") {
        registrations++;
        json(response, 201, {
          client_id: "fixture-client",
          client_secret: CLIENT_SECRET,
          redirect_uris: [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        });
        return;
      }
      if (url.pathname === "/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "fixture-code");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { Location: redirect.toString() }).end();
        return;
      }
      if (url.pathname === "/token") {
        if (rejectRefresh) {
          json(response, 400, { error: "invalid_grant", error_description: "refresh rejected" });
          return;
        }
        tokenIssues++;
        currentAccess = `fixture-access-${tokenIssues}`;
        issuedAccessTokens.push(currentAccess);
        json(response, 200, {
          access_token: currentAccess,
          refresh_token: `fixture-refresh-${tokenIssues}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.headers["x-fixture-secret"] !== HEADER_SECRET) {
          response.writeHead(400).end("missing static header");
          return;
        }
        if (request.headers.authorization !== `Bearer ${currentAccess}`) {
          response.writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
          }).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        protectedCalls++;
        const body = decodeRequest(JSON.parse(await readRequest(request)));
        if (body.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (body.method === "initialize") {
          rpc(response, body.id, {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "oauth-fixture", version: "1" },
          });
          return;
        }
        if (body.method === "tools/list") {
          rpc(response, body.id, {
            tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
          });
          return;
        }
        if (body.method === "tools/call") {
          rpc(response, body.id, {
            content: [{ type: "text", text: `protected result ${currentAccess} ${HEADER_SECRET}` }],
          });
          return;
        }
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const authDirectory = temporaryDirectory("flywheel-mcp-oauth-");
    const logs: unknown[] = [];
    const manager = createMcpManager({
      executionCwd: authDirectory,
      authDir: authDirectory,
      env: { FIXTURE_HEADER: HEADER_SECRET },
      servers: {
        fixture: { url: `${baseUrl}/mcp`, headers: { "X-Fixture-Secret": ["$", "{FIXTURE_HEADER}"].join("") }, enabled: true },
      },
      log: (message, fields) => logs.push([message, fields]),
    });

    await waitForState(manager, "needs_auth");
    expect(registrations).toBe(0);
    const authorization = await manager.authorize("fixture");
    expect(registrations).toBe(1);
    if (authorization.url === undefined) throw new Error("Fixture was already authorized");
    const redirect = await fetch(authorization.url, { redirect: "manual" });
    const callback = redirect.headers.get("location");
    if (callback === null) throw new Error("Fixture did not redirect");
    const completion = authorization.complete();
    expect((await fetch(callback)).status).toBe(200);
    await completion;
    // The caller owns the reconnect after credentials change, exactly as the
    // /mcp command and the mcp CLI action do.
    await manager.credentialUpdated("fixture");

    expect(manager.entries()[0]?.state.tag).toBe("ready");
    const connection = await manager.acquire("fixture");
    currentAccess = "rejected-access-token";
    const results = await Promise.all([
      connection.callTool({ name: "echo" }),
      connection.callTool({ name: "echo" }),
    ]);
    expect(results.map((result) => result.content)).toEqual([
      [{ type: "text", text: "protected result [REDACTED] [REDACTED]" }],
      [{ type: "text", text: "protected result [REDACTED] [REDACTED]" }],
    ]);
    expect(tokenIssues).toBe(2);
    expect(protectedCalls).toBeGreaterThan(0);
    const credentialsPath = join(authDirectory, "mcp-credentials.json");
    if (process.platform === "win32") expect(windowsDirectoryIsOwnerOnly(credentialsPath)).toBe(true);
    else expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    for (const secret of [...issuedAccessTokens, CLIENT_SECRET, HEADER_SECRET]) {
      expect(JSON.stringify(logs)).not.toContain(secret);
    }
    rejectRefresh = true;
    currentAccess = "rejected-again";
    await expect(connection.callTool({ name: "echo" })).rejects.toThrow("needs authentication");
    expect(manager.entries()[0]?.state.tag).toBe("needs_auth");

    await manager.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
  });
});

/** The JSON-RPC fields of one MCP request that the fixture answers by. */
const decodeRequest = Schema.decodeUnknownSync(Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
}));

async function readRequest(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

function rpc(response: import("node:http").ServerResponse, id: number | undefined, result: unknown): void {
  json(response, 200, { jsonrpc: "2.0", id, result });
}

async function waitForState(manager: ReturnType<typeof createMcpManager>, tag: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (manager.entries()[0]?.state.tag === tag) return;
    await Bun.sleep(5);
  }
  throw new Error(`MCP manager did not enter ${tag}: ${JSON.stringify(manager.entries().map((entry) => ({
    name: entry.name,
    tag: entry.state.tag,
    error: entry.state.tag === "failed" ? entry.state.error.message : undefined,
  })))}`);
}
