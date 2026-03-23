/**
 * ShipOutputExtractor — parses compound doc blocks from ship step 3
 * (learning extraction) and persists them via extractLearning().
 *
 * Follows the same hook pattern as plan-output-extractor.ts and
 * review-output-extractor.ts.
 */

import type { WorkerResult } from "../schemas/worker";
import type { OnStepCompleteHook } from "../controller/execution-loop";
import { Log } from "../utils/log";
import { extractLearning, CompoundDocSchema } from "../memory/extract";
import type { ExtractionInput, ExtractionResult } from "../memory/extract";
import { parseFrontmatter } from "../utils/frontmatter";
import { extractTextFromOutput } from "./output-text-extractor";

const log = Log.create({ service: "ship-hook" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The compound extraction step index in the ship workflow (0-based). */
export const COMPOUND_STEP_INDEX = 3;

// ---------------------------------------------------------------------------
// Compound doc parser
// ---------------------------------------------------------------------------

/**
 * Parse compound doc blocks from worker output text.
 *
 * Splits on frontmatter delimiters (`---`) and looks for blocks where
 * `type: compound` is present in the YAML frontmatter. Extracts the
 * title, problem, solution, tags, and context fields.
 *
 * Returns an array of ExtractionInput objects (validated against
 * CompoundDocSchema). Invalid blocks are silently skipped.
 */
export function parseCompoundDocs(output: string): ExtractionInput[] {
  if (!output.trim()) return [];

  const results: ExtractionInput[] = [];

  // Split on `---` line boundaries to find frontmatter-delimited blocks.
  // A compound doc block looks like:
  //   ---
  //   type: compound
  //   title: "..."
  //   ...
  //   ---
  //   ## Problem
  //   ...
  //   ## Solution
  //   ...
  //
  // Strategy: find all `---` delimited blocks and check if they contain type: compound.
  const blocks = splitFrontmatterBlocks(output);

  for (const block of blocks) {
    const parsed = parseFrontmatter(block);
    if (!parsed) continue;

    const { frontmatter, body } = parsed;

    // Only process compound type docs
    if (frontmatter.type !== "compound") continue;

    const input: ExtractionInput = {
      title: String(frontmatter.title ?? ""),
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      problem: extractSection(body, "Problem"),
      solution: extractSection(body, "Solution"),
      context: extractSection(body, "Context") || undefined,
    };

    // Validate before returning
    const validation = CompoundDocSchema.safeParse(input);
    if (validation.success) {
      results.push(input);
    }
  }

  return results;
}

/**
 * Split output text into potential frontmatter-delimited blocks.
 *
 * Looks for lines that are exactly `---` and reconstructs complete
 * frontmatter blocks (from `---` to `---` plus trailing body content).
 */
function splitFrontmatterBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");

  let i = 0;
  while (i < lines.length) {
    // Look for opening `---`
    if (lines[i].trim() === "---") {
      // Find the closing `---`
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "---") {
        j++;
      }

      if (j < lines.length) {
        // Found closing delimiter — collect body until next `---` or end
        let k = j + 1;
        while (k < lines.length && lines[k].trim() !== "---") {
          k++;
        }

        // Reconstruct the full block: frontmatter + body
        const block = lines.slice(i, k).join("\n");
        blocks.push(block);
        i = k; // Continue from next potential block
      } else {
        i = j;
      }
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Extract the content under a `## <heading>` section.
 * Returns the text between the heading and the next `## ` heading (or end of string).
 */
function extractSection(body: string, heading: string): string {
  const pattern = new RegExp(`^## ${heading}\\s*$`, "im");
  const match = body.match(pattern);
  if (!match || match.index === undefined) return "";

  const start = match.index + match[0].length;
  const rest = body.slice(start);

  // Find next ## heading
  const nextHeading = rest.match(/^## /m);
  const sectionText = nextHeading?.index !== undefined
    ? rest.slice(0, nextHeading.index)
    : rest;

  return sectionText.trim();
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create an `onStepComplete` hook for the ship workflow.
 *
 * After step 3 (compound extraction), parses worker output for compound doc
 * blocks and persists each one via `extractLearning()`.
 *
 * Only processes step 3 (COMPOUND_STEP_INDEX). Returns empty object for
 * all other steps.
 *
 * @param projectCwd - The project root directory
 * @param knownHashes - Optional pre-built hash set for fast dedup (from SESMemoryRetriever.getHashes())
 * @returns An OnStepCompleteHook suitable for ExecutionLoop
 */
export function createShipOnStepComplete(
  projectCwd: string,
  knownHashes?: Set<string>,
): OnStepCompleteHook {
  const solutionsDir = `${projectCwd}/docs/solutions`;
  const draftsDir = `${projectCwd}/.flywheel/cache/ses-drafts`;

  return async (
    stepIndex: number,
    result: WorkerResult,
    _accumulatedExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    if (stepIndex !== COMPOUND_STEP_INDEX) {
      return {};
    }

    try {
      // Extract clean text from NDJSON-wrapped output
      const cleanText = extractTextFromOutput(result.output);
      const compoundDocs = parseCompoundDocs(cleanText);

      if (compoundDocs.length === 0) {
        log.info("no compound docs found in ship output");
        return { learningsExtracted: 0 };
      }

      const results: ExtractionResult[] = [];
      // Build a mutable hash set: start from known hashes, add new ones as we go
      const hashSet = knownHashes ? new Set(knownHashes) : undefined;

      for (const doc of compoundDocs) {
        const extractionResult = extractLearning(doc, {
          solutionsDir,
          draftsDir,
          knownHashes: hashSet,
        });
        results.push(extractionResult);

        // Add newly written hashes to the set for intra-batch dedup
        if (hashSet && extractionResult.reason === "success") {
          hashSet.add(extractionResult.hash);
        }
      }

      const written = results.filter((r) => r.reason === "success").length;
      const duplicates = results.filter((r) => r.reason === "duplicate").length;
      const failed = results.filter((r) => r.reason === "validation_failed").length;

      log.info("compound learning extraction complete", {
        total: results.length,
        written,
        duplicates,
        failed,
      });

      return {
        learningsExtracted: written,
        learningsDuplicate: duplicates,
        learningsFailed: failed,
      };
    } catch (err) {
      log.error("unexpected error extracting compound learnings", {
        error: err instanceof Error ? err : String(err),
      });
      return { learningsExtracted: 0 };
    }
  };
}
