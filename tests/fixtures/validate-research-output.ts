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

import {
  type CriterionResult,
  type ResearchVariant,
  type ValidationResult,
} from "./validate-research-output-types";
import { extractFrontmatter } from "./validate-research-output-parsing";
import {
  checkYamlFrontmatter,
  checkRequiredSections,
  checkFileLineRefs,
  checkCodeBlockLength,
  checkNoPrescriptiveLanguage,
  checkNoEvaluativeLanguage,
  checkNoDebuggingLanguage,
  checkNoPlanContamination,
} from "./validate-research-output-checks";

// Re-export types and helpers so this remains the canonical module entry point.
export type { ResearchVariant, CriterionResult, ValidationResult } from "./validate-research-output-types";
export {
  extractFrontmatter,
  extractSections,
  findFileLineRefs,
  findCodeBlocks,
  getBodyExcludingOpenQuestions,
  stripInlineCode,
  scanForPatterns,
} from "./validate-research-output-parsing";
export {
  checkYamlFrontmatter,
  checkRequiredSections,
  checkFileLineRefs,
  checkCodeBlockLength,
  checkNoPrescriptiveLanguage,
  checkNoEvaluativeLanguage,
  checkNoDebuggingLanguage,
  checkNoPlanContamination,
} from "./validate-research-output-checks";

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
    process.exit(1);
  }

  const variant = args[variantIdx + 1];
  if (variant !== "plan" && variant !== "standalone") {
    process.exit(1);
  }

  // Get file path (first non-flag argument)
  const filePath = args.find(
    (a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--variant"),
  );
  if (!filePath) {
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const result = validateResearchOutput(content, variant, filePath);

  for (const c of result.criteria) {
    const icon = c.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    if (c.violations && c.violations.length > 0) {
      for (const v of c.violations.slice(0, 5)) {
      }
      if (c.violations.length > 5) {
      }
    }
  }
  if (result.passed) {
  } else {
    const failed = result.criteria.filter((c) => !c.passed).length;
  }

  process.exit(result.passed ? 0 : 1);
}
