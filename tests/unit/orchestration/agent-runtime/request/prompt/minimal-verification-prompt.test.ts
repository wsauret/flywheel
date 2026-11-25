import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { buildSystemPrompt } from "../../../../../../src/orchestration/agent-runtime/request/prompt/system-prompt"
import { renderSystemPrompt } from "../../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { promptOptions, type ToolPromptFields } from "../../../../../helpers/prompt-capabilities.js";

const read = (path: string) => readFileSync(path, "utf8")

test("assembled prompts require the smallest complete verification", () => {
  const corePrompt = read("src/infra/definitions/agent-assets/system-prompt.md")
  const tools: ToolPromptFields[] = ["bash", "memory"].map((name) => ({ name, action: "ui_meta", description: name }))
  const compiled = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools, promptKind: "chat" })))
  for (const rule of [
    "Never revert changes you did not make unless explicitly asked",
    "You may edit applicable AGENTS.md files",
    "without a separate permission request",
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
    "Avoid changing public interfaces or contracts without the approval of the user.",
    "Internal changes that the request needs, such as a new helper or a reworked private function, are not interface changes.",
    "keep accepting every input that the request does not name, because callers or tests that you do not know about can depend on it",
  ]) expect(compiled).toContain(rule)
  expect(compiled).not.toContain("not only the test suite")
  expect(compiled).not.toContain("Inspect the code to verify")
  expect(compiled).not.toContain("scratch harnesses")
  // Without a shell the evidence rule keeps its goal and names no probe; without memory the knowledge rule names none.
  const bare = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools: [], promptKind: "chat" })))
  expect(bare).toContain("Do NOT make assumptions. Prove each claim with the evidence that can settle it")
  expect(bare).toContain("Settle such a claim with the tools you have, or report it as an unverified assumption.")
  expect(bare).not.toContain("throwaway script")
  expect(bare).not.toContain("in memory")
  expect(bare).not.toContain("{{")
  // The rules on open ambiguity and irreplaceable inputs hold with or without a shell.
  for (const prompt of [compiled, bare]) for (const rule of [
    "An ambiguous requirement is not a claim to prove, because evidence settles how things behave, not what the user meant.",
    "or the only copy of a log, copy it first.",
  ]) expect(prompt).toContain(rule)
})

test("experiments settle external and runtime claims that code reading cannot", () => {
  const doctrine = read("src/infra/definitions/agent-assets/engineering-doctrine.md")
  expect(doctrine).toContain("run the probe and reclassify the risk from what you observed")
  const design = read("src/agent-skills/design/SKILL.md")
  expect(design).toContain("settled by a throwaway probe against the real thing")
  for (const skill of ["design", "implementation"]) {
    expect(read(`src/agent-skills/${skill}/SKILL.md`)).not.toMatch(/proof[- ]of[- ]concept is unnecessary/u)
  }
  // The core prompt owns the mocked-boundary rule; the verification skill relies on it and does not restate it.
  expect(read("src/infra/definitions/agent-assets/system-prompt.md")).toContain("A test that mocks an external boundary does not prove that boundary")
  expect(read("src/agent-skills/verification/SKILL.md")).not.toContain("scratch harnesses")
  const subagentTool = read("src/orchestration/modules/subagents/tool.ts")
  expect(subagentTool).toContain("is not a lookup: it needs an experiment against the real thing, which a read-only agent cannot run")
})

test("assembled prompts accept decisive no-change outcomes", () => {
  const tools: ToolPromptFields[] = [
    { name: "edit", action: "file_edit", description: "Edit files" },
    { name: "ask_user", action: "ask_user", description: "Ask the user" },
  ]
  const corePrompt = read("src/infra/definitions/agent-assets/system-prompt.md")
  const compiled = renderSystemPrompt(buildSystemPrompt(promptOptions({ corePrompt, tools, promptKind: "chat", chatHost: { communication: true } })))

  // The core prompt's CONSTRAINTS own the rule; the delivery block does not restate it.
  expect(compiled.split("no change is needed is a successful result")).toHaveLength(2)
  expect(compiled).not.toContain("do not fabricate edits")
  expect(compiled).not.toContain("every change request must produce an implementation")
})

test("verification owners require fresh minimal proof without automatic UAT", () => {
  // The core prompt owns the sufficiency, staleness, and gate rules; the verification skill keeps only its own method.
  const core = read("src/infra/definitions/agent-assets/system-prompt.md")
  for (const rule of ["Tests alone are sufficient", "Add UAT beyond that only for a specific evidence gap or explicit acceptance requirement", "Assume past observations are stale", "Honor explicit repository gates"]) expect(core).toContain(rule)
  const verification = read("src/agent-skills/verification/SKILL.md")
  expect(verification).toContain("do not prove the current state. Run the selected checks yourself")
  expect(read("src/orchestration/agent-runtime/request/prompt/system-prompt.ts")).not.toContain("Current inspected evidence does not need a duplicate run")
  const review = read("src/agent-skills/code-review/SKILL.md")
  expect(review).toContain("A changed CLI, UI, HTTP route, or output format alone is not a trigger")
})
