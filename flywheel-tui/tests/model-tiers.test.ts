import { describe, test, expect } from "bun:test";
import { resolveModelTier, validateResolvedModels, TIER_TABLE } from "../src/orchestration/config/model-tiers.js";

const A = TIER_TABLE.anthropic;
const O = TIER_TABLE.openai;

// ---------------------------------------------------------------------------
// Tier resolution: named tiers → concrete models
// ---------------------------------------------------------------------------

describe("resolveModelTier: named tiers", () => {
  test('"powerful" + anthropic', () => {
    expect(resolveModelTier("powerful", "worker", "anthropic")).toBe(A.powerful);
  });

  test('"powerful" + openai', () => {
    expect(resolveModelTier("powerful", "worker", "openai")).toBe(O.powerful);
  });

  test('"mid" + anthropic', () => {
    expect(resolveModelTier("mid", "worker", "anthropic")).toBe(A.mid);
  });

  test('"mid" + openai', () => {
    expect(resolveModelTier("mid", "worker", "openai")).toBe(O.mid);
  });

  test('"cheap" + anthropic', () => {
    expect(resolveModelTier("cheap", "worker", "anthropic")).toBe(A.cheap);
  });

  test('"cheap" + openai', () => {
    expect(resolveModelTier("cheap", "worker", "openai")).toBe(O.cheap);
  });
});

// ---------------------------------------------------------------------------
// Model family aliases (opus/sonnet/haiku → tier names)
// ---------------------------------------------------------------------------

describe("resolveModelTier: model family aliases", () => {
  test('"opus" → powerful (anthropic)', () => {
    expect(resolveModelTier("opus", "worker", "anthropic")).toBe(A.powerful);
  });

  test('"opus" → powerful (openai)', () => {
    expect(resolveModelTier("opus", "worker", "openai")).toBe(O.powerful);
  });

  test('"sonnet" → mid (anthropic)', () => {
    expect(resolveModelTier("sonnet", "worker", "anthropic")).toBe(A.mid);
  });

  test('"sonnet" → mid (openai)', () => {
    expect(resolveModelTier("sonnet", "worker", "openai")).toBe(O.mid);
  });

  test('"haiku" → cheap (anthropic)', () => {
    expect(resolveModelTier("haiku", "worker", "anthropic")).toBe(A.cheap);
  });

  test('"haiku" → cheap (openai)', () => {
    expect(resolveModelTier("haiku", "worker", "openai")).toBe(O.cheap);
  });
});

// ---------------------------------------------------------------------------
// Explicit model passthrough
// ---------------------------------------------------------------------------

describe("resolveModelTier: explicit models pass through", () => {
  test("full claude model ID passes through unchanged", () => {
    expect(resolveModelTier("claude-opus-4-7", "worker", "anthropic")).toBe(
      "claude-opus-4-7",
    );
  });

  test("full openai model ID passes through unchanged", () => {
    expect(resolveModelTier("gpt-5.4", "worker", "openai")).toBe("gpt-5.4");
  });

  test("unknown string passes through unchanged", () => {
    expect(
      resolveModelTier("my-custom-model-v2", "worker", "anthropic"),
    ).toBe("my-custom-model-v2");
  });
});

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe("resolveModelTier: case-insensitive matching", () => {
  test('"Powerful" resolves like "powerful"', () => {
    expect(resolveModelTier("Powerful", "worker", "anthropic")).toBe(A.powerful);
  });

  test('"OPUS" resolves like "opus"', () => {
    expect(resolveModelTier("OPUS", "worker", "anthropic")).toBe(A.powerful);
  });

  test('"Mid" resolves like "mid"', () => {
    expect(resolveModelTier("Mid", "evaluator", "openai")).toBe(O.mid);
  });

  test('"HAIKU" resolves like "haiku"', () => {
    expect(resolveModelTier("HAIKU", "worker", "openai")).toBe(O.cheap);
  });

  test('"CHEAP" resolves like "cheap"', () => {
    expect(resolveModelTier("CHEAP", "worker", "anthropic")).toBe(A.cheap);
  });
});

