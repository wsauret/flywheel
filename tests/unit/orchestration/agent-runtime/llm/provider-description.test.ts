import { describe, expect, it } from "bun:test";
import { describeProvider } from "../../../../../src/orchestration/agent-runtime/llm/provider-description.js";
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";

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

  it("does not borrow metadata from another provider when the exact route has none", async () => {
    await expect(describeProvider("shared-model", {
      accessProvider: "provider-a",
      protocol: "openai-responses",
      providerHint: "provider-a",
    })).rejects.toThrow("Model info unavailable for shared-model");
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
