import { afterEach, describe, expect, it } from "bun:test";
import { installCustomProvidersFromConfig } from "../../../../src/orchestration/config/custom-providers.js";
import { customProviderById, customProviderIds, customProviderModelUnavailableReason, customProviderOwning, installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";

// Validation of the [custom_providers] config section: an invalid entry is
// warned about and dropped, never fatal, and valid entries land in the
// registry with canonical model ids and defaults applied.

afterEach(() => {
  installCustomProviders([]);
});

function install(section: Parameters<typeof installCustomProvidersFromConfig>[0]): string[] {
  const warnings: string[] = [];
  installCustomProvidersFromConfig(section, warnings);
  return warnings;
}

describe("installCustomProvidersFromConfig", () => {
  it("installs a valid entry with defaults applied", () => {
    const warnings = install({ local_llama: { base_url: "http://localhost:8080/v1/", models: ["Llama-3.3-70B"] } });
    expect(warnings).toEqual([]);
    const entry = customProviderById("local_llama");
    expect(entry?.displayName).toBe("local_llama");
    expect(entry?.baseUrl).toBe("http://localhost:8080/v1");
    expect(entry?.modelIds.has("llama-3.3-70b")).toBe(true);
    expect(entry?.contextLimit).toBe(128_000);
    expect(entry?.catalogId).toBeUndefined();
  });

  it("retains ownership of a contributor wire under its canonical model identity", () => {
    install({ local: { base_url: "http://localhost:8080/v1", models: ["local-contributor"] } });

    expect(customProviderOwning("local")?.id).toBe("local");
    expect(customProviderModelUnavailableReason("local", "local")).toBeUndefined();
  });

  it("keeps declared display name, catalog id, and context limit", () => {
    install({ proxy: { base_url: "https://proxy.example/v1", models: ["m1"], display_name: "My Proxy", catalog_id: "groq", context_limit: 32_000 } });
    const entry = customProviderById("proxy");
    expect(entry?.displayName).toBe("My Proxy");
    expect(entry?.catalogId).toBe("groq");
    expect(entry?.contextLimit).toBe(32_000);
  });

  it("drops an entry whose id is malformed", () => {
    const warnings = install({ "Bad Id": { base_url: "http://localhost:1/v1", models: ["m"] } });
    expect(customProviderIds()).toEqual([]);
    expect(warnings.join("\n")).toContain("[custom_providers.Bad Id]");
  });

  it("drops an entry that shadows a first-party provider id", () => {
    const warnings = install({ openrouter: { base_url: "http://localhost:1/v1", models: ["m"] } });
    expect(customProviderIds()).toEqual([]);
    expect(warnings.join("\n")).toContain("first-party provider id");
  });

  it("drops an invalid base_url without exposing it in diagnostics", () => {
    const sentinel = "ftp://user:secret-token@host/v1";
    const warnings = install({ bad: { base_url: sentinel, models: ["m"] } });
    expect(customProviderIds()).toEqual([]);
    expect(warnings.join("\n")).toContain("base_url must be an http(s) URL");
    expect(warnings.join("\n")).not.toContain(sentinel);
  });

  it("drops an entry with no models", () => {
    const warnings = install({ empty: { base_url: "http://localhost:1/v1", models: [] } });
    expect(customProviderIds()).toEqual([]);
    expect(warnings.join("\n")).toContain("declares no models");
  });

  it("drops model ids with terminal control characters", () => {
    const warnings = install({ unsafe: { base_url: "http://localhost:1/v1", models: ["gpt-5\u001b[2J"] } });
    expect(customProviderIds()).toEqual([]);
    expect(warnings.join("\n")).toContain("must not contain terminal control characters");
    expect(warnings.join("\n")).not.toContain("\u001b");
  });

  it("gives a model claimed by two entries to the first declaration", () => {
    const warnings = install({
      alpha: { base_url: "http://localhost:1/v1", models: ["shared-model"] },
      beta: { base_url: "http://localhost:2/v1", models: ["shared-model", "beta-model"] },
    });
    expect(customProviderById("alpha")?.modelIds.has("shared-model")).toBe(true);
    expect(customProviderById("beta")?.modelIds.has("shared-model")).toBe(false);
    expect(customProviderById("beta")?.modelIds.has("beta-model")).toBe(true);
    expect(warnings.join("\n")).toContain("the first declaration wins");
  });
});
