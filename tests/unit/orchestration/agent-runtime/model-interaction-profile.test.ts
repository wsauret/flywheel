import { describe, expect, test } from "bun:test"

import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"

describe("model interaction profile resolution", () => {
  test("serves the OpenAI guidance models through the default profile with their guidance and the apply_patch edit contract", () => {
    for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]) {
      const profile = resolveModelInteractionProfile(model, "openai")
      expect(profile.id).toBe("default")
      expect(profile.fileEditContract).toBe("apply_patch")
      expect(profile.modelGuidance).toBeDefined()
      expect(resolveModelInteractionProfile(model, "openai")).toBe(profile)
    }
  })

  test("selects one immutable file-edit contract from the canonical serving identity and family", () => {
    for (const model of ["gpt-5", "o3", "codex-mini", "chatgpt-4o"]) {
      expect(resolveModelInteractionProfile(model, "openai").fileEditContract).toBe("apply_patch")
      expect(resolveModelInteractionProfile(model, "anthropic").fileEditContract).toBe("edit")
      expect(resolveModelInteractionProfile(model, "google").fileEditContract).toBe("edit")
    }
    for (const model of ["claude-sonnet-4", "gemini-2.5-pro", "openai/gpt-5", "o3fake", "other-model"]) {
      expect(resolveModelInteractionProfile(model, "openai").fileEditContract).toBe("edit")
    }
    expect(resolveModelInteractionProfile("gpt-5", "openai")).toBe(resolveModelInteractionProfile("gpt-5", "openai"))
  })

  test("gives guidance only to the models of the guidance table and their later family versions, without changing tool contracts", () => {
    for (const model of ["claude-fable-5.1", "claude-fable-5.2", "claude-haiku-5.5"]) {
      const profile = resolveModelInteractionProfile(model, "anthropic")
      expect(profile.modelGuidance).toBeDefined()
      expect(profile.id).toBe("default")
      expect(profile.fileEditContract).toBe(resolveModelInteractionProfile("claude-sonnet-4", "anthropic").fileEditContract)
      expect(resolveModelInteractionProfile(model, "anthropic")).toBe(profile)
      expect(resolveModelInteractionProfile(`anthropic/${model}`, "anthropic").modelGuidance).toBeUndefined()
      expect(resolveModelInteractionProfile(model, "openai")).toBe(profile)
    }
    // A later version shares the profile object of its newest earlier entry.
    expect(resolveModelInteractionProfile("claude-fable-5.3", "anthropic")).toBe(resolveModelInteractionProfile("claude-fable-5.2", "anthropic"))
    expect(resolveModelInteractionProfile("claude-fable-5.2", "anthropic")).not.toBe(resolveModelInteractionProfile("claude-fable-5.1", "anthropic"))
    expect(resolveModelInteractionProfile("gpt-6.2-sol", "openai")).toBe(resolveModelInteractionProfile("gpt-6.1-sol", "openai"))
    expect(resolveModelInteractionProfile("gpt-7-luna", "openai").modelGuidance).toBeUndefined()
    // A model whose guidance is the base alone has no entry.
    for (const model of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-opus-5", "claude-fable-5", "claude-sonnet-4", "claude-haiku-5"]) {
      expect(resolveModelInteractionProfile(model, "anthropic").modelGuidance).toBeUndefined()
    }
  })
})
