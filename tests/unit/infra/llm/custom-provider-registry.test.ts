import { afterEach, describe, expect, it } from "bun:test";
import { buildCustomProviderSlice, customProviderById, customProviderIds, customProviderModelUnavailableReason, installCustomProviders, isCustomProviderModel, publishCustomProviderSlice, subscribeCustomProviderRetirement } from "../../../../src/infra/llm/custom-provider-registry.js";
import { detectModelFamily, isCustomProviderOnlyModel } from "../../../../src/infra/llm/model-family.js";

// The registry is the process projection of [custom_providers] config. These
// tests cover its replace semantics and how family detection and the
// custom-only rejection consult it.

const LOCAL_LLAMA = {
  id: "local_llama",
  displayName: "Local Llama",
  baseUrl: "http://localhost:8080/v1",
  modelIds: new Set(["llama-3.3-70b", "gpt-4o"]),
  catalogId: undefined,
  contextLimit: 128_000,
};

afterEach(() => {
  installCustomProviders([]);
});

describe("custom provider registry", () => {
  it("rejects duplicate provider ids", () => {
    expect(() => installCustomProviders([LOCAL_LLAMA, LOCAL_LLAMA])).toThrow("Duplicate custom provider id: local_llama");
  });

  it("builds replacements without publishing and retires the prior generation after publication", () => {
    installCustomProviders([]);
    const retired: number[] = [];
    const unsubscribe = subscribeCustomProviderRetirement((generation) => retired.push(generation));
    const candidate = buildCustomProviderSlice([LOCAL_LLAMA]);
    expect(customProviderIds()).toEqual([]);
    publishCustomProviderSlice(candidate);
    expect(customProviderIds()).toEqual(["local_llama"]);
    expect(retired).toHaveLength(1);
    unsubscribe();
  });

  it("does not republish an equivalent replacement", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const installed = customProviderById("local_llama");
    const retired: number[] = [];
    const unsubscribe = subscribeCustomProviderRetirement((generation) => retired.push(generation));

    publishCustomProviderSlice(buildCustomProviderSlice([{ ...LOCAL_LLAMA, modelIds: new Set(LOCAL_LLAMA.modelIds) }]));

    expect(customProviderById("local_llama")).toBe(installed);
    expect(retired).toEqual([]);
    unsubscribe();
  });

  it("answers model membership and unavailable reasons from the declared set", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(isCustomProviderModel("llama-3.3-70b")).toBe(true);
    expect(isCustomProviderModel("claude-opus-4")).toBe(false);
    expect(customProviderModelUnavailableReason("local_llama", "llama-3.3-70b")).toBeUndefined();
    expect(customProviderModelUnavailableReason("local_llama", "claude-opus-4")).toContain("[custom_providers.local_llama]");
  });
});

describe("family detection for custom models", () => {
  it("maps declared custom models to the openai family", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(detectModelFamily("llama-3.3-70b")).toBe("openai");
  });

  it("leaves undeclared unknown ids without a family", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(detectModelFamily("mystery-model")).toBeNull();
  });

  it("never overrides a first-party family pattern", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(detectModelFamily("gpt-4o")).toBe("openai");
    expect(isCustomProviderOnlyModel("gpt-4o")).toBe(false);
  });

  it("marks ids only a custom entry declares as custom-only", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(isCustomProviderOnlyModel("llama-3.3-70b")).toBe(true);
    expect(isCustomProviderOnlyModel("llama-3.3-70b[large]")).toBe(true);
  });
});
