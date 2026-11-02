import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Redacted } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js";
import { appendCredentialInstance } from "../../../../src/infra/auth/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import { isCredentialCollection } from "../../../../src/infra/auth/auth-store-types.js";
import type { AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import { loginWithOAuth, reconnectWithOAuth } from "../../../../src/orchestration/auth/auth-actions.js";
import { chatgptModule } from "../../../../src/orchestration/modules/provider-chatgpt/module.js";
import { githubCopilotModule } from "../../../../src/orchestration/modules/provider-github-copilot/module.js";
import { supergrokModule } from "../../../../src/orchestration/modules/provider-supergrok/module.js";
import type { FirstPartyModule } from "../../../../src/orchestration/modules.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";
import { FREE_PLAN_REPLACE_QUESTION } from "../../../../src/infra/llm/free-plan-accounts.js";
import { createUsageAuthority } from "../../../../src/infra/llm/usage-authority.js";
import { installedCredentialSlotClassifier } from "../../../../src/orchestration/credential-provider-modules.js";

// Injected deps, not mock.module: other test files replace the auth-actions
// module wholesale for the TUI hook, and bun module mocks leak across files in
// a shard, so these tests must not depend on module-registry state.

type LoginDeps = Required<NonNullable<Parameters<typeof loginWithOAuth>[2]>>;
type OAuthDefinition = Parameters<typeof loginWithOAuth>[0];

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

const copilot = oauthDefinition(githubCopilotModule);
const chatgpt = oauthDefinition(chatgptModule);
const supergrok = oauthDefinition(supergrokModule);

const AUTH_CONTEXT: AuthContext = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
};
const receipt = { providerId: "chatgpt", before: undefined, after: [] };
const persist = mock<LoginDeps["persist"]>(async () => ({ instanceId: "test-instance", persisted: true, receipt }));
const resolve = mock(async (): Promise<AuthContext> => AUTH_CONTEXT);
/** A usage reader that reads no plan, for a login that the free-plan rule does not decide. */
const unreadUsage: LoginDeps["readUsage"] = async () => ({ kind: "fetch-failure" });
const loginOptions = {
  authDir: "/scratch/flywheel-login-abort-test/auth",
  profileId: "work",
  resolveKey: async () => undefined,
  openBrowser: async () => true,
  settle: async () => {},
  launcher: refusingLauncher,
};

const copilotResult = { identity: "test-user", credential: { type: "oauth", access: Redacted.make("cop_test"), refresh: Redacted.make("gho_test"), expires: Date.now() + 60_000 } } as const;
const chatgptResult = { identity: "acct_1", credential: { type: "oauth", access: Redacted.make("at_test"), refresh: Redacted.make("rt_test"), expires: Date.now() + 60_000, accountId: "acct_1" } } as const;
const supergrokResult = { identity: "test@example.com", credential: { type: "oauth", access: Redacted.make("xat_test"), refresh: Redacted.make("xrt_test"), expires: Date.now() + 60_000 } } as const;

