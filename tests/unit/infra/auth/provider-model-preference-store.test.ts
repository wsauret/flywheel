import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { deselectAllProviderModels, prepareProviderModelPreferences, providerModelPreferencesRevision, readProviderModelPreferences, setProviderAutoEnableNewModels, setProviderFreeRoutePreference, setProviderModelPreference } from "../../../../src/infra/auth/provider-model-preference-store.js";
import { authStoreRevision } from "../../../../src/infra/auth/auth-store.js";
import { authDir } from "../../../../src/infra/paths.js";
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js";
import { groupedOfferingIndex } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

const aliases = groupedOfferingIndex([{
  modelId: "claude-fable-5.1",
  offerings: [
    { wireModelId: "anthropic/claude-fable-5-1", metadata: null, dataUse: "standard" },
    { wireModelId: "claude-fable-5-1-contributor", metadata: null, dataUse: "contributor" },
  ],
}]);
const datedAliases = groupedOfferingIndex([{
  modelId: "claude-opus-4.6",
  offerings: [
    { wireModelId: "claude-opus-4-6-20260101", metadata: null, dataUse: "standard" },
    { wireModelId: "claude-opus-4-6-2026-02-01", metadata: null, dataUse: "standard" },
  ],
}]);

describe("provider model preference store", () => {
  test("persists canonical deterministic deltas and removes the final empty file", async () => {
    const root = temporaryDirectory("model-preferences-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const accounts = [
      { kind: "singleton" as const, providerId: "openai_api" },
      { kind: "singleton" as const, providerId: "anthropic_api" },
    ];
    await setProviderModelPreference(access, accounts[0]!, " GPT-5 ", "enabled", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    await setProviderModelPreference(access, accounts[1]!, "Claude-Opus-4-6", "disabled", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    const path = join(authDir(root, "work"), "model-preferences.json");
    expect(readFileSync(path, "utf8")).toBe('{\n  "version": 4,\n  "accounts": [\n    {\n      "account": {\n        "kind": "singleton",\n        "providerId": "anthropic_api"\n      },\n      "disabled": [\n        "claude-opus-4.6"\n      ]\n    },\n    {\n      "account": {\n        "kind": "singleton",\n        "providerId": "openai_api"\n      },\n      "enabled": [\n        "gpt-5"\n      ]\n    }\n  ]\n}\n');
    await setProviderModelPreference(access, accounts[0]!, "gpt-5", "default", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    await setProviderModelPreference(access, accounts[1]!, "claude-opus-4-6", "default", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    expect(existsSync(path)).toBe(false);
    access.close();
  });

  test("migrates v2 with free routes off and persists the preference per exact account", async () => {
    const root = temporaryDirectory("model-preferences-free-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const path = join(authDir(root, "work"), "model-preferences.json");
    const openrouter = { kind: "singleton" as const, providerId: "openrouter" };
    const openai = { kind: "singleton" as const, providerId: "openai_api" };
    const accounts = [openrouter, openai];
    writeFileSync(path, '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"openrouter"},"disabled":["model"]}]}');

    const migrated = await prepareProviderModelPreferences(access, "same", accounts, () => "same", new Map());
    expect(migrated?.accounts.get(accessProviderAccountKey(openrouter))?.preferFreeRoutes).toBe(false);
    expect(readFileSync(path, "utf8")).toContain('"version": 4');

    await setProviderFreeRoutePreference(access, openrouter, true, accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    const preferences = readProviderModelPreferences(access, new Map());
    expect(preferences.accounts.get(accessProviderAccountKey(openrouter))?.preferFreeRoutes).toBe(true);
    expect(preferences.accounts.get(accessProviderAccountKey(openai))).toBeUndefined();
    access.close();
  });

  test("migrates v3 with automatic additions on and preserves explicit deselections", async () => {
    const root = temporaryDirectory("model-preferences-v3-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "singleton" as const, providerId: "openai_api" };
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":3,"accounts":[{"account":{"kind":"singleton","providerId":"openai_api"},"disabled":["gpt-5-mini"]}]}');

    const migrated = await prepareProviderModelPreferences(access, "same", [account], () => "same", new Map());

    expect(migrated?.accounts.get(accessProviderAccountKey(account))).toMatchObject({
      disabled: new Set(["gpt-5-mini"]),
    });
    expect(migrated?.autoEnableNewModels).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"version": 4');
    access.close();
  });

  test("round-trips a free-route preference without model deltas", async () => {
    const root = temporaryDirectory("model-preferences-free-only-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "singleton" as const, providerId: "openrouter" };
    const accounts = [account];

    await setProviderFreeRoutePreference(access, account, true, accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    expect(readProviderModelPreferences(access, new Map()).accounts.get(accessProviderAccountKey(account))).toMatchObject({
      enabled: new Set(),
      disabled: new Set(),
      preferFreeRoutes: true,
    });
    await prepareProviderModelPreferences(access, authStoreRevision(access), accounts, () => authStoreRevision(access), new Map());
    await setProviderFreeRoutePreference(access, account, false, accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    expect(readProviderModelPreferences(access, new Map()).accounts.size).toBe(0);
    access.close();
  });

  test("automatic additions preserve current checks when the policy changes", async () => {
    const root = temporaryDirectory("model-preferences-auto-enable-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "singleton" as const, providerId: "openai_api" };
    const accounts = [account];

    await setProviderAutoEnableNewModels(
      access,
      false,
      new Map([[accessProviderAccountKey(account), { account, effectiveModelIds: ["gpt-5"], catalogModelIds: ["gpt-5", "gpt-5-mini"] }]]),
      accounts,
      authStoreRevision(access),
      providerModelPreferencesRevision(access),
    );
    expect(readProviderModelPreferences(access, new Map()).accounts.get(accessProviderAccountKey(account))).toMatchObject({
      enabled: new Set(["gpt-5"]),
      disabled: new Set(["gpt-5-mini"]),
    });
    expect(readProviderModelPreferences(access, new Map()).autoEnableNewModels).toBe(false);

    await setProviderAutoEnableNewModels(
      access,
      true,
      new Map([[accessProviderAccountKey(account), { account, effectiveModelIds: ["gpt-5"], catalogModelIds: ["gpt-5", "gpt-5-mini"] }]]),
      accounts,
      authStoreRevision(access),
      providerModelPreferencesRevision(access),
    );
    expect(readProviderModelPreferences(access, new Map()).accounts.get(accessProviderAccountKey(account))).toMatchObject({
      enabled: new Set(),
      disabled: new Set(["gpt-5-mini"]),
    });
    expect(readProviderModelPreferences(access, new Map()).autoEnableNewModels).toBe(true);
    access.close();
  });

  test("normalizes persisted offering aliases with canonical then disabled conflict precedence", async () => {
    const root = temporaryDirectory("model-preferences-aliases-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"disabled":["claude-fable-5-1"]}]}');
    expect(readProviderModelPreferences(access, new Map([[accessProviderAccountKey({ kind: "singleton", providerId: "anthropic_api" }), aliases]])).accounts.values().next().value?.disabled).toEqual(new Set(["claude-fable-5.1"]));
    const account = { kind: "singleton" as const, providerId: "anthropic_api" };
    const indexes = new Map([[accessProviderAccountKey(account), aliases]]);
    await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes);
    expect(readFileSync(path, "utf8")).toContain('"claude-fable-5.1"');
    expect(readFileSync(path, "utf8")).not.toContain('"claude-fable-5-1"');

    writeFileSync(path, '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"enabled":["claude-fable-5-1"],"disabled":["anthropic/claude-fable-5-1"]}]}');
    expect(readProviderModelPreferences(access, indexes).accounts.get(accessProviderAccountKey(account))).toMatchObject({
      enabled: new Set(),
      disabled: new Set(["claude-fable-5.1"]),
    });
    writeFileSync(path, '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"enabled":["claude-fable-5.1"],"disabled":["claude-fable-5-1-contributor"]}]}');
    expect(readProviderModelPreferences(access, indexes).accounts.get(accessProviderAccountKey(account))).toMatchObject({
      enabled: new Set(["claude-fable-5.1"]),
      disabled: new Set(),
    });
    access.close();
  });

  test("migrates OpenCode Go choices saved under a free wire so each keeps the route it chose", async () => {
    const root = temporaryDirectory("model-preferences-free-wire-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "subscription" as const, providerId: "opencode_go", instanceId: "go" };
    const key = accessProviderAccountKey(account);
    const freeRouteModel = (modelId: string) => ({ modelId, offerings: [
      { wireModelId: modelId, metadata: null, dataUse: "standard" as const },
      { wireModelId: `${modelId}-free`, metadata: null, dataUse: "standard" as const, routeKind: "free" as const },
    ] });
    const indexes = new Map([[key, groupedOfferingIndex([
      { modelId: "beam-1.0-501b-a23b", offerings: [{ wireModelId: "beam-free", metadata: null, dataUse: "standard" }] },
      freeRouteModel("minimax-m3.1-flash"),
      freeRouteModel("glm-5.2"),
    ])]]);
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":4,"accounts":[{"account":{"kind":"subscription","providerId":"opencode_go","instanceId":"go"},"enabled":["beam-free","minimax-m3.1-flash-free"],"disabled":["glm-5.2-free"]}]}');

    const migrated = await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes);

    // The free-only wire names its model, the enabled free route keeps serving free, and the disabled free route never disabled the paid wire.
    expect(migrated?.accounts.get(key)).toEqual({ account, enabled: new Set(["beam-1.0-501b-a23b", "minimax-m3.1-flash"]), disabled: new Set(), preferFreeRoutes: true });
    expect(readFileSync(path, "utf8")).not.toMatch(/-free/);
    expect(readProviderModelPreferences(access, indexes).accounts.get(key)).toEqual(migrated?.accounts.get(key));
    access.close();
  });

  test("drops an account whose only saved choice disabled a free route", async () => {
    const root = temporaryDirectory("model-preferences-free-wire-only-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "subscription" as const, providerId: "opencode_go", instanceId: "go" };
    const key = accessProviderAccountKey(account);
    const indexes = new Map([[key, groupedOfferingIndex([{ modelId: "minimax-m3.1-flash", offerings: [
      { wireModelId: "minimax-m3.1-flash", metadata: null, dataUse: "standard" },
      { wireModelId: "minimax-m3.1-flash-free", metadata: null, dataUse: "standard", routeKind: "free" },
    ] }])]]);
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":4,"accounts":[{"account":{"kind":"subscription","providerId":"opencode_go","instanceId":"go"},"disabled":["minimax-m3.1-flash-free"]}]}');

    const migrated = await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes);

    expect(migrated?.accounts.has(key)).toBe(false);
    expect(readProviderModelPreferences(access, indexes).accounts.size).toBe(0);
    access.close();
  });

  test("migrates dated v2 preferences to the undated canonical identity", async () => {
    const root = temporaryDirectory("model-preferences-dated-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "singleton" as const, providerId: "anthropic_api" };
    const key = accessProviderAccountKey(account);
    const indexes = new Map([[key, datedAliases]]);
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"enabled":["claude-opus-4-6-20260101"],"disabled":["claude-opus-4-6-2026-02-01"]}]}');

    const migrated = await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes);

    expect(migrated?.accounts.get(key)).toMatchObject({ enabled: new Set(), disabled: new Set(["claude-opus-4.6"]) });
    expect(readFileSync(path, "utf8")).toContain('"claude-opus-4.6"');
    expect(readFileSync(path, "utf8")).not.toMatch(/20260101|2026-02-01/);

    const readOnlyBytes = '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"enabled":["claude-opus-4.6"],"disabled":["claude-opus-4-6-20260201"]}]}';
    writeFileSync(path, readOnlyBytes);
    const readOnly = await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes, "read-only");
    expect(readOnly?.accounts.get(key)).toMatchObject({ enabled: new Set(["claude-opus-4.6"]), disabled: new Set() });
    expect(readFileSync(path, "utf8")).toBe(readOnlyBytes);
    access.close();
  });

  test("rejects malformed state without changing its bytes", async () => {
    const root = temporaryDirectory("model-preferences-malformed-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const path = join(authDir(root, "work"), "model-preferences.json");
    const malformed = '{"version":1,"providers":{"openai_api":{"enabled":["gpt-5"],"disabled":["gpt-5"]}}}';
    writeFileSync(path, malformed);
    expect(() => readProviderModelPreferences(access, new Map())).toThrow();
    await expect(setProviderModelPreference(access, "openai_api", "gpt-5", "default", [{ kind: "singleton", providerId: "openai_api" }], authStoreRevision(access), providerModelPreferencesRevision(access))).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(malformed);
    access.close();
  });

  test("rejects auth and preference races without changing preference bytes", async () => {
    const root = temporaryDirectory("model-preferences-race-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = { kind: "singleton" as const, providerId: "openai_api" };
    const expectedPreferenceRevision = providerModelPreferencesRevision(access);

    await expect(setProviderModelPreference(access, account, "gpt-5", "enabled", [account], "prepared-auth", expectedPreferenceRevision)).rejects.toThrow("changed during provider-model preference mutation");
    expect(providerModelPreferencesRevision(access)).toBe(expectedPreferenceRevision);

    await expect(setProviderModelPreference(access, account, "gpt-5", "enabled", [account], authStoreRevision(access), "stale-preference")).rejects.toThrow("changed during provider-model preference mutation");
    expect(providerModelPreferencesRevision(access)).toBe(expectedPreferenceRevision);
    access.close();
  });

  test("adds the complete current catalog without forgetting off-catalog choices", async () => {
    const root = temporaryDirectory("model-preferences-clear-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const selected = { kind: "singleton" as const, providerId: "openai_api" };
    const other = { kind: "singleton" as const, providerId: "anthropic_api" };
    const accounts = [selected, other];
    await setProviderModelPreference(access, selected, "gpt-4.1", "disabled", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));
    await setProviderModelPreference(access, other, "claude-opus-4-6", "enabled", accounts, authStoreRevision(access), providerModelPreferencesRevision(access));

    await deselectAllProviderModels(access, selected, ["gpt-5-mini", " GPT-5 "], accounts, authStoreRevision(access), providerModelPreferencesRevision(access));

    const preferences = readProviderModelPreferences(access, new Map());
    expect(preferences.accounts.get(accessProviderAccountKey(selected))).toMatchObject({ enabled: new Set(), disabled: new Set(["gpt-4.1", "gpt-5", "gpt-5-mini"]) });
    expect(preferences.accounts.get(accessProviderAccountKey(other))?.enabled).toEqual(new Set(["claude-opus-4.6"]));
    access.close();
  });

  test("migrates one legacy subscription delta to every current account", async () => {
    const root = temporaryDirectory("model-preferences-migrate-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, '{"version":1,"providers":{"chatgpt":{"disabled":["gpt-5"]}}}');
    const accounts = [
      { kind: "subscription" as const, providerId: "chatgpt", instanceId: "first" },
      { kind: "subscription" as const, providerId: "chatgpt", instanceId: "second" },
    ];
    const migrated = await prepareProviderModelPreferences(access, "same", accounts, () => "same", new Map());
    expect([...migrated!.accounts.keys()]).toEqual(accounts.map(accessProviderAccountKey));
    expect(readFileSync(path, "utf8")).toContain('"version": 4');
    access.close();
  });

  test.each([
    ["legacy", '{"version":1,"providers":{"chatgpt":{"disabled":["gpt-5"]}}}'],
    ["noncanonical", '{"version":2,"accounts":[{"account":{"kind":"singleton","providerId":"anthropic_api"},"disabled":["claude-fable-5-1"]}]}'],
  ])("decodes %s preferences without changing access-only bytes", async (_name, bytes) => {
    const root = temporaryDirectory("model-preferences-read-only-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const path = join(authDir(root, "work"), "model-preferences.json");
    writeFileSync(path, bytes);
    const account = bytes.includes("chatgpt")
      ? { kind: "subscription" as const, providerId: "chatgpt", instanceId: "first" }
      : { kind: "singleton" as const, providerId: "anthropic_api" };
    const indexes = new Map([[accessProviderAccountKey(account), aliases]]);

    const preferences = await prepareProviderModelPreferences(access, "same", [account], () => "same", indexes, "read-only");

    expect(preferences?.accounts.get(accessProviderAccountKey(account))?.disabled).toEqual(new Set([bytes.includes("chatgpt") ? "gpt-5" : "claude-fable-5.1"]));
    expect(readFileSync(path, "utf8")).toBe(bytes);
    access.close();
  });

  test("every write keeps the choices of an account that is not current now, such as one that discovery did not find", async () => {
    const root = temporaryDirectory("model-preferences-absent-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const discovered = { kind: "subscription" as const, providerId: "claude_agent_sdk", instanceId: "uuid-person" };
    const other = { kind: "singleton" as const, providerId: "openai_api" };
    const both = [discovered, other];
    await setProviderModelPreference(access, discovered, "claude-opus-4-6", "disabled", both, authStoreRevision(access), providerModelPreferencesRevision(access));
    const writes = [
      () => setProviderModelPreference(access, other, "gpt-5", "enabled", [other], authStoreRevision(access), providerModelPreferencesRevision(access)),
      () => deselectAllProviderModels(access, other, ["gpt-5.1"], [other], authStoreRevision(access), providerModelPreferencesRevision(access)),
      () => setProviderFreeRoutePreference(access, other, true, [other], authStoreRevision(access), providerModelPreferencesRevision(access)),
      () => setProviderAutoEnableNewModels(access, false, new Map([[accessProviderAccountKey(other), { account: other, effectiveModelIds: ["gpt-5"], catalogModelIds: ["gpt-5"] }]]), [other], authStoreRevision(access), providerModelPreferencesRevision(access)),
    ];

    for (const write of writes) {
      await write();
      expect(readProviderModelPreferences(access, new Map()).accounts.get(accessProviderAccountKey(discovered))?.disabled).toEqual(new Set(["claude-opus-4.6"]));
    }
    access.close();
  });

  test("rejects a target absent from current accounts", async () => {
    const root = temporaryDirectory("model-preferences-non-current-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const current = { kind: "singleton" as const, providerId: "openai_api" };
    const absent = { kind: "singleton" as const, providerId: "anthropic_api" };
    await expect(setProviderModelPreference(access, absent, "claude-opus-4-6", "enabled", [current], authStoreRevision(access), providerModelPreferencesRevision(access))).rejects.toThrow("not a current account");
    expect(readProviderModelPreferences(access, new Map()).accounts.size).toBe(0);
    access.close();
  });
});
