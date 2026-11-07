import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { createExaWebSearch } from "../../../../../src/orchestration/agent-runtime/web-search/exa.js";
import { createWebSearch } from "../../../../../src/orchestration/agent-runtime/web-search/select.js";
import type { WebSearchProvider } from "../../../../../src/orchestration/agent-runtime/web-search/types.js";
import { composeFirstPartyModules, createWebSearchProviderResolver, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.js";
import type { ModuleId } from "../../../../../src/protocol/module-ids.js";
import { authProviders } from "../../../../helpers/auth-context.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

interface SeenBody { [key: string]: unknown; contents?: { highlights?: { query?: string } } }
interface SeenRequest { url: string; body: SeenBody; headers: { [key: string]: string } }

/** An Exa provider whose fetch is scripted per endpoint. */
function exaWith(responses: { search?: unknown; contents?: unknown; status?: number }, seen: SeenRequest[] = []) {
  return createExaWebSearch(() => Redacted.make("test-key"), {
    retryDelayMs: 1,
    fetchImpl: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      const body: SeenBody = JSON.parse(String(init?.body));
      seen.push({
        url: String(url),
        body,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      if (responses.status) return new Response("", { status: responses.status });
      return jsonResponse(String(url).endsWith("/contents") ? responses.contents : responses.search);
    }, { preconnect: fetch.preconnect }),
  });
}

const SEARCH_BODY = {
  results: [
    { url: "https://a/", title: "A", highlights: ["alpha content here", "second alpha passage"], publishedDate: "2026-01-01" },
    { url: "https://b/", title: "B", highlights: ["beta content"] },
  ],
};

const CONTENTS_BODY = {
  results: [{
    url: "https://a/",
    title: "A",
    text: "line zero\nline one has needle\nline two",
    extras: { links: ["https://linked-0/", "https://linked-1/"] },
  }],
};

describe("exa web search provider", () => {
  it("is available exactly when an API key is present", () => {
    expect(createExaWebSearch(() => undefined).available()).toBe(false);
    expect(createExaWebSearch(() => Redacted.make("k")).available()).toBe(true);
  });

  it("maps search_query to /search with domains, recency, and highlight contents", async () => {
    const seen: SeenRequest[] = [];
    const exa = exaWith({ search: SEARCH_BODY }, seen);
    const response = await exa.run({ search_query: [{ q: "alpha", domains: ["a.com"], recency: 7 }] }, { retrievalSessionId: "s1" });
    expect(seen[0]?.url).toBe("https://api.exa.ai/search");
    expect(seen[0]?.headers["x-api-key"]).toBe("test-key");
    expect(seen[0]?.body.query).toBe("alpha");
    expect(seen[0]?.body.includeDomains).toEqual(["a.com"]);
    expect(typeof seen[0]?.body.startPublishedDate).toBe("string");
    // Snippets come from query-aware highlights, joined into one passage.
    expect(seen[0]?.body.contents?.highlights?.query).toBe("alpha");
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({ refId: "search1", url: "https://a/", title: "A" });
    expect(response.results[0]?.snippet).toBe("alpha content here ... second alpha passage");
  });

  it("opens a search ref via /contents, renders lines, and lists links", async () => {
    const exa = exaWith({ search: SEARCH_BODY, contents: CONTENTS_BODY });
    await exa.run({ search_query: [{ q: "alpha" }] }, { retrievalSessionId: "s2" });
    const opened = await exa.run({ open: [{ ref_id: "search1" }] }, { retrievalSessionId: "s2" });
    expect(opened.output).toContain("Total lines: 3");
    expect(opened.output).toContain("L1: line one has needle");
    expect(opened.output).toContain("[0] https://linked-0/");
  });

  it("opens a raw URL without a prior search", async () => {
    const exa = exaWith({ contents: CONTENTS_BODY });
    const opened = await exa.run({ open: [{ ref_id: "https://a/" }] }, { retrievalSessionId: "s3" });
    expect(opened.output).toContain("L0: line zero");
  });

  it("find scans the cached document and reports line numbers", async () => {
    const exa = exaWith({ contents: CONTENTS_BODY });
    await exa.run({ open: [{ ref_id: "https://a/" }] }, { retrievalSessionId: "s4" });
    const found = await exa.run({ find: [{ ref_id: "view1", pattern: "NEEDLE" }] }, { retrievalSessionId: "s4" });
    expect(found.output).toContain("L1: line one has needle");
  });

  it("click follows a numbered link from an opened page", async () => {
    const seen: SeenRequest[] = [];
    const exa = exaWith({ contents: CONTENTS_BODY }, seen);
    await exa.run({ open: [{ ref_id: "https://a/" }] }, { retrievalSessionId: "s5" });
    await exa.run({ click: [{ ref_id: "view1", id: 1 }] }, { retrievalSessionId: "s5" });
    const clickFetch = seen.at(-1);
    expect(clickFetch?.url).toBe("https://api.exa.ai/contents");
    expect(clickFetch?.body.urls).toEqual(["https://linked-1/"]);
  });

  it("refuses an unknown ref with an actionable error", async () => {
    const exa = exaWith({ contents: CONTENTS_BODY });
    expect(exa.run({ open: [{ ref_id: "search99" }] }, { retrievalSessionId: "s6" })).rejects.toThrow('unknown ref_id "search99"');
  });

  it("maps a rejected key to a clear error", async () => {
    const exa = exaWith({ status: 401 });
    expect(exa.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s7" })).rejects.toThrow("Exa API key was rejected");
  });

  it("throws on a 2xx search body without a results collection", async () => {
    const exa = exaWith({ search: { data: [] } });
    expect(exa.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s8" })).rejects.toThrow("without a results collection");
  });

  it("find on an unopened search ref fetches the page once and reuses it for click", async () => {
    const seen: SeenRequest[] = [];
    const exa = exaWith({ search: SEARCH_BODY, contents: CONTENTS_BODY }, seen);
    await exa.run({ search_query: [{ q: "alpha" }] }, { retrievalSessionId: "s9" });
    const found = await exa.run({ find: [{ ref_id: "search1", pattern: "needle" }] }, { retrievalSessionId: "s9" });
    expect(found.output).toContain("L1: line one has needle");
    const fetchesAfterFind = seen.length;
    // The implicit fetch cached the document under its URL, so the search
    // ref now supports find and click without another /contents call.
    const again = await exa.run({ find: [{ ref_id: "search1", pattern: "needle" }] }, { retrievalSessionId: "s9" });
    expect(again.output).toContain("L1: line one has needle");
    expect(seen.length).toBe(fetchesAfterFind);
    await exa.run({ click: [{ ref_id: "search1", id: 0 }] }, { retrievalSessionId: "s9" });
    expect(seen.at(-1)?.body.urls).toEqual(["https://linked-0/"]);
  });

  it("response_length selects the returned window size", async () => {
    const longPage = { results: [{ url: "https://long/", title: "Long", text: Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n") }] };
    const exa = exaWith({ contents: longPage });
    const short = await exa.run({ open: [{ ref_id: "https://long/" }], response_length: "short" }, { retrievalSessionId: "s10" });
    expect(short.output).toContain("showing L0-L119");
    const long = await exa.run({ open: [{ ref_id: "https://long/" }], response_length: "long" }, { retrievalSessionId: "s10" });
    expect(long.output).toContain("showing L0-L1199");
    const defaulted = await exa.run({ open: [{ ref_id: "https://long/" }] }, { retrievalSessionId: "s10" });
    expect(defaulted.output).toContain("showing L0-L399");
  });

  it("reopening a cached page renders without another network call", async () => {
    const seen: SeenRequest[] = [];
    const exa = exaWith({ contents: CONTENTS_BODY }, seen);
    await exa.run({ open: [{ ref_id: "https://a/" }] }, { retrievalSessionId: "s11" });
    const count = seen.length;
    const reopened = await exa.run({ open: [{ ref_id: "https://a/", lineno: 1 }] }, { retrievalSessionId: "s11" });
    expect(reopened.output).toContain("L1: line one has needle");
    expect(seen.length).toBe(count);
  });
});

describe("web search provider selection", () => {
  function provider(id: "chatgpt" | "exa", available: boolean, ran: string[]): WebSearchProvider {
    return {
      id,
      available: () => available,
      run: async () => {
        ran.push(id);
        return { results: [] };
      },
    };
  }

  it("uses the preferred provider when available", async () => {
    const ran: string[] = [];
    const capability = createWebSearch({
      preference: "exa",
      providers: [provider("chatgpt", true, ran), provider("exa", true, ran)],
    });
    await capability.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" });
    expect(ran).toEqual(["exa"]);
  });

  it("falls back to the other provider when the preferred one is unavailable", async () => {
    const ran: string[] = [];
    const capability = createWebSearch({
      preference: "exa",
      providers: [provider("chatgpt", true, ran), provider("exa", false, ran)],
    });
    expect(capability.available()).toBe(true);
    await capability.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" });
    expect(ran).toEqual(["chatgpt"]);
  });

  it("is unavailable and refuses to run when no provider has credentials", async () => {
    const capability = createWebSearch({
      providers: [provider("chatgpt", false, []), provider("exa", false, [])],
    });
    expect(capability.available()).toBe(false);
    expect(capability.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" })).rejects.toThrow("no web search provider is available: connect ChatGPT or Exa in /auth");
  });

  it("names only the captured providers when it refuses to run", async () => {
    const capability = createWebSearch({ providers: [provider("exa", false, [])] });
    expect(capability.run({ search_query: [{ q: "x" }] }, { retrievalSessionId: "s" })).rejects.toThrow("no web search provider is available: connect Exa in /auth");
  });
});

describe("web backend module composition", () => {
  const auth = {
    providers: authProviders(),
    credentialLineages: {}, droppedCredentials: [],
  };

  it("binds Exa to the injected connection without reading live auth", () => {
    const connection = captureProviderConnection({
      authDir: "/profile-must-not-be-read",
      auth: { ...auth, providers: authProviders({ base: auth.providers, apiKeys: { exa: "injected-exa" } }),},
      oauthPersistence: "memory-only",
    });
    const resolver = createWebSearchProviderResolver({
      authDir: connection.authDir,
      getAuth: () => { throw new Error("live auth read"); },
      connection,
    });
    const exa = resolver(composeFirstPartyModules(SHIPPED_MODULES, ["web-chatgpt"])).at(0);

    expect(exa?.id).toBe("exa");
    expect(exa?.available()).toBe(true);
  });
  const resolveProviders = createWebSearchProviderResolver({ authDir: "/scratch/unused", getAuth: () => auth });
  const providers = (disabledModuleIds: readonly ModuleId[]) => resolveProviders(
    composeFirstPartyModules(SHIPPED_MODULES, disabledModuleIds),
  ).map((provider) => provider.id);

  it("keeps ChatGPT fallback when Exa is off", () => {
    expect(providers(["web-exa"])).toEqual(["chatgpt"]);
  });

  it("does not invent a backend when both are off", () => {
    expect(providers(["web-chatgpt", "web-exa"])).toEqual([]);
  });

  it("removes every owned contribution when Web is off", () => {
    const composition = composeFirstPartyModules(SHIPPED_MODULES, ["web", "web-chatgpt", "web-exa"]);
    expect(composition.contributions.filter(({ domain, id }) => domain === "webBackends" || domain === "webAuthProviders" || id === "web")).toEqual([]);
  });
});
