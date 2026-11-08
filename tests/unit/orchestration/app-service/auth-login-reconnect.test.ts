import { describe, expect, test } from "bun:test";

import { Redacted, Schema } from "effect";
import { mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAuthLoginService, type AuthLoginService } from "../../../../src/orchestration/app-service/auth-login-service.js";
import { dispatchAuthMutation } from "../../../../src/orchestration/app-service/auth-mutations.js";
import { providerLoginFlow, type ProviderOAuthLogin } from "../../../../src/orchestration/auth/auth-actions.js";
import { FrontendMutationSchema } from "../../../../src/protocol/runtime-protocol-schemas.js";
import { testAuthContext } from "../../../helpers/auth-context.js";
import type { AuthOperationNotice } from "../../../../src/protocol/auth-status-protocol-types.js";
import { createModulePolicy } from "../../../../src/orchestration/config/module-policy.js";
import { defaultModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection.js";
import { composeFirstPartyModules, composeRealmModuleSnapshot } from "../../../../src/orchestration/modules.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
import { createLoginObservations } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";

/** Reconnecting an account and adding one are different operations.
 *
 *  The credential store refuses a credential whose identity is already stored,
 *  and it refuses it *after* the provider has accepted the login — so getting
 *  this wrong looks like the browser flow succeeding and the editor hanging
 *  forever, which is exactly what it did. */

import { account, provider, service, silentLog } from "./_auth-login-service-fixtures.js";

describe("auth login instance selection", () => {
  test.each(["renewed", "failed", "cancelled"] as const)("claims one hidden-profile question and settles only after its flow: %s", async (outcome) => {
    const observations = createLoginObservations();
    const target = { accountId: "one", identity: "one@example.com", configDir: "/scratch/profile-b/login" };
    observations.recordRequest(target, "login-rejected");
    const waiting = observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
    const id = observations.loginQuestions()[0]!.id;
    const finish = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    let starts = 0;
    const seen: string[] = [];
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "a", directory: "/scratch/profile-a" }), openBrowser: async () => false,
      resolveLoginProfile: (directory) => directory === "/scratch/profile-b" ? { id: "b", directory } : undefined,
      recovery: () => observations,
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async (_grant, directory) => {
        seen.push(directory);
        return [provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: [account("one")] })];
      },
      settleCatalog: () => async () => { await finish.promise; if (outcome === "failed") throw new Error("catalog failed"); },
      refresh: async () => {},
      publishNotice: async (settlement, scope) => {
        expect(scope.question).toBe(true);
        seen.push(scope.profileId);
        expect(settlement?.kind).toBe(outcome === "renewed" ? "completed" : "failed");
        if (outcome === "renewed") await login.cancel(undefined, { loginQuestionId: id });
        published.resolve();
      },
      loginFlows: () => ({
        flow: "browser",
        login: async () => { throw new Error("must reconnect"); },
        reconnect: async (instanceId, ports) => {
          starts += 1;
          expect(instanceId).toBe("one");
          expect(ports.authDir).toBe("/scratch/profile-b");
          expect(ports.loginQuestionId).toBe(id);
          ports.onAuthorizeUrl?.({ url: "https://example.invalid/login" });
          await finish.promise;
          ports.signal?.throwIfAborted();
          await ports.settle({ kind: "subscription", providerId: "anthropic_sub", instanceId }, ports.authDir);
          return true;
        },
      }),
      log: silentLog,
    });
    try {
      const first = login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: id });
      expect(await login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: id })).toEqual({ kind: "ignored", providerId: "anthropic_sub" });
      const result = await first;
      expect(result.kind).toBe("browser");
      expect(starts).toBe(1);
      let released = false;
      void waiting.then(() => { released = true; });
      await Promise.resolve();
      expect(released).toBe(false);
      await login.decline("anthropic_sub", id);
      expect(released).toBe(false);
      if (outcome === "cancelled") await login.cancel(undefined, { loginQuestionId: id });
      finish.resolve();
      expect(await waiting).toBe(outcome === "renewed" ? "renewed" : "declined");
      await published.promise;
      expect(seen).toEqual(["/scratch/profile-b", "b"]);
    } finally { finish.resolve(); login.dispose(); }
  });

  test.each(["preflight", "before-url"] as const)("a scoped close during %s prevents a late login from starting or opening", async (stage) => {
    const observations = createLoginObservations();
    const target = { accountId: "one", identity: "one@example.com", configDir: "/scratch/profile-b/login" };
    observations.recordRequest(target, "login-rejected");
    const waiting = observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
    const id = observations.loginQuestions()[0]!.id;
    const admission = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let starts = 0;
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "a", directory: "/scratch/profile-a" }), openBrowser: async () => false, recovery: () => observations,
      resolveLoginProfile: (directory) => ({ id: "b", directory }),
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher,
      admit: async (request) => { if (stage === "preflight") { entered.resolve(); await admission.promise; } return { ok: true, grant: { ...defaultModuleState(), ...request } }; },
      providers: async () => [provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: [account("one")] })],
      settleCatalog: () => async () => {}, refresh: async () => {}, publishNotice: async () => {}, log: silentLog,
      loginFlows: () => ({ flow: "browser", login: async () => testAuthContext(), reconnect: async (_id, ports) => {
        starts += 1;
        entered.resolve();
        await admission.promise;
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/late" });
        return true;
      } }),
    });
    const pending = login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: id });
    await entered.promise;
    await login.cancel(undefined, { loginQuestionId: "stale" });
    await login.cancel(undefined, { loginQuestionId: id });
    expect(await waiting).toBe("declined");
    admission.resolve();
    expect(await pending).toMatchObject({ kind: stage === "preflight" ? "ignored" : "failed" });
    expect(starts).toBe(stage === "preflight" ? 0 : 1);
    observations.recordRequest(target, "served");
    observations.recordRequest(target, "login-rejected");
    const nextWait = observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
    const nextId = observations.loginQuestions()[0]!.id;
    await dispatchAuthMutation({ authLogin: login }, { type: "auth.login.decline", providerId: "anthropic_sub", loginQuestionId: nextId });
    expect(await nextWait).toBe("declined");
    expect(await login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: nextId })).toMatchObject({ kind: "ignored" });
    login.dispose();
  });

  test.each(["served", "forgotten"] as const)("an episode that ends outside the login (%s) before the URL still gets its sign-in step", async (exit) => {
    const observations = createLoginObservations();
    const target = { accountId: "one", identity: "one@example.com", configDir: "/scratch/profile-b/login" };
    observations.recordRequest(target, "login-rejected");
    void observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
    const id = observations.loginQuestions()[0]!.id;
    const entered = Promise.withResolvers<void>();
    const urlGate = Promise.withResolvers<void>();
    const url = "https://example.invalid/authorize";
    const notices: string[] = [];
    const published = Promise.withResolvers<void>();
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "a", directory: "/scratch/profile-a" }), openBrowser: async () => false, recovery: () => observations,
      resolveLoginProfile: (directory) => ({ id: "b", directory }),
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async () => [provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: [account("one")] })],
      settleCatalog: () => async () => {}, refresh: async () => {}, log: silentLog,
      publishNotice: async (notice) => { notices.push(notice.kind); published.resolve(); },
      loginFlows: () => ({ flow: "browser", login: async () => testAuthContext(), reconnect: async (_id, ports) => {
        entered.resolve();
        await urlGate.promise;
        ports.onAuthorizeUrl?.({ url });
        await ports.onManualCodeInput?.();
        return true;
      } }),
    });
    try {
      const pending = login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: id });
      await entered.promise;
      if (exit === "served") observations.recordRequest(target, "served");
      else observations.forget(target);
      urlGate.resolve();
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
      const result = await Promise.race([pending, Promise.resolve(undefined)]);
      expect(result).toMatchObject({ kind: "browser", authorizeUri: url });
      if (result?.kind !== "browser") throw new Error("No browser step");
      expect(login.completeBrowserLogin(result.operationId, Redacted.make("code#state"))).toBe(true);
      await published.promise;
      expect(notices).toEqual(["completed"]);
    } finally { urlGate.resolve(); login.dispose(); }
  });

  test.each(["missing-account", "unsupported", "missing-profile"] as const)("automatic preflight %s declines without adding an account", async (failure) => {
    const observations = createLoginObservations();
    const target = { accountId: "one", identity: "one@example.com", configDir: "/scratch/profile-b/login" };
    observations.recordRequest(target, "login-rejected");
    const waiting = observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
    const id = observations.loginQuestions()[0]!.id;
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "a", directory: "/scratch/profile-a" }), openBrowser: async () => false, recovery: () => observations,
      resolveLoginProfile: (directory) => failure === "missing-profile" ? undefined : { id: "b", directory },
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async () => [provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: failure === "missing-account" ? [] : [account("one")] })],
      settleCatalog: () => async () => {}, refresh: async () => {}, publishNotice: async () => {}, log: silentLog,
      loginFlows: () => undefined,
    });
    expect(await login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: id })).toMatchObject({ kind: failure === "unsupported" ? "unsupported" : "failed" });
    expect(await waiting).toBe("declined");
    expect(observations.loginQuestions()).toEqual([]);
    login.dispose();
  });

  test("stale close and late rejection cannot cancel a later episode", async () => {
    const observations = createLoginObservations();
    const target = { accountId: "one", identity: "one@example.com", configDir: "/scratch/profile-b/login" };
    const flows = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let starts = 0;
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "a", directory: "/scratch/profile-a" }), openBrowser: async () => false, recovery: () => observations,
      resolveLoginProfile: (directory) => ({ id: "b", directory }),
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async () => [provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: [account("one")] })],
      settleCatalog: () => async () => {}, refresh: async () => {}, publishNotice: async () => {}, log: silentLog,
      loginFlows: () => ({ flow: "browser", login: async () => testAuthContext(), reconnect: async (_id, ports) => {
        const done = flows[starts++]!;
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/login" });
        await done.promise;
        return true;
      } }),
    });
    const ask = () => {
      observations.recordRequest(target, "login-rejected");
      const waiting = observations.awaitLogin("/scratch/profile-b", target, new AbortController().signal);
      return { waiting, id: observations.loginQuestions()[0]!.id };
    };
    const first = ask();
    const old = await login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: first.id });
    if (old.kind !== "browser") throw new Error("Browser flow did not start");
    await login.cancel(undefined, { loginQuestionId: first.id, operationId: old.operationId });
    expect(await first.waiting).toBe("declined");
    observations.recordRequest(target, "served");
    const second = ask();
    const next = await login.login({ providerId: "anthropic_sub", instanceId: "one", loginQuestionId: second.id });
    if (next.kind !== "browser") throw new Error("New browser flow did not start");
    await login.cancel(undefined, { loginQuestionId: first.id, operationId: old.operationId });
    await login.cancel(undefined, { loginQuestionId: second.id, operationId: old.operationId });
    flows[0]!.reject(new Error("old flow failed late"));
    await Promise.resolve();
    expect(observations.loginQuestions()).toMatchObject([{ id: second.id, phase: "logging-in" }]);
    flows[1]!.resolve();
    expect(await second.waiting).toBe("renewed");
    expect(starts).toBe(2);
    login.dispose();
  });
  test("login reads the admitted selection and retains it through a later disable", async () => {
    const home = mkdtempSync(join(tmpdir(), "flywheel-login-grant-"));
    const config = join(home, "flywheel.toml");
    const policy = await createModulePolicy({ userDataRoot: home });
    // The projection's own selection is stale: it lacks ChatGPT, which the login grant admits.
    const staleComposition = composeFirstPartyModules(undefined, ["provider-chatgpt"]);
    const projection = createAuthStatusProjection({
      initialProfile: { id: "default", displayName: "Default", source: "default", directory: home, availableProfiles: [], persistedId: "default", projectBinding: undefined, retirements: {} },
      moduleSelection: () => staleComposition,
      subscriptionSpendConsent: (profileId) => ({ kind: "available", profileId, authorityIncarnation: "test", authorityRevision: 0, usageGeneration: 0, accounts: [] }),
    });
    const finish = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const reads: string[] = [];
    const settlements: boolean[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (ports) => {
        ports.onAuthorizeUrl?.({ url: "https://example.invalid" });
        await finish.promise;
        await ports.settle({ kind: "subscription", providerId: "chatgpt", instanceId: "new" }, ports.authDir);
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = createAuthLoginService({
      resolveProfile: () => ({ id: "default", directory: home }),
      resolveKey: async (value) => Redacted.make(value),
      launcher: refusingLauncher,
      openBrowser: async () => false,
      refresh: async () => {},
      publishNotice: async () => { settled.resolve(); },
      settleCatalog: (grant) => async () => {
        settlements.push(grant.moduleIds.includes("provider-chatgpt"));
      },
      admit: policy.admit,
      providers: async (grant) => {
        const rows = (await projection.snapshot({ kind: "defaults" }, undefined, composeRealmModuleSnapshot(grant))).providers;
        const row = rows.find((candidate) => candidate.providerId === "chatgpt");
        if (row !== undefined) reads.push(row.loginMethod);
        return rows;
      },
      loginFlows: () => flow,
      log: silentLog,
    });
    try {
      expect((await projection.snapshot()).providers.some((row) => row.providerId === "chatgpt")).toBe(false);
      expect(await login.login({ providerId: "chatgpt" })).toMatchObject({ kind: "browser" });
      writeFileSync(join(home, "next.toml"), 'disabled_modules = ["provider-chatgpt"]\n');
      renameSync(join(home, "next.toml"), config);
      await policy.admit({ operation: "unrelated work", required: [] });
      expect(policy.state().moduleIds).not.toContain("provider-chatgpt");
      finish.resolve();
      await settled.promise;
      expect(reads).toEqual(["browser-auth"]);
      expect(settlements).toEqual([true]);
      expect(await login.login({ providerId: "chatgpt" })).toMatchObject({ kind: "unsupported" });
      expect((await projection.snapshot()).providers.some((row) => row.providerId === "chatgpt")).toBe(false);
    } finally {
      login.dispose();
      finish.resolve();
      await policy.dispose();
      rmSync(home, { recursive: true });
    }
  });

  test("a committed disable refuses stale visible providers before login, reconnect, or key persistence", async () => {
    const home = mkdtempSync(join(tmpdir(), "flywheel-login-admission-"));
    const config = join(home, "flywheel.toml");
    writeFileSync(config, "");
    const policy = await createModulePolicy({ userDataRoot: home });
    const calls: string[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (ports) => { calls.push("login"); ports.onAuthorizeUrl?.({ url: "https://example.invalid" }); return testAuthContext(); },
      reconnect: async (_id, ports) => { calls.push("reconnect"); ports.onAuthorizeUrl?.({ url: "https://example.invalid" }); return true; },
    };
    const login = service([
      provider({ providerId: "chatgpt", loginMethod: "browser-auth", accounts: [account("one")] }),
      provider({ providerId: "anthropic_api", loginMethod: "api-key" }),
    ], new Map([["chatgpt", flow]]), async () => {}, join(home, "credentials"), async () => { calls.push("settle"); }, policy.admit);
    try {
      expect(policy.state().moduleIds).toContain("provider-chatgpt");
      writeFileSync(join(home, "next.toml"), 'disabled_modules = ["provider-anthropic-api", "provider-chatgpt"]\n');
      renameSync(join(home, "next.toml"), config);
      expect(policy.state().moduleIds).toContain("provider-chatgpt");
      for (const instanceId of [undefined, "one"]) {
        expect(await login.login({ providerId: "chatgpt", instanceId })).toMatchObject({ kind: "unsupported" });
      }
      expect(await login.login({ providerId: "anthropic_api", apiKey: Redacted.make("sk-ant-valid") })).toMatchObject({ kind: "unsupported" });
      expect(calls).toEqual([]);
      expect(await Bun.file(join(home, "credentials", "auth.json")).exists()).toBe(false);
    } finally {
      login.dispose();
      await policy.dispose();
      rmSync(home, { recursive: true });
    }
  });

  test("a provider outside the effective selection is refused even when its installed flow exists", async () => {
    const chatgpt = providerLoginFlow("chatgpt");
    expect(chatgpt?.flow).toBe("browser");
    if (chatgpt === undefined) throw new Error("expected the installed ChatGPT flow");
    const login = service([], new Map([["chatgpt", chatgpt]]));
    for (const id of ["github_copilot", "chatgpt"]) {
      const result = await login.login({ providerId: id });
      expect(result.kind).toBe("unsupported");
    }
    login.dispose();
  });

  test("an api-key provider still asks for the key when reconnecting", async () => {
    // The instance says which account; it does not supply the secret, and a
    // reconnect that skipped the prompt would have nothing to store.
    const login = service([provider({ providerId: "anthropic", loginMethod: "api-key", accounts: [account("one")] })]);
    const result = await login.login({ providerId: "anthropic", instanceId: "one" });
    expect(result.kind).toBe("needs_key");
    login.dispose();
  });

});

