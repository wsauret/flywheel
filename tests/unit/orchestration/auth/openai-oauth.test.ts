import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { Serve, Server } from "bun";
import { Redacted } from "effect";

import * as authStore from "../../../../src/infra/auth/auth-store.js";
import * as authStoreMutations from "../../../../src/infra/auth/auth-store-mutations.js";
import { CHATGPT_BACKEND_API_BASE } from "../../../../src/infra/auth/openai-auth-types.js";
import { fakeFetch } from "../../../helpers/fake-fetch.js";
const savedCredentials: unknown[] = [];

function installStorageMocks(): void {
  spyOn(authStoreMutations, "setCredential").mockImplementation(async (_id, cred) => {
    savedCredentials.push(cred);
  });
  spyOn(authStore, "getCredential").mockReturnValue(undefined);
  spyOn(authStore, "loadAuthStoreWithDiagnostics").mockReturnValue({ revision: "missing", store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions: [] });
  spyOn(authStoreMutations, "deleteCredential").mockImplementation(async () => {});
}

/** The callback handler a test drives, as the browser's request reaches it. */
type CallbackFetch = (req: Request) => Promise<Response>;

/** A Bun server that serves nothing itself and reports each `stop` call with
 *  whether it closed active connections. The flow under test calls only `stop`. */
function callbackServer<WebSocketData>(onStop: (force: boolean) => void): Server<WebSocketData> {
  const server: Server<WebSocketData> = {
    stop: async (force) => { onStop(force === true); },
    closeIdleConnections: () => 0,
    reload: () => server,
    fetch: () => new Response(null, { status: 404 }),
    upgrade: () => false,
    publish: () => 0,
    subscriberCount: () => 0,
    requestIP: () => null,
    timeout: () => {},
    ref: () => {},
    unref: () => {},
    pendingRequests: 0,
    pendingWebSockets: 0,
    url: new URL("http://localhost:1455/"),
    port: 1455,
    hostname: "localhost",
    protocol: "http",
    development: false,
    id: "test-callback",
    [Symbol.dispose]: () => {},
  };
  return server;
}

/** Replaces Bun.serve until the next `mock.restore()`. Each listener the flow
 *  starts reports its host and its request handler to `listen`, which may
 *  throw to refuse the bind; the handler runs bound to its server, as Bun
 *  runs it. */
function stubServe(listen: (hostname: string | undefined, handle: CallbackFetch) => void, onStop: (force: boolean) => void = () => {}): void {
  spyOn(Bun, "serve").mockImplementation(<WebSocketData, R extends string>(options: Serve.Options<WebSocketData, R>): Server<WebSocketData> => {
    const server = callbackServer<WebSocketData>(onStop);
    const { fetch } = options;
    listen(options.hostname, async (req) => {
      const response = await fetch?.call(server, req, server);
      if (!(response instanceof Response)) throw new Error("the callback handler answered no response");
      return response;
    });
    return server;
  });
}

