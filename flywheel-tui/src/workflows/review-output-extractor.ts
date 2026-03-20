/**
 * ReviewOutputExtractor — parses P3 findings from review output and
 * provides an onStepComplete hook for interactive P3 triage.
 *
 * Three modes:
 *   1. interactive + user picks items → p3Triage: { included, excluded, source: "user" }
 *   2. interactive + user dismisses → p3Triage: { directive: REVIEW_P3_DIRECTIVE }
 *   3. non-interactive → p3Triage: { directive: REVIEW_P3_DIRECTIVE }
 *
 * Returns empty object when no P3 findings are parsed (Decision #9).
 */

import type { WorkerResult } from "../schemas/worker";
import type { OnStepCompleteHook } from "../controller/execution-loop";
import type { QuestionInfo } from "../controller/question-service";
import { Log } from "../utils/log";

const log = Log.create({ service: "review-hook" });
import {
  QuestionRejectedError,
  type QuestionService,
} from "../controller/question-service";
import { extractSection, parseTableRow } from "./question-parser";
import { extractTextFromOutput } from "./output-text-extractor";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The multi-agent review step index in the review workflow (0-based). */
export const REVIEW_MULTI_AGENT_STEP_INDEX = 1;

/** Directive sent when P3 findings are auto-included (non-interactive or dismissed). */
export const REVIEW_P3_DIRECTIVE = "include-non-cosmetic" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface P3Finding {
  title: string;
  summary: string;
  location: string;
}

// ---------------------------------------------------------------------------
// P3 Finding Parser
// ---------------------------------------------------------------------------

/**
 * Parse P3 findings from review output.
 *
 * Supports three formats:
 *   1. Table rows with severity column containing "P3"
 *   2. Bullet lists under P3/Nice-to-have/Minor/Deferred section headings
 *   3. Inline "P3 (deferred):" bullet format anywhere
 *
 * On any parse failure, returns empty array (never throws).
 */