describe("auth login flow registration", () => {
  test("an oauth provider without a registered flow is unsupported, not guessed", async () => {
    const login = service([provider()]);
    const result = await login.login({ providerId: "github_copilot" });
    expect(result.kind).toBe("unsupported");
    login.dispose();
  });

  test("a known account routes to the registered reconnect, a new one to login", async () => {
    const calls: string[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => {
        calls.push("login");
        ports.onUserCode?.({ userCode: "CODE-1", url: "https://example.invalid/device" });
        return testAuthContext();
      },
      reconnect: async (instanceId, ports) => {
        calls.push(`reconnect:${instanceId}`);
        ports.onUserCode?.({ userCode: "CODE-2", url: "https://example.invalid/device" });
        return true;
      },
    };
    const flows = new Map([["github_copilot", flow]]);
    const login = service([provider({ accounts: [account("one")] })], flows);

    const reconnected = await login.login({ providerId: "github_copilot", instanceId: "one" });
    expect(reconnected).toMatchObject({ kind: "device_code", userCode: "CODE-2" });

    const added = await login.login({ providerId: "github_copilot" });
    expect(added).toMatchObject({ kind: "device_code", userCode: "CODE-1" });

    expect(calls).toEqual(["reconnect:one", "login"]);
    login.dispose();
  });

  test("a device flow whose link carries the code answers without a code", async () => {
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => {
        ports.onUserCode?.({ url: "https://example.invalid/device?user_code=CODE" });
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service([provider({ accounts: [] })], new Map([["github_copilot", flow]]));
    const result = await login.login({ providerId: "github_copilot" });
    expect(result).toEqual({ kind: "device_code", operationId: expect.any(String), providerId: "github_copilot", verificationUri: "https://example.invalid/device?user_code=CODE" });
    login.dispose();
  });

  test("a browser flow answers with the authorize URL its registration reports", async () => {
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (ports) => {
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/authorize" });
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service(
      [provider({ providerId: "chatgpt", loginMethod: "browser-auth" })],
      new Map([["chatgpt", flow]]),
    );
    const result = await login.login({ providerId: "chatgpt" });
    expect(result).toMatchObject({ kind: "browser", authorizeUri: "https://example.invalid/authorize" });
    login.dispose();
  });

  test("a browser flow accepts completion only for its active operation", async () => {
    const completed = Promise.withResolvers<string>();
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (ports) => {
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/authorize" });
        const input = await ports.onManualCodeInput?.();
        if (input === undefined) throw new Error("manual completion is unavailable");
        completed.resolve(input);
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service(
      [provider({ providerId: "chatgpt", loginMethod: "browser-auth" })],
      new Map([["chatgpt", flow]]),
    );

    const result = await login.login({ providerId: "chatgpt" });
    if (result.kind !== "browser") throw new Error(`Expected browser login, got ${result.kind}`);
    expect(login.completeBrowserLogin("stale-operation", Redacted.make("stale-code"))).toBe(false);
    expect(login.completeBrowserLogin(result.operationId, Redacted.make("http://localhost/auth/callback?code=fresh-code"))).toBe(true);
    expect(login.completeBrowserLogin(result.operationId, Redacted.make("duplicate-code"))).toBe(false);
    expect(await completed.promise).toBe("http://localhost/auth/callback?code=fresh-code");
    login.dispose();
  });

  test("a browser failure after the URL answer settles the exact operation", async () => {
    const published = Promise.withResolvers<AuthOperationNotice>();
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      async login(ports) {
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/authorize" });
        await ports.onManualCodeInput?.();
        throw new Error("OAuth state mismatch");
      },
      async reconnect(_instanceId, ports) { await this.login(ports); return true; },
    };
    const login = service(
      [provider({ providerId: "chatgpt", loginMethod: "browser-auth" })],
      new Map([["chatgpt", flow]]),
      async (settlement) => {
        if (settlement !== undefined) published.resolve(settlement);
      },
    );

    const result = await login.login({ providerId: "chatgpt" });
    if (result.kind !== "browser") throw new Error(`Expected browser login, got ${result.kind}`);
    expect(login.completeBrowserLogin(result.operationId, Redacted.make("wrong-state"))).toBe(true);
    expect(await published.promise).toEqual({
      kind: "failed",
      operationId: result.operationId,
      providerId: "chatgpt",
      message: "OAuth state mismatch",
    });
    login.dispose();
  });

  test("a default profile change settles an active login before switching", async () => {
    const order: string[] = [];
    const authLogin: AuthLoginService = {
      decline: async () => {},
      login: async () => ({ kind: "completed", providerId: "chatgpt" }),
      answerPrompt: async (providerId) => ({ kind: "ignored", providerId }),
      completeBrowserLogin: () => false,
      async cancel(reason) { order.push(`cancel:${reason}`); },
      disconnect: async () => {},
      rename: async () => {},
      dispose() {},
    };
    const authProfiles = {
      async previewDelete() { throw new Error("unexpected deletion preview"); },
      async mutate() { order.push("select"); return { id: "work" }; },
      async refresh() {},
      async settle() {},
    };

    await dispatchAuthMutation(
      { authLogin, authProfileSelection: authProfiles },
      { type: "auth.profile.select", scope: { kind: "defaults" }, id: "work" },
    );

    expect(order).toEqual(["cancel:Authentication stopped because the auth profile changed.", "select"]);
  });

  test("a registered flow that fails before reporting anything still answers", async () => {
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async () => { throw new Error("device endpoint unreachable"); },
      reconnect: async () => true,
    };
    const login = service([provider()], new Map([["github_copilot", flow]]));
    const result = await login.login({ providerId: "github_copilot" });
    expect(result).toMatchObject({ kind: "failed", message: "device endpoint unreachable" });
    login.dispose();
  });

  test("a completed OAuth reconnect publishes its end once", async () => {
    const published = Promise.withResolvers<void>();
    let refreshes = 0;
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async () => testAuthContext(),
      reconnect: async (_instanceId, ports) => {
        ports.onUserCode?.({ userCode: "CODE", url: "https://example.invalid/device" });
        return true;
      },
    };
    const login = service(
      [provider({ accounts: [account("one")] })],
      new Map([["github_copilot", flow]]),
      async (settlement) => {
        expect(settlement).toMatchObject({ kind: "completed", providerId: "github_copilot" });
        refreshes += 1;
        published.resolve();
      },
    );

    expect(await login.login({ providerId: "github_copilot", instanceId: "one" })).toMatchObject({ kind: "device_code" });
    await published.promise;
    expect(refreshes).toBe(1);
    login.dispose();
  });

  test("a protocol API key is stored in the selected remote profile and settles once", async () => {
    const home = mkdtempSync(join(tmpdir(), "flywheel-login-count-"));
    const directory = join(home, ".flywheel", "auth", "profiles", "work");
    mkdirSync(directory, { recursive: true });
    let settlements = 0;
    let refreshes = 0;
    const login = service(
      [provider({ providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, loginMethod: "api-key" })],
      new Map(),
      async () => { refreshes += 1; },
      directory,
      async () => { settlements += 1; },
    );
    try {
      const mutation = Schema.decodeUnknownSync(FrontendMutationSchema)({
        type: "auth.login",
        providerId: "anthropic_api",
        apiKey: "sk-ant-valid",
      });
      if (mutation.type !== "auth.login") throw new Error(`Decoded the wrong mutation: ${mutation.type}`);
      expect(await login.login(mutation)).toMatchObject({ kind: "completed" });
      expect(await Bun.file(join(directory, "auth.json")).text()).toContain("sk-ant-valid");
      expect(settlements).toBe(1);
      expect(refreshes).toBe(0);
    } finally {
      login.dispose();
      rmSync(home, { recursive: true });
    }
  });
});
