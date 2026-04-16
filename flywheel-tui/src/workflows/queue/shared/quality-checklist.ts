// Single source of truth for the quality checklist.
// Used by three consumers with different framing:
// - worker-callback.ts: worker self-review injection (turn boundary)
// - evaluator-criteria.ts: evaluator assessment criteria (sprint mode)
// - prompts.ts: evaluator system prompt addendum (sprint mode, labels only)

interface ChecklistItem {
  label: string
  description: string
}

const QUALITY_CHECKLIST: readonly ChecklistItem[] = [
  { label: "Task alignment", description: "all requested changes present and complete? No TODOs, placeholders, or missing pieces. If acceptance criteria exist, verify each is met." },
  { label: "Elegance", description: 'simplest design that owns its responsibilities completely. No dead code, no speculative code, no unnecessary abstractions. Consumers need no internal knowledge. Data flows one direction without ceremony. A reader says "of course" not "why".' },
  { label: "Diff review", description: "scan the diff for obvious mistakes: unused imports, debug code, missing implementations, accidental deletions." },
  { label: "Tests", description: "tests added/updated for new behavior? Run the full test suite — zero failures." },
  { label: "Build", description: "does it compile? Run the type checker or build command if available." },
  { label: "Regression", description: "could the changes break existing functionality beyond what tests cover?" },
  { label: "Generalization", description: "your solution must remain correct for any numeric values, array dimensions, or file contents change." },
  { label: "Dedicated test script", description: "write a dedicated test script that tests each requirement independently, including edge cases, with clear PASS/FAIL output per test." },
  { label: "Handoff finality", description: "TREAT handoff AS IRREVERSIBLE AND FINAL. Before completing, verify ALL requirements are met." },
]

/** Numbered markdown list: `1. **Label** — description` */
export function formatChecklistNumbered(): string {
  return QUALITY_CHECKLIST
    .map((item, i) => `${i + 1}. **${item.label}** — ${item.description}`)
    .join("\n")
}

/** Comma-separated labels: `diff review, task alignment, ...` */
export function formatChecklistLabels(): string {
  return QUALITY_CHECKLIST.map((item) => item.label.toLowerCase()).join(", ")
}
