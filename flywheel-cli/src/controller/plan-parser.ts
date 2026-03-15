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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `### Phase N: Title` headings */
const PHASE_HEADING_RE = /^###\s+Phase\s+(\d+):\s*(.+)$/;

/** Matches top-level checklist items: `- [ ]`, `- [x]`, `- [~]` */
const TOP_LEVEL_STEP_RE = /^- \[[ x~]\]\s+(.+)$/;

/** Matches indented lines (2+ spaces or tab prefix) */
const INDENTED_RE = /^(?:\s{2,}|\t)/;

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
  const lines = planContent.split("\n");
  const phases: PlanPhase[] = [];

  let currentPhase: {
    phaseNumber: number;
    title: string;
    descriptionLines: string[];
    steps: string[];
  } | null = null;

  for (const line of lines) {
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function finalizePhase(
  raw: {
    phaseNumber: number;
    title: string;
    descriptionLines: string[];
    steps: string[];
  },
  index: number,
  state?: ParsedStateFile | null,
): PlanPhase {
  const description = raw.descriptionLines.join("\n").trim();
  const status = resolveStatus(raw.title, index, state);

  return {
    index,
    title: raw.title,
    description,
    steps: raw.steps,
    status,
  };
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
