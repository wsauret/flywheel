import { describe, expect, it } from "bun:test";
import { describeProvider, requireModelMetadata } from "../../../../../src/orchestration/agent-runtime/llm/provider-description.js";
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js";
import { providerModelInfo } from "../../../../../src/infra/llm/catalog/provider-model-info.js";

describe("provider description", () => {
  it("uses selected offering metadata without a generic model lookup", async () => {
    const exact = modelInfo("openai", "shared-model", "shared", 7, 21, "2026-08-01", { contextLimit: 123_456, outputLimit: 12_345 });
    const description = await describeProvider("shared-model", {
      accessProvider: "provider-a",
      protocol: "openai-responses",
      providerHint: "provider-a",
      resolvedModelMetadata: exact,
    });

    expect(description.contextLimit).toBe(123_456);
    expect(description.outputLimit).toBe(12_345);
  });

  it("prices a Chat Completions cache read and write at the input rate when the catalog states no cache price, and an OpenAI Responses read at half", async () => {
    const tokens = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 0 };
    const price = async (protocol: "chat-completions" | "openai-responses") => (await describeProvider("vendor-model", {
      accessProvider: "openrouter",
      protocol,
      providerHint: "openrouter",
      resolvedModelMetadata: modelInfo("chat-completions", "vendor-model", "vendor", 4, 8, "2026-08-01"),
    })).priceFor(tokens);

    expect(await price("chat-completions")).toMatchObject({ status: "priced", amountUsd: 8 });
    expect(await price("openai-responses")).toMatchObject({ status: "priced", amountUsd: 6 });
  });

  it("does not borrow metadata from another provider when the exact route has none", () => {
    expect(() => requireModelMetadata("shared-model", undefined)).toThrow("Model info unavailable for shared-model");
  });

  it("constructs a runnable provider from an unmatched first-party row", async () => {
    const metadata = providerModelInfo({ provider: "openai", id: "provider-new" });
    await expect(describeProvider("provider-new", {
      accessProvider: "openai_api",
      protocol: "openai-responses",
      providerHint: "openai",
      resolvedModelMetadata: metadata,
    })).resolves.toMatchObject({ contextLimit: 200_000, outputLimit: 4_096 });
  });
});
