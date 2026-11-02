import { expect, test } from "bun:test";
import { deriveProviderModelPreferences, resolveAccountProviderModelPreferences } from "../../../../src/infra/llm/provider-model-preferences.js";

test("provider unions derive from explicit account identities", () => {
  const catalog = new Set(["alpha", "beta", "gamma"]);
  const curated = new Set(["alpha", "beta"]);
  const account = { kind: "subscription", providerId: "chatgpt", instanceId: "account" } as const;
  const resolved = resolveAccountProviderModelPreferences(catalog, curated, { enabled: new Set(["gamma"]), disabled: new Set(["beta"]) }, true);
  const provider = deriveProviderModelPreferences(new Map([["chatgpt", { catalog, curatedDefault: curated }]]), [[account, resolved]]).get("chatgpt")!;
  expect([...provider.enabled]).toEqual(["gamma"]);
  expect([...provider.disabled]).toEqual([]);
  expect([...provider.effective]).toEqual(["alpha", "gamma"]);
});

test("account resolution isolates conflicting preferences for the same provider", () => {
  const catalog = new Set(["alpha", "beta"]);
  const curated = new Set(["alpha"]);
  const first = resolveAccountProviderModelPreferences(catalog, curated, { enabled: new Set(["beta"]), disabled: new Set() }, true);
  const second = resolveAccountProviderModelPreferences(catalog, curated, { enabled: new Set(), disabled: new Set(["alpha"]) }, true);
  expect([...first.effective]).toEqual(["alpha", "beta"]);
  expect([...second.effective]).toEqual([]);
});

test("an account can preserve current selections while later catalog models default off", () => {
  const initialCatalog = new Set(["alpha", "beta"]);
  const preference = {
    enabled: new Set(["alpha"]),
    disabled: new Set(["beta"]),
  };

  expect([...resolveAccountProviderModelPreferences(initialCatalog, initialCatalog, preference, false).effective]).toEqual(["alpha"]);
  expect([...resolveAccountProviderModelPreferences(new Set([...initialCatalog, "gamma"]), initialCatalog, preference, false).effective]).toEqual(["alpha"]);
});
