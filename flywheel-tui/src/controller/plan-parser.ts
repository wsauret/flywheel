/**
 * Plan markdown parser.
 *
 * Extracts phase list from plan markdown. Parses `### Phase N: Title` headings
 * with their checklist items (`- [ ]`, `- [x]`, `- [~]`). Only top-level
 * checklist items are steps; indented sub-items are ignored.
 *
 * Cross-references with state file phases to determine execution status.
 */

import type { ParsedPhase, ParsedStateFile } from "../state/reader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanPhase {
  /** 0-based index */
  index: number;
  /** Phase title (e.g. "Setup project structure") */
  title: string;
  /** Full content under the phase heading (raw markdown) */
  description: string;
  /** Top-level checklist items (step descriptions) */
  steps: string[];
  /** Status from state file cross-reference, or "pending" if no state */
  status: "completed" | "pending" | "in_progress";
  /** Milestone this phase belongs to (from `## Milestone: <name>` markers) */
  milestone?: string;
}

/** Discriminated union for plan validation results. */
export type ValidationResult =
  | { ok: true; phases: PlanPhase[] }
  | { ok: false; issues: string[]; phases: PlanPhase[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `### Phase N: Title` headings */
const PHASE_HEADING_RE = /^###\s+Phase\s+(\d+):\s*(.+)$/;

/** Matches top-level checklist items: `- [ ]`, `- [x]`, `- [~]` */
const TOP_LEVEL_STEP_RE = /^- \[[ x~]\]\s+(.+)$/;

/** Matches indented lines (2+ spaces or tab prefix) */
const INDENTED_RE = /^(?:\s{2,}|\t)/;

/** Matches acceptance-criteria-like section headings */
const ACCEPTANCE_CRITERIA_RE =
  /^##\s+(Acceptance\s+Criteria|Success\s+Criteria|Verification|Done\s+When)\s*$/i;

/** Matches exactly `## Milestone: <name>` (H2, capital M, colon-space, then name) */
const MILESTONE_RE = /^## Milestone: (.+)$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a plan markdown string into structured phases.
 *
 * @param planContent - Raw plan markdown content
 * @param state - Optional state file for cross-referencing phase status
 * @returns Array of parsed phases
 */
export function parsePlan(
  planContent: string,
  state?: ParsedStateFile | null,
): PlanPhase[] {
  planContent = planContent.replace(/\r\n/g, "\n");
  const lines = planContent.split("\n");
  const phases: PlanPhase[] = [];

  let currentPhase: {
    phaseNumber: number;
    title: string;
    descriptionLines: string[];
    steps: string[];
    milestone?: string;
  } | null = null;

  /** Tracks the current milestone scope (set by `## Milestone: <name>`) */
  let currentMilestone: string | undefined;

  for (const line of lines) {
    // Check for milestone marker before phase heading
    const milestoneMatch = line.match(MILESTONE_RE);
    if (milestoneMatch) {
      // Flush previous phase before switching milestone
      if (currentPhase) {
        phases.push(finalizePhase(currentPhase, phases.length, state));
        currentPhase = null;
      }

      const name = milestoneMatch[1].trim();
      // Only set milestone if name is non-empty after trimming
      currentMilestone = name.length > 0 ? name : undefined;
      continue;
    }

    const headingMatch = line.match(PHASE_HEADING_RE);

    if (headingMatch) {
      // Flush previous phase
      if (currentPhase) {
        phases.push(finalizePhase(currentPhase, phases.length, state));
      }

      currentPhase = {
        phaseNumber: parseInt(headingMatch[1], 10),
        title: headingMatch[2].trim(),
        descriptionLines: [],
        steps: [],
        milestone: currentMilestone,
      };
      continue;
    }

    if (currentPhase) {
      // Skip indented lines (sub-items) for step extraction
      if (INDENTED_RE.test(line)) {
        currentPhase.descriptionLines.push(line);
        continue;
      }

      const stepMatch = line.match(TOP_LEVEL_STEP_RE);
      if (stepMatch) {
        currentPhase.steps.push(stepMatch[1].trim());
      }

      currentPhase.descriptionLines.push(line);
    }
  }

  // Flush last phase
  if (currentPhase) {
    phases.push(finalizePhase(currentPhase, phases.length, state));
  }

  return phases;
}

/**
 * Extract just the phase titles from a plan (lightweight, no state cross-ref).
 */
export function extractPhaseTitles(planContent: string): string[] {
  const titles: string[] = [];
  for (const line of planContent.split("\n")) {
    const match = line.match(PHASE_HEADING_RE);
    if (match) {
      titles.push(match[2].trim());
    }
  }
  return titles;
}

/**
 * Validate a plan's structure and return a discriminated union result.
 *
 * Checks:
 * 1. At least one phase exists
 * 2. Every phase has at least one step (checklist item)
 * 3. An acceptance criteria section is present
 *
 * The parsed phases are always returned (even on failure) so callers can
 * inspect partial structure.
 */
export function validatePlan(planContent: string): ValidationResult {
  const phases = parsePlan(planContent);
  const issues: string[] = [];

  // Check 1: at least one phase
  if (phases.length === 0) {
    issues.push("Plan has no phases. Expected at least one '### Phase N: Title' heading.");
  }

  // Check 2: every phase must have at least one step
  for (const phase of phases) {
    if (phase.steps.length === 0) {
      issues.push(
        `Phase ${phase.index + 1} ("${phase.title}") has no steps. Add checklist items (- [ ] ...).`,
      );
    }
  }

  // Check 3: acceptance criteria section
  if (!hasAcceptanceCriteria(planContent)) {
    issues.push(
      "Plan is missing an acceptance criteria section. " +
        "Add a '## Acceptance Criteria', '## Success Criteria', '## Verification', or '## Done When' heading.",
    );
  }

  if (issues.length === 0) {
    return { ok: true, phases };
  }
  return { ok: false, issues, phases };
}

/**
 * Check whether plan content contains an acceptance-criteria-like section.
 */
export function hasAcceptanceCriteria(planContent: string): boolean {
  const normalized = planContent.replace(/\r\n/g, "\n");
  for (const line of normalized.split("\n")) {
    if (ACCEPTANCE_CRITERIA_RE.test(line)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function finalizePhase(
  raw: {
    phaseNumber: number;
    title: string;
    descriptionLines: string[];
    steps: string[];
    milestone?: string;
  },
  index: number,
  state?: ParsedStateFile | null,
): PlanPhase {
  const description = raw.descriptionLines.join("\n").trim();
  const status = resolveStatus(raw.title, index, state);

  const phase: PlanPhase = {
    index,
    title: raw.title,
    description,
    steps: raw.steps,
    status,
  };

  if (raw.milestone !== undefined) {
    phase.milestone = raw.milestone;
  }

  return phase;
}

/**
 * Cross-reference a phase with the state file to determine status.
 * Matches by index first; falls back to title matching if available.
 */
function resolveStatus(
  title: string,
  index: number,
  state?: ParsedStateFile | null,
): PlanPhase["status"] {
  if (!state || !state.phases.length) return "pending";

  // Try by index first
  if (index < state.phases.length) {
    return mapStateStatus(state.phases[index].status);
  }

  // Fallback: match by title (normalized)
  const normalizedTitle = title.toLowerCase().trim();
  const match = state.phases.find(
    (p) => p.name.toLowerCase().trim() === normalizedTitle,
  );
  if (match) {
    return mapStateStatus(match.status);
  }

  return "pending";
}

function mapStateStatus(
  status: ParsedPhase["status"],
): PlanPhase["status"] {
  return status;
}
