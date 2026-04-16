// Single source of truth for the quality checklist.
// Used by three consumers with different framing:
// - worker-callback.ts: worker self-review injection (turn boundary)
// - evaluator-criteria.ts: evaluator assessment criteria (sprint mode)
// - prompts.ts: evaluator system prompt addendum (sprint mode, labels only)

interface ChecklistItem {
  label: string
  description: string
  /** Guidance the dispatcher reads when deciding whether to include this label. */
  whenToInclude: string
}

const QUALITY_CHECKLIST: readonly ChecklistItem[] = [
  {
    label: "Task alignment",
    description: "all requested changes present and complete? No TODOs, placeholders, or missing pieces. If acceptance criteria exist, verify each is met.",
    whenToInclude: "always include.",
  },
  {
    label: "Elegance",
    description: 'simplest design that owns its responsibilities completely. No dead code, no speculative code, no unnecessary abstractions. Consumers need no internal knowledge. Data flows one direction without ceremony. A reader says "of course" not "why".',
    whenToInclude: "include when the task involves design decisions or non-trivial code structure.",
  },
  {
    label: "Diff review",
    description: "scan the diff for obvious mistakes: unused imports, debug code, missing implementations, accidental deletions.",
    whenToInclude: "include when modifying existing code.",
  },
  {
    label: "Tests",
    description: "tests added/updated for new behavior? Run the full test suite — zero failures.",
    whenToInclude: "include when `required_tests: true` or the task produces testable code.",
  },
  {
    label: "Build",
    description: "does it compile? Run the type checker or build command if available.",
    whenToInclude: "include when modifying compiled/typechecked code.",
  },
  {
    label: "Regression",
    description: "could the changes break existing functionality beyond what tests cover?",
    whenToInclude: "include when the task touches existing code covered by tests.",
  },
  {
    label: "Generalization",
    description: "your solution must remain correct for any numeric values, array dimensions, or file contents change.",
    whenToInclude: "include for algorithms or data structures that must handle varying inputs.",
  },
  {
    label: "Dedicated test script",
    description: "write a dedicated test script that tests each requirement independently, including edge cases, with clear PASS/FAIL output per test.",
    whenToInclude: "include when acceptance needs verification beyond existence/content checks.",
  },
  {
    label: "Handoff finality",
    description: "TREAT handoff AS IRREVERSIBLE AND FINAL. Before completing, verify ALL requirements are met.",
    whenToInclude: "always include.",
  },
]

/** Canonical label set — the only values `self_review_items` may contain. */
export const CHECKLIST_LABELS: readonly string[] = QUALITY_CHECKLIST.map((i) => i.label)

/** Numbered markdown list: `1. **Label** — description`. Pass a subset of labels to filter; undefined = all. */
export function formatChecklistNumbered(labels?: readonly string[]): string {
  const items = labels
    ? QUALITY_CHECKLIST.filter((i) => labels.includes(i.label))
    : QUALITY_CHECKLIST
  return items
    .map((item, i) => `${i + 1}. **${item.label}** — ${item.description}`)
    .join("\n")
}

/** Comma-separated labels: `diff review, task alignment, ...` */
export function formatChecklistLabels(): string {
  return QUALITY_CHECKLIST.map((item) => item.label.toLowerCase()).join(", ")
}

/** Quoted canonical labels for prompt injection: `"Task alignment", "Elegance", ...` */
export function formatChecklistLabelsQuoted(): string {
  return CHECKLIST_LABELS.map((l) => `"${l}"`).join(", ")
}

/** Markdown bullets pairing each label with its dispatcher include-guidance. */
export function formatChecklistInclusionGuidance(): string {
  return QUALITY_CHECKLIST
    .map((i) => `- "${i.label}" — ${i.whenToInclude}`)
    .join("\n")
}
