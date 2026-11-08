import { describe, expect, jest, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { CHATGPT_SSE_ZSTD_MAX_BYTES, CHATGPT_SSE_ZSTD_MIN_BYTES, createChatGPTClient } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-client.js";
import { assertChatGptAccountUnchanged, chatGptRefreshIdentity, createChatGPTTokenAccessor, getConnectionChatGPTTokenAccessor } from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { AuthStoreMutationError } from "../../../../../src/infra/auth/auth-store-mutations.js";
import { authProviders } from "../../../../helpers/auth-context.js";

function tokens(accountId?: string, refresh = `refresh-${accountId ?? "unknown"}`) {
  return {
    accessToken: Redacted.make(`access-${accountId}`),
    refreshToken: Redacted.make(refresh),
    expiresAtMs: Date.now() + 3_600_000,
    ...(accountId ? { accountId } : {}),
  };
}

function jwtAccessToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("ChatGPT account affinity", () => {
  test("a refreshed credential for the same account remains usable", () => {
    expect(() => { assertChatGptAccountUnchanged(tokens("account-a"), tokens("account-a")) }).not.toThrow();
  });

  test("a refreshed credential for another account fails before provider I/O", () => {
    expect(() => { assertChatGptAccountUnchanged(tokens("account-a"), tokens("account-b")) })
      .toThrow("changed from account-a to account-b");
  });

  test("credentials without account IDs must retain the same refresh identity", () => {
    expect(() => { assertChatGptAccountUnchanged(tokens(undefined, "refresh-a"), tokens(undefined, "refresh-a")) }).not.toThrow();
    expect(() => { assertChatGptAccountUnchanged(tokens(undefined, "refresh-a"), tokens(undefined, "refresh-b")) })
      .toThrow("credential identity changed");
  });

  test("a missing account ID on only one side fails closed", () => {
    expect(() => { assertChatGptAccountUnchanged(tokens("account-a"), tokens(undefined, "refresh-a")) })
      .toThrow("credential identity changed");
  });
  test("one captured connection owns one ChatGPT token accessor", () => {
    const connection = captureProviderConnection({
      authDir: "/profile-must-not-be-read",
      auth: { providers: authProviders({ oauth: ["chatgpt"] }), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([["chatgpt", [{ instanceId: "account-a", credential: { type: "oauth", access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: Date.now() + 3_600_000, accountId: "account-a" } }]]]),
      oauthPersistence: "memory-only",
    });

    const compareAndSet = async () => true;
    expect(getConnectionChatGPTTokenAccessor(connection, "account-a", compareAndSet)).toBe(getConnectionChatGPTTokenAccessor(connection, "account-a", compareAndSet));
  });

  test("refresh single-flight identity is stable per account and distinct across accounts", () => {
    expect(chatGptRefreshIdentity(tokens("account-a"))).toBe(chatGptRefreshIdentity(tokens("account-a", "rotated")));
    expect(chatGptRefreshIdentity(tokens("account-a"))).not.toBe(chatGptRefreshIdentity(tokens("account-b")));
    expect(chatGptRefreshIdentity(tokens(undefined, "refresh-a"))).not.toBe(chatGptRefreshIdentity(tokens(undefined, "refresh-b")));
  });

  test("memory-only refresh never reads a profile credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flywheel-chatgpt-memory-only-"));
    await writeFile(join(directory, "auth.json"), JSON.stringify({
      chatgpt: { type: "oauth", access: "stored-access", refresh: "stored-refresh", expires: Date.now() + 3_600_000, accountId: "account-a" },
    }), { mode: 0o600 });
    const expiredSeed = { accessToken: Redacted.make("captured-access"), refreshToken: Redacted.make("captured-refresh"), expiresAtMs: 1, accountId: "account-a" };
    const originalFetch = globalThis.fetch;
    let refreshBody = "";
    let refreshCalls = 0;
    const refreshFetch: typeof globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshCalls += 1;
      refreshBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: jwtAccessToken("account-a"), refresh_token: "refreshed-refresh", expires_in: 3_600, token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    }, { preconnect: () => {} });
    globalThis.fetch = refreshFetch;

    try {
      const accessor = createChatGPTTokenAccessor({ seed: expiredSeed, persistence: "memory-only" });
      await accessor.fresh();
      await accessor.fresh();
      expect(refreshCalls).toBe(1);
      expect(refreshBody).toContain("captured-refresh");
      expect(refreshBody).not.toContain("stored-refresh");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("shares one refresh exchange across account-bound accessors", async () => {
    const seed = { accessToken: Redacted.make("expired"), refreshToken: Redacted.make("shared-refresh"), expiresAtMs: 1, accountId: "shared-account" };
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      return Response.json({ access_token: jwtAccessToken("shared-account"), expires_in: 3_600, token_type: "bearer" });
    }, { preconnect: () => {} });
    try {
      const first = createChatGPTTokenAccessor({ seed, persistence: "memory-only" });
      const second = createChatGPTTokenAccessor({ seed, persistence: "memory-only" });
      const results = await Promise.all([first.fresh(), second.fresh()]);
      expect(calls).toBe(1);
      expect(results.map((result) => Redacted.value(result.accessToken))).toEqual([jwtAccessToken("shared-account"), jwtAccessToken("shared-account")]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("access-only delegation never reads or rotates a profile credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flywheel-chatgpt-access-only-"));
    await writeFile(join(directory, "auth.json"), JSON.stringify({
      chatgpt: { type: "oauth", access: "stored-access", refresh: "stored-refresh", expires: Date.now() + 3_600_000, accountId: "account-a" },
    }), { mode: 0o600 });
    const expiredSeed = { accessToken: Redacted.make("delegated-access"), refreshToken: Redacted.make("delegated-refresh"), expiresAtMs: 1, accountId: "account-a" };
    const originalFetch = globalThis.fetch;
    let refreshCalls = 0;
    globalThis.fetch = Object.assign(async () => {
      refreshCalls += 1;
      throw new Error("access-only delegation must not refresh");
    }, { preconnect: () => {} });

    try {
      const accessor = createChatGPTTokenAccessor({ seed: expiredSeed, persistence: "access-only" });
      await expect(accessor.fresh()).rejects.toThrow("delegated ChatGPT access token expired");
      expect(refreshCalls).toBe(0);
      const stored = JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
      expect(stored.chatgpt.access).toBe("stored-access");
      expect(stored.chatgpt.refresh).toBe("stored-refresh");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("profile refresh persists the accessor credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flywheel-chatgpt-profile-"));
    await writeFile(join(directory, "auth.json"), JSON.stringify({
      chatgpt: { type: "oauth", access: "captured-access", refresh: "captured-refresh", expires: 1, accountId: "account-a" },
    }), { mode: 0o600 });
    const seed = { accessToken: Redacted.make("captured-access"), refreshToken: Redacted.make("captured-refresh"), expiresAtMs: 1, accountId: "account-a" };
    const originalFetch = globalThis.fetch;
    const refreshFetch: typeof globalThis.fetch = Object.assign(async () =>
      new Response(JSON.stringify({ access_token: jwtAccessToken("account-a"), refresh_token: "profile-refreshed-refresh", expires_in: 3_600, token_type: "bearer" }), { status: 200, headers: { "content-type": "application/json" } }), { preconnect: () => {} });
    globalThis.fetch = refreshFetch;

    try {
      const accessor = createChatGPTTokenAccessor({
        seed,
        persistence: "profile",
        compareAndSet: async (_expected, next) => {
          await writeFile(join(directory, "auth.json"), JSON.stringify({ chatgpt: { type: "oauth", access: Redacted.value(next.accessToken), refresh: Redacted.value(next.refreshToken!), expires: next.expiresAtMs, accountId: next.accountId } }));
          return true;
        },
      });
      await accessor.fresh();
      const stored = JSON.parse(await readFile(join(directory, "auth.json"), "utf8"));
      expect(stored.chatgpt.access).toBe(jwtAccessToken("account-a"));
      expect(stored.chatgpt.refresh).toBe("profile-refreshed-refresh");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a refreshed access token for another account before persistence", async () => {
    const seed = { accessToken: Redacted.make("captured-access"), refreshToken: Redacted.make("captured-refresh"), expiresAtMs: 1, accountId: "account-a" };
    const originalFetch = globalThis.fetch;
    let persisted = false;
    globalThis.fetch = Object.assign(async () => Response.json({ access_token: jwtAccessToken("account-b"), refresh_token: "rotated-refresh", expires_in: 3_600, token_type: "bearer" }), { preconnect: () => {} });
    const accessor = createChatGPTTokenAccessor({
      seed,
      persistence: "profile",
      compareAndSet: async () => { persisted = true; return true; },
    });
    try {
      await expect(accessor.fresh()).rejects.toThrow("different or unknown account");
      expect(persisted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a stop during the refresh exchange still saves the rotated token, and the next request uses it", async () => {
    const seed = { accessToken: Redacted.make("captured-access"), refreshToken: Redacted.make("stopped-refresh"), expiresAtMs: 1, accountId: "account-a" };
    const sent: string[] = [];
    const answer = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
      await answer.promise;
      return Response.json({ access_token: jwtAccessToken("account-a"), refresh_token: "rotated-refresh", expires_in: 3_600, token_type: "bearer" });
    }, { preconnect: () => {} });
    let saved = "stopped-refresh";
    const written = Promise.withResolvers<void>();
    const accessor = createChatGPTTokenAccessor({
      seed,
      persistence: "profile",
      compareAndSet: async (expected, next) => {
        if (Redacted.value(expected.refreshToken!) !== saved) return false;
        saved = Redacted.value(next.refreshToken!);
        written.resolve();
        return true;
      },
    });
    try {
      const stop = new AbortController();
      const reason = new Error("the turn was stopped");
      const stopped = accessor.fresh({ signal: stop.signal, caller: "model request" });
      stop.abort(reason);
      await expect(stopped).rejects.toBe(reason);
      answer.resolve();
      await Promise.race([written.promise, Bun.sleep(25)]);
      expect(saved).toBe("rotated-refresh");
      const next = await accessor.fresh({ caller: "model request" });
      expect(Redacted.value(next.refreshToken!)).toBe("rotated-refresh");
      expect(sent).toEqual(["stopped-refresh"]);
    } finally {
      answer.resolve();
      globalThis.fetch = originalFetch;
    }
  });

  test("a refused save surfaces the storage condition until repair, and the capture after repair saves the rotated token without a second exchange", async () => {
    const seed = () => ({ accessToken: Redacted.make("captured-access"), refreshToken: Redacted.make("unsaved-refresh"), expiresAtMs: 1, accountId: "account-a" });
    const sent: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new URLSearchParams(String(init?.body ?? "")).get("refresh_token") ?? "");
      return Response.json({ access_token: jwtAccessToken("account-a"), refresh_token: "rotated-refresh", expires_in: 3_600, token_type: "bearer" });
    }, { preconnect: () => {} });
    let saved = "unsaved-refresh";
    let refusal: AuthStoreMutationError | undefined = new AuthStoreMutationError([]);
    const compareAndSet = async (expected: { refreshToken?: Redacted.Redacted<string> }, next: { refreshToken?: Redacted.Redacted<string> }) => {
      if (refusal !== undefined) throw refusal;
      if (Redacted.value(expected.refreshToken!) !== saved) return false;
      saved = Redacted.value(next.refreshToken!);
      return true;
    };
    try {
      const condition = refusal;
      const refused = createChatGPTTokenAccessor({ seed: seed(), persistence: "profile", compareAndSet });
      await expect(refused.fresh({ caller: "model request" })).rejects.toBe(condition);
      await expect(refused.fresh({ caller: "model request" })).rejects.toBe(condition);
      refusal = undefined;
      // The store still holds the consumed token, so the capture after repair is seeded with it.
      const recaptured = createChatGPTTokenAccessor({ seed: seed(), persistence: "profile", compareAndSet });
      const repaired = await recaptured.fresh({ caller: "model request" });
      expect(Redacted.value(repaired.refreshToken!)).toBe("rotated-refresh");
      expect(saved).toBe("rotated-refresh");
      expect(sent).toEqual(["unsaved-refresh"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("refresh deadline", () => {
    // Each case uses its own refresh token, so the shared refresh exchange of
    // one case never answers another.
    async function refreshUnderDeadline(refreshToken: string, answer: (release: Promise<void>) => Promise<Response>, act: (refresh: Promise<unknown>, controller: AbortController) => Promise<void>) {
      const seed = { accessToken: Redacted.make("expired"), refreshToken: Redacted.make(refreshToken), expiresAtMs: 1, accountId: "account-a" };
      const controller = new AbortController();
      const added = spyOn(controller.signal, "addEventListener");
      const removed = spyOn(controller.signal, "removeEventListener");
      const release = Promise.withResolvers<void>();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => answer(release.promise), { preconnect: () => {} });
      jest.useFakeTimers();
      const timers = spyOn(globalThis, "setTimeout");
      const cleared = spyOn(globalThis, "clearTimeout");
      try {
        const accessor = createChatGPTTokenAccessor({ seed, persistence: "memory-only" });
        await act(accessor.fresh({ signal: controller.signal }), controller);
        const deadlines = timers.mock.calls.flatMap(([, delay], index) => delay === 30_000 ? [timers.mock.results[index]!.value] : []);
        expect(deadlines).toHaveLength(1);
        expect(cleared).toHaveBeenCalledWith(deadlines[0]);
        expect(added).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1]);
      } finally {
        timers.mockRestore();
        cleared.mockRestore();
        jest.useRealTimers();
        release.resolve();
        globalThis.fetch = originalFetch;
      }
    }
    const answered = async () => Response.json({ access_token: jwtAccessToken("account-a"), expires_in: 3_600, token_type: "bearer" });
    const unanswered = async (release: Promise<void>) => { await release; return Response.json({ error: "released" }, { status: 400 }); };

    test("a refresh that answers leaves no timer or abort listener behind", async () => {
      await refreshUnderDeadline("deadline-answered", answered, async (refresh) => { await refresh; });
    });

    test("a refused refresh leaves no timer or abort listener behind", async () => {
      await refreshUnderDeadline("deadline-refused", async () => Response.json({ error: "invalid_grant" }, { status: 400 }), async (refresh) => {
        await expect(refresh).rejects.toBeDefined();
      });
    });

    test("a cancelled refresh fails with the abort reason and leaves no timer or abort listener behind", async () => {
      const reason = new Error("the turn was stopped");
      await refreshUnderDeadline("deadline-cancelled", unanswered, async (refresh, controller) => {
        controller.abort(reason);
        await expect(refresh).rejects.toBe(reason);
      });
    });

    test("a refresh that does not answer within its bound fails as timed out and leaves no abort listener behind", async () => {
      await refreshUnderDeadline("deadline-timed-out", unanswered, async (refresh) => {
        jest.advanceTimersByTime(30_000);
        await expect(refresh).rejects.toThrow("Token refresh timed out");
      });
    });
  });

  test("uses a tolerant access-token account fallback for SSE headers", async () => {
    const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "token-account" } })).toString("base64url");
    const calls: RequestInit[] = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens(undefined), accessToken: Redacted.make(`header.${payload}.signature`) },
      oauthPersistence: "profile",
      transportFetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    await client.responses.create({ model: "gpt-test", input: "hello", stream: true });
    expect(new Headers(calls[0]?.headers).get("chatgpt-account-id")).toBe("token-account");
  });

  test("compresses one eligible ChatGPT SSE dispatch with bounded zstd", async () => {
    const bodies: Array<BodyInit | null | undefined> = [];
    const headers: Headers[] = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") },
      oauthPersistence: "profile",
      transportFetch: async (_url, init) => {
        bodies.push(init?.body);
        headers.push(new Headers(init?.headers));
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    const input = "x".repeat(CHATGPT_SSE_ZSTD_MIN_BYTES);
    await client.responses.create({ model: "gpt-test", input, stream: true });
    expect(bodies).toHaveLength(1);
    expect(headers[0]?.get("content-encoding")).toBe("zstd");
    expect(bodies[0]).toBeInstanceOf(Uint8Array);
    const body = bodies[0];
    if (!(body instanceof Uint8Array)) throw new Error("expected compressed body");
    const decoded = new TextDecoder().decode(Bun.zstdDecompressSync(body));
    expect(decoded).toContain(input);
    expect(CHATGPT_SSE_ZSTD_MAX_BYTES).toBeGreaterThan(CHATGPT_SSE_ZSTD_MIN_BYTES);
  });

  test("sends the exact original body once below the compression minimum", async () => {
    const bodies: Array<BodyInit | null | undefined> = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") },
      oauthPersistence: "profile",
      transportFetch: async (_url, init) => {
        bodies.push(init?.body);
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    await client.responses.create({ model: "gpt-test", input: "x", stream: true });
    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]).toBe("string");
    expect(bodies[0]).toContain('"input":"x"');
  });

  test("sends the exact original body once above the compression maximum", async () => {
    const bodies: Array<BodyInit | null | undefined> = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") }, oauthPersistence: "profile",
      transportFetch: async (_url, init) => { bodies.push(init?.body); return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }); },
    });
    const input = "x".repeat(CHATGPT_SSE_ZSTD_MAX_BYTES + 1);
    await client.responses.create({ model: "gpt-test", input, stream: true });
    expect(bodies).toHaveLength(1);
    expect(typeof bodies[0]).toBe("string");
    expect(bodies[0]).toContain(input);
  });

  test("removes content-length from a compressed request", async () => {
    const headers: Headers[] = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") },
      oauthPersistence: "profile",
      transportFetch: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    await client.responses.create({ model: "gpt-test", input: "x".repeat(CHATGPT_SSE_ZSTD_MIN_BYTES), stream: true }, { headers: { "content-length": "9999" } });
    expect(headers[0]?.get("content-encoding")).toBe("zstd");
    expect(headers[0]?.has("content-length")).toBe(false);
  });

  test("uses the exact original body once when compression throws", async () => {
    const compress = spyOn(Bun, "zstdCompressSync").mockImplementation(() => { throw new Error("unavailable"); });
    const bodies: Array<BodyInit | null | undefined> = [];
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") }, oauthPersistence: "profile",
      transportFetch: async (_url, init) => { bodies.push(init?.body); return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }); },
    });
    try {
      const input = "x".repeat(CHATGPT_SSE_ZSTD_MIN_BYTES);
      await client.responses.create({ model: "gpt-test", input, stream: true });
      expect(bodies).toHaveLength(1);
      expect(typeof bodies[0]).toBe("string");
      expect(bodies[0]).toContain(input);
    } finally { compress.mockRestore(); }
  });

  test("does not resend plain text when the compressed fetch rejects", async () => {
    let calls = 0;
    const client = createChatGPTClient({
      auth: { kind: "chatgpt", ...tokens("account-a") }, oauthPersistence: "profile",
      transportFetch: async () => { calls++; throw new Error("network rejected"); },
    });
    try {
      await client.responses.create({ model: "gpt-test", input: "x".repeat(CHATGPT_SSE_ZSTD_MIN_BYTES), stream: true });
    } catch { /* The SDK wraps the fetch rejection. */ }
    expect(calls).toBe(1);
  });
});