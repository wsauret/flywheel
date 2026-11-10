import { describe, expect, it } from "bun:test";
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import { Effect, Exit, Scope } from "effect";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { ProviderRuntimeCache } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js";
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

  it("reuses a client only for the same composition, auth, eligibility, and routing key", async () => {
    const cache = new ProviderRuntimeCache<object>();
    // Composition is one value per disabled set, so a different composition
    // is a different selection, not a second call.
    const firstComposition = composeFirstPartyModules();
    const secondComposition = composeFirstPartyModules(undefined, ["provider-chatgpt"]);
    const firstAuthGeneration = {};
    const secondAuthGeneration = {};
    const firstEligibility = {};
    const secondEligibility = {};
    let constructions = 0;
    const build = async (): Promise<object> => ({ construction: ++constructions });

    const first = await cache.resolve(firstComposition, firstAuthGeneration, "model-a", build, { lifetime: testProviderSessionLifetime(), eligibilityGeneration: firstEligibility });
    const reused = await cache.resolve(firstComposition, firstAuthGeneration, "model-a", build, { lifetime: testProviderSessionLifetime(), eligibilityGeneration: firstEligibility });
    const reeligible = await cache.resolve(firstComposition, firstAuthGeneration, "model-a", build, { lifetime: testProviderSessionLifetime(), eligibilityGeneration: secondEligibility });
    const recomposed = await cache.resolve(secondComposition, firstAuthGeneration, "model-a", build, { lifetime: testProviderSessionLifetime(), eligibilityGeneration: secondEligibility });
    const reauthenticated = await cache.resolve(firstComposition, secondAuthGeneration, "model-a", build, { lifetime: testProviderSessionLifetime(), eligibilityGeneration: secondEligibility });

    expect(reused).toBe(first);
    expect(reeligible).not.toBe(first);
    expect(recomposed).not.toBe(first);
    expect(reauthenticated).not.toBe(first);
    expect(constructions).toBe(4);
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
