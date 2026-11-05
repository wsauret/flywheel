import { describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Redacted } from "effect";
import {
  authorizeMcpServer,
  createSilentMcpOAuth,
  fromSdkClientInformation,
  fromSdkTokens,
  toSdkClientInformation,
  toSdkTokens,
} from "../../../../../src/orchestration/modules/mcp/oauth.js";
import type {
  McpCredential,
  McpCredentialStore,
} from "../../../../../src/orchestration/modules/mcp/credentials.js";
import { McpOAuthNeedsAuthError, McpRegistrationRefusedError } from "../../../../../src/orchestration/modules/mcp/errors.js";
import { mcpSignInFailure } from "../../../../../src/orchestration/modules/mcp/protocol.js";

function memoryCredentialStore(initial?: McpCredential): McpCredentialStore & { saves(): number } {
  let credential = initial;
  let saveCount = 0;
  return {
    get: () => credential,
    save: async (_server, _url, value) => { credential = value; saveCount++; },
    delete: async () => { credential = undefined; },
    saves: () => saveCount,
  };
}

describe("MCP OAuth", () => {
  it("presents a valid stored token without authorization network calls", async () => {
    const store = memoryCredentialStore({
      tokens: {
        accessToken: Redacted.make("valid-access"),
        refreshToken: Redacted.make("valid-refresh"),
        tokenType: "Bearer",
        expiresAt: Date.now() + 60_000,
      },
    });
    const oauth = createSilentMcpOAuth("test", "https://example.test/mcp", store, store.get("test", "https://example.test/mcp"), undefined);

    await oauth.refreshIfNeeded(new AbortController().signal);

    expect((await oauth.provider.tokens())?.access_token).toBe("valid-access");
    expect(store.saves()).toBe(0);
  });

  it("persists every SDK credential operation and keeps secrets redacted", async () => {
    const store = memoryCredentialStore();
    const oauth = createSilentMcpOAuth("test", "https://example.test/mcp", store, undefined, undefined);

    await oauth.provider.saveClientInformation?.({ client_id: "client", client_secret: "client-secret" });
    await oauth.provider.saveCodeVerifier("verifier-secret");
    await oauth.provider.saveTokens({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" });

    expect(store.saves()).toBe(3);
    expect(oauth.secrets.map(Redacted.value)).toEqual([
      "client-secret",
      "verifier-secret",
      "access-secret",
      "refresh-secret",
    ]);
  });

  it("converts only at the SDK boundary", () => {
    const tokens = fromSdkTokens({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_in: 60,
      scope: "tools",
      issuer: "https://auth.example",
    });
    const client = fromSdkClientInformation({ client_id: "client", client_secret: "secret", issuer: "https://auth.example" });

    expect(toSdkTokens(tokens).access_token).toBe("access");
    expect(toSdkTokens(tokens).issuer).toBe("https://auth.example");
    expect(toSdkClientInformation(client)).toEqual({ client_id: "client", client_secret: "secret", issuer: "https://auth.example" });
    expect(String(tokens.accessToken)).not.toContain("access");
    expect(String(client.clientSecret)).not.toContain("secret");
  });

});

// Slack's hosted MCP server has this shape: no registration endpoint, and a token
// endpoint that accepts only client_secret_post.
describe("MCP OAuth with a pre-registered client", () => {
  it("authorizes and refreshes without dynamic registration and keeps stored secrets", async () => {
    const requests: { readonly path: string; readonly body: URLSearchParams }[] = [];
    let tokenIssues = 0;
    const fixture = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", baseUrl);
      const body = new URLSearchParams(await readBody(request));
      requests.push({ path: url.pathname, body });
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(response, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], scopes_supported: ["a", "b"] });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(response, {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      } else if (url.pathname === "/token") {
        tokenIssues++;
        json(response, { access_token: `access-${tokenIssues}`, refresh_token: `refresh-${tokenIssues}`, token_type: "Bearer", expires_in: 3600 });
      } else {
        response.writeHead(404).end();
      }
    });
    const baseUrl = `http://127.0.0.1:${await listenOnFreePort(fixture)}`;
    const callbackPort = await freePort();
    const store = memoryCredentialStore({ headers: { "X-Api-Key": Redacted.make("header-secret") }, clientSecret: Redacted.make("client-secret") });
    const client = { clientId: "123.456", clientSecret: Redacted.make("client-secret") };
    try {
      const authorization = await authorizeMcpServer({
        server: "slack",
        url: `${baseUrl}/mcp`,
        credentialStore: store,
        client,
        scope: "a",
        callbackPort,
      });
      if (authorization.url === undefined) throw new Error("The fixture was already authorized");
      const authorizeUrl = new URL(authorization.url);
      expect(authorization.redirectUrl).toBe(`http://127.0.0.1:${callbackPort}/callback`);
      expect(authorizeUrl.searchParams.get("client_id")).toBe("123.456");
      expect(authorizeUrl.searchParams.get("scope")).toBe("a");
      const completion = authorization.complete();
      const callback = new URL(authorization.redirectUrl);
      callback.searchParams.set("code", "code-1");
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
      expect((await fetch(callback)).status).toBe(200);
      await completion;

      const exchange = requests.find((request) => request.path === "/token")?.body;
      expect(exchange?.get("client_id")).toBe("123.456");
      expect(exchange?.get("client_secret")).toBe("client-secret");
      const saved = store.get("slack", `${baseUrl}/mcp`);
      expect(Redacted.value(saved?.tokens?.accessToken ?? Redacted.make(""))).toBe("access-1");
      expect(saved?.tokens?.issuer).toBe(baseUrl);
      expect(saved?.clientInformation).toBeUndefined();
      expect(Redacted.value(saved?.clientSecret ?? Redacted.make(""))).toBe("client-secret");
      expect(Redacted.value(saved?.headers?.["X-Api-Key"] ?? Redacted.make(""))).toBe("header-secret");

      const expiring = { ...saved, tokens: { ...saved?.tokens, accessToken: Redacted.make("access-1"), tokenType: "Bearer", expiresAt: Date.now() } };
      const silent = createSilentMcpOAuth("slack", `${baseUrl}/mcp`, store, expiring, client);
      await silent.refreshIfNeeded(new AbortController().signal);
      const refresh = requests.filter((request) => request.path === "/token").at(-1)?.body;
      expect(refresh?.get("grant_type")).toBe("refresh_token");
      expect(refresh?.get("client_secret")).toBe("client-secret");
      expect((await silent.provider.tokens())?.access_token).toBe("access-2");
      expect(silent.secrets.map(Redacted.value)).toContain("client-secret");
      expect(requests.some((request) => request.path === "/register")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
});

describe("MCP OAuth issuer binding", () => {
  it("never presents tokens or a dynamic client stamped for another authorization server", async () => {
    const fixture = await authorizationServerFixture();
    try {
      const formerIssuer = `${fixture.baseUrl}/tenant-a`;
      const stamped: McpCredential = {
        tokens: {
          accessToken: Redacted.make("access-a"),
          refreshToken: Redacted.make("refresh-a"),
          tokenType: "Bearer",
          expiresAt: Date.now(),
          issuer: formerIssuer,
        },
        clientInformation: { clientId: "client-a", clientSecret: Redacted.make("client-secret-a"), issuer: formerIssuer },
      };
      const store = memoryCredentialStore(stamped);
      const silent = createSilentMcpOAuth("work", `${fixture.baseUrl}/mcp`, store, stamped, undefined);

      await expect(silent.refreshIfNeeded(new AbortController().signal)).rejects.toBeInstanceOf(McpOAuthNeedsAuthError);

      expect(fixture.requests.map((request) => request.path)).toContain("/register");
      expect(fixture.requests.some((request) => request.path.startsWith("/tenant-a"))).toBe(false);
      for (const request of fixture.requests) {
        expect(`${request.authorization} ${request.body}`).not.toContain("refresh-a");
        expect(`${request.authorization} ${request.body}`).not.toContain("client-secret-a");
      }
      expect(store.get("work", `${fixture.baseUrl}/mcp`)?.clientInformation).toMatchObject({ clientId: "client-b", issuer: fixture.baseUrl });
    } finally {
      await fixture.close();
    }
  });

  it("stamps the issuer on unstamped legacy credentials after their first refresh", async () => {
    const fixture = await authorizationServerFixture();
    try {
      const legacy: McpCredential = {
        tokens: { accessToken: Redacted.make("legacy-access"), refreshToken: Redacted.make("legacy-refresh"), tokenType: "Bearer", expiresAt: Date.now() },
        clientInformation: { clientId: "legacy-client", clientSecret: Redacted.make("legacy-secret") },
      };
      const store = memoryCredentialStore(legacy);
      const silent = createSilentMcpOAuth("work", `${fixture.baseUrl}/mcp`, store, legacy, undefined);

      await silent.refreshIfNeeded(new AbortController().signal);

      const refresh = new URLSearchParams(fixture.requests.find((request) => request.path === "/token")?.body);
      expect(refresh.get("refresh_token")).toBe("legacy-refresh");
      expect(refresh.get("client_id")).toBe("legacy-client");
      const saved = store.get("work", `${fixture.baseUrl}/mcp`);
      expect(Redacted.value(saved?.tokens?.accessToken ?? Redacted.make(""))).toBe("access-b");
      expect(saved?.tokens?.issuer).toBe(fixture.baseUrl);
      expect(saved?.clientInformation).toMatchObject({ clientId: "legacy-client", issuer: fixture.baseUrl });
    } finally {
      await fixture.close();
    }
  });
});

describe("MCP OAuth client registration", () => {
  it("fails a sign-in as a registration refusal only when the server has no registration endpoint or refuses registration", async () => {
    for (const registration of ["absent", "refused"] as const) {
      const fixture = await authorizationServerFixture(registration);
      try {
        const failed = authorizeMcpServer({ server: "slack", url: `${fixture.baseUrl}/mcp`, credentialStore: memoryCredentialStore(), client: undefined });
        await expect(failed).rejects.toBeInstanceOf(McpRegistrationRefusedError);
        expect(mcpSignInFailure(await failed.catch((error: unknown) => error))).toBe("MCP authentication failed. This server may accept only approved apps. You can try Use Claude as client.");
      } finally {
        await fixture.close();
      }
    }
    const preregistered = await authorizationServerFixture("absent");
    try {
      const authorization = await authorizeMcpServer({ server: "slack", url: `${preregistered.baseUrl}/mcp`, credentialStore: memoryCredentialStore(), client: { clientId: "approved-app" } });
      expect(new URL(authorization.url ?? "").searchParams.get("client_id")).toBe("approved-app");
      await authorization.close();
    } finally {
      await preregistered.close();
    }
    const unreachable = authorizeMcpServer({ server: "gone", url: "http://127.0.0.1:1/mcp", credentialStore: memoryCredentialStore(), client: undefined });
    await expect(unreachable).rejects.not.toBeInstanceOf(McpRegistrationRefusedError);
    expect(mcpSignInFailure(await unreachable.catch((error: unknown) => error))).toBe("MCP authentication failed. Try again.");
  });
});

/** A resource server whose metadata names itself as the only authorization server, with
 *  dynamic registration unless `registration` says otherwise. It records every request it receives. */
async function authorizationServerFixture(registration: "accepted" | "absent" | "refused" = "accepted"): Promise<{
  readonly baseUrl: string;
  readonly requests: { readonly path: string; readonly authorization: string; readonly body: string }[];
  close(): Promise<void>;
}> {
  const requests: { readonly path: string; readonly authorization: string; readonly body: string }[] = [];
  const fixture = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    requests.push({ path: url.pathname, authorization: request.headers.authorization ?? "", body: await readBody(request) });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        ...(registration === "absent" ? {} : { registration_endpoint: `${baseUrl}/register` }),
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    } else if (url.pathname === "/register" && registration === "refused") {
      response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_client_metadata", error_description: "unapproved app" }));
    } else if (url.pathname === "/register") {
      json(response, { client_id: "client-b", client_secret: "client-secret-b", redirect_uris: ["http://127.0.0.1/callback"] });
    } else if (url.pathname === "/token") {
      json(response, { access_token: "access-b", refresh_token: "refresh-b", token_type: "Bearer", expires_in: 3600 });
    } else {
      response.writeHead(404).end();
    }
  });
  const baseUrl = `http://127.0.0.1:${await listenOnFreePort(fixture)}`;
  return { baseUrl, requests, close: () => new Promise<void>((resolve) => fixture.close(() => resolve())) };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

async function listenOnFreePort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not bind");
  return address.port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listenOnFreePort(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
