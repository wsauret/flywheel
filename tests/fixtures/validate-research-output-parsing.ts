/**
 * validate-research-output-parsing.ts — Parsing helpers for research output validation.
 */

import * as yaml from "js-yaml";

/**
 * Extract YAML frontmatter from content (delimited by --- lines).
 * Returns { frontmatter, body } or null if no valid frontmatter.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  const [, frontmatterText, body] = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  if (frontmatterText === undefined || body === undefined) return null;

  try {
    const parsed = yaml.load(frontmatterText);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      frontmatter: { ...parsed },
      body,
    };
  } catch {
    return null;
  }
}

/**
 * Extract section headings (## level) from markdown body.
 */
export function extractSections(body: string): string[] {
  const sections: string[] = [];
  for (const [, heading] of body.matchAll(/^##\s+(.+)$/gm)) {
    if (heading !== undefined) sections.push(heading.trim());
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
  for (const [, ref] of body.matchAll(refRegex)) {
    if (ref !== undefined) refs.add(ref);
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

  for (const [i, line] of lines.entries()) {
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
 * Strip inline code spans (backtick-quoted text) from a line.
 * This prevents false positives from code references like `SHOULD_BE`.
 */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`]+`/g, "");
}

/**
 * Scan text for pattern violations, returning line numbers and matched text.
 * Skips content inside fenced code blocks (``` delimiters) and inline code spans.
 */
export function scanForPatterns(
  text: string,
  patterns: RegExp[],
): Array<{ line: number; text: string }> {
  const lines = text.split("\n");
  const violations: Array<{ line: number; text: string }> = [];
  let inCodeBlock = false;

  for (const [i, lineText] of lines.entries()) {
    // Track code block state
    if (lineText.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    // Strip inline code spans before checking patterns
    const textToCheck = stripInlineCode(lineText);
    for (const pattern of patterns) {
      if (pattern.test(textToCheck)) {
        violations.push({ line: i + 1, text: lineText.trim() });
        break; // Only report one violation per line
      }
    }
  }

  return violations;
}