export function parseP3Findings(output: string): P3Finding[] {
  if (!output.trim()) return [];

  try {
    const findings: P3Finding[] = [];

    findings.push(...parseP3FromTable(output));
    findings.push(...parseP3FromSections(output));
    findings.push(...parseP3InlineBullets(output));

    // Deduplicate by title (first occurrence wins)
    return deduplicateFindings(findings);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Table parser
// ---------------------------------------------------------------------------

/**
 * Extract P3 findings from markdown tables with a Severity column.
 *
 * Looks for tables under any `## ...` heading (commonly `## Findings`).
 * Identifies rows where the severity cell contains "P3".
 */
function parseP3FromTable(output: string): P3Finding[] {
  const findings: P3Finding[] = [];

  // "Findings" is the canonical heading from the review dispatch prompt template.
  const sectionHeadings = [
    "Findings",
  ];

  for (const heading of sectionHeadings) {
    const section = extractSection(output, heading);
    if (!section) continue;

    const lines = section
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|"));

    if (lines.length < 2) continue;

    // Identify column positions from header row
    const headers = parseTableRow(lines[0]).map((h) => h.toLowerCase().trim());
    const findingCol = headers.findIndex(
      (h) => h === "finding" || h.includes("finding"),
    );
    const severityCol = headers.findIndex(
      (h) => h === "severity" || h.includes("severity"),
    );
    const fileCol = headers.findIndex(
      (h) => h === "file" || h.includes("file") || h === "location" || h.includes("location"),
    );
    const summaryCol = headers.findIndex(
      (h) => h === "summary" || h.includes("summary") || h === "description" || h.includes("description"),
    );

    if (severityCol === -1) continue;

    // Parse data rows (skip header and separator)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Skip separator rows
      if (line.match(/^\|[\s-|]+\|$/)) continue;

      const cells = parseTableRow(line);
      const severity = cells[severityCol]?.trim() ?? "";

      if (!severity.toUpperCase().includes("P3")) continue;

      findings.push({
        title: cells[findingCol]?.trim() ?? severity,
        summary: cells[summaryCol]?.trim() ?? "",
        location: cells[fileCol]?.trim() ?? "",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Section-based bullet parser
// ---------------------------------------------------------------------------

/**
 * Section headings that contain P3 findings.
 * "Minor Findings" is the canonical heading from the review dispatch prompt template.
 */
const P3_SECTION_HEADINGS = [
  "Minor Findings",
];

/**
 * Extract P3 findings from bullet lists under dedicated P3 section headings.
 */
function parseP3FromSections(output: string): P3Finding[] {
  const findings: P3Finding[] = [];

  for (const heading of P3_SECTION_HEADINGS) {
    const section = extractSection(output, heading);
    if (!section) continue;

    const lines = section.split("\n");
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(?:P3\s*(?:\(deferred\))?:\s*)?(.+)/i);
      if (!bullet) continue;

      const text = bullet[1].trim();
      if (!text) continue;

      const { title, location } = parseBulletText(text);
      findings.push({ title, summary: text, location });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Inline bullet parser (P3: / P3 (deferred): anywhere)
// ---------------------------------------------------------------------------

/**
 * Parse P3 bullets from anywhere in the output (not under a specific section).
 * Matches lines like: `- P3: ...` or `- P3 (deferred): ...`
 */
function parseP3InlineBullets(output: string): P3Finding[] {
  const findings: P3Finding[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.match(
      /^\s*[-*]\s+P3\s*(?:\(deferred\))?\s*:\s*(.+)/i,
    );
    if (!match) continue;

    const text = match[1].trim();
    if (!text) continue;

    const { title, location } = parseBulletText(text);
    findings.push({ title, summary: text, location });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a short title and file location from a bullet line text.
 *
 * Tries to find backtick-wrapped file references like `src/foo.ts:42`.
 * Falls back to the first ~60 chars of the text as title.
 */
function parseBulletText(text: string): { title: string; location: string } {
  // Try to extract a file location from backticks
  const locationMatch = text.match(/`([^`]*\.[a-z]+(?::\d+)?)`/);
  const location = locationMatch ? locationMatch[1] : "";

  // Title: strip the location reference and trim, then truncate
  let title = text;
  if (locationMatch) {
    title = text
      .replace(locationMatch[0], "")
      .replace(/\s+in\s*$/, "")
      .replace(/\s+at\s*$/, "")
      .trim();
  }

  // Truncate to ~60 chars at word boundary
  if (title.length > 60) {
    const truncated = title.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    title = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  }

  return { title, location };
}

/**
 * Deduplicate findings by title (case-insensitive). First occurrence wins.
 */
function deduplicateFindings(findings: P3Finding[]): P3Finding[] {
  const seen = new Set<string>();
  const result: P3Finding[] = [];

  for (const f of findings) {
    const key = f.title.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(f);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/** Options for the review onStepComplete hook factory. */
export interface ReviewHookOptions {
  /** QuestionService instance for interactive triage flow. */
  questionService?: QuestionService;
  /** When true, P3 triage is presented to the user via QuestionService. */
  interactive?: boolean;
}

/**
 * Handle P3 findings from the multi-agent review step.
 *
 * Three modes:
 *   1. interactive + questionService + user picks → p3Triage: { included, excluded, source: "user" }
 *   2. interactive + user dismisses (QuestionRejectedError) → p3Triage: { directive }
 *   3. non-interactive → p3Triage: { directive }
 *
 * Returns empty object when no P3 findings are parsed (Decision #9).
 */
async function handleP3Triage(
  output: string,
  options: ReviewHookOptions,
): Promise<Record<string, unknown>> {
  // Extract clean text from NDJSON-wrapped output before parsing
  const cleanText = extractTextFromOutput(output);
  const p3Findings = parseP3Findings(cleanText);

  // No P3 findings → nothing to do (omit p3Triage key per Decision #9)
  if (p3Findings.length === 0) {
    return {};
  }

  const { questionService, interactive } = options;

  // Non-interactive path: auto-include with directive
  if (!interactive || !questionService) {
    return {
      p3Triage: { directive: REVIEW_P3_DIRECTIVE },
    };
  }

  // Interactive path: present single multi-select question
  try {
    const questions: QuestionInfo[] = [
      {
        question: "Which P3 findings should be included in the review?",
        header: "P3 Triage",
        options: p3Findings.map((f) => ({
          label: f.title,
          description: `${f.location}: ${f.summary}`.replace(/^:\s*/, ""),
        })),
        multiple: true,
        custom: false,
      },
    ];

    const answers = await questionService.ask(questions);
    const selectedLabels = new Set(answers[0] ?? []);
    const included = p3Findings.filter((f) => selectedLabels.has(f.title));
    const excluded = p3Findings.filter((f) => !selectedLabels.has(f.title));

    return {
      p3Triage: { included, excluded, source: "user" },
    };
  } catch (err) {
    if (err instanceof QuestionRejectedError) {
      // User dismissed — auto-include with directive
      return {
        p3Triage: { directive: REVIEW_P3_DIRECTIVE },
      };
    }
    // Unexpected error — re-throw to outer catch
    throw err;
  }
}

/**
 * Create an `onStepComplete` hook for the review workflow.
 *
 * After the multi-agent review step (step 1), extracts P3 findings
 * and either presents them for interactive triage or auto-includes
 * them with a directive.
 *
 * @param options - Question service and interactive flag
 * @returns An OnStepCompleteHook suitable for ExecutionLoop
 */
export function createReviewOnStepComplete(
  options?: ReviewHookOptions,
): OnStepCompleteHook {
  const hookOptions: ReviewHookOptions = options ?? {};

  return async (
    stepIndex: number,
    result: WorkerResult,
    _accumulatedExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    // Only process after the multi-agent review step
    if (stepIndex !== REVIEW_MULTI_AGENT_STEP_INDEX) {
      return {};
    }

    try {
      return await handleP3Triage(result.output, hookOptions);
    } catch (err) {
      // Outer catch: unexpected errors don't abort the pipeline
      log.error("unexpected error handling P3 triage", { error: err instanceof Error ? err : String(err) });
      return {};
    }
  };
}
