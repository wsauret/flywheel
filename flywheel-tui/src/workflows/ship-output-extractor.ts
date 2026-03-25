/**
 * ShipOutputExtractor — reads compound doc blocks from ship step 3
 * (learning extraction) via handoff and persists them via extractLearning().
 *
 * Handoff is the ONLY path. No fallback to stdout parsing.
 */

import type { WorkerResult } from "../schemas/worker";
import type { OnStepCompleteHook } from "../controller/execution-loop";
import { Log } from "../utils/log";
import { extractLearning, CompoundDocSchema } from "../memory/extract";
import type { ExtractionInput, ExtractionResult } from "../memory/extract";
import { readHandoff } from "../handoff/reader";
import { WorkerHandoffSchema } from "../schemas/handoff";
import type { CompoundDoc as HandoffCompoundDoc } from "../schemas/handoff";

const log = Log.create({ service: "ship-hook" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The compound extraction step index in the ship workflow (0-based). */
export const COMPOUND_STEP_INDEX = 3;

/**
 * Map handoff CompoundDoc to ExtractionInput.
 * Handoff has: { title, type, tags, problem, solution, context? }
 * ExtractionInput has: { title, tags, problem, solution, context? }
 * The `type` field is dropped (not needed by extractLearning).
 */
function mapHandoffCompoundDocs(docs: HandoffCompoundDoc[]): ExtractionInput[] {
  return docs.map((d) => ({
    title: d.title,
    tags: d.tags,
    problem: d.problem,
    solution: d.solution,
    context: d.context,
  }));
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Create an `onStepComplete` hook for the ship workflow.
 *
 * After step 3 (compound extraction), reads compound docs from handoff
 * and persists each one via `extractLearning()`.
 *
 * Handoff is the only path. No fallback to stdout parsing.
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
      let compoundDocs: ExtractionInput[] = [];

      if (result.handoffPath) {
        try {
          const handoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
          if (handoff.compound_docs && handoff.compound_docs.length > 0) {
            compoundDocs = mapHandoffCompoundDocs(handoff.compound_docs);
            log.info("read compound_docs from handoff", { count: compoundDocs.length });
          }
        } catch (err) {
          log.warn("handoff read failed for compound_docs, returning zero", {
            error: err instanceof Error ? err.message : String(err),
          });
          return { learningsExtracted: 0 };
        }
      }

      if (compoundDocs.length === 0) {
        log.info("no compound docs found in ship handoff");
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
