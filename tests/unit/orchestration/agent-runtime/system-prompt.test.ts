import { describe, expect, it } from "bun:test"
import { buildSystemPrompt, buildSystemPromptParts } from "../../../../src/orchestration/agent-runtime/system-prompt.js"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { promptOptions } from "../../../helpers/prompt-capabilities.js";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"

const activeFragment = "## Experiment Mode (ACTIVE)\nEXPERIMENT_FRAGMENT_MARKER"

describe("buildSystemPrompt experiment fragment", () => {
  it("adds no experiment text when the request supplies no active fragment", () => {
    const prompt = buildSystemPrompt(promptOptions({ corePrompt: "core", tools: [], promptKind: "chat" }))

    expect(renderSystemPrompt(prompt)).not.toContain("Experiment Mode (ACTIVE)")
    expect(buildSystemPromptParts(promptOptions({ corePrompt: "core", tools: [], promptKind: "chat" })))
      .not.toContainEqual(expect.objectContaining({ label: "module fragment" }))
  })

  it("adds the request-pinned active fragment exactly once", () => {
    const prompt = buildSystemPrompt(promptOptions({
      corePrompt: "core",
      tools: [],
      promptKind: "chat",
      moduleFragments: [activeFragment],
    }))

    expect(renderSystemPrompt(prompt).split("EXPERIMENT_FRAGMENT_MARKER")).toHaveLength(2)
    expect(buildSystemPromptParts(promptOptions({
      corePrompt: "core",
      tools: [],
      promptKind: "chat",
      moduleFragments: [activeFragment],
    }))).toContainEqual({ label: "module fragment", text: activeFragment, tier: "session" })
  })
})

describe("buildSystemPrompt chat profile", () => {
  it("renders the chat prompt through the capability check as the chat body in place of every chat body, the doctrine, and communication", () => {
    const modelGuidance = resolveModelInteractionProfile("claude-opus-5.5", "anthropic").modelGuidance
    for (const guidance of [modelGuidance ? { modelGuidance } : {}, {}]) {
      const parts = buildSystemPromptParts(promptOptions({
        corePrompt: "core",
        engineeringDoctrine: "doctrine",
        tools: [{ name: "read", action: "file_read", description: "Reads a file." }],
        promptKind: "chat",
        purpose: { kind: "interactive-chat" },
        chatHost: { communication: true },
        chatPrompt: "A\n{{if:bash}}\nB\n{{end}}",
        ...guidance,
      }))

      expect(parts[0]).toEqual({ label: "chat profile", text: "A", tier: "stable" })
      for (const label of ["model chat body", "core system prompt", "engineering doctrine", "communication"]) {
        expect(parts.map((part) => part.label)).not.toContain(label)
      }
    }
  })
})
