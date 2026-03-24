#!/usr/bin/env bun
/**
 * validate-research-output.ts — Validates research output against quality criteria.
 *
 * Checks structural requirements (YAML frontmatter, sections, file:line refs,
 * code block length) and content requirements (documentarian mode — no prescriptive,
 * evaluative, debugging, or plan contamination language).
 *
 * Importable as a module (exports validation functions) AND runnable as a CLI script.
 *
 * Usage:
 *   bun run scripts/validate-research-output.ts <file> --variant plan
 *   bun run scripts/validate-research-output.ts <file> --variant standalone
 *   bun run scripts/validate-research-output.ts --help
 */

import * as fs from "node:fs";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResearchVariant = "plan" | "standalone";

export interface CriterionResult {
  criterion: string;
  passed: boolean;
  details: string;
  violations?: Array<{ line: number; text: string }>;
}

export interface ValidationResult {
  file: string;
  variant: ResearchVariant;
  passed: boolean;
  criteria: CriterionResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLAN_REQUIRED_SECTIONS = [
  "Codebase Map",
  "Relevant Code",
  "Patterns to Follow",
  "Constraints",
  "Open Questions",
];

const STANDALONE_REQUIRED_SECTIONS = [
  "Research Question",
  "Summary",
  "Detailed Findings",
  "Code References",
  "Patterns Identified",
  "Open Questions",
];

const MIN_FILE_LINE_REFS_PLAN = 3;
const MIN_FILE_LINE_REFS_STANDALONE = 5;
const MAX_CODE_BLOCK_LINES = 15;

// Prescriptive language patterns (case-insensitive)
const PRESCRIPTIVE_PATTERNS = [
  /\bshould\b/i,
  /\bcould improve\b/i,
  /\bconsider\b/i,
  /\brecommend\b/i,
  /\bsuggest\b/i,
  /\bit would be better\b/i,
  /\bideally\b/i,
];

// Evaluative language patterns (case-insensitive)
const EVALUATIVE_PATTERNS = [
  /\bbad\b/i,
  /\bpoorly\b/i,
  /\bmessy\b/i,
  /\bhacky\b/i,
  /\bwell-designed\b/i,
  /\bproblematic\b/i,
  /\banti-pattern\b/i,
  /\bcode smell\b/i,
  /\btechnical debt\b/i,
];

// Debugging language patterns (case-insensitive)
const DEBUGGING_PATTERNS = [
  /\broot cause\b/i,
  /\bthe bug\b/i,
  /\bthe fix\b/i,
  /\bstack trace\b/i,
  /\bfails when\b/i,
  /\bbreaks because\b/i,
  /\bthe error occurs\b/i,
];

// Plan contamination section titles
const PLAN_CONTAMINATION_SECTIONS = [
  "Implementation Checklist",
  "Phases",
  "Action Items",
  "Next Steps",
  "Root Cause",
  "Fix",
  "Reproduction Steps",
];

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from content (delimited by --- lines).
 * Returns { frontmatter, body } or null if no valid frontmatter.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const parsed = yaml.load(match[1]);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      frontmatter: parsed as Record<string, unknown>,
      body: match[2],
    };
  } catch {
    return null;
  }
}

/**
 * Extract section headings (## level) from markdown body.
 */
export function extractSections(body: string): string[] {
  const headingRegex = /^##\s+(.+)$/gm;
  const sections: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(body)) !== null) {
    sections.push(m[1].trim());
  }
  return sections;
}

/**
 * Find unique file:line references (e.g. path/file.ts:42).
 */
