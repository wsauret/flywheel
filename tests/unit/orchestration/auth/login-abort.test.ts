import { describe, expect, it, mock } from "bun:test";
import { Redacted } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendCredentialInstanceWithReceipt } from "../../../../src/infra/auth/store/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/store/auth-store.js";
import { isCredentialCollection } from "../../../../src/infra/auth/store/auth-store-types.js";
import type { AccessProviderDefinition, DeviceCodeLoginPorts, OAuthLoginResult } from "../../../../src/infra/llm/access-provider.js";
import type { SubscriptionUsageReader } from "../../../../src/infra/llm/subscription-usage.js";
import { providerLoginFlow, type ProviderOAuthLogin } from "../../../../src/orchestration/auth/auth-actions.js";
import { chatgptModule } from "../../../../src/orchestration/modules/provider-chatgpt/module.js";
import { githubCopilotModule } from "../../../../src/orchestration/modules/provider-github-copilot/module.js";
import { supergrokModule } from "../../../../src/orchestration/modules/provider-supergrok/module.js";
import type { FirstPartyModule } from "../../../../src/orchestration/modules.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
import { FREE_PLAN_REPLACE_QUESTION } from "../../../../src/infra/llm/free-plan-accounts.js";
import { createUsageAuthority } from "../../../../src/infra/llm/usage-authority.js";
import { installedCredentialSlotClassifier } from "../../../../src/orchestration/credential-provider-modules.js";

// Each login runs a shipped provider definition whose round trip with the
// provider is replaced, through the flow that clients call, against a real
// auth store.

type OAuthDefinition = AccessProviderDefinition & { readonly auth: { readonly kind: "oauth" } };
type Start = (ports: Pick<DeviceCodeLoginPorts, "previous">) => Promise<OAuthLoginResult>;

function declaresOAuth(definition: AccessProviderDefinition): definition is OAuthDefinition {
  return definition.auth.kind === "oauth";
}

/** The OAuth definition a provider module contributes; the generic login is
 *  exercised against the shipped definitions, never a provider-named action. */
function oauthDefinition(module: FirstPartyModule): OAuthDefinition {
  const definition = module.contributions.find((contribution) => contribution.domain === "providers")?.value.definition;
  if (definition === undefined || !declaresOAuth(definition)) throw new Error(`${module.id} declares no OAuth provider`);
  return definition;
}

/** A usage reader that reads no plan, for a login that the free-plan rule does not decide. */
const unreadUsage: SubscriptionUsageReader = async () => ({ kind: "fetch-failure" });

/** The login flow of `module`'s provider, whose round trip with the provider answers `start`. */
function flowOf(module: FirstPartyModule, start: Start, readUsage: SubscriptionUsageReader = unreadUsage): ProviderOAuthLogin {
  const definition = oauthDefinition(module);
  const flow = providerLoginFlow(definition.id, [{ definition: { ...definition, auth: { ...definition.auth, start } }, usageReader: readUsage }]);
  if (flow === undefined) throw new Error(`${module.id} answers no login flow`);
  return flow;
}

const copilotResult = { identity: "test-user", credential: { type: "oauth", access: Redacted.make("cop_test"), refresh: Redacted.make("gho_test"), expires: Date.now() + 60_000 } } as const;
const chatgptResult = { identity: "acct_1", credential: { type: "oauth", access: Redacted.make("at_test"), refresh: Redacted.make("rt_test"), expires: Date.now() + 60_000, accountId: "acct_1" } } as const;
const supergrokResult = { identity: "test@example.com", credential: { type: "oauth", access: Redacted.make("xat_test"), refresh: Redacted.make("xrt_test"), expires: Date.now() + 60_000 } } as const;

