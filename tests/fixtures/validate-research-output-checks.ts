/**
 * validate-research-output-checks.ts — Validation criteria check functions.
 */

import {
  type CriterionResult,
  type ResearchVariant,
  PLAN_REQUIRED_SECTIONS,
  STANDALONE_REQUIRED_SECTIONS,
  MIN_FILE_LINE_REFS_PLAN,
  MIN_FILE_LINE_REFS_STANDALONE,
  MAX_CODE_BLOCK_LINES,
  PRESCRIPTIVE_PATTERNS,
  EVALUATIVE_PATTERNS,
  DEBUGGING_PATTERNS,
  PLAN_CONTAMINATION_SECTIONS,
} from "./validate-research-output-types";
import {
  extractFrontmatter,
  extractSections,
  findFileLineRefs,
  findCodeBlocks,
  getBodyExcludingOpenQuestions,
  scanForPatterns,
} from "./validate-research-output-parsing";

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
