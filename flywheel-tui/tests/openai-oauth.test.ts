import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  let buildAuthorizeUrl: typeof import("../src/orchestration/auth/openai-oauth.js").buildAuthorizeUrl;

  beforeEach(async () => {
    const mod = await import("../src/orchestration/auth/openai-oauth.js");
    buildAuthorizeUrl = mod.buildAuthorizeUrl;
  });

  it("includes all required OAuth params", () => {
    const url = buildAuthorizeUrl(
      "http://localhost:1455/auth/callback",
      { verifier: "test-verifier", challenge: "test-challenge" },
      "test-state",
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://auth.openai.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(parsed.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("test-state");
    expect(parsed.searchParams.get("originator")).toBe("flywheel");
  });

  it("includes id_token_add_organizations and codex_cli_simplified_flow", () => {
    const url = buildAuthorizeUrl(
      "http://localhost:1455/auth/callback",
      { verifier: "v", challenge: "c" },
      "s",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(parsed.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  });

  it("produces a valid URL (no encoding issues)", () => {
    const url = buildAuthorizeUrl(
      "http://localhost:1455/auth/callback",
      { verifier: "abc123", challenge: "xyz789" },
      "state-with-dashes",
    );
    expect(() => new URL(url)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken — mock fetch
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  let refreshAccessToken: typeof import("../src/orchestration/auth/openai-oauth.js").refreshAccessToken;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const mod = await import("../src/orchestration/auth/openai-oauth.js");
    refreshAccessToken = mod.refreshAccessToken;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct form-urlencoded body", async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedHeaders = Object.fromEntries(
        (init?.headers as Headers)?.entries?.() ??
          Object.entries(init?.headers as Record<string, string> ?? {}),
      );
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await refreshAccessToken("old-refresh-token");
    expect(result.access_token).toBe("new-access");
    expect(result.refresh_token).toBe("new-refresh");

    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=old-refresh-token");
    expect(capturedBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(capturedHeaders?.["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("throws on non-200 response", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    expect(refreshAccessToken("bad-token")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForTokens — mock fetch
// ---------------------------------------------------------------------------

describe("exchangeCodeForTokens", () => {
  let exchangeCodeForTokens: typeof import("../src/orchestration/auth/openai-oauth.js").exchangeCodeForTokens;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const mod = await import("../src/orchestration/auth/openai-oauth.js");
    exchangeCodeForTokens = mod.exchangeCodeForTokens;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends authorization_code grant with correct params", async () => {
    let capturedBody: string | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          access_token: "exchanged-access",
          refresh_token: "exchanged-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await exchangeCodeForTokens(
      "auth-code-123",
      "http://localhost:1455/auth/callback",
      "pkce-verifier",
    );

    expect(result.access_token).toBe("exchanged-access");
    expect(capturedBody).toContain("grant_type=authorization_code");
    expect(capturedBody).toContain("code=auth-code-123");
    expect(capturedBody).toContain("redirect_uri=" + encodeURIComponent("http://localhost:1455/auth/callback"));
    expect(capturedBody).toContain("code_verifier=pkce-verifier");
    expect(capturedBody).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("throws on non-200 response", async () => {
    globalThis.fetch = (async () => {
      return new Response("Bad Request", { status: 400 });
    }) as typeof fetch;

    expect(exchangeCodeForTokens("bad", "http://localhost:1455/auth/callback", "v")).rejects.toThrow();
  });
});
