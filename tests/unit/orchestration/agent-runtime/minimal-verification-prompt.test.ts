import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { buildSystemPrompt, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

const read = (path: string) => readFileSync(path, "utf8")

test("assembled prompts require the smallest complete verification", () => {
  const corePrompt = read("src/infra/agent-assets/system-prompt.md")
  const tools: ToolPromptFields[] = ["bash", "memory"].map((name) => ({ name, action: "ui_meta", description: name }))
  const compiled = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools, promptKind: "chat" })))
  for (const rule of [
    "Never revert changes you did not make unless explicitly asked",
    "You may edit applicable AGENTS.md files",
    "without a separate permission request",
    "Do not duplicate repository instructions in memory",
    "Do NOT make assumptions. Prove each claim with the evidence that can settle it",
    "Reading code settles what that code does",
    "does not settle what a remote service returns",
    "writing a throwaway script in the scratchpad, running it against the real thing",
    "When a probe of how code, a tool, or a runtime behaves is cheap and possible, it is not optional",
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
  // Without a shell the evidence rule keeps its goal and names no probe; without memory the knowledge rule names none.
  const bare = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools: [], promptKind: "chat" })))
  expect(bare).toContain("Do NOT make assumptions. Prove each claim with the evidence that can settle it")
  expect(bare).toContain("Settle such a claim with the tools you have, or report it as an unverified assumption.")
  expect(bare).not.toContain("throwaway script")
  expect(bare).toContain("Session notes hold current progress, plans, handoffs, and temporary findings.")
  expect(bare).not.toContain("in memory")
  expect(bare).not.toContain("{{")
  // The rules on open ambiguity and irreplaceable inputs hold with or without a shell.
  for (const prompt of [compiled, bare]) for (const rule of [
    "An ambiguous requirement is not a claim to prove, because evidence settles how things behave, not what the requester meant. When nobody can answer it now, choose the reading that you judge best, state the choice in your result, and finish. When a person can answer, the rules for asking still apply.",
    "copy it first, because clients, compilers, and formatters can rewrite the files they open",
  ]) expect(prompt).toContain(rule)
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
  expect(subagentTool).toContain("is not a lookup: it needs an experiment against the real thing, which a read-only agent cannot run")
})

test("assembled prompts accept decisive no-change outcomes", () => {
  const tools: ToolPromptFields[] = [
    { name: "edit", action: "file_edit", description: "Edit files" },
    { name: "ask_user", action: "ask_user", description: "Ask the user" },
  ]
  const corePrompt = read("src/infra/agent-assets/system-prompt.md")
  const compiled = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools, promptKind: "chat", chatHost: { communication: true } })))

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
