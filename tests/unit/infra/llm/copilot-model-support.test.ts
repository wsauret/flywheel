import { describe, expect, test } from "bun:test";
import { normalizeCopilotCatalogRow } from "../../../../src/orchestration/modules/provider-github-copilot/model-support.js";

describe("normalizeCopilotCatalogRow", () => {
  test("keeps only chat endpoints, prefers Responses over chat completions, and omits a model with no chat endpoint", () => {
    expect(normalizeCopilotCatalogRow({ id: "gpt-6.1-sol", supported_endpoints: ["ws:/responses", "/chat/completions", "/responses"] }))
      .toMatchObject({ transport: "openai-responses", metadata: { supportedEndpoints: ["/chat/completions", "/responses"] } });
    expect(normalizeCopilotCatalogRow({ id: "gemini-3.5-flash", supported_endpoints: ["/chat/completions"] })?.transport).toBe("chat-completions");
    expect(normalizeCopilotCatalogRow({ id: "text-embedding-3-small", supported_endpoints: ["/embeddings"] })).toBeUndefined();
  });

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
