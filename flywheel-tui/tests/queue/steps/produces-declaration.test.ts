import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";

import "../../../src/workflows/handoff-types/register-all.js";
import "../../../src/workflows/queue/steps/register-all.js";

import {
  buildScaffolding,
  getStepProduces,
  registerScaffolding,
} from "../../../src/workflows/queue/shared/scaffolding.js";
import { getHandoffType } from "../../../src/workflows/handoff-types/registry.js";
import type { Step } from "../../../src/workflows/queue/types.js";

describe("getStepProduces", () => {
  it("returns undefined when a registered strategy does not set produces", () => {
    const key = `test-${randomUUID()}`;
    registerScaffolding(key, () => ({ preamble: "a", postamble: "b" }));
    expect(getStepProduces(key)).toBeUndefined();
  });

  it("returns the declared produces name when a strategy sets it", () => {
    const key = `test-${randomUUID()}`;
    registerScaffolding(key, () => ({ preamble: "a", postamble: "b", produces: "x" }));
    expect(getStepProduces(key)).toBe("x");
  });

  it("returns undefined for a completely unregistered key", () => {
    expect(getStepProduces(`test-${randomUUID()}`)).toBeUndefined();
  });

  it("buildScaffolding still returns empty strings for a completely unregistered key", () => {
    const unknownStep = {
      id: `unknown-${randomUUID()}`,
      type: `unknown-${randomUUID()}`,
      title: "",
      status: "pending" as const,
    } as unknown as Step;
    const result = buildScaffolding(unknownStep, { handoffPath: "/tmp/h.json" });
    expect(result.preamble).toBe("");
    expect(result.postamble).toBe("");
  });

  it("resolves the sprint variant's produces to work-handoff", () => {
    expect(getStepProduces("work:sprint")).toBe("work-handoff");
  });

  it("resolves the work type's produces to work-handoff", () => {
    expect(getStepProduces("work")).toBe("work-handoff");
  });

  it("falls back from variant key to type-level produces when the variant omits produces", () => {
    const typeKey = `test-${randomUUID()}`;
    const variantHint = `variant-${randomUUID()}`;
    const fullVariantKey = `${typeKey}:${variantHint}`;
    registerScaffolding(typeKey, () => ({ preamble: "", postamble: "", produces: "type-level" }));
    registerScaffolding(fullVariantKey, () => ({ preamble: "", postamble: "" }));
    expect(getStepProduces(fullVariantKey)).toBe("type-level");
  });

  it("does not bubble a variant's produces up to a type-only lookup", () => {
    const typeKey = `test-${randomUUID()}`;
    const variantHint = `variant-${randomUUID()}`;
    const fullVariantKey = `${typeKey}:${variantHint}`;
    registerScaffolding(typeKey, () => ({ preamble: "", postamble: "" }));
    registerScaffolding(fullVariantKey, () => ({
      preamble: "",
      postamble: "",
      produces: "variant-only",
    }));
    expect(getStepProduces(typeKey)).toBeUndefined();
  });

  it("every production produces declaration resolves to a registered handoff type", () => {
    const productionKeys = ["work", "work:sprint"];
    for (const key of productionKeys) {
      const produces = getStepProduces(key);
      expect(produces).toBeDefined();
      if (produces === undefined) continue;
      expect(getHandoffType(produces)).toBeDefined();
    }
  });
});
