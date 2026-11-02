import { afterEach, describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { CopilotTokenRefreshError, refreshGitHubCopilotToken } from "../../../../src/orchestration/modules/provider-github-copilot/token-refresh.js";

describe("refreshGitHubCopilotToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns stored tokens on a well-formed response", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 1_800;
    globalThis.fetch = Object.assign(async () =>
      new Response(JSON.stringify({ token: "copilot-tok", expires_at: expiresAt }), { status: 200 }), { preconnect: originalFetch.preconnect });

    const tokens = await refreshGitHubCopilotToken(Redacted.make("gh-token"), "enterprise.ghe.com");

    expect(Redacted.value(tokens.copilotToken)).toBe("copilot-tok");
    expect(tokens.expiresAtMs).toBe(expiresAt * 1_000);
    expect(Redacted.value(tokens.githubToken)).toBe("gh-token");
    expect(tokens.enterpriseDomain).toBe("enterprise.ghe.com");
  });

  it("shares one provider exchange across concurrent callers", async () => {
    let calls = 0;
    const expiresAt = Math.floor(Date.now() / 1000) + 1_800;
    globalThis.fetch = Object.assign(async () => {
      calls += 1;
      return Response.json({ token: "shared-token", expires_at: expiresAt });
    }, { preconnect: originalFetch.preconnect });

    const results = await Promise.all([
      refreshGitHubCopilotToken(Redacted.make("shared-github-token")),
      refreshGitHubCopilotToken(Redacted.make("shared-github-token")),
    ]);

    expect(calls).toBe(1);
    expect(results.map((result) => Redacted.value(result.copilotToken))).toEqual(["shared-token", "shared-token"]);
  });

  it("does not let one cancelled waiter abort a shared exchange", async () => {
    const response = Promise.withResolvers<Response>();
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls += 1; return response.promise; }, { preconnect: originalFetch.preconnect });
    const controller = new AbortController();
    const first = refreshGitHubCopilotToken(Redacted.make("cancel-shared-token"), undefined, controller.signal).then(() => "resolved", () => "cancelled");
    const second = refreshGitHubCopilotToken(Redacted.make("cancel-shared-token"));

    controller.abort();
    response.resolve(Response.json({ token: "surviving-token", expires_at: Math.floor(Date.now() / 1000) + 1_800 }));

    expect(await first).toBe("cancelled");
    expect(Redacted.value((await second).copilotToken)).toBe("surviving-token");
    expect(calls).toBe(1);
  });

  it("throws a typed http error that carries only a safe reason, never the raw body", async () => {
    const secretBody = "Bearer gh-token leaked back in the body";
    globalThis.fetch = Object.assign(async () => new Response(secretBody, { status: 401, statusText: "Unauthorized" }), { preconnect: originalFetch.preconnect });

    const error = await refreshGitHubCopilotToken(Redacted.make("gh-token")).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(CopilotTokenRefreshError);
    if (!(error instanceof CopilotTokenRefreshError)) throw new Error("Expected CopilotTokenRefreshError");
    expect(error.reason).toEqual({ kind: "http", status: 401 });
    expect(error.message).not.toContain(secretBody);
    expect(error.message).not.toContain("gh-token");
  });

  it("throws a typed malformed_response error when token fields are missing", async () => {
    globalThis.fetch = Object.assign(async () =>
      new Response(JSON.stringify({ token: 123, expires_at: "soon" }), { status: 200 }), { preconnect: originalFetch.preconnect });

    const error = await refreshGitHubCopilotToken(Redacted.make("gh-token")).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(CopilotTokenRefreshError);
    if (!(error instanceof CopilotTokenRefreshError)) throw new Error("Expected CopilotTokenRefreshError");
    expect(error.reason).toEqual({ kind: "malformed_response" });
  });

  it("rejects oversized response bodies and tokens", async () => {
    globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ token: "x".repeat(300_000), expires_at: 2_000 })), { preconnect: originalFetch.preconnect });
    await expect(refreshGitHubCopilotToken(Redacted.make("gh-token"))).rejects.toBeInstanceOf(CopilotTokenRefreshError);
    globalThis.fetch = Object.assign(async () => Response.json({ token: "x".repeat(8_193), expires_at: 2_000 }), { preconnect: originalFetch.preconnect });
    await expect(refreshGitHubCopilotToken(Redacted.make("gh-token"))).rejects.toBeInstanceOf(CopilotTokenRefreshError);
  });
});