const temporaryDirectory = temporaryDirectories();
// The auth store creates `profile-locks` beside the auth directory, so the
// auth directory is one level inside the temporary directory that the
// cleanup removes.
const makeAuthDir = (prefix: string): string => {
  const dir = join(temporaryDirectory(prefix), "profile");
  mkdirSync(dir);
  return dir;
};
const optionsFor = (authDir: string) => ({
  authDir,
  profileId: "work",
  resolveKey: async () => undefined,
  openBrowser: async () => true,
  settle: async () => {},
  launcher: refusingLauncher,
});
const storedAccounts = (authDir: string, providerId: string): readonly { readonly id: string; readonly identity: string; readonly credential: unknown }[] => {
  const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, installedCredentialSlotClassifier()).store[providerId];
  return isCredentialCollection(credentials) ? credentials.map(({ id, identity, credential }) => ({ id, identity, credential })) : [];
};
const storedIdentities = (authDir: string, providerId: string): readonly string[] => storedAccounts(authDir, providerId).map(({ identity }) => identity);

describe("oauth login abort", () => {
  it("a device-code login does not write the credential when cancelled", async () => {
    const authDir = makeAuthDir("login-abort-");
    const controller = new AbortController();
    controller.abort();
    await expect(flowOf(githubCopilotModule, async () => copilotResult).login({ ...optionsFor(authDir), signal: controller.signal })).rejects.toThrow("Login cancelled");
    expect(storedAccounts(authDir, "github_copilot")).toEqual([]);
  });

  it("returns the committed login when cancellation arrives after the credential is stored", async () => {
    const authDir = makeAuthDir("login-abort-");
    const controller = new AbortController();
    const settle = async () => { controller.abort(); };

    await expect(flowOf(chatgptModule, async () => chatgptResult).login({ ...optionsFor(authDir), settle, signal: controller.signal })).resolves.toBeDefined();
    expect(storedIdentities(authDir, "chatgpt")).toEqual(["acct_1"]);
  });

  it("settles the catalog only after credential commit", async () => {
    const authDir = makeAuthDir("login-abort-");
    const storedAtSettlement: (readonly string[])[] = [];
    const settle = async () => { storedAtSettlement.push(storedIdentities(authDir, "chatgpt")); };

    await flowOf(chatgptModule, async () => chatgptResult).login({ ...optionsFor(authDir), settle });

    expect(storedAtSettlement).toEqual([["acct_1"]]);
  });

  it("does not settle the catalog before credential commit", async () => {
    const authDir = makeAuthDir("login-abort-");
    const controller = new AbortController();
    const settle = mock(async () => {});
    await expect(flowOf(chatgptModule, async () => { controller.abort(); return chatgptResult; }).login({ ...optionsFor(authDir), settle, signal: controller.signal })).rejects.toThrow("Login cancelled");
    expect(settle).not.toHaveBeenCalled();
    expect(storedAccounts(authDir, "chatgpt")).toEqual([]);
  });

  it("a second device-code provider writes its own credential id from the same login", async () => {
    const authDir = makeAuthDir("login-abort-");
    await flowOf(supergrokModule, async () => supergrokResult).login(optionsFor(authDir));
    const accounts = storedAccounts(authDir, "supergrok");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.credential).toMatchObject({ type: "oauth", access: "xat_test", refresh: "xrt_test" });
  });
});

