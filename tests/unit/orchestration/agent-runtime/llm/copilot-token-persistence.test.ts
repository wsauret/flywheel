import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { setCredential } from "../../../../../src/infra/auth/auth-store-mutations.js";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import type { OAuthCredential } from "../../../../../src/infra/auth/auth-store-types.js";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { buildCopilotClients } from "../../../../../src/orchestration/modules/provider-github-copilot/clients.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { authProviders } from "../../../../helpers/auth-context.js";

const expired: OAuthCredential = {
  type: "oauth",
  access: "expired-copilot-token",
  refresh: "github-token",
  expires: 1,
};

const runtimeExpired = { ...expired, access: Redacted.make(expired.access), refresh: Redacted.make(expired.refresh ?? "") };

const auth: AuthContext = {
  providers: authProviders({ oauth: ["github_copilot"] }),
  credentialLineages: {}, droppedCredentials: [],
};

function installRefreshFetch(): () => string | null {
  let authorization: string | null = null;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/copilot_internal/v2/token")) {
      return new Response(JSON.stringify({ token: "fresh-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    authorization = new Headers(init?.headers).get("Authorization");
    return new Response(JSON.stringify({ id: "response", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
  }, { preconnect: () => {} });
  return () => authorization;
}

function installRejectedModelFetch(): () => number {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }, { preconnect: () => {} });
  return () => calls;
}

async function forceRefresh(authDir: string, persistence: "profile" | "memory-only" | "access-only"): Promise<void> {
  const connection = captureProviderConnection({
    authDir,
    auth,
    oauthPersistence: persistence,
    subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "test-copilot", credential: runtimeExpired }]]]),
  });
  const { openai } = buildCopilotClients(
    runtimeExpired,
    connection,
    { kind: "subscription", providerId: "github_copilot", instanceId: "test-copilot", spendMode: "included" },
    persistence === "profile" ? async (_expected, next) => {
      await setCredential("github_copilot", { type: "oauth", access: Redacted.value(next.copilotToken), refresh: Redacted.value(next.githubToken), expires: next.expiresAtMs }, authDir);
      return true;
    } : undefined,
  );
  await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] });
}

describe("Copilot token persistence", () => {
  const originalFetch = globalThis.fetch;
  const directories: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("refreshes a memory-only connection without creating an auth artifact", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "flywheel-copilot-memory-only-"));
    directories.push(authDir);
    const authorization = installRefreshFetch();

    await forceRefresh(authDir, "memory-only");
    expect(authorization()).toBe("Bearer fresh-copilot-token");

    expect(existsSync(join(authDir, "auth.json"))).toBe(false);
  });

  it("rejects access-only refresh before provider I/O", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "flywheel-copilot-access-only-"));
    directories.push(authDir);
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls += 1; return Response.json({}); }, { preconnect: () => {} });

    await expect(forceRefresh(authDir, "access-only")).rejects.toThrow();
    expect(calls).toBe(0);
    expect(existsSync(join(authDir, "auth.json"))).toBe(false);
  });

  it("preserves profile CAS persistence on refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-copilot-profile-"));
    directories.push(root);
    // The auth store creates `profile-locks` beside the auth directory, so the
    // auth directory is one level inside the directory that the cleanup removes.
    const authDir = join(root, "profile");
    mkdirSync(authDir);
    await setCredential("github_copilot", expired, authDir);
    installRefreshFetch();

    await forceRefresh(authDir, "profile");

    const stored = JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8"));
    expect(stored.github_copilot.access).toBe("fresh-copilot-token");
    expect(stored.github_copilot.refresh).toBe("github-token");
  });

  it("returns an external attempt failure when proactive refresh is rejected without a notice or model request", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "flywheel-copilot-rejected-refresh-"));
    directories.push(authDir);
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      throw new Error("refresh unavailable");
    }, { preconnect: () => {} });
    const connection = captureProviderConnection({
      authDir,
      auth,
      oauthPersistence: "memory-only",
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "rejected-refresh", credential: runtimeExpired }]]]),
    });
    const clients = buildCopilotClients(
      runtimeExpired,
      connection,
      { kind: "subscription", providerId: "github_copilot", instanceId: "rejected-refresh", spendMode: "included" },
    );

    const failure = await clients.openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }).catch((error) => error);

    expect(failure.cause).toBeInstanceOf(ProviderAttemptFailure);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/copilot_internal/v2/token");
  });

  it("leaves profile persistence failures unchanged", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "flywheel-copilot-persistence-failure-"));
    directories.push(authDir);
    installRefreshFetch();
    const persistenceFailure = new Error("profile persistence failed");
    const connection = captureProviderConnection({
      authDir,
      auth,
      oauthPersistence: "profile",
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "persistence-failure", credential: runtimeExpired }]]]),
    });
    const clients = buildCopilotClients(
      runtimeExpired,
      connection,
      { kind: "subscription", providerId: "github_copilot", instanceId: "persistence-failure", spendMode: "included" },
      async () => { throw persistenceFailure; },
    );

    const failure = await clients.openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }).catch((error) => error);

    expect(failure).not.toBeInstanceOf(ProviderAttemptFailure);
    expect(failure.cause).toBe(persistenceFailure);
  });

  it("does not resend a model request after a reactive 401", async () => {
    const calls = installRejectedModelFetch();
    const connection = captureProviderConnection({
      auth,
      authDir: "/unused",
      oauthPersistence: "memory-only",
      subscriptionCredentials: new Map([["github_copilot", [{ instanceId: "reactive-401", credential: { ...runtimeExpired, expires: Date.now() + 3_600_000 } }]]]),
    });
    const { openai } = buildCopilotClients(
      { ...runtimeExpired, expires: Date.now() + 3_600_000 },
      connection,
      { kind: "subscription", providerId: "github_copilot", instanceId: "reactive-401", spendMode: "included" },
    );

    const failure = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] }).catch((error) => error);
    expect(failure).toMatchObject({ status: 401 });
    expect(calls()).toBe(1);
  });
});
