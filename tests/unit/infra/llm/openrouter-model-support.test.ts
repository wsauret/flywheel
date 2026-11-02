import { describe, expect, it } from "bun:test";
import { isVendorScopedModelId } from "../../../../src/infra/llm/model-family.js";
import {
  normalizeOpenRouterModelMetadata,
  openRouterModelPricing,
  openRouterModelOutputCap,
  canonicalizeOpenRouterCatalogRow,
  canonicalizeOpenRouterWireId,
} from "../../../../src/orchestration/modules/provider-openrouter/model-support.js";
import { isListableRoute } from "../../../../src/infra/llm/provider-model-info.js";
import { canonicalizeGoogleVertexWireId } from "../../../../src/orchestration/modules/provider-google-vertex/module.js";

describe("OpenRouter catalog resolution", () => {
  it("recognizes slash ids by shape", () => {
    expect(isVendorScopedModelId("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(isVendorScopedModelId("openai/gpt-4o:free")).toBe(true);
    expect(isVendorScopedModelId("gpt-4o")).toBe(false);
  });

  it("derives one aggregation key while preserving paid and free wire routes", () => {
    expect(canonicalizeOpenRouterCatalogRow({
      id: "anthropic/claude-opus-4.8",
      pricing: { prompt: "1", completion: "2" },
      supported_parameters: ["tools"],
    })).toMatchObject({
      modelId: "claude-opus-4.8",
      wireModelId: "anthropic/claude-opus-4.8",
      metadata: { pricing: { prompt: 1, completion: 2 } },
    });
    expect(canonicalizeOpenRouterCatalogRow({
      id: "anthropic/claude-opus-4.8:free",
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["tools"],
    })).toMatchObject({
      modelId: "claude-opus-4.8",
      wireModelId: "anthropic/claude-opus-4.8:free",
      routeKind: "free",
      metadata: { pricing: { prompt: 0, completion: 0 } },
    });
    expect(canonicalizeOpenRouterWireId("~anthropic/claude-latest")).toBeUndefined();
    expect(canonicalizeOpenRouterCatalogRow({ id: "openai/gpt-6-luna", pricing: { prompt: "0.0000001", completion: "0.0000005" }, supported_parameters: ["tools"] })?.resolvedMetadata)
      .toMatchObject({ cost: { input: 0.1, output: 0.5 }, toolCall: true });
  });

  it("lists only priced text routes that call tools", () => {
    const usable = {
      id: "vendor/usable",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools", "temperature"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    };
    const listable = (row: unknown) => {
      const decoded = canonicalizeOpenRouterCatalogRow(row);
      return decoded !== undefined && isListableRoute({ ...decoded, dataUse: "standard" });
    };
    expect(listable(usable)).toBe(true);
    expect(canonicalizeOpenRouterCatalogRow({ ...usable, supported_parameters: ["temperature"] })?.resolvedMetadata?.toolCall).toBe(false);
    expect(listable({ ...usable, supported_parameters: ["temperature"] })).toBe(false);
    expect(listable({ ...usable, supported_parameters: undefined })).toBe(false);
    expect(listable({ ...usable, pricing: { prompt: "-1", completion: "-1" } })).toBe(false);
    expect(listable({ ...usable, pricing: undefined })).toBe(false);
    expect(listable({ ...usable, architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] } })).toBe(false);
    expect(listable({ ...usable, architecture: { input_modalities: ["audio"], output_modalities: ["text"] } })).toBe(false);
    expect(canonicalizeOpenRouterWireId("openai/gpt-6-sol:batch")).toBeUndefined();
    expect(canonicalizeOpenRouterCatalogRow({ id: "openai/gpt-6-sol:batch", pricing: { prompt: "0.000001", completion: "0.000005" } })).toBeUndefined();
  });

  it("keeps the Vertex express catalog limited to Gemini models", () => {
    expect(canonicalizeGoogleVertexWireId("google/gemini-3-8-flash@default")).toEqual({
      modelId: "gemini-3.8-flash",
      dataUse: "standard",
    });
    expect(canonicalizeGoogleVertexWireId("anthropic/claude-opus-4-5@20251101")).toBeUndefined();
    expect(canonicalizeGoogleVertexWireId("zai-org/glm-5-2-maas")).toBeUndefined();
  });


  it("normalizes only complete finite OpenRouter-owned prices and output caps", () => {
    const metadata = normalizeOpenRouterModelMetadata({
      pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000005" },
      top_provider: { max_completion_tokens: 32_768 },
    });
    expect(metadata).toEqual({
      pricing: { prompt: 0.000001, completion: 0.000002, input_cache_read: 0.0000005 },
      top_provider: { max_completion_tokens: 32_768 },
    });
    expect(openRouterModelPricing(metadata)).toEqual({
      prompt: 0.000001,
      completion: 0.000002,
      inputCacheRead: 0.0000005,
    });
    expect(openRouterModelOutputCap(metadata)).toBe(32_768);
    expect(normalizeOpenRouterModelMetadata({ pricing: { prompt: "NaN", completion: "1" }, top_provider: { max_completion_tokens: 1 } })).toEqual({
      top_provider: { max_completion_tokens: 1 },
    });
    expect(normalizeOpenRouterModelMetadata({ pricing: { prompt: "1", completion: "1" }, top_provider: { max_completion_tokens: 1.5 } })).toEqual({
      pricing: { prompt: 1, completion: 1 },
    });
    expect(normalizeOpenRouterModelMetadata({ top_provider: { max_completion_tokens: Number.MAX_SAFE_INTEGER } })).toEqual({
      top_provider: { max_completion_tokens: 2_000_000 },
    });
    expect(normalizeOpenRouterModelMetadata({ top_provider: { max_completion_tokens: 2_000_000 } })).toEqual({
      top_provider: { max_completion_tokens: 2_000_000 },
    });
  });
});