describe("OAuth reconnect identity", () => {
  const slots = (providerId: string): "subscription" | "metered" => providerId === "github_copilot" ? "subscription" : "metered";
  const original = { type: "oauth" as const, access: "gho_old", refresh: "cop_old", expires: 1 };
  const id = "12345678-0000-0000-0000-000000000000";

  it("replaces the selected account's credential and the identity the flow reports", async () => {
    const authDir = makeAuthDir("copilot-reconnect-test-");
    await appendCredentialInstanceWithReceipt("github_copilot", { id, identity: "old-account", credential: original }, authDir, slots);

    const replaced = await flowOf(githubCopilotModule, async () => ({ ...copilotResult, identity: "alice" })).reconnect(id, optionsFor(authDir));
    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;

    expect(replaced).toBe(true);
    expect(isCredentialCollection(credentials) ? credentials[0]?.identity : undefined).toBe("alice");
    expect(isCredentialCollection(credentials) ? credentials[0]?.credential : undefined).toMatchObject({ access: "cop_test", refresh: "gho_test" });
  });

  it("keeps the stored identity when the flow reports none", async () => {
    const authDir = makeAuthDir("copilot-reconnect-test-");
    await appendCredentialInstanceWithReceipt("github_copilot", { id, identity: "alice", credential: original }, authDir, slots);

    const replaced = await flowOf(githubCopilotModule, async () => ({ credential: copilotResult.credential })).reconnect(id, optionsFor(authDir));
    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;

    expect(replaced).toBe(true);
    expect(isCredentialCollection(credentials) ? credentials[0]?.identity : undefined).toBe("alice");
    expect(isCredentialCollection(credentials) ? credentials[0]?.credential : undefined).toMatchObject({ access: "cop_test", refresh: "gho_test" });
  });

  it("hands the previous credential to the flow so a reconnect keeps its enterprise domain", async () => {
    const authDir = makeAuthDir("copilot-reconnect-test-");
    await appendCredentialInstanceWithReceipt("github_copilot", { id, identity: "alice", credential: { ...original, enterpriseDomain: "company.ghe.com" } }, authDir, slots);
    let previousDomain: string | undefined;

    await flowOf(githubCopilotModule, async (ports) => { previousDomain = ports.previous?.enterpriseDomain; return copilotResult; }).reconnect(id, optionsFor(authDir));

    expect(previousDomain).toBe("company.ghe.com");
  });

  it("restores the old OAuth identity, label, and credential when settlement rejects", async () => {
    const authDir = makeAuthDir("copilot-reconnect-test-");
    await appendCredentialInstanceWithReceipt("github_copilot", { id, identity: "old-account", label: "Work", credential: original }, authDir, slots);
    const before = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;
    const previous = isCredentialCollection(before) ? before[0] : undefined;

    await expect(flowOf(githubCopilotModule, async () => ({ ...copilotResult, identity: "new-account" })).reconnect(id, {
      ...optionsFor(authDir),
      settle: async () => { throw new Error("catalog rejected"); },
    })).rejects.toThrow("catalog rejected");

    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;
    expect(isCredentialCollection(credentials) ? credentials[0] : undefined).toEqual(previous);
  });
});

