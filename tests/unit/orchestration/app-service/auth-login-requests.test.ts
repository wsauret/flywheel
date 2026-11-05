import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAuthLoginService } from "../../../../src/orchestration/app-service/auth-login-service.js";
import { dispatchAuthMutation } from "../../../../src/orchestration/app-service/auth-mutations.js";
import { LoginRefusedError, type ProviderOAuthLogin } from "../../../../src/orchestration/auth/auth-actions.js";
import { defaultModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import type { AuthOperationNotice } from "../../../../src/protocol/auth-status-protocol-types.js";
import { testAuthContext } from "../../../helpers/auth-context.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
import { account, provider, service, silentLog } from "./_auth-login-service-fixtures.js";

/** What one client request asks of the runtime's login service: the profile
 *  it writes, whether the runtime opens the sign-in page, and the steps a flow
 *  answers with. Every client's credential change takes this path. */
describe("auth login requests", () => {
  test("a flow's pre-flight question is a step, and its answer gets the flow's next step", async () => {
    const answers: string[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => {
        answers.push(await ports.onPrompt?.({ message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true }) ?? "no prompt port");
        ports.onUserCode?.({ userCode: "CODE-1", url: "https://example.invalid/device" });
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service([provider()], new Map([["github_copilot", flow]]));
    const first = await login.login({ providerId: "github_copilot" });
    if (first.kind !== "prompt") throw new Error(`Expected a prompt, got ${first.kind}`);
    expect(first.prompt).toEqual({ message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true });
    expect(await login.answerPrompt("github_copilot", "stale-operation", "x")).toEqual({ kind: "ignored", providerId: "github_copilot" });
    const next = await dispatchAuthMutation({ authLogin: login }, { type: "auth.login.answer", providerId: "github_copilot", operationId: first.operationId, answer: "" });
    expect(next).toEqual({ kind: "device_code", operationId: first.operationId, providerId: "github_copilot", userCode: "CODE-1", verificationUri: "https://example.invalid/device" });
    expect(answers).toEqual([""]);
    expect(await login.answerPrompt("github_copilot", first.operationId, "again")).toMatchObject({ kind: "ignored" });
    login.dispose();
  });

  test("the runtime opens the sign-in page only for a client at its machine", async () => {
    const opened: string[] = [];
    const ports: boolean[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (browser) => {
        ports.push(browser.openBrowser !== undefined);
        void browser.openBrowser?.("https://example.invalid/authorize");
        browser.onAuthorizeUrl?.({ url: "https://example.invalid/authorize" });
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service([provider({ providerId: "chatgpt", loginMethod: "browser-auth" })], new Map([["chatgpt", flow]]), undefined, undefined, undefined, undefined, async (url) => { opened.push(url); return true; });
    expect(await login.login({ providerId: "chatgpt" })).toMatchObject({ kind: "browser" });
    expect(await login.login({ providerId: "chatgpt", openBrowser: true })).toMatchObject({ kind: "browser" });
    expect(ports).toEqual([false, true]);
    expect(opened).toEqual(["https://example.invalid/authorize"]);
    login.dispose();
  });

  test("a login, disconnect, and rename write the profile the request names and refuse one the runtime does not own", async () => {
    const home = mkdtempSync(join(tmpdir(), "flywheel-login-profile-"));
    const directories = { default: join(home, "default"), work: join(home, "work") } as const;
    for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true });
    const refreshed: string[] = [];
    const login = createAuthLoginService({
      resolveProfile: (profileId = "default") => profileId === "default" || profileId === "work" ? { id: profileId, directory: directories[profileId] } : undefined,
      resolveKey: async (value) => Redacted.make(value), launcher: refusingLauncher, openBrowser: async () => false,
      admit: async (request) => ({ ok: true, grant: { ...defaultModuleState(), ...request } }),
      providers: async () => [provider({ providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, loginMethod: "api-key" })],
      settleCatalog: () => async () => {}, refresh: async (profileId) => { refreshed.push(profileId); }, publishNotice: async () => {},
      loginFlows: () => undefined, log: silentLog,
    });
    try {
      expect(await login.login({ providerId: "anthropic_api", apiKey: Redacted.make("sk-ant-work"), profileId: "work" })).toMatchObject({ kind: "completed" });
      expect(await Bun.file(join(directories.work, "auth.json")).text()).toContain("sk-ant-work");
      expect(await Bun.file(join(directories.default, "auth.json")).exists()).toBe(false);
      expect(await login.login({ providerId: "anthropic_api", apiKey: Redacted.make("sk-ant-gone"), profileId: "gone" })).toEqual({ kind: "failed", providerId: "anthropic_api", message: "The auth profile is no longer available." });
      await login.disconnect({ providerId: "anthropic_api", profileId: "work" });
      expect(await Bun.file(join(directories.work, "auth.json")).text()).not.toContain("sk-ant-work");
      expect(refreshed).toEqual(["work"]);
      expect(await dispatchAuthMutation({ authLogin: login }, { type: "auth.account.rename", providerId: "anthropic_api", instanceId: "one", label: "Work", profileId: "gone" })).toEqual({ ok: false, error: "The auth profile is no longer available." });
    } finally {
      login.dispose();
      rmSync(home, { recursive: true });
    }
  });

  test("a reconnect whose account changed meanwhile fails instead of reporting success", async () => {
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async () => testAuthContext(),
      reconnect: async (_instanceId, ports) => {
        ports.onUserCode?.({ userCode: "CODE", url: "https://example.invalid/device" });
        return false;
      },
    };
    const published = Promise.withResolvers<AuthOperationNotice | undefined>();
    const login = service([provider({ accounts: [account("one")] })], new Map([["github_copilot", flow]]), async (settlement) => { published.resolve(settlement); });
    expect(await login.login({ providerId: "github_copilot", instanceId: "one" })).toMatchObject({ kind: "device_code" });
    expect(await published.promise).toMatchObject({ kind: "failed", message: "credentials changed before reconnect completed" });
    login.dispose();
  });

  test("a login to an account the profile already holds still ends, after the flow's progress", async () => {
    const notices: AuthOperationNotice[] = [];
    const ended = Promise.withResolvers<void>();
    const flow: ProviderOAuthLogin = {
      flow: "browser",
      login: async (ports) => {
        ports.onAuthorizeUrl?.({ url: "https://example.invalid/authorize" });
        ports.onProgress?.("Exchanging for a token...");
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const held = provider({ providerId: "anthropic_sub", loginMethod: "browser-auth", accounts: [account("one")] });
    const login = service([held], new Map([["anthropic_sub", flow]]), async (notice) => {
      if (notice === undefined) return;
      notices.push(notice);
      if (notice.kind !== "progress") ended.resolve();
    });
    const first = await login.login({ providerId: "anthropic_sub" });
    if (first.kind !== "browser") throw new Error(`Expected a browser step, got ${first.kind}`);
    await ended.promise;
    expect(notices).toEqual([
      { kind: "progress", operationId: first.operationId, providerId: "anthropic_sub", message: "Exchanging for a token..." },
      { kind: "completed", operationId: first.operationId, providerId: "anthropic_sub" },
    ]);
    login.dispose();
  });

  test("a replace question after sign-in is a notice: an answer confirms it, and a cancel ends the flow before it stores (PI-MODEL-069)", async () => {
    const replies: boolean[] = [];
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => {
        ports.onUserCode?.({ userCode: "CODE", url: "https://example.invalid/device" });
        const replace = await ports.confirmReplace?.("Replace it?");
        replies.push(replace === true);
        if (replace !== true) throw new Error("not reached");
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const notices: AuthOperationNotice[] = [];
    let asked = Promise.withResolvers<void>();
    const login = service([provider()], new Map([["github_copilot", flow]]), async (notice) => {
      if (notice === undefined) return;
      notices.push(notice);
      if (notice.kind === "confirmation") asked.resolve();
    });

    const confirmed = await login.login({ providerId: "github_copilot" });
    if (confirmed.kind !== "device_code") throw new Error(`Expected a device code, got ${confirmed.kind}`);
    await asked.promise;
    expect(notices.at(-1)).toEqual({ kind: "confirmation", operationId: confirmed.operationId, providerId: "github_copilot", message: "Replace it?" });
    expect(await dispatchAuthMutation({ authLogin: login }, { type: "auth.login.answer", providerId: "github_copilot", operationId: confirmed.operationId, answer: "confirm" })).toEqual({ kind: "completed", providerId: "github_copilot" });
    expect(replies).toEqual([true]);

    asked = Promise.withResolvers();
    const declined = await login.login({ providerId: "github_copilot" });
    if (declined.kind !== "device_code") throw new Error(`Expected a device code, got ${declined.kind}`);
    await asked.promise;
    await login.cancel(undefined, { operationId: declined.operationId });
    expect(replies).toEqual([true]);
    expect(notices.filter(({ operationId }) => operationId === declined.operationId).map(({ kind }) => kind)).toEqual(["confirmation"]);
    login.dispose();
  });

  test("a sign-in that a rule refuses settles as a refusal whose message is complete (PI-MODEL-069)", async () => {
    const refused: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => { ports.onUserCode?.({ url: "https://example.invalid/device" }); throw new LoginRefusedError("This GitHub Copilot account is on a free plan. Nothing was stored.") },
      reconnect: async () => true,
    };
    const settled = Promise.withResolvers<AuthOperationNotice>();
    const refusing = service([provider()], new Map([["github_copilot", refused]]), async (notice) => { if (notice !== undefined && notice.kind !== "progress") settled.resolve(notice); });
    expect(await refusing.login({ providerId: "github_copilot" })).toMatchObject({ kind: "device_code" });
    expect(await settled.promise).toMatchObject({ kind: "failed", refused: true, message: "This GitHub Copilot account is on a free plan. Nothing was stored." });
    refusing.dispose();
  });

  test("a completion that cannot be published is published as a failure that says why", async () => {
    const notices: AuthOperationNotice[] = [];
    const ended = Promise.withResolvers<void>();
    const flow: ProviderOAuthLogin = {
      flow: "device-code",
      login: async (ports) => {
        ports.onUserCode?.({ userCode: "CODE", url: "https://example.invalid/device" });
        return testAuthContext();
      },
      reconnect: async () => true,
    };
    const login = service([provider()], new Map([["github_copilot", flow]]), async (notice) => {
      if (notice?.kind === "completed") throw new Error("Session not found: gone");
      if (notice === undefined) return;
      notices.push(notice);
      ended.resolve();
    });
    const first = await login.login({ providerId: "github_copilot" });
    if (first.kind !== "device_code") throw new Error(`Expected a device code, got ${first.kind}`);
    await ended.promise;
    expect(notices).toEqual([{ kind: "failed", operationId: first.operationId, providerId: "github_copilot", message: "The account is saved, but Flywheel could not show it: Session not found: gone" }]);
    login.dispose();
  });
});
