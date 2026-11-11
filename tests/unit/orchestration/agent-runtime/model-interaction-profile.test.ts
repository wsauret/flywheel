import { describe, expect, test } from "bun:test"

import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"

describe("model interaction profile resolution", () => {
  test("serves gpt-6-luna through the default profile and the apply_patch edit contract", () => {
    const profile = resolveModelInteractionProfile("gpt-6-luna", "openai")
    expect(profile).toEqual({ id: "default", fileEditContract: "apply_patch" })
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

  test("gives chat guidance only to the models of the guidance table and their later family versions, without changing tool contracts", () => {
    for (const model of ["claude-opus-5.5", "claude-sonnet-5.5", "claude-fable-5.1", "claude-fable-5.2", "claude-haiku-5.5"]) {
      const profile = resolveModelInteractionProfile(model, "anthropic")
      expect(profile.chatGuidance).toBeDefined()
      expect(profile.id).toBe("default")
      expect(profile.fileEditContract).toBe(resolveModelInteractionProfile("claude-sonnet-4", "anthropic").fileEditContract)
      expect(resolveModelInteractionProfile(model, "anthropic")).toBe(profile)
      expect(resolveModelInteractionProfile(`anthropic/${model}`, "anthropic").chatGuidance).toBeUndefined()
      expect(resolveModelInteractionProfile(model, "openai")).toBe(profile)
    }
    // A later version shares the profile object of its newest earlier entry.
    expect(resolveModelInteractionProfile("claude-fable-5.3", "anthropic")).toBe(resolveModelInteractionProfile("claude-fable-5.2", "anthropic"))
    expect(resolveModelInteractionProfile("claude-fable-5.2", "anthropic")).not.toBe(resolveModelInteractionProfile("claude-fable-5.1", "anthropic"))
    for (const model of ["claude-opus-5", "claude-fable-5", "claude-sonnet-4", "claude-haiku-5"]) {
      expect(resolveModelInteractionProfile(model, "anthropic").chatGuidance).toBeUndefined()
    }
  })
})
