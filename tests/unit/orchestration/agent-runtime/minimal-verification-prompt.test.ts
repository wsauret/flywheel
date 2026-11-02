import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { buildSystemPrompt, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

const read = (path: string) => readFileSync(path, "utf8")

test("assembled prompts require the smallest complete verification", () => {
  const corePrompt = read("src/infra/agent-assets/system-prompt.md")
  const compiled = renderSystemPrompt(buildSystemPrompt({ corePrompt, tools: [], promptKind: "chat" }))
  for (const rule of [
    "Never revert changes you did not make unless explicitly asked",
    "You may edit applicable AGENTS.md files",
    "without a separate permission request",
    "Do not duplicate repository instructions in memory",
    "Do NOT make assumptions. Prove each claim with the evidence that can settle it",
    "Reading code settles what that code does",
    "does not settle what a remote service returns",
    "writing a throwaway script in the scratchpad, running it against the real thing",
    "When a probe is cheap and possible it is not optional",
    "Do not call a task done until you have seen it work",
    "A test that mocks an external boundary does not prove that boundary",
    "Use the smallest complete verification of the work, then stop",
    "Tests alone are sufficient",
    "only for a specific evidence gap or explicit acceptance requirement",
    "Assume past observations are stale",
    "Run fresh checks for the current decision",
  ]) expect(compiled).toContain(rule)
  expect(compiled).not.toContain("not only the test suite")
  expect(compiled).not.toContain("Inspect the code to verify")
  expect(compiled).not.toContain("scratch harnesses")
})

test("experiments settle external and runtime claims that code reading cannot", () => {
  const doctrine = read("src/infra/agent-assets/engineering-doctrine.md")
  expect(doctrine).toContain("run the probe and reclassify the risk from what you observed")
  for (const skill of ["design", "implementation"]) {
    const text = read(`src/agent-skills/${skill}/SKILL.md`)
    expect(text).toContain("settled by a throwaway probe against the real thing")
    expect(text).not.toMatch(/proof[- ]of[- ]concept is unnecessary/u)
  }
  const verification = read("src/agent-skills/verification/SKILL.md")
  expect(verification).toContain("A test that mocks an external boundary does not prove that boundary")
  expect(verification).not.toContain("scratch harnesses")
  const subagentTool = read("src/orchestration/modules/subagents/tool.ts")
  expect(subagentTool).toContain("is an experiment, not a search")
  expect(subagentTool).toContain("explorer is read-only and cannot run it")
})

test("assembled prompts accept decisive no-change outcomes", () => {
  const tools: ToolPromptFields[] = [
    { name: "edit", action: "file_edit", description: "Edit files" },
    { name: "ask_user", action: "ask_user", description: "Ask the user" },
  ]
  const corePrompt = read("src/infra/agent-assets/system-prompt.md")
  const compiled = renderSystemPrompt(buildSystemPrompt({ corePrompt, tools, promptKind: "chat", chatHost: { communication: true } }))

  // The core prompt's CONSTRAINTS own the rule; the delivery block does not restate it.
  expect(compiled.split("no change is needed is a successful result")).toHaveLength(2)
  expect(compiled).not.toContain("do not fabricate edits")
  expect(compiled).not.toContain("every change request must produce an implementation")
})

test("verification owners require fresh minimal proof without automatic UAT", () => {
  const verification = read("src/agent-skills/verification/SKILL.md")
  expect(verification).toContain("Tests alone are sufficient")
  expect(verification).toContain("Assume past observations are stale")
  expect(verification).toContain("Run the selected checks yourself")
  expect(verification).toContain("Honor explicit repository gates")
  const implementation = read("src/agent-skills/implementation/SKILL.md")
  expect(implementation).toContain("only for an evidence gap, explicit acceptance requirement, or explicit repository gate")
  expect(read("src/orchestration/agent-runtime/system-prompt.ts")).not.toContain("Current inspected evidence does not need a duplicate run")
  const review = read("src/agent-skills/code-review/SKILL.md")
  expect(review).toContain("A changed CLI, UI, HTTP route, or output format alone is not a trigger")
})
