import { describe, expect, it } from "bun:test"
import { buildSystemPrompt, buildSystemPromptParts } from "../../../../src/orchestration/agent-runtime/system-prompt.js"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

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
