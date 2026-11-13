import { describe, expect, it } from "bun:test";
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import { Effect, Exit, Scope } from "effect";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { ProviderRuntimeCache, providerRuntimeServingKey } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js";
import { captureProviderConnection, type ProviderConnection } from "../../../../src/infra/auth/auth-context.js";
import type { AdmittedFailoverPlan } from "../../../../src/infra/llm/access-provider.js";
import type { ProviderSessionLifetime } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { holdSharedTree, treeLogin, type SharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js";

describe("provider runtime cache", () => {
  it("unsubscribes exactly once when its owner disposes it", () => {
    let unsubscribeCalls = 0;
    const cache = new ProviderRuntimeCache<object>(() => () => { unsubscribeCalls += 1; });

    cache.dispose();
    cache.dispose();

    expect(unsubscribeCalls).toBe(1);
  });

  it("reuses a client only for the same composition, serving key, and routing key", async () => {
    const cache = new ProviderRuntimeCache<object>();
    // Composition is one value per disabled set, so a different composition
    // is a different selection, not a second call.
    const firstComposition = composeFirstPartyModules();
    const secondComposition = composeFirstPartyModules(undefined, ["provider-chatgpt"]);
    let constructions = 0;
    const build = async (): Promise<object> => ({ construction: ++constructions });

    const first = await cache.resolve(firstComposition, "serving-a", "model-a", build, { lifetime: testProviderSessionLifetime() });
    const reused = await cache.resolve(firstComposition, "serving-a", "model-a", build, { lifetime: testProviderSessionLifetime() });
    const recomposed = await cache.resolve(secondComposition, "serving-a", "model-a", build, { lifetime: testProviderSessionLifetime() });
    const reauthenticated = await cache.resolve(firstComposition, "serving-b", "model-a", build, { lifetime: testProviderSessionLifetime() });

    expect(reused).toBe(first);
    expect(recomposed).not.toBe(first);
    expect(reauthenticated).not.toBe(recomposed);
    expect(constructions).toBe(3);
  });

  it("keeps the client and its provider-session scope across an eligibility publication that leaves the selection unchanged, such as the listing's move from cached to live rows or an unused fallback that leaves the plan, and rebuilds it for a new login or a removed one", async () => {
    const cache = new ProviderRuntimeCache<{ readonly released: () => boolean }>();
    const runnerScope = Scope.makeUnsafe();
    const lifetime = { providerSessionKey: "conversation", scope: runnerScope };
    const composition = composeFirstPartyModules();
    const build = async (owned: ProviderSessionLifetime) => {
      let released = false;
      // A hosted Claude agent closes its task in this finalizer (cause lifetime-end).
      await Effect.runPromise(Scope.addFinalizer(owned.scope, Effect.sync(() => { released = true; })));
      return { released: () => released };
    };
    const claude = (instanceId: string) => ({ kind: "subscription", providerId: "claude_agent_sdk", instanceId, spendMode: "included" } as const);
    const connectionOf = (logins: readonly string[]) => captureProviderConnection({
      profileId: "default", authDir: "/scratch/auth", auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [], observation: "store-1" },
      subscriptionCredentials: new Map([["claude_agent_sdk", logins.map((instanceId) => ({ instanceId, lineageId: instanceId, identity: instanceId, credential: { type: "external", configDir: `/scratch/auth/claude/${instanceId}` } as const }))]]),
    });
    const openrouter = { kind: "singleton", providerId: "openrouter", spendMode: "direct_api" } as const;
    const planOf = (connection: ProviderConnection, logins: readonly string[], revision: number, catalogProvenance: "last-known-good" | "live", fallback: boolean): AdmittedFailoverPlan => {
      const attributions = logins.map((instanceId) => ({ candidate: claude(instanceId), wireModelId: "claude-haiku-5-5", dataUse: "standard", transport: "anthropic-messages", catalogProvenance, eligibilityProfileId: "default", eligibilityRevision: revision } as const));
      const candidateAttributions = fallback ? [...attributions, { candidate: openrouter, wireModelId: "anthropic/claude-haiku-5.5", dataUse: "standard", catalogProvenance, eligibilityProfileId: "default", eligibilityRevision: revision } as const] : attributions;
      return { kind: "admitted", connectionId: connection.id, model: "claude-haiku-5.5", family: "anthropic", candidates: candidateAttributions.map(({ candidate }) => candidate), candidateAttributions };
    };
    // Each admission captures a new connection and a new eligibility revision of the same account state.
    const keyOf = (logins: readonly string[], revision: number, catalogProvenance: "last-known-good" | "live" = "live", fallback = false) => {
      const connection = connectionOf(logins);
      return providerRuntimeServingKey(planOf(connection, logins, revision, catalogProvenance, fallback), connection);
    };

    // Startup admits on the cached listing; the live listing publishes the next revision.
    const first = await cache.resolve(composition, keyOf(["account-a"], 1, "last-known-good", true), "model-a", build, { lifetime });
    const republished = await cache.resolve(composition, keyOf(["account-a"], 2, "live", true), "model-a", build, { lifetime });
    expect(republished).toBe(first);
    expect(first.released()).toBe(false);

    // The fallback's listing drops the model, so the plan loses a candidate that no request used: the hosted task on
    // the primary candidate serves on.
    const narrowed = await cache.resolve(composition, keyOf(["account-a"], 3, "live", false), "model-a", build, { lifetime });
    expect(narrowed).toBe(first);
    expect(first.released()).toBe(false);

    const loggedIn = await cache.resolve(composition, keyOf(["account-a", "account-b"], 3), "model-a", build, { lifetime });
    expect(loggedIn).not.toBe(first);
    expect(first.released()).toBe(true);

    const disconnected = await cache.resolve(composition, keyOf(["account-a"], 4), "model-a", build, { lifetime });
    expect(disconnected).not.toBe(loggedIn);
    expect(loggedIn.released()).toBe(true);

    await Effect.runPromise(Scope.close(runnerScope, Exit.void));
  });

  it("the serving key follows a stored credential change through the credential store's observation", () => {
    const connectionOf = (observation: string) => captureProviderConnection({
      profileId: "default", authDir: "/scratch/auth", auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [], observation }, subscriptionCredentials: new Map(),
    });
    const keyOf = (observation: string) => {
      const connection = connectionOf(observation);
      return providerRuntimeServingKey({ model: "claude-haiku-5.5", family: "anthropic" }, connection);
    };
    expect(keyOf("store-1")).toBe(keyOf("store-1"));
    expect(keyOf("store-2")).not.toBe(keyOf("store-1"));
  });

  it("retains only the current routing generation for a composition and auth pair", async () => {
    const cache = new ProviderRuntimeCache<object>();
    const composition = composeFirstPartyModules();
    const authGeneration = {};
    let constructions = 0;
    const build = async (): Promise<object> => ({ construction: ++constructions });

    const first = await cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() });
    await cache.resolve(composition, authGeneration, "model-b", build, { lifetime: testProviderSessionLifetime() });
    const rebuilt = await cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() });

    expect(rebuilt).not.toBe(first);
    expect(constructions).toBe(3);
  });

  it("does not retain runtimes built while role resolution is unavailable", async () => {
    const cache = new ProviderRuntimeCache<object>();
    const composition = composeFirstPartyModules();
    const authGeneration = {};
    let constructions = 0;
    const build = async (): Promise<object> => ({ construction: ++constructions });

    for (let request = 0; request < 3; request += 1) {
      await cache.resolve(composition, authGeneration, "unresolved", build, { lifetime: testProviderSessionLifetime(), retain: () => false });
    }

    expect(constructions).toBe(3);
  });

  it("reuses construction while planning from current availability", async () => {
    let available = "subscription";
    let constructions = 0;
    let plans = 0;
    const cache = new ProviderRuntimeCache<{
      plannedAttempt: () => Promise<string>;
    }>();
    const composition = composeFirstPartyModules();
    const authGeneration = {};
    const build = async (): Promise<{ plannedAttempt: () => Promise<string> }> => {
      constructions += 1;
      return {
        plannedAttempt: async (): Promise<string> => {
          plans += 1;
          return available;
        },
      };
    };

    const firstRuntime = await cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() });
    const firstPlan = await firstRuntime.plannedAttempt();
    available = "api";
    const secondRuntime = await cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() });
    const secondPlan = await secondRuntime.plannedAttempt();

    expect(secondRuntime).toBe(firstRuntime);
    expect(firstPlan).toBe("subscription");
    expect(secondPlan).toBe("api");
    expect(constructions).toBe(1);
    expect(plans).toBe(2);
  });

  it("does not retain failed construction", async () => {
    const cache = new ProviderRuntimeCache<object>();
    const composition = composeFirstPartyModules();
    const authGeneration = {};
    let attempts = 0;
    const build = async (): Promise<object> => {
      attempts += 1;
      if (attempts === 1) throw new Error("construction failed");
      return {};
    };

    await expect(cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() })).rejects.toThrow("construction failed");
    await cache.resolve(composition, authGeneration, "model-a", build, { lifetime: testProviderSessionLifetime() });

    expect(attempts).toBe(2);
  });

  it("releases the provider-session resources of every client it replaces, so a toggle back builds a new client", async () => {
    const cache = new ProviderRuntimeCache<{ readonly key: string; readonly released: () => boolean }>();
    const runnerScope = Scope.makeUnsafe();
    const lifetime = { providerSessionKey: "conversation", scope: runnerScope };
    const on = composeFirstPartyModules();
    const off = composeFirstPartyModules(undefined, ["background-commands"]);
    const authGeneration = {};
    const build = async (owned: ProviderSessionLifetime) => {
      let released = false;
      await Effect.runPromise(Scope.addFinalizer(owned.scope, Effect.sync(() => { released = true; })));
      return { key: owned.providerSessionKey, released: () => released };
    };

    const first = await cache.resolve(on, authGeneration, "model-a", build, { lifetime });
    const switched = await cache.resolve(on, authGeneration, "model-b", build, { lifetime });
    expect(first.released()).toBe(true);
    expect(switched.released()).toBe(false);
    expect(switched.key).toBe("conversation");

    await cache.resolve(off, authGeneration, "model-b", build, { lifetime });
    const toggledBack = await cache.resolve(on, authGeneration, "model-b", build, { lifetime });
    expect(switched.released()).toBe(true);
    expect(toggledBack).not.toBe(switched);
    expect(toggledBack.released()).toBe(false);

    await Effect.runPromise(Scope.close(runnerScope, Exit.void));
    expect(toggledBack.released()).toBe(true);
  });
});

