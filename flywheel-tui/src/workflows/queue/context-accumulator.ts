import type { Step } from "./types.js";

interface HandoffEntry {
  stepId: string;
  stepType: Step["type"];
  stepTitle: string;
  handoff: Record<string, unknown>;
}

interface HandoffSummary {
  stepId: string;
  stepType: Step["type"];
  stepTitle: string;
  decisions: string[];
  artifacts: string[];
  issues: string[];
}

export interface AccumulatorState {
  entries: HandoffEntry[];
}

export interface AccumulatedContext {
  summaries: HandoffSummary[];
  recentHandoffs: HandoffEntry[];
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

export interface ContextAccumulator {
  accumulate(data: unknown): void;
  getContext(): AccumulatedContext;
  serialize(): AccumulatorState;
  size(): number;
}

interface ContextAccumulatorOptions {
  windowSize?: number;
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
