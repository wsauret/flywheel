// Context Accumulator — Windowed Detail Strategy (ADR-004 Decision 8)
//
// Accumulates handoff data from completed steps. Uses a windowed detail
// strategy: the last N handoffs are kept in full detail; older handoffs
// are summarized to key decisions, artifacts, and issues.
//
// Failed step handoffs are NOT added (only successful completions).
//
// The accumulator state is serializable for persistence alongside queue
// state and is restorable on session resume.
//
// Terminology:
//   HandoffEntry — full-detail record of a step's handoff
//   HandoffSummary — compressed record of an older step's handoff

import type { Step } from "./types.js";

// Types

/** Full-detail handoff entry for recent steps. */
interface HandoffEntry {
  /** ID of the step that produced this handoff. */
  stepId: string;
  /** Type of the step. */
  stepType: Step["type"];
  /** Title of the step. */
  stepTitle: string;
  /** The complete handoff data from the worker. */
  handoff: Record<string, unknown>;
}

/** Summarized handoff for older steps (outside the detail window). */
interface HandoffSummary {
  /** ID of the step that produced this handoff. */
  stepId: string;
  /** Type of the step. */
  stepType: Step["type"];
  /** Title of the step. */
  stepTitle: string;
  /** Key decisions extracted from the handoff. */
  decisions: string[];
  /** Artifacts (files created/modified) extracted from the handoff. */
  artifacts: string[];
  /** Issues/warnings extracted from the handoff. */
  issues: string[];
}

/** Serializable state for persistence and restoration. */
export interface AccumulatorState {
  /** All entries in order (full detail). Used for windowing on getContext(). */
  entries: HandoffEntry[];
}

/**
 * Context returned to the dispatcher. Includes windowed detail:
 * last N in full, older ones summarized.
 */
export interface AccumulatedContext {
  /** Summarized older handoffs (outside the detail window). */
  summaries: HandoffSummary[];
  /** Full-detail recent handoffs (last N). */
  recentHandoffs: HandoffEntry[];
  /** Total number of accumulated entries. */
  totalSteps: number;
}

function extractStringArray(
  data: Record<string, unknown>,
  ...keys: string[]
): string[] {
  const result: string[] = [];
  for (const key of keys) {
    const val = data[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") {
          result.push(item);
        }
      }
    }
  }
  return result;
}

function summarizeEntry(entry: HandoffEntry): HandoffSummary {
  const h = entry.handoff;
  return {
    stepId: entry.stepId,
    stepType: entry.stepType,
    stepTitle: entry.stepTitle,
    decisions: extractStringArray(h, "decisions"),
    artifacts: extractStringArray(
      h,
      "artifacts",
      "artifacts_produced",
      "files_modified",
      "files_created",
    ),
    issues: extractStringArray(h, "issues", "warnings", "discoveredIssues"),
  };
}

/**
 * ContextAccumulator extends the executor's StepContextAccumulator interface
 * with serialization and size methods for persistence support.
 *
 * `accumulate(data)` accepts `unknown` (matching StepContextAccumulator)
 * but only processes objects with the expected shape (stepId, stepType,
 * stepTitle, handoff). Anything else is silently ignored.
 */
export interface ContextAccumulator {
  /** Add a completed step's handoff data. */
  accumulate(data: unknown): void;
  /** Get windowed context for the dispatcher. */
  getContext(): AccumulatedContext;
  /** Serialize for persistence alongside queue state. */
  serialize(): AccumulatorState;
  /** Number of accumulated entries. */
  size(): number;
}

interface ContextAccumulatorOptions {
  /** Number of recent handoffs to keep in full detail. Default: 3. */
  windowSize?: number;
  /** Pre-existing state to restore from persistence. */
  initialState?: AccumulatorState;
}

export function createContextAccumulator(
  opts?: ContextAccumulatorOptions,
): ContextAccumulator {
  const windowSize = opts?.windowSize ?? 3;
  const entries: HandoffEntry[] = opts?.initialState?.entries
    ? [...opts.initialState.entries]
    : [];

  function accumulate(data: unknown): void {
    if (
      data == null ||
      typeof data !== "object" ||
      !("stepId" in data) ||
      !("stepType" in data) ||
      !("stepTitle" in data) ||
      !("handoff" in data)
    ) {
      return;
    }

    const d = data as {
      stepId: string;
      stepType: Step["type"];
      stepTitle: string;
      handoff: Record<string, unknown>;
    };

    entries.push({
      stepId: d.stepId,
      stepType: d.stepType,
      stepTitle: d.stepTitle,
      handoff: d.handoff,
    });
  }

  function getContext(): AccumulatedContext {
    if (entries.length === 0) {
      return { summaries: [], recentHandoffs: [], totalSteps: 0 };
    }

    const windowStart = Math.max(0, entries.length - windowSize);
    const recentHandoffs = entries.slice(windowStart);
    const olderEntries = entries.slice(0, windowStart);
    const summaries = olderEntries.map(summarizeEntry);

    return {
      summaries,
      recentHandoffs,
      totalSteps: entries.length,
    };
  }

  function serialize(): AccumulatorState {
    return { entries: [...entries] };
  }

  function size(): number {
    return entries.length;
  }

  return { accumulate, getContext, serialize, size };
}
