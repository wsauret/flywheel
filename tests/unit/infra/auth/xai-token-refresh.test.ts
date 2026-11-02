import { afterEach, describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import type { StoredTokens } from "../../../../src/infra/auth/openai-auth-types.js";
import { ensureFreshXaiTokens, XaiTokenRefreshError, type XaiTokenRefreshDependencies } from "../../../../src/orchestration/modules/provider-supergrok/token-refresh.js";

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: Redacted.make("xai-access"),
    refreshToken: Redacted.make("xai-refresh"),
    expiresAtMs: Date.now() + 3_600_000,
    ...overrides,
  };
}

interface CapturedRequest { url: string; form: URLSearchParams }

function mockTokenEndpoint(status: number, body: { [key: string]: unknown }): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, form: new URLSearchParams(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }, { preconnect: () => {} });
  return requests;
}

describe("ensureFreshXaiTokens", () => {
  const originalFetch = globalThis.fetch;
  const dependencies: XaiTokenRefreshDependencies = { compareAndSet: async () => true };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns an unexpired captured seed without network access", async () => {
    globalThis.fetch = Object.assign(async () => { throw new Error("network must not be reached"); }, { preconnect: () => {} });
    const seed = tokens();
    expect(await ensureFreshXaiTokens(seed, dependencies)).toBe(seed);
  });

  it("refreshes an expired captured token through candidate-bound compare-and-set", async () => {
    const seed = tokens({ expiresAtMs: Date.now() - 1000 });
    const requests = mockTokenEndpoint(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
    let expected: StoredTokens | undefined;
    let persisted: StoredTokens | undefined;
    const fresh = await ensureFreshXaiTokens(seed, {
      compareAndSet: async (current, next) => {
        expected = current;
        persisted = next;
        return true;
      },
    });
    expect(fresh).not.toBe(seed);
    expect(Redacted.value(fresh.accessToken)).toBe("new-access");
    expect(Redacted.value(fresh.refreshToken!)).toBe("new-refresh");
    expect(expected).toBe(seed);
    expect(persisted).toBe(fresh);
    expect(requests[0]!.url).toBe("https://auth.x.ai/oauth2/token");
    expect(requests[0]!.form.get("refresh_token")).toBe("xai-refresh");
    expect(fresh.expiresAtMs).toBeGreaterThan(Date.now() + 7_000_000);
  });

  it("shares one provider exchange across concurrent callers", async () => {
    const seed = tokens({ expiresAtMs: Date.now() - 1000 });
    const requests = mockTokenEndpoint(200, { access_token: "shared-access", expires_in: 3600 });
    const [first, second] = await Promise.all([
      ensureFreshXaiTokens(seed, dependencies),
      ensureFreshXaiTokens(seed, dependencies),
    ]);
    expect(requests).toHaveLength(1);
    expect(Redacted.value(first.accessToken)).toBe("shared-access");
    expect(Redacted.value(second.accessToken)).toBe("shared-access");
  });

  it("refreshes memory-only credentials without persistence", async () => {
    mockTokenEndpoint(200, { access_token: "memory-access", expires_in: 3600 });
    let persisted = false;
    const fresh = await ensureFreshXaiTokens(tokens({ expiresAtMs: 1 }), { compareAndSet: async () => { persisted = true; return true; } }, undefined, "memory-only");
    expect(Redacted.value(fresh.accessToken)).toBe("memory-access");
    expect(persisted).toBe(false);
  });

  it("rejects access-only refresh before provider I/O", async () => {
    const requests = mockTokenEndpoint(200, { access_token: "must-not-be-used", expires_in: 3600 });
    await expect(ensureFreshXaiTokens(tokens({ expiresAtMs: 1 }), dependencies, undefined, "access-only")).rejects.toThrow("access-only credentials cannot refresh");
    expect(requests).toHaveLength(0);
  });

  it("keeps the old refresh token and defaults expiry when the response omits them", async () => {
    mockTokenEndpoint(200, { access_token: "new-access" });
    const fresh = await ensureFreshXaiTokens(tokens({ expiresAtMs: Date.now() - 1000 }), dependencies);
    expect(Redacted.value(fresh.refreshToken!)).toBe("xai-refresh");
    expect(fresh.expiresAtMs).toBeGreaterThan(Date.now() + 3_500_000);
    expect(fresh.expiresAtMs).toBeLessThan(Date.now() + 3_700_000);
  });

  it("surfaces a rejected refresh as a typed error carrying the OAuth code", async () => {
    mockTokenEndpoint(400, { error: "invalid_grant" });
    await expect(ensureFreshXaiTokens(tokens({ expiresAtMs: Date.now() - 1000 }), dependencies)).rejects.toThrow(XaiTokenRefreshError);
  });

  it("cancels an in-flight refresh through the public signal seam", async () => {
    const controller = new AbortController();
    globalThis.fetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }), { preconnect: () => {} });
    const refresh = ensureFreshXaiTokens(tokens({ expiresAtMs: Date.now() - 1 }), dependencies, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(refresh).rejects.toThrow("cancelled");
  });

  it("fails clearly when the captured credential has no refresh token", async () => {
    const seed = tokens({ expiresAtMs: Date.now() - 1000 });
    const withoutRefresh: StoredTokens = { accessToken: seed.accessToken, refreshToken: undefined, expiresAtMs: seed.expiresAtMs };
    await expect(ensureFreshXaiTokens(withoutRefresh, dependencies)).rejects.toThrow("no refresh token");
  });
});