// ---------------------------------------------------------------------------
// Component defaults (undefined raw)
// ---------------------------------------------------------------------------

describe("resolveModelTier: component defaults", () => {
  test("worker defaults to powerful (anthropic)", () => {
    expect(resolveModelTier(undefined, "worker", "anthropic")).toBe(A.powerful);
  });

  test("worker defaults to powerful (openai)", () => {
    expect(resolveModelTier(undefined, "worker", "openai")).toBe(O.powerful);
  });

  test("evaluator defaults to mid (anthropic)", () => {
    expect(resolveModelTier(undefined, "evaluator", "anthropic")).toBe(A.mid);
  });

  test("evaluator defaults to mid (openai)", () => {
    expect(resolveModelTier(undefined, "evaluator", "openai")).toBe(O.mid);
  });

  test("dispatcher defaults to mid (anthropic)", () => {
    expect(resolveModelTier(undefined, "dispatcher", "anthropic")).toBe(A.mid);
  });

  test("dispatcher defaults to mid (openai)", () => {
    expect(resolveModelTier(undefined, "dispatcher", "openai")).toBe(O.mid);
  });
});

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

describe("validateResolvedModels", () => {
  test("passes when correct keys are present", () => {
    const errors = validateResolvedModels(
      [{ component: "worker", model: A.powerful, engineId: "claude" }],
      { ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    expect(errors).toEqual([]);
  });

  test("missing ANTHROPIC_API_KEY for claude model", () => {
    const errors = validateResolvedModels(
      [{ component: "worker", model: A.mid, engineId: "claude" }],
      {},
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.component).toBe("worker");
    expect(errors[0]!.model).toBe(A.mid);
    expect(errors[0]!.issue).toBe("Missing ANTHROPIC_API_KEY");
  });

  test("missing OPENAI_API_KEY for gpt model", () => {
    const errors = validateResolvedModels(
      [{ component: "worker", model: O.powerful, engineId: "harness" }],
      {},
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.component).toBe("worker");
    expect(errors[0]!.model).toBe(O.powerful);
    expect(errors[0]!.issue).toBe("Missing OPENAI_API_KEY");
  });

  test("missing OPENAI_API_KEY for o-series model (o3)", () => {
    const errors = validateResolvedModels(
      [{ component: "evaluator", model: "o3", engineId: "harness" }],
      {},
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.component).toBe("evaluator");
    expect(errors[0]!.model).toBe("o3");
    expect(errors[0]!.issue).toBe("Missing OPENAI_API_KEY");
  });

  test("mixed vendors validates both keys, returns errors for each", () => {
    const errors = validateResolvedModels(
      [
        { component: "worker", model: A.powerful, engineId: "harness" },
        { component: "evaluator", model: O.mid, engineId: "harness" },
      ],
      {},
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]!.issue).toBe("Missing ANTHROPIC_API_KEY");
    expect(errors[1]!.issue).toBe("Missing OPENAI_API_KEY");
  });

  test("claude engine with non-claude model reports mismatch", () => {
    const errors = validateResolvedModels(
      [{ component: "worker", model: O.powerful, engineId: "claude" }],
      { OPENAI_API_KEY: "sk-test" },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.issue).toContain("Claude engine requires Claude models");
    expect(errors[0]!.issue).toContain(O.powerful);
  });

  test("no errors when all keys present for mixed vendor setup", () => {
    const errors = validateResolvedModels(
      [
        { component: "worker", model: A.powerful, engineId: "harness" },
        { component: "evaluator", model: O.mid, engineId: "harness" },
        { component: "dispatcher", model: A.mid, engineId: "harness" },
      ],
      { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" },
    );
    expect(errors).toEqual([]);
  });
});