describe("oauth login abort", () => {
  beforeEach(() => {
    persist.mockClear();
    resolve.mockClear();
  });

  it("a device-code login does not write the credential when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loginWithOAuth(copilot, { ...loginOptions, signal: controller.signal }, { start: async () => copilotResult, persist, resolve, readUsage: unreadUsage }),
    ).rejects.toThrow("Login cancelled");
    expect(persist).not.toHaveBeenCalled();
  });

  it("returns the committed login when cancellation arrives during persistence", async () => {
    const controller = new AbortController();
    const commitThenAbort: LoginDeps["persist"] = async () => {
      controller.abort();
      return { instanceId: "test-instance", persisted: true, receipt };
    };

    await expect(loginWithOAuth(chatgpt, { ...loginOptions, signal: controller.signal }, { start: async () => chatgptResult, persist: commitThenAbort, resolve, readUsage: unreadUsage })).resolves.toEqual(AUTH_CONTEXT);
  });

  it("settles the catalog only after credential commit", async () => {
    const events: string[] = [];
    const orderedPersist: LoginDeps["persist"] = async () => {
      events.push("credential");
      return { instanceId: "test-instance", persisted: true, receipt };
    };
    const settle: NonNullable<LoginDeps["settle"]> = async () => {
      events.push("catalog");
    };

    await loginWithOAuth(chatgpt, loginOptions, { start: async () => chatgptResult, persist: orderedPersist, resolve, settle, readUsage: unreadUsage });

    expect(events).toEqual(["credential", "catalog"]);
  });

  it("does not settle the catalog before credential commit", async () => {
    const controller = new AbortController();
    const settle = mock(async () => {});
    await expect(loginWithOAuth(chatgpt, { ...loginOptions, signal: controller.signal }, {
      start: async () => { controller.abort(); return chatgptResult; },
      persist,
      resolve,
      settle,
    })).rejects.toThrow("Login cancelled");
    expect(settle).not.toHaveBeenCalled();
  });

  it("a second device-code provider writes its own credential id from the same login", async () => {
    await loginWithOAuth(supergrok, loginOptions, { start: async () => supergrokResult, persist, resolve });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]?.[0]).toBe("supergrok");
    expect(persist.mock.calls[0]?.[1]).toMatchObject({ type: "oauth", access: "xat_test", refresh: "xrt_test" });
  });
});

describe("OAuth reconnect identity", () => {
  const temporaryDirectory = temporaryDirectories();
  // The auth store creates `profile-locks` beside the auth directory, so the
  // auth directory is one level inside the temporary directory that the
  // cleanup removes.
  const makeAuthDir = (): string => {
    const dir = join(temporaryDirectory("copilot-reconnect-test-"), "profile");
    mkdirSync(dir);
    return dir;
  };
  const slots = (providerId: string): "subscription" | "metered" => providerId === "github_copilot" ? "subscription" : "metered";
  const resolveKey = async () => undefined;
  const openBrowser = async () => true;
  const original = { type: "oauth" as const, access: "gho_old", refresh: "cop_old", expires: 1 };
  const id = "12345678-0000-0000-0000-000000000000";

  it("replaces the selected account's credential and the identity the flow reports", async () => {
    const authDir = makeAuthDir();
    await appendCredentialInstance("github_copilot", { id, identity: "old-account", credential: original }, authDir, slots);

    const replaced = await reconnectWithOAuth(copilot, id, { authDir, profileId: "work", resolveKey, openBrowser, settle: async () => {}, launcher: refusingLauncher }, { start: async () => ({ ...copilotResult, identity: "alice" }), resolve });
    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;

    expect(replaced).toBe(true);
    expect(isCredentialCollection(credentials) ? credentials[0]?.identity : undefined).toBe("alice");
    expect(isCredentialCollection(credentials) ? credentials[0]?.credential : undefined).toMatchObject({ access: "cop_test", refresh: "gho_test" });
  });

  it("keeps the stored identity when the flow reports none", async () => {
    const authDir = makeAuthDir();
    await appendCredentialInstance("github_copilot", { id, identity: "alice", credential: original }, authDir, slots);

    const replaced = await reconnectWithOAuth(copilot, id, { authDir, profileId: "work", resolveKey, openBrowser, settle: async () => {}, launcher: refusingLauncher }, { start: async () => ({ credential: copilotResult.credential }), resolve });
    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;

    expect(replaced).toBe(true);
    expect(isCredentialCollection(credentials) ? credentials[0]?.identity : undefined).toBe("alice");
    expect(isCredentialCollection(credentials) ? credentials[0]?.credential : undefined).toMatchObject({ access: "cop_test", refresh: "gho_test" });
  });

  it("hands the previous credential to the flow so a reconnect keeps its enterprise domain", async () => {
    const authDir = makeAuthDir();
    await appendCredentialInstance("github_copilot", { id, identity: "alice", credential: { ...original, enterpriseDomain: "company.ghe.com" } }, authDir, slots);
    let previousDomain: string | undefined;

    await reconnectWithOAuth(copilot, id, { authDir, profileId: "work", resolveKey, openBrowser, settle: async () => {}, launcher: refusingLauncher }, {
      start: async (ports) => { previousDomain = ports.previous?.enterpriseDomain; return copilotResult; },
      resolve,
    });

    expect(previousDomain).toBe("company.ghe.com");
  });

  it("restores the old OAuth identity, label, and credential when settlement rejects", async () => {
    const authDir = makeAuthDir();
    await appendCredentialInstance("github_copilot", { id, identity: "old-account", label: "Work", credential: original }, authDir, slots);
    const before = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;
    const previous = isCredentialCollection(before) ? before[0] : undefined;

    await expect(reconnectWithOAuth(copilot, id, {
      authDir,
      profileId: "work",
      resolveKey,
      openBrowser,
      settle: async () => { throw new Error("catalog rejected"); },
      launcher: refusingLauncher,
    }, { start: async () => ({ ...copilotResult, identity: "new-account" }), resolve })).rejects.toThrow("catalog rejected");

    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, slots).store.github_copilot;
    expect(isCredentialCollection(credentials) ? credentials[0] : undefined).toEqual(previous);
  });
});

