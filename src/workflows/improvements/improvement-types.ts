// The vocabulary of recorded improvement facts. No lane writes them any more:
// the memory lane and then the definition lane (reviewable proposal docs under
// private/improvements) are retired, and their facts remain readable history.

export const DEFINITION_TARGET_KINDS = [
  "step_prompt",
  "workflow_template",
  "handoff_schema",
  "review_rubric",
  "validator",
  "test",
  "project_instruction",
  "adr",
] as const

export const DEFINITION_AUTHORITIES = ["project_local", "user_global", "shipped_default"] as const

export const DEFINITION_RISK_TIERS = ["review_required", "human_required"] as const

/** Recorded outcome of one audited bookmark: `proposal` when the audit created
 *  or sharpened a plan document, `banked` when it wrote no plan but its findings
 *  reached a lane (a committed memory or definition doc, or a rejection because
 *  the canonical doc already holds the learning), `noop` when it produced
 *  neither. */
export const INSPIRATION_OUTCOMES = ["noop", "proposal", "banked"] as const
