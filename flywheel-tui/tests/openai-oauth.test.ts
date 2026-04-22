import { describe, it, expect, beforeEach, afterEach } from "bun:test";

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