// ---------------------------------------------------------------------------
// refreshAccessToken — mock fetch
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  let refreshAccessToken: typeof import("../../../../src/orchestration/auth/openai-oauth.js").refreshAccessToken;
  let ChatGPTTokenRefreshError: typeof import("../../../../src/orchestration/auth/openai-oauth.js").ChatGPTTokenRefreshError;
  let startBrowserFlow: typeof import("../../../../src/orchestration/auth/openai-oauth.js").startBrowserFlow;
  let fetchChatGPTModels: typeof import("../../../../src/orchestration/modules/provider-chatgpt/catalog.js").fetchChatGPTModels;
  const originalFetch = globalThis.fetch;
  // The flow reaches the consent page through an injected handoff, so a test
  // observes the URL it was given instead of a process it launched.
  const openedUrls: string[] = [];
  const openBrowser = async (url: string): Promise<boolean> => {
    openedUrls.push(url);
    return true;
  };
  beforeEach(async () => {
    mock.restore();
    savedCredentials.length = 0;
    openedUrls.length = 0;
    installStorageMocks();
    const moduleUrl = new URL("../../../../src/orchestration/auth/openai-oauth.ts", import.meta.url);
    const mod: typeof import("../../../../src/orchestration/auth/openai-oauth.js") = await import(`${moduleUrl.href}?openai-oauth-test=${crypto.randomUUID()}`);
    refreshAccessToken = mod.refreshAccessToken;
    ChatGPTTokenRefreshError = mod.ChatGPTTokenRefreshError;
    startBrowserFlow = mod.startBrowserFlow;
    fetchChatGPTModels = (await import("../../../../src/orchestration/modules/provider-chatgpt/catalog.js")).fetchChatGPTModels;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });


  it("sends correct form-urlencoded body", async () => {
    let capturedBody: string | undefined;
    interface CapturedHeaders { [name: string]: string }
    let capturedHeaders: CapturedHeaders | undefined;

    globalThis.fetch = fakeFetch(async (input, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await refreshAccessToken(Redacted.make("old-refresh-token"));
    expect(Redacted.value(result.accessToken)).toBe("new-access");
    expect(Redacted.value(result.refreshToken!)).toBe("new-refresh");

    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=old-refresh-token");
    expect(capturedBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(capturedHeaders?.["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("identifies ChatGPT model discovery as Flywheel", async () => {
    let capturedHeaders = new Headers();
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return Response.json({ models: [{ slug: "gpt-test" }] });
      },
      { preconnect: originalFetch.preconnect },
    );

    expect(await fetchChatGPTModels(
      Redacted.make("access"),
      "account",
      new AbortController().signal,
      {
        limits: { responseBytes: 1024, canonicalRows: 10, modelIdLength: 100, durableBytes: 4096 },
        extractRows: (body) => {
          if (typeof body !== "object" || body === null || !("models" in body) || !Array.isArray(body.models)) return [];
          return body.models;
        },
      },
    )).toEqual({ kind: "rows", rows: [{ slug: "gpt-test" }] });
    expect(capturedHeaders.get("user-agent")).toMatch(/^flywheel\/\d+\.\d+\.\d+ \(.+ .+; .+\)$/);
    expect(capturedHeaders.get("authorization")).toBe("Bearer access");
    expect(capturedHeaders.get("chatgpt-account-id")).toBe("account");
  });

  it("preserves allowlisted refresh failure codes without reflecting provider text", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response(
        JSON.stringify({
          error: {
            code: "refresh_token_reused",
            message: "secret provider text",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
      { preconnect: originalFetch.preconnect },
    );

    try {
      await refreshAccessToken(Redacted.make("bad-token"));
      throw new Error("expected refreshAccessToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatGPTTokenRefreshError);
      if (!(err instanceof ChatGPTTokenRefreshError)) throw err;
      expect(err.status).toBe(401);
      expect(err.code).toBe("refresh_token_reused");
      expect(err.message).not.toContain("secret provider text");
    }
  });

  it("rejects malformed token JSON", async () => {
    globalThis.fetch = Object.assign(
      async () => new Response(
        JSON.stringify({
          access_token: "new-access",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      { preconnect: originalFetch.preconnect },
    );

    expect(refreshAccessToken(Redacted.make("bad-token"))).rejects.toThrow();
  });

  it("does not start the browser server when already cancelled", async () => {
    let serverStarted = false;

    stubServe(() => {
      serverStarted = true;
      throw new Error("server should not start");
    });

    const abort = new AbortController();
    abort.abort();

    await expect(startBrowserFlow({ openBrowser, signal: abort.signal }))
      .rejects.toThrow("Login cancelled");
    expect(serverStarted).toBe(false);
    expect(openedUrls).toEqual([]);
  });

  it("stops the callback server when browser login is cancelled", async () => {
    const stopped: boolean[] = [];

    stubServe(() => {}, (force) => stopped.push(force));

    const abort = new AbortController();
    const flow = startBrowserFlow({
      openBrowser,
      signal: abort.signal,
      onAuthorizeUrl: () => abort.abort(),
    });

    await expect(flow).rejects.toThrow("Login cancelled");
    expect(stopped).toEqual([false, false]);
    expect(openedUrls).toHaveLength(1);
  });

  it("reports browser authorize URL after launching the browser", async () => {
    let capturedFetch: CallbackFetch | undefined;
    const stopped: boolean[] = [];
    const tokenBodies: string[] = [];

    stubServe((_hostname, handle) => { capturedFetch = handle; }, (force) => stopped.push(force));

    globalThis.fetch = fakeFetch(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/oauth/token")) {
        tokenBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            access_token: "browser-access",
            refresh_token: "browser-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.startsWith(`${CHATGPT_BACKEND_API_BASE}/models`)) {
        return new Response(
          JSON.stringify({ models: [{ slug: "gpt-5.5" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("unexpected url", { status: 500 });
    });

    const instructions: Array<{ url: string }> = [];
    const result = await startBrowserFlow({
      loginHint: "dev@example.com",
      openBrowser,
      onAuthorizeUrl: ({ url }) => {
        instructions.push({ url });
        expect(openedUrls[0]).toBe(url);
        const state = new URL(url).searchParams.get("state");
        expect(state).toBeTruthy();
        void capturedFetch?.(
          new Request(`http://localhost:1455/auth/callback?state=${state}&code=browser-code`),
        );
      },
    });

    expect(Redacted.value(result.accessToken)).toBe("browser-access");
    // startBrowserFlow no longer persists credentials -- auth-actions.ts is the single writer
    expect(savedCredentials).toHaveLength(0);
    expect(stopped).toEqual([false, false]);
    expect(openedUrls).toHaveLength(1);
    expect(instructions).toHaveLength(1);
    const authorizeInstruction = instructions[0];
    if (!authorizeInstruction) throw new Error("authorize URL was not reported");
    const authorizeUrl = new URL(authorizeInstruction.url);
    expect(authorizeUrl.origin).toBe("https://auth.openai.com");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("login_hint")).toBe("dev@example.com");
    expect(tokenBodies[0]).toContain("code=browser-code");
  });

  /** Replaces Bun.serve with listeners that record their host and handler.
   *  A host in `busy` refuses to bind, as a port held by another program does. */
  function stubCallbackListeners(busy: readonly string[] = []) {
    const hosts: string[] = [];
    let handler: CallbackFetch | undefined;
    stubServe((hostname, handle) => {
      if (hostname !== undefined && busy.includes(hostname)) throw Object.assign(new Error("Failed to start server. Is port 1455 in use?"), { code: "EADDRINUSE" });
      hosts.push(hostname ?? "");
      handler = handle;
    });
    return {
      hosts,
      handler: (): CallbackFetch => {
        if (handler === undefined) throw new Error("no callback listener started");
        return handler;
      },
    };
  }

  /** Answers the token exchange with `status`, after `release` resolves. */
  function stubTokenExchange(status: number, release: Promise<void> = Promise.resolve()): void {
    globalThis.fetch = fakeFetch(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith("/oauth/token")) return new Response("unexpected url", { status: 500 });
      await release;
      if (status !== 200) return new Response(JSON.stringify({ error: "invalid_grant" }), { status, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ access_token: "browser-access", refresh_token: "browser-refresh", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  const stateOf = (url: string): string => new URL(url).searchParams.get("state") ?? "";

  it("answers the browser only after the token exchange settles, and with its outcome", async () => {
    const listeners = stubCallbackListeners();
    const release = Promise.withResolvers<void>();
    stubTokenExchange(400, release.promise);
    const page = Promise.withResolvers<Response>();
    let answered = false;
    const flow = startBrowserFlow({
      openBrowser,
      onAuthorizeUrl: ({ url }) => {
        void Promise.resolve(listeners.handler()(new Request(`http://localhost:1455/auth/callback?state=${stateOf(url)}&code=fake-code`))).then((response) => {
          answered = true;
          page.resolve(response);
        });
      },
    });
    const settled = flow.then(() => undefined, (error: unknown) => error);
    await Bun.sleep(20);
    expect(answered).toBe(false);
    release.resolve();
    expect(await settled).toBeInstanceOf(Error);
    const html = await (await page.promise).text();
    expect(html).toContain("could not complete this sign-in");
    expect(html).not.toContain("Authorization Successful");
    expect(listeners.hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps waiting after a callback from another sign-in attempt", async () => {
    const listeners = stubCallbackListeners();
    stubTokenExchange(200);
    const pages: Promise<Response>[] = [];
    const result = await startBrowserFlow({
      openBrowser,
      onAuthorizeUrl: ({ url }) => {
        const handle = listeners.handler();
        pages.push(Promise.resolve(handle(new Request("http://localhost:1455/auth/callback?state=stale-attempt&code=stale-code"))), Promise.resolve(handle(new Request(`http://localhost:1455/auth/callback?state=${stateOf(url)}&code=browser-code`))));
      },
    });
    expect(Redacted.value(result.accessToken)).toBe("browser-access");
    const [stale, current] = await Promise.all(pages);
    expect(stale?.status).toBe(400);
    expect(await stale?.text()).toContain("different sign-in attempt");
    expect(await current?.text()).toContain("Authorization Successful");
  });

  it("refuses a callback port another program holds before it reports the URL", async () => {
    stubCallbackListeners(["127.0.0.1"]);
    const reported: string[] = [];
    await expect(startBrowserFlow({ openBrowser, onAuthorizeUrl: ({ url }) => reported.push(url) }))
      .rejects.toThrow("Port 1455 is in use by another program");
    expect(reported).toEqual([]);
    expect(openedUrls).toEqual([]);
  });

  it("explains a pasted address from another sign-in attempt in plain words", async () => {
    stubCallbackListeners();
    stubTokenExchange(200);
    const flow = startBrowserFlow({
      openBrowser,
      onManualCodeInput: async () => "http://localhost:1455/auth/callback?code=old-code&state=old-attempt",
    });
    await expect(flow).rejects.toThrow("This address belongs to a different sign-in attempt");
  });

});
