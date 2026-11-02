import { describe, expect, test } from "bun:test";
import {
  buildCopilotCatalog,
  copilotEndpointForModel,
  copilotEndpointForMetadata,
  copilotModelUnavailableReason,
  normalizeCopilotCatalogRow,
} from "../../../../src/orchestration/modules/provider-github-copilot/model-support.js";

const CATALOG = buildCopilotCatalog([
  { id: "claude-fable-5", endpoints: ["/v1/messages", "/chat/completions"] },
  { id: "gpt-6.1-sol", endpoints: ["/responses", "ws:/responses"] },
  { id: "gemini-3.5-flash", endpoints: ["/chat/completions"] },
  { id: "text-embedding-3-small", endpoints: ["/embeddings"] },
]);

describe("buildCopilotCatalog", () => {
  test("prefers the native Anthropic endpoint over chat completions", () => {
    expect(CATALOG.get("claude-fable-5")).toEqual({ endpoint: "anthropic-messages", wireModelId: "claude-fable-5" });
  });

  test("prefers the Responses endpoint and ignores unknown wire variants", () => {
    expect(CATALOG.get("gpt-6.1-sol")).toEqual({ endpoint: "openai-responses", wireModelId: "gpt-6.1-sol" });
  });

  test("falls back to chat completions when it is the only chat endpoint", () => {
    expect(CATALOG.get("gemini-3.5-flash")).toEqual({ endpoint: "openai-completions", wireModelId: "gemini-3.5-flash" });
  });

  test("omits listed models with no chat-usable endpoint", () => {
    expect(CATALOG.has("text-embedding-3-small")).toBe(false);
  });

  test("selects the same wire id and endpoint in either alias order", () => {
    const aliases = [
      { id: "gpt-6-1-sol", endpoints: ["/chat/completions"] },
      { id: "gpt-6.1-sol", endpoints: ["/responses"] },
    ];
    expect(buildCopilotCatalog(aliases)).toEqual(buildCopilotCatalog(aliases.toReversed()));
    expect(buildCopilotCatalog(aliases).get("gpt-6.1-sol")).toEqual({ endpoint: "openai-completions", wireModelId: "gpt-6-1-sol" });
  });
});

describe("normalizeCopilotCatalogRow", () => {
  test("retains exact endpoint and complete current billing evidence", () => {
    const row = normalizeCopilotCatalogRow({
      id: "claude-fable-5",
      supported_endpoints: ["/v1/messages", "/chat/completions"],
      object: "model",
      capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 200_000 } },
      billing: {
        multiplier: 1.25,
        token_prices: {
          batch_size: 1_000_000,
          default: { input_price: 2, cache_price: 0.2, output_price: 8, context_max: 200_000 },
          long_context: { input_price: 4, cache_price: 0.4, output_price: 16, context_max: 1_000_000 },
        },
      },
    });
    expect(row).toMatchObject({
      modelId: "claude-fable-5",
      wireModelId: "claude-fable-5",
      transport: "anthropic-messages",
      metadata: {
        object: "model",
        supportedEndpoints: ["/v1/messages", "/chat/completions"],
        capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 200_000 } },
        billing: {
          multiplier: 1.25,
          tokenPrices: {
            batchSize: 1_000_000,
            default: { inputPrice: 2, cachePrice: 0.2, outputPrice: 8, contextMax: 200_000 },
            longContext: { inputPrice: 4, cachePrice: 0.4, outputPrice: 16, contextMax: 1_000_000 },
          },
        },
      },
    });
    expect(row?.resolvedMetadata).toMatchObject({
      provider: "github-copilot",
      id: "claude-fable-5",
      attachment: true,
      contextLimit: 200_000,
      pricing: { status: "available" },
    });
  });

  test("keeps independently valid billing modes and omits invalid price metadata", () => {
    expect(normalizeCopilotCatalogRow({
      id: "gpt-6.1-sol",
      supported_endpoints: ["/responses"],
      billing: { multiplier: 0.5 },
    })).toMatchObject({ transport: "openai-responses", metadata: { supportedEndpoints: ["/responses"], billing: { multiplier: 0.5 } } });
    expect(normalizeCopilotCatalogRow({
      id: "gpt-6.1-sol",
      supported_endpoints: ["/responses"],
      billing: {
        token_prices: {
          batch_size: 0,
          default: { input_price: 2, cache_price: 0.2, output_price: 8 },
        },
      },
    })?.metadata).toEqual({ supportedEndpoints: ["/responses"] });
    expect(normalizeCopilotCatalogRow({
      id: "gpt-6.1-sol",
      supported_endpoints: ["/responses"],
      billing: {
        multiplier: -1,
        token_prices: {
          batch_size: 1_000_000,
          default: { input_price: 2, cache_price: Number.NaN, output_price: 8 },
        },
      },
    })?.metadata).toEqual({ supportedEndpoints: ["/responses"] });
  });
});

describe("copilotModelUnavailableReason", () => {
  test("returns undefined for a listed model", () => {
    expect(copilotModelUnavailableReason("claude-fable-5", CATALOG)).toBeUndefined();
  });

  test("names the model when the listing does not carry it", () => {
    expect(copilotModelUnavailableReason("llama-3", CATALOG)).toContain("llama-3");
  });

  test("reports the missing listing when no catalog was captured", () => {
    expect(copilotModelUnavailableReason("claude-fable-5", undefined)).toContain("listing");
  });
});

describe("copilotEndpointForModel", () => {
  test("returns the catalog endpoint for an admitted model", () => {
    expect(copilotEndpointForModel("claude-fable-5", CATALOG)).toBe("anthropic-messages");
  });

  test("throws for a model the catalog does not name", () => {
    expect(() => copilotEndpointForModel("o3-mini", CATALOG)).toThrow("not supported via GitHub Copilot");
  });
});

describe("copilotEndpointForMetadata", () => {
  test("prefers Copilot supported endpoints over models.dev transport metadata", () => {
    expect(copilotEndpointForMetadata({
      supportedEndpoints: ["/responses"],
      transport: { npm: "@ai-sdk/anthropic" },
    })).toBe("openai-responses");
  });

  test("falls back to models.dev npm transport metadata", () => {
    expect(copilotEndpointForMetadata({ transport: { npm: "@ai-sdk/anthropic" } })).toBe("anthropic-messages");
    expect(copilotEndpointForMetadata({ transport: { npm: "@ai-sdk/openai" } })).toBe("openai-responses");
    expect(copilotEndpointForMetadata({ transport: { npm: "@ai-sdk/openai-compatible" } })).toBe("openai-completions");
  });
});
