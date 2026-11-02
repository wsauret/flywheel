import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  RuntimeSaveModelEffortMutationSchema,
  RuntimeModelAssignmentRowSchema,
  RuntimeModelOptionRowSchema,
} from "../../../src/protocol/model-assignment-protocol-schemas.js";
import { FrontendMutationSchema } from "../../../src/protocol/runtime-protocol-schemas.js";

const slot = { kind: "role" as const, roleId: "reviewer" };

describe("model assignment protocol schemas", () => {
  it("preserves role-scoped effort across the wire boundary", () => {
    const mutation = {
      scope: { kind: "defaults" as const },
      slot,
      model: "gpt-6-luna",
      effort: "high" as const,
    };

    expect(Schema.decodeUnknownSync(RuntimeSaveModelEffortMutationSchema)(JSON.parse(JSON.stringify(mutation)))).toEqual(mutation);
    expect(Schema.decodeUnknownSync(FrontendMutationSchema)({ type: "model.save_effort", ...mutation })).toEqual({ type: "model.save_effort", ...mutation });
    expect(() => Schema.decodeUnknownSync(FrontendMutationSchema)({ type: "model.remember_effort", model: mutation.model, effort: mutation.effort })).toThrow();
  });

  it("preserves role-default state across the wire boundary", () => {
    const assignment = {
      slot,
      label: "Reviewer",
      model: "gpt-6-luna",
      effort: "xhigh" as const,
      modelSource: "explicit" as const,
      matchesInheritedPair: false,
      savedModel: "lost-model",
    };
    const option = {
      slot,
      model: "gpt-6-luna",
      label: "gpt-6-luna",
      selectable: true,
      efforts: ["low", "medium", "high"] as const,
      effort: "high" as const,
      cost: { input: 2, output: 10, cacheRead: 0.2 },
      roleDefault: true,
      providers: [{ name: "ChatGPT Subscription", shortName: "ChatGPT", serving: false }, { name: "OpenAI API Key", shortName: "OpenAI", serving: true }],
    };

    expect(Schema.decodeUnknownSync(RuntimeModelAssignmentRowSchema)(JSON.parse(JSON.stringify(assignment)))).toEqual(assignment);
    expect(Schema.decodeUnknownSync(RuntimeModelOptionRowSchema)(JSON.parse(JSON.stringify(option)))).toEqual(option);
  });
});