describe("free-plan sign-in (PI-MODEL-069)", () => {
  const makeFreePlanAuthDir = (): string => makeAuthDir("free-plan-login-test-");
  const storeCredential = (authDir: string, id: string, identity: string) =>
    appendCredentialInstanceWithReceipt("chatgpt", { id, identity, credential: { type: "oauth", access: "at_stored", refresh: "rt_stored", expires: Date.now() + 60_000 } }, authDir, installedCredentialSlotClassifier());
  const withAuthority = <T>(authDir: string, use: (authority: ReturnType<typeof createUsageAuthority>) => T): T => {
    const authority = createUsageAuthority({ profileDir: authDir, profileId: "work" });
    try { return use(authority); } finally { authority.dispose(); }
  };
  /** Stores a ChatGPT account and the plan that the last usage reading of its identity named. */
  const storeAccount = async (authDir: string, id: string, identity: string, plan: string): Promise<void> => {
    await storeCredential(authDir, id, identity);
    withAuthority(authDir, (authority) => authority.record({ providerId: "chatgpt", instanceId: id, identity, plan, providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] }));
  };
  const chatgptIdentities = (authDir: string): readonly string[] => storedIdentities(authDir, "chatgpt");
  /** A usage reader that reads `plans[identity]`, and fails for an identity it does not name. */
  const usageReader = (plans: { readonly [identity: string]: string | null }) => mock<SubscriptionUsageReader>(async ({ account }) => {
    const plan = account.identity === undefined ? undefined : plans[account.identity];
    if (plan === undefined) return { kind: "fetch-failure" };
    return { kind: "success", report: { providerId: "chatgpt", instanceId: account.instanceId, identity: account.identity ?? "", ...(plan === null ? {} : { plan }), providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] } };
  });
  const signIn = (authDir: string, readUsage: SubscriptionUsageReader, confirmReplace?: (question: string) => Promise<boolean>) =>
    flowOf(chatgptModule, async () => ({ ...chatgptResult, identity: "new@example.com" }), readUsage).login({
      ...optionsFor(authDir), ...(confirmReplace === undefined ? {} : { confirmReplace }),
    });

  it("refuses a free-plan account beside another account of its provider and stores nothing", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000001", "paid@example.com", "pro");

    await expect(signIn(authDir, usageReader({ "new@example.com": "free" }))).rejects.toThrow("free plan");
    expect(chatgptIdentities(authDir)).toEqual(["paid@example.com"]);
  });

  it("refuses an account whose plan cannot be read beside another account, and stores nothing", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000005", "paid@example.com", "pro");

    await expect(signIn(authDir, usageReader({}))).rejects.toThrow("could not read the plan");
    expect(chatgptIdentities(authDir)).toEqual(["paid@example.com"]);
  });

  it("stores a free-plan account that is the provider's only account, and saves its plan for the serving rule", async () => {
    const authDir = makeFreePlanAuthDir();
    await signIn(authDir, usageReader({ "new@example.com": "guest" }));
    const [stored] = storedAccounts(authDir, "chatgpt");
    expect(stored?.identity).toBe("new@example.com");
    expect(withAuthority(authDir, (authority) => authority.current({ providerId: "chatgpt", instanceId: stored?.id ?? "", identity: "new@example.com" })?.plan)).toBe("guest");
  });

  it("asks before a paid account replaces the free-plan account, and a confirmation replaces it", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000002", "free@example.com", "free");
    const questions: string[] = [];

    await signIn(authDir, usageReader({ "new@example.com": "plus" }), async (question) => { questions.push(question); return true; });

    expect(questions).toEqual([FREE_PLAN_REPLACE_QUESTION]);
    expect(FREE_PLAN_REPLACE_QUESTION).toBe("This will replace your attached free subscription because we only allow multiple copies of paid subscriptions.");
    expect(chatgptIdentities(authDir)).toEqual(["new@example.com"]);
  });

  it("reads the plan of a stored account that no saved reading names before it decides", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeCredential(authDir, "11111111-0000-4000-8000-000000000006", "free@example.com");
    const questions: string[] = [];

    await signIn(authDir, usageReader({ "new@example.com": "plus", "free@example.com": "free" }), async (question) => { questions.push(question); return true; });

    expect(questions).toEqual([FREE_PLAN_REPLACE_QUESTION]);
    expect(chatgptIdentities(authDir)).toEqual(["new@example.com"]);
  });

  it("does not take the plan of another identity that the same account held before", async () => {
    const authDir = makeFreePlanAuthDir();
    const id = "11111111-0000-4000-8000-000000000007";
    withAuthority(authDir, (authority) => authority.record({ providerId: "chatgpt", instanceId: id, identity: "old@example.com", plan: "free", providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] }));
    await storeCredential(authDir, id, "reconnected@example.com");
    const confirmReplace = mock(async () => true);

    await signIn(authDir, usageReader({ "new@example.com": "plus", "reconnected@example.com": "pro" }), confirmReplace);

    expect(confirmReplace).not.toHaveBeenCalled();
    expect(chatgptIdentities(authDir).toSorted()).toEqual(["new@example.com", "reconnected@example.com"]);
  });

  it("stores nothing when the person declines the replacement", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000003", "free@example.com", "free");

    await expect(signIn(authDir, usageReader({ "new@example.com": "plus" }), async () => false)).rejects.toThrow("Nothing was stored");
    expect(chatgptIdentities(authDir)).toEqual(["free@example.com"]);
  });

  it("refuses a confirmed replacement when the accounts changed while the question was open, and deletes nothing", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000008", "free@example.com", "free");

    await expect(signIn(authDir, usageReader({ "new@example.com": "plus" }), async () => {
      await storeCredential(authDir, "11111111-0000-4000-8000-000000000009", "other@example.com");
      return true;
    })).rejects.toThrow("changed during the sign-in");
    expect(chatgptIdentities(authDir)).toEqual(["free@example.com", "other@example.com"]);
  });

  it("adds a paid account beside a paid account without asking, and a reading that names no plan counts as paid", async () => {
    const authDir = makeFreePlanAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000004", "paid@example.com", "pro");
    const confirmReplace = mock(async () => true);

    await signIn(authDir, usageReader({ "new@example.com": null }), confirmReplace);

    expect(confirmReplace).not.toHaveBeenCalled();
    expect(chatgptIdentities(authDir).toSorted()).toEqual(["new@example.com", "paid@example.com"]);
  });
});