export function findFileLineRefs(body: string): string[] {
  // Match patterns like path/file.ts:42 or src/foo/bar.tsx:123
  const refRegex = /(?:^|[\s`(|])([a-zA-Z0-9_./-]+\.[a-zA-Z]+:\d+)/gm;
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(body)) !== null) {
    refs.add(m[1]);
  }
  return Array.from(refs);
}

/**
 * Find code blocks and their line counts.
 */
export function findCodeBlocks(body: string): Array<{ startLine: number; lineCount: number }> {
  const blocks: Array<{ startLine: number; lineCount: number }> = [];
  const lines = body.split("\n");
  let inBlock = false;
  let blockStart = 0;
  let blockLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      if (!inBlock) {
        inBlock = true;
        blockStart = i + 1;
        blockLineCount = 0;
      } else {
        blocks.push({ startLine: blockStart, lineCount: blockLineCount });
        inBlock = false;
      }
    } else if (inBlock) {
      blockLineCount++;
    }
  }

  return blocks;
}

/**
 * Get the body text outside of the "Open Questions" section.
 * Content checks should exclude the Open Questions section.
 */
export function getBodyExcludingOpenQuestions(body: string): string {
  const lines = body.split("\n");
  const result: string[] = [];
  let inOpenQuestions = false;

  for (const line of lines) {
    // Check if we're entering the Open Questions section
    if (/^##\s+Open Questions/i.test(line)) {
      inOpenQuestions = true;
      continue;
    }
    // Check if we've hit a new section heading (leaving Open Questions)
    if (inOpenQuestions && /^##\s+/.test(line)) {
      inOpenQuestions = false;
    }
    if (!inOpenQuestions) {
      result.push(line);
    }
  }

  return result.join("\n");
}

/**
 * Scan text for pattern violations, returning line numbers and matched text.
 * Skips content inside fenced code blocks (``` delimiters).
 */
export function scanForPatterns(
  text: string,
  patterns: RegExp[],
): Array<{ line: number; text: string }> {
  const lines = text.split("\n");
  const violations: Array<{ line: number; text: string }> = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    // Track code block state
    if (lineText.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    for (const pattern of patterns) {
      if (pattern.test(lineText)) {
        violations.push({ line: i + 1, text: lineText.trim() });
        break; // Only report one violation per line
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Validation criteria checks
// ---------------------------------------------------------------------------

export function checkYamlFrontmatter(content: string): CriterionResult {
  const result = extractFrontmatter(content);
  if (!result) {
    return {
      criterion: "yaml_frontmatter",
      passed: false,
      details: "No valid YAML frontmatter found (must be delimited by --- lines with parseable YAML)",
    };
  }

  const missing: string[] = [];
  if (!result.frontmatter.type) missing.push("type");
  if (!result.frontmatter.date) missing.push("date");
  if (result.frontmatter.status !== "complete") missing.push("status: complete");

  if (missing.length > 0) {
    return {
      criterion: "yaml_frontmatter",
      passed: false,
      details: `YAML frontmatter missing required fields: ${missing.join(", ")}`,
    };
  }

  return {
    criterion: "yaml_frontmatter",
    passed: true,
    details: `Valid YAML frontmatter with type="${result.frontmatter.type}", date="${result.frontmatter.date}", status="complete"`,
  };
}

export function checkRequiredSections(body: string, variant: ResearchVariant): CriterionResult {
  const required = variant === "plan" ? PLAN_REQUIRED_SECTIONS : STANDALONE_REQUIRED_SECTIONS;
  const found = extractSections(body);
  const missing = required.filter(
    (req) => !found.some((f) => f.toLowerCase() === req.toLowerCase()),
  );

  if (missing.length > 0) {
    return {
      criterion: "required_sections",
      passed: false,
      details: `Missing required sections: ${missing.join(", ")}. Found: ${found.join(", ")}`,
    };
  }

  return {
    criterion: "required_sections",
    passed: true,
    details: `All ${required.length} required sections present: ${required.join(", ")}`,
  };
}

export function checkFileLineRefs(body: string, variant: ResearchVariant): CriterionResult {
  const refs = findFileLineRefs(body);
  const minRequired = variant === "plan" ? MIN_FILE_LINE_REFS_PLAN : MIN_FILE_LINE_REFS_STANDALONE;

  if (refs.length < minRequired) {
    return {
      criterion: "file_line_refs",
      passed: false,
      details: `Found ${refs.length} unique file:line references (minimum ${minRequired} required). Found: ${refs.join(", ")}`,
    };
  }

  return {
    criterion: "file_line_refs",
    passed: true,
    details: `Found ${refs.length} unique file:line references (minimum ${minRequired} required)`,
  };
}

export function checkCodeBlockLength(body: string): CriterionResult {
  const blocks = findCodeBlocks(body);
  const oversized = blocks.filter((b) => b.lineCount > MAX_CODE_BLOCK_LINES);

  if (oversized.length > 0) {
    return {
      criterion: "code_block_length",
      passed: false,
      details: `${oversized.length} code block(s) exceed ${MAX_CODE_BLOCK_LINES} lines: ${oversized.map((b) => `block at line ${b.startLine} (${b.lineCount} lines)`).join(", ")}`,
    };
  }

  return {
    criterion: "code_block_length",
    passed: true,
    details: `All ${blocks.length} code block(s) are within ${MAX_CODE_BLOCK_LINES}-line limit`,
  };
}

export function checkNoPrescriptiveLanguage(body: string): CriterionResult {
  const textToScan = getBodyExcludingOpenQuestions(body);
  const violations = scanForPatterns(textToScan, PRESCRIPTIVE_PATTERNS);

  if (violations.length > 0) {
    return {
      criterion: "no_prescriptive_language",
      passed: false,
      details: `Found ${violations.length} prescriptive language violation(s) outside Open Questions`,
      violations,
    };
  }

  return {
    criterion: "no_prescriptive_language",
    passed: true,
    details: "No prescriptive language found outside Open Questions section",
  };
}

export function checkNoEvaluativeLanguage(body: string): CriterionResult {
  const textToScan = getBodyExcludingOpenQuestions(body);
  const violations = scanForPatterns(textToScan, EVALUATIVE_PATTERNS);

  if (violations.length > 0) {
    return {
      criterion: "no_evaluative_language",
      passed: false,
      details: `Found ${violations.length} evaluative language violation(s)`,
      violations,
    };
  }

  return {
    criterion: "no_evaluative_language",
    passed: true,
    details: "No evaluative language found",
  };
}

export function checkNoDebuggingLanguage(body: string): CriterionResult {
  const textToScan = getBodyExcludingOpenQuestions(body);
  const violations = scanForPatterns(textToScan, DEBUGGING_PATTERNS);

  if (violations.length > 0) {
    return {
      criterion: "no_debugging_language",
      passed: false,
      details: `Found ${violations.length} debugging language violation(s)`,
      violations,
    };
  }

  return {
    criterion: "no_debugging_language",
    passed: true,
    details: "No debugging language found",
  };
}

export function checkNoPlanContamination(body: string): CriterionResult {
  const sections = extractSections(body);
  const contaminated = sections.filter((s) =>
    PLAN_CONTAMINATION_SECTIONS.some(
      (p) => s.toLowerCase() === p.toLowerCase(),
    ),
  );

  if (contaminated.length > 0) {
    return {
      criterion: "no_plan_contamination",
      passed: false,
      details: `Found plan/debugging contamination sections: ${contaminated.join(", ")}`,
    };
  }

  return {
    criterion: "no_plan_contamination",
    passed: true,
    details: "No plan/debugging contamination sections found",
  };
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate research output content against all quality criteria.
 * @param content - The raw markdown content to validate
 * @param variant - "plan" or "standalone" research variant
 * @param file - Optional file path for reporting
 */
export function validateResearchOutput(
  content: string,
  variant: ResearchVariant,
  file = "<inline>",
): ValidationResult {
  const frontmatterResult = extractFrontmatter(content);
  const body = frontmatterResult?.body ?? content;

  const criteria: CriterionResult[] = [
    // Structural checks
    checkYamlFrontmatter(content),
    checkRequiredSections(body, variant),
    checkFileLineRefs(body, variant),
    checkCodeBlockLength(body),
    // Content checks (documentarian mode)
    checkNoPrescriptiveLanguage(body),
    checkNoEvaluativeLanguage(body),
    checkNoDebuggingLanguage(body),
    checkNoPlanContamination(body),
  ];

  return {
    file,
    variant,
    passed: criteria.every((c) => c.passed),
    criteria,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function printUsage() {
  console.log(`
${BOLD}validate-research-output.ts${RESET} — Validate research output against quality criteria.

${BOLD}Usage:${RESET}
  bun run scripts/validate-research-output.ts <file> --variant plan|standalone

${BOLD}Options:${RESET}
  --variant plan|standalone   Select which section schema to check (required)
  --help                      Show this help message

${BOLD}Checks:${RESET}
  Structural:
    - YAML frontmatter present and valid (type, date, status: complete)
    - Required sections present (5 for plan, 6 for standalone)
    - File:line references (min 3 for plan, 5 for standalone)
    - No code blocks over 15 lines

  Content (documentarian mode):
    - No prescriptive language (should, recommend, suggest, etc.)
    - No evaluative language (bad, messy, hacky, etc.)
    - No debugging language (root cause, the bug, the fix, etc.)
    - No plan contamination sections (Implementation Checklist, Next Steps, etc.)

${BOLD}Examples:${RESET}
  bun run scripts/validate-research-output.ts output.md --variant plan
  bun run scripts/validate-research-output.ts research.md --variant standalone
`);
}

// Only run CLI when executed directly (not imported)
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Parse --variant flag
  const variantIdx = args.indexOf("--variant");
  if (variantIdx === -1 || !args[variantIdx + 1]) {
    console.error(`${RED}ERROR${RESET}: --variant plan|standalone is required.`);
    process.exit(1);
  }

  const variant = args[variantIdx + 1] as ResearchVariant;
  if (variant !== "plan" && variant !== "standalone") {
    console.error(`${RED}ERROR${RESET}: --variant must be "plan" or "standalone", got "${variant}".`);
    process.exit(1);
  }

  // Get file path (first non-flag argument)
  const filePath = args.find(
    (a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--variant"),
  );
  if (!filePath) {
    console.error(`${RED}ERROR${RESET}: No file path provided.`);
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`${RED}ERROR${RESET}: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const result = validateResearchOutput(content, variant, filePath);

  // Print results
  console.log(`\n${BOLD}=== Research Output Validation ===${RESET}\n`);
  console.log(`  File: ${CYAN}${result.file}${RESET}`);
  console.log(`  Variant: ${CYAN}${result.variant}${RESET}`);
  console.log();

  for (const c of result.criteria) {
    const icon = c.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${icon} ${c.criterion}: ${c.details}`);
    if (c.violations && c.violations.length > 0) {
      for (const v of c.violations.slice(0, 5)) {
        console.log(`       ${DIM}Line ${v.line}: ${v.text}${RESET}`);
      }
      if (c.violations.length > 5) {
        console.log(`       ${DIM}... and ${c.violations.length - 5} more${RESET}`);
      }
    }
  }

  console.log();
  if (result.passed) {
    console.log(`  ${GREEN}${BOLD}All criteria passed.${RESET}\n`);
  } else {
    const failed = result.criteria.filter((c) => !c.passed).length;
    console.log(`  ${RED}${BOLD}${failed} criterion/criteria failed.${RESET}\n`);
  }

  // Print JSON result to stdout for programmatic consumption
  console.log(JSON.stringify(result, null, 2));

  process.exit(result.passed ? 0 : 1);
}