describe("free-plan sign-in (PI-MODEL-038)", () => {
  const temporaryDirectory = temporaryDirectories();
  const makeAuthDir = (): string => {
    const dir = join(temporaryDirectory("free-plan-login-test-"), "profile");
    mkdirSync(dir);
    return dir;
  };
  const storeCredential = (authDir: string, id: string, identity: string) =>
    appendCredentialInstance("chatgpt", { id, identity, credential: { type: "oauth", access: "at_stored", refresh: "rt_stored", expires: Date.now() + 60_000 } }, authDir, installedCredentialSlotClassifier());
  const withAuthority = <T>(authDir: string, use: (authority: ReturnType<typeof createUsageAuthority>) => T): T => {
    const authority = createUsageAuthority({ profileDir: authDir, profileId: "work" });
    try { return use(authority); } finally { authority.dispose(); }
  };
  /** Stores a ChatGPT account and the plan that the last usage reading of its identity named. */
  const storeAccount = async (authDir: string, id: string, identity: string, plan: string): Promise<void> => {
    await storeCredential(authDir, id, identity);
    withAuthority(authDir, (authority) => authority.record({ providerId: "chatgpt", instanceId: id, identity, plan, providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] }));
  };
  const storedAccounts = (authDir: string): readonly { readonly id: string; readonly identity: string }[] => {
    const credentials = loadAuthStoreWithDiagnostics(authDir, undefined, installedCredentialSlotClassifier()).store.chatgpt;
    return isCredentialCollection(credentials) ? credentials.map(({ id, identity }) => ({ id, identity })) : [];
  };
  const storedIdentities = (authDir: string): readonly string[] => storedAccounts(authDir).map(({ identity }) => identity);
  /** A usage reader that reads `plans[identity]`, and fails for an identity it does not name. */
  const usageReader = (plans: { readonly [identity: string]: string | null }) => mock<LoginDeps["readUsage"]>(async ({ account }) => {
    const plan = account.identity === undefined ? undefined : plans[account.identity];
    if (plan === undefined) return { kind: "fetch-failure" };
    return { kind: "success", report: { providerId: "chatgpt", instanceId: account.instanceId, identity: account.identity ?? "", ...(plan === null ? {} : { plan }), providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] } };
  });
  const signIn = (authDir: string, readUsage: LoginDeps["readUsage"], confirmReplace?: (question: string) => Promise<boolean>) => loginWithOAuth(chatgpt, {
    ...loginOptions, authDir, ...(confirmReplace === undefined ? {} : { confirmReplace }),
  }, { start: async () => ({ ...chatgptResult, identity: "new@example.com" }), resolve, readUsage });

  it("refuses a free-plan account beside another account of its provider and stores nothing", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000001", "paid@example.com", "pro");

    await expect(signIn(authDir, usageReader({ "new@example.com": "free" }))).rejects.toThrow("free plan");
    expect(storedIdentities(authDir)).toEqual(["paid@example.com"]);
  });

  it("refuses an account whose plan cannot be read beside another account, and stores nothing", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000005", "paid@example.com", "pro");

    await expect(signIn(authDir, usageReader({}))).rejects.toThrow("could not read the plan");
    expect(storedIdentities(authDir)).toEqual(["paid@example.com"]);
  });

  it("stores a free-plan account that is the provider's only account, and saves its plan for the serving rule", async () => {
    const authDir = makeAuthDir();
    await signIn(authDir, usageReader({ "new@example.com": "guest" }));
    const [stored] = storedAccounts(authDir);
    expect(stored?.identity).toBe("new@example.com");
    expect(withAuthority(authDir, (authority) => authority.current({ providerId: "chatgpt", instanceId: stored?.id ?? "", identity: "new@example.com" })?.plan)).toBe("guest");
  });

  it("asks before a paid account replaces the free-plan account, and a confirmation replaces it", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000002", "free@example.com", "free");
    const questions: string[] = [];

    await signIn(authDir, usageReader({ "new@example.com": "plus" }), async (question) => { questions.push(question); return true; });

    expect(questions).toEqual([FREE_PLAN_REPLACE_QUESTION]);
    expect(FREE_PLAN_REPLACE_QUESTION).toBe("This will replace your attached free subscription because we only allow multiple copies of paid subscriptions.");
    expect(storedIdentities(authDir)).toEqual(["new@example.com"]);
  });

  it("reads the plan of a stored account that no saved reading names before it decides", async () => {
    const authDir = makeAuthDir();
    await storeCredential(authDir, "11111111-0000-4000-8000-000000000006", "free@example.com");
    const questions: string[] = [];

    await signIn(authDir, usageReader({ "new@example.com": "plus", "free@example.com": "free" }), async (question) => { questions.push(question); return true; });

    expect(questions).toEqual([FREE_PLAN_REPLACE_QUESTION]);
    expect(storedIdentities(authDir)).toEqual(["new@example.com"]);
  });

  it("does not take the plan of another identity that the same account held before", async () => {
    const authDir = makeAuthDir();
    const id = "11111111-0000-4000-8000-000000000007";
    withAuthority(authDir, (authority) => authority.record({ providerId: "chatgpt", instanceId: id, identity: "old@example.com", plan: "free", providerStatus: "ok", observedAtMs: Date.now(), metrics: [], spendSources: [] }));
    await storeCredential(authDir, id, "reconnected@example.com");
    const confirmReplace = mock(async () => true);

    await signIn(authDir, usageReader({ "new@example.com": "plus", "reconnected@example.com": "pro" }), confirmReplace);

    expect(confirmReplace).not.toHaveBeenCalled();
    expect(storedIdentities(authDir).toSorted()).toEqual(["new@example.com", "reconnected@example.com"]);
  });

  it("stores nothing when the person declines the replacement", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000003", "free@example.com", "free");

    await expect(signIn(authDir, usageReader({ "new@example.com": "plus" }), async () => false)).rejects.toThrow("Nothing was stored");
    expect(storedIdentities(authDir)).toEqual(["free@example.com"]);
  });

  it("refuses a confirmed replacement when the accounts changed while the question was open, and deletes nothing", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000008", "free@example.com", "free");

    await expect(signIn(authDir, usageReader({ "new@example.com": "plus" }), async () => {
      await storeCredential(authDir, "11111111-0000-4000-8000-000000000009", "other@example.com");
      return true;
    })).rejects.toThrow("changed during the sign-in");
    expect(storedIdentities(authDir)).toEqual(["free@example.com", "other@example.com"]);
  });

  it("adds a paid account beside a paid account without asking, and a reading that names no plan counts as paid", async () => {
    const authDir = makeAuthDir();
    await storeAccount(authDir, "11111111-0000-4000-8000-000000000004", "paid@example.com", "pro");
    const confirmReplace = mock(async () => true);

    await signIn(authDir, usageReader({ "new@example.com": null }), confirmReplace);

    expect(confirmReplace).not.toHaveBeenCalled();
    expect(storedIdentities(authDir).toSorted()).toEqual(["new@example.com", "paid@example.com"]);
  });
});
