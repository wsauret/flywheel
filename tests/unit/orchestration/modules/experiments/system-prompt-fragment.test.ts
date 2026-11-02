import { describe, expect, it } from "bun:test"
import { renderExperimentSystemPromptFragment } from "../../../../../src/orchestration/modules/experiments/system-prompt-fragment.js"

describe("renderExperimentSystemPromptFragment", () => {
  it("copies the active experiment loop contract with Flywheel-owned paths and notes", () => {
    const fragment = renderExperimentSystemPromptFragment({ checksCommand: "bun run check:experiment" })

    for (const marker of [
      "## Experiment Mode (ACTIVE)",
      "init_experiment",
      "run_experiment",
      "log_experiment",
      ".experiment/charter.md",
      "read-only",
      "bun run check:experiment",
      "runs automatically after every passing benchmark in run_experiment",
      "status 'checks_failed'",
      "You cannot use status 'keep' when checks have failed.",
      "does NOT affect the primary metric",
      "session checkpoint",
      "theme ledger",
      "ideas backlog",
      "what has been tried",
      "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.",
    ]) {
      expect(fragment).toContain(marker)
    }
    expect(fragment).not.toContain(".auto/")
    expect(fragment).not.toContain("log.jsonl")
    expect(fragment).not.toContain("edit .experiment/charter.md")
  })

  it("omits backpressure guidance when the charter records no checks command", () => {
    const fragment = renderExperimentSystemPromptFragment({ checksCommand: null })

    expect(fragment).toContain("## Experiment Mode (ACTIVE)")
    expect(fragment).not.toContain("## Backpressure Checks (ACTIVE)")
  })
})
