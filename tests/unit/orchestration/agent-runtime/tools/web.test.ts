import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Redacted } from "effect";
import { appendCredentialInstance } from "../../../../../src/infra/auth/auth-store-mutations.js";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { CHATGPT_BACKEND_API_BASE } from "../../../../../src/infra/auth/openai-auth-types.js";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { createWebTool } from "../../../../../src/orchestration/agent-runtime/tools/web.js";
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { composeFirstPartyModules, type ModuleId } from "../../../../../src/orchestration/modules.js";
import type { RuntimeToolInput, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { WebSearchError, type WebSearchCommand, type WebSearchPort, type WebSearchProvider, type WebSearchResponse, type WebSearchRunOptions } from "../../../../../src/orchestration/agent-runtime/web-search/types.js";
import { createChatGptWebSearch } from "../../../../../src/orchestration/agent-runtime/web-search/chatgpt.js";
import { createWebSearch } from "../../../../../src/orchestration/agent-runtime/web-search/select.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { makeContext } from "./_fixtures.js";
import { authProviders } from "../../../../helpers/auth-context.js";

const { userDataRoot } = testDirectories(process.cwd());

function authContext(chatgptConfigured: boolean): AuthContext {
  return {
    providers: authProviders(chatgptConfigured ? { oauth: ["chatgpt"] } : {}),
    credentialLineages: {}, droppedCredentials: [],
  };
}

function capability(overrides?: Partial<WebSearchPort>): WebSearchPort {
  return {
    available: () => true,
    run: async () => ({ results: [] }),
    ...overrides,
  };
}

function context(): ToolContext {
  return makeContext({ artifactScopeId: "session-1", sessionId: "session-1" });
}

/** One request planned over a web runtime that resolves to the given port, for a tree whose modules `disabled`
 *  leaves off. */
function plan(port?: WebSearchPort, selected?: ReadonlySet<string>, disabled: readonly ModuleId[] = []) {
  return planToolExposure({
    kernel: testKernelToolDeps({ userDataRoot, moduleSnapshot: composeFirstPartyModules(undefined, disabled) }),
    modules: composeModuleRuntimes(port ? [["web", () => port]] : []),
    ...(selected ? { selected } : {}),
  });
}

describe("web tool exposure", () => {
  it("is advertised when a ChatGPT login exists", async () => {
    expect((await plan(capability())).tools.has("web")).toBe(true);
  });

  it("is omitted with the credential named when there is no login", async () => {
    const planned = await plan(capability({ available: () => false }));
    expect(planned.tools.has("web")).toBe(false);
    expect(planned.omitted).toContainEqual({ name: "web", reason: "no web search provider available (connect ChatGPT or Exa in /auth)" });
  });

  it("names only the web backends that the tree holds in its omission reason", async () => {
    const unavailable = capability({ available: () => false });
    expect((await plan(unavailable, undefined, ["web-chatgpt"])).omitted).toContainEqual({ name: "web", reason: "no web search provider available (connect Exa in /auth)" });
    expect((await plan(unavailable, undefined, ["web-chatgpt", "web-exa"])).omitted).toContainEqual({ name: "web", reason: "no web search provider available (turn on a web retrieval backend in Settings)" });
  });

  it("is omitted when a selected allowlist does not name it, even with a login", async () => {
    const planned = await plan(capability(), new Set<string>());
    expect(planned.tools.has("web")).toBe(false);
    expect(planned.omitted).toContainEqual({ name: "web", reason: "not in selected allowlist" });
  });
});

describe("web tool execution", () => {
  it("refuses a call that names no operation", async () => {
    const result = await createWebTool(capability()).execute({}, context());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("at least one operation");
  });

  it("passes the dedicated retrieval scope to the capability", async () => {
    let seen: { command: WebSearchCommand; options: WebSearchRunOptions } | undefined;
    const tool = createWebTool(capability({
      run: async (command, options) => {
        seen = { command, options };
        return { results: [] };
      },
    }));
    const toolContext = Object.assign(context(), { artifactScopeId: "artifact-1", retrievalSessionId: "retrieval-1" });
    await tool.execute({ search_query: [{ q: "bun releases" }] }, toolContext);
    expect(seen?.options.retrievalSessionId).toBe("retrieval-1");
    expect(seen?.command.search_query).toEqual([{ q: "bun releases" }]);
  });

  it("formats results with ref_ids so later operations can reference them", async () => {
    const response: WebSearchResponse = {
      results: [
        { refId: "turn0search0", title: "Bun", url: "https://bun.com/", snippet: "A fast runtime" },
        { url: "https://bun.sh/" },
      ],
    };
    const tool = createWebTool(capability({ run: async () => response }));
    const result = await tool.execute({ search_query: [{ q: "bun" }] }, context());
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("1. Bun [turn0search0]");
    expect(result.content).toContain("https://bun.com/");
    expect(result.content).toContain("A fast runtime");
    expect(result.content).toContain("2. https://bun.sh/");
  });

  it("caps the result list at 10 and notes the omission", async () => {
    const many: WebSearchResponse = {
      results: Array.from({ length: 33 }, (_, i) => ({ refId: `search${i}`, url: `https://r${i}/` })),
    };
    const tool = createWebTool(capability({ run: async () => many }));
    const result = await tool.execute({ search_query: [{ q: "x" }] }, context());
    expect(result.content).toContain("10. https://r9/");
    expect(result.content).not.toContain("https://r10/");
    expect(result.content).toContain("(23 lower-ranked results omitted; refine the query to surface others)");
  });

  it("returns document output for open operations", async () => {
    const tool = createWebTool(capability({ run: async () => ({ results: [], output: "L0: page content" }) }));
    const result = await tool.execute({ open: [{ ref_id: "turn0search0" }] }, context());
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("L0: page content");
  });

  it("reports an empty search plainly", async () => {
    const tool = createWebTool(capability());
    const result = await tool.execute({ search_query: [{ q: "nothing" }] }, context());
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe('No results for "nothing".');
  });

  it("maps WebSearchError to an error outcome instead of throwing", async () => {
    const tool = createWebTool(capability({
      run: async () => { throw new WebSearchError("the ChatGPT login was rejected"); },
    }));
    const result = await tool.execute({ search_query: [{ q: "x" }] }, context());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("the ChatGPT login was rejected");
  });
});

describe("web provider request capture", () => {
  function provider(id: "chatgpt" | "exa", available: () => boolean, run: () => Promise<WebSearchResponse>): WebSearchProvider {
    return { id, available, run };
  }

  it("uses the captured preference while checking current availability", async () => {
    const ran: string[] = [];
    let exaAvailable = false;
    const search = createWebSearch({
      preference: "exa",
      providers: [
        provider("chatgpt", () => true, async () => { ran.push("chatgpt"); return { results: [] }; }),
        provider("exa", () => exaAvailable, async () => { ran.push("exa"); return { results: [] }; }),
      ],
    });

    await search.run({ search_query: [{ q: "first" }] }, { retrievalSessionId: "s" });
    exaAvailable = true;
    await search.run({ search_query: [{ q: "second" }] }, { retrievalSessionId: "s" });

    expect(ran).toEqual(["chatgpt", "exa"]);
  });

  it("surfaces the selected provider failure without invoking the fallback", async () => {
    let fallbackCalls = 0;
    const search = createWebSearch({
      preference: "exa",
      providers: [
        provider("chatgpt", () => true, async () => { fallbackCalls += 1; return { results: [] }; }),
        provider("exa", () => true, async () => { throw new WebSearchError("exa request failed"); }),
      ],
    });

    await expect(search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" })).rejects.toThrow("exa request failed");
    expect(fallbackCalls).toBe(0);
  });
});

describe("chatgpt web search boundary", () => {
  const temporaryDirectory = temporaryDirectories();
  const classifySlot = (providerId: string) => providerId === "chatgpt" ? "subscription" as const : "metered" as const;
  async function authDirWithLogin(): Promise<string> {
    // The auth store keeps its profile locks beside the profile directory. A child
    // profile directory keeps those locks inside the temporary directory.
    const dir = join(temporaryDirectory("web-search-auth-"), "default");
    await mkdir(dir);
    await appendCredentialInstance("chatgpt", { id: "chatgpt-account", identity: "acct-1", credential: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3_600_000, accountId: "acct-1" } }, dir, (providerId) => providerId === "chatgpt" ? "subscription" : "metered");
    return dir;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("reports unavailable without a stored ChatGPT credential", () => {
    expect(createChatGptWebSearch("/scratch/does-not-exist", classifySlot).available()).toBe(false);
  });

  it("reports available with a stored ChatGPT OAuth credential", async () => {
    expect(createChatGptWebSearch(await authDirWithLogin(), classifySlot).available()).toBe(true);
  });

  it("uses an injected ChatGPT credential without an auth file", async () => {
    const connection = captureProviderConnection({
      authDir: "/profile-must-not-be-read",
      auth: authContext(true),
      subscriptionCredentials: new Map([["chatgpt", [{ instanceId: "injected-account", credential: { type: "oauth", access: Redacted.make("injected-access"), refresh: Redacted.make("injected-refresh"), expires: Date.now() + 3_600_000, accountId: "injected-account" } }]]]),
      oauthPersistence: "memory-only",
    });
    const authorizations: Array<string | null> = [];
    const search = createChatGptWebSearch(connection.authDir, classifySlot, {
      fetchImpl: Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse({ results: [] });
      }, { preconnect: () => {} }),
    }, connection);

    expect(search.available()).toBe(true);
    await search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "injected" });
    expect(authorizations.at(-1)).toBe("Bearer injected-access");
  });

  it("never falls back to a stored credential when the injected connection has none", async () => {
    const authDir = await authDirWithLogin();
    const connection = captureProviderConnection({
      authDir,
      auth: authContext(false),
      subscriptionCredentials: new Map(),
      oauthPersistence: "access-only",
    });
    let fetched = false;
    const search = createChatGptWebSearch(authDir, classifySlot, {
      fetchImpl: Object.assign(async () => {
        fetched = true;
        return jsonResponse({ results: [] });
      }, { preconnect: () => {} }),
    }, connection);

    expect(search.available()).toBe(false);
    await expect(search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "injected" })).rejects.toThrow("requires exactly one saved ChatGPT account");
    expect(fetched).toBe(false);
  });

  it("refuses an ambiguous multi-account ChatGPT connection", async () => {
    const credential = (accountId: string) => ({ type: "oauth" as const, access: Redacted.make(`${accountId}-access`), expires: Date.now() + 3_600_000, accountId });
    const connection = captureProviderConnection({
      authDir: "/profile-must-not-be-read",
      auth: authContext(true),
      subscriptionCredentials: new Map([["chatgpt", [
        { instanceId: "account-a", credential: credential("account-a") },
        { instanceId: "account-b", credential: credential("account-b") },
      ]]]),
      oauthPersistence: "memory-only",
    });
    const search = createChatGptWebSearch(connection.authDir, classifySlot, undefined, connection);

    expect(search.available()).toBe(false);
    await expect(search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "ambiguous" })).rejects.toThrow("requires exactly one saved ChatGPT account");
  });

  it("sends the bearer token, account id, and stable session id", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const search = createChatGptWebSearch(await authDirWithLogin(), classifySlot, {
      fetchImpl: Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(url), init: init ?? {} };
        return jsonResponse({ results: [{ ref_id: "turn0search0", title: "T", url: "https://x/", snippet: "s" }] });
      }, { preconnect: () => {} }),
    });
    const response = await search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "sess-9" });
    expect(seen?.url).toBe(`${CHATGPT_BACKEND_API_BASE}/alpha/search`);
    const headers = seen?.init.headers;
    if (!headers || Array.isArray(headers) || headers instanceof Headers) throw new Error("fetch must receive header fields");
    const headerFields: RuntimeToolInput = headers;
    expect(headerFields.Authorization).toBe("Bearer test-access");
    expect(headerFields["ChatGPT-Account-ID"]).toBe("acct-1");
    expect(JSON.parse(String(seen?.init.body))).toEqual({ id: "sess-9", model: "gpt-4o", commands: { search_query: [{ q: "x" }] } });
    expect(response.results).toEqual([{ refId: "turn0search0", title: "T", url: "https://x/", snippet: "s" }]);
  });

  it("retries transient 5xx and succeeds", async () => {
    const statuses = [503, 502];
    const search = createChatGptWebSearch(await authDirWithLogin(), classifySlot, {
      retryDelayMs: 1,
      fetchImpl: Object.assign(async () => {
        const status = statuses.shift();
        return status ? new Response("busy", { status }) : jsonResponse({ results: [], output: "ok" });
      }, { preconnect: () => {} }),
    });
    const response = await search.run({ open: [{ ref_id: "https://x/" }] }, { retrievalSessionId: "s" });
    expect(response.output).toBe("ok");
    expect(statuses).toHaveLength(0);
  });

  it("maps auth rejection and rate limiting to WebSearchError", async () => {
    for (const [status, fragment] of [[401, "login was rejected"], [429, "rate-limited"]] as const) {
      const search = createChatGptWebSearch(await authDirWithLogin(), classifySlot, { fetchImpl: Object.assign(async () => new Response("", { status }), { preconnect: () => {} }) });
      expect(search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" })).rejects.toThrow(fragment);
    }
  });

  it("throws on a 2xx body that is not a response instead of faking an empty result", async () => {
    const search = createChatGptWebSearch(await authDirWithLogin(), classifySlot, {
      fetchImpl: Object.assign(async () => new Response("<html>gateway</html>", { status: 200 }), { preconnect: () => {} }),
    });
    expect(search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" })).rejects.toThrow("unreadable response body");
  });

  it("drops unreadable result entries but keeps readable ones", async () => {
    const search = createChatGptWebSearch(await authDirWithLogin(), classifySlot, {
      fetchImpl: Object.assign(async () => jsonResponse({ results: [null, 42, { unrelated: true }, { url: "https://keep/" }] }), { preconnect: () => {} }),
    });
    const response = await search.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" });
    expect(response.results).toEqual([{ url: "https://keep/" }]);
  });
});
