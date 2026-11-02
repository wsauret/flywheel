import { describe, expect, test } from "bun:test";
import { canonicalCatalogModelId, canonicalModelId, canonicalWireModelMap, dashedModelId, dottedModelVersion, legacyDottedModelId } from "../../../../src/infra/llm/model-id.js";

describe("model identity normalization", () => {
  test("uses dotted numeric segments for every model family", () => {
    expect(canonicalModelId("claude-fable-5-1")).toBe("claude-fable-5.1");
    expect(canonicalModelId("gpt-6-1-sol")).toBe("gpt-6.1-sol");
    expect(canonicalModelId("gemini-2-5-flash")).toBe("gemini-2.5-flash");
    expect(canonicalModelId("qwen3-8-max")).toBe("qwen3.8-max");
    expect(canonicalModelId("meta/muse-spark-1-1")).toBe("meta/muse-spark-1.1");
  });

  test("keeps a parameter size after a version apart from it", () => {
    expect(canonicalModelId("qwen3-8b")).toBe("qwen3-8b");
    expect(canonicalModelId("meta-llama/llama-3-3-70b-instruct")).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(canonicalModelId("mistral-small-3-2-24b-instruct")).toBe("mistral-small-3.2-24b-instruct");
    expect(canonicalModelId("wizardlm-2-8x22b")).toBe("wizardlm-2-8x22b");
    expect(canonicalModelId("qwen3.5-0.8b")).toBe("qwen3.5-0.8b");
    expect(canonicalModelId("hy-mt2-1.8b")).toBe("hy-mt2-1.8b");
    expect(canonicalModelId("qwen3.8-2.4t-a95b")).toBe("qwen3.8-2.4t-a95b");
    expect(canonicalModelId("glm-4-5v")).toBe("glm-4.5v");
    expect(canonicalModelId("phi-3-5-mini-instruct")).toBe("phi-3.5-mini-instruct");
  });

  test("states the spelling earlier releases saved for a model", () => {
    expect(legacyDottedModelId("qwen3-8b")).toBe("qwen3.8b");
    expect(legacyDottedModelId("llama-3.3-70b-instruct")).toBe("llama-3.3.70b-instruct");
    expect(legacyDottedModelId("claude-opus-4.5")).toBe("claude-opus-4.5");
  });

  test("can migrate only numeric version separators", () => {
    expect(dottedModelVersion(" Vendor/Model-1-2 ")).toBe(" Vendor/Model-1.2 ");
    expect(dottedModelVersion(" Claude-4-2025-05-14 ")).toBe(" Claude-4-2025-05-14 ");
  });

  test("strips supported terminal date snapshots from canonical identity", () => {
    expect(canonicalModelId("claude-opus-4-6-20260201")).toBe("claude-opus-4.6");
    expect(canonicalModelId("claude-opus-4-6-2026-02-01")).toBe("claude-opus-4.6");
    expect(canonicalModelId("claude-opus-4-6-20261340")).toBe("claude-opus-4.6");
    expect(canonicalModelId("claude-opus-4-6-2026-99-99")).toBe("claude-opus-4.6");
    expect(canonicalModelId("claude-opus-20260201-preview")).toBe("claude-opus-20260201-preview");
    expect(canonicalModelId("claude-opus-4-6-2026020")).toBe("claude-opus-4.6.2026020");
    expect(canonicalModelId("claude-opus-4-6-19990101")).toBe("claude-opus-4.6.19990101");
    expect(canonicalModelId("claude-sonnet-4@20250514")).toBe("claude-sonnet-4@20250514");
  });

  test("formats dotted identities for dashed provider wires", () => {
    expect(dashedModelId("claude-fable-5.1")).toBe("claude-fable-5-1");
    expect(dashedModelId("gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(dashedModelId("meta/muse-spark-1.1")).toBe("meta/muse-spark-1-1");
  });

  test("leaves nonnumeric punctuation unchanged", () => {
    expect(canonicalModelId("vendor/model.latest")).toBe("vendor/model.latest");
    expect(canonicalModelId("gpt-6-1-sol-contributor")).toBe("gpt-6.1-sol-contributor");
    expect(dashedModelId("vendor/model-latest")).toBe("vendor/model-latest");
  });

  test("classifies only a terminal contributor catalog marker", () => {
    expect(canonicalCatalogModelId("gpt-6-1-sol-contributor")).toEqual({ modelId: "gpt-6.1-sol", dataUse: "contributor" });
    expect(canonicalCatalogModelId("gpt-contributor-6-1")).toEqual({ modelId: "gpt-contributor-6.1", dataUse: "standard" });
    expect(canonicalCatalogModelId("gpt-6-1-sol-contributor-preview")).toEqual({ modelId: "gpt-6.1-sol-contributor-preview", dataUse: "standard" });
    expect(canonicalCatalogModelId("claude-opus-4-6-20260201-contributor")).toEqual({ modelId: "claude-opus-4.6", dataUse: "contributor" });
  });

  test("chooses provider aliases without input-order dependence", () => {
    // Identity only: the collision diagnostic is the catalog resolution's, and
    // this module stays inside the protocol closure every browser client bundles.
    const aliases = ["gpt-6-1-sol", "gpt-6.1-sol"];
    expect(canonicalWireModelMap(aliases)).toEqual(canonicalWireModelMap(aliases.toReversed()));
    expect(canonicalWireModelMap(aliases).get("gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(canonicalWireModelMap(["claude-opus-4-6-20260101", "claude-opus-4-6-20260201"]).get("claude-opus-4.6")).toBe("claude-opus-4-6-20260201");
    expect(canonicalWireModelMap(["claude-opus-4-6-20260201", "claude-opus-4-6"]).get("claude-opus-4.6")).toBe("claude-opus-4-6");
  });
});