describe("provider runtime cache lifetimes", () => {
  it("builds the client with every field of the requested lifetime in its own scope", async () => {
    const parent = await Effect.runPromise(Scope.make());
    const cache = new ProviderRuntimeCache<object>();
    let built: ProviderSessionLifetime | undefined;
    const { tree, release } = holdSharedTree("tree-root", () => ({ modules: composeFirstPartyModules(), shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }));
    await cache.resolve(composeFirstPartyModules(), {}, "model-a", async (lifetime) => { built = lifetime; return {}; }, {
      lifetime: { providerSessionKey: "session-key", scope: parent, sharedHost: tree },
    });
    expect(built).toMatchObject({ providerSessionKey: "session-key" });
    expect(built?.sharedHost).toBe(tree);
    release();
    expect(built?.scope).not.toBe(parent);
    cache.dispose();
    await Effect.runPromise(Scope.close(parent, Exit.void));
  });

  it("rebuilds the client when the tree's last release ends its shared tree, so the client follows the live host's login", async () => {
    const parent = await Effect.runPromise(Scope.make());
    const cache = new ProviderRuntimeCache<{ readonly tree: SharedTree | undefined }>();
    const composition = composeFirstPartyModules();
    const authGeneration = {};
    const build = async (lifetime: ProviderSessionLifetime) => ({ tree: lifetime.sharedHost });
    const resolveIn = (tree: SharedTree) => cache.resolve(composition, authGeneration, "model-a", build, {
      lifetime: { providerSessionKey: "session-key", scope: parent, sharedHost: tree },
    });

    const firstHold = holdSharedTree("cache-tree-root", () => ({ modules: composition, shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }));
    const releaseFirstHost = firstHold.tree.hold("login-a");
    const first = await resolveIn(firstHold.tree);
    releaseFirstHost();
    firstHold.release();

    const secondHold = holdSharedTree("cache-tree-root", () => ({ modules: composition, shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }));
    const releaseSecondHost = secondHold.tree.hold("login-b");
    const second = await resolveIn(secondHold.tree);

    expect(second).not.toBe(first);
    expect(second.tree).toBe(secondHold.tree);
    expect(second.tree?.login).toBe(treeLogin("cache-tree-root"));
    expect(second.tree?.login).toBe("login-b");
    releaseSecondHost();
    secondHold.release();
    cache.dispose();
    await Effect.runPromise(Scope.close(parent, Exit.void));
  });
});
