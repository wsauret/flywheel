/**
 * Context enrichment utilities — Level 2 context inlining.
 *
 * Extracted from dispatcher-orchestrator.ts so that enrichment can be
 * invoked by the execution loop independently of the dispatcher.
 */

import { isPathWithinBoundary } from "../utils/path-security";
import { Log } from "../utils/log";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Inline context budget (bytes)
// ---------------------------------------------------------------------------

/** Maximum bytes of file content to inline into a dispatcher prompt. */
export const INLINE_CONTENT_BUDGET = 8192;

const log = Log.create({ service: "context-enrichment" });

// ---------------------------------------------------------------------------
// enrichPromptWithContext — Level 2 context inlining
// ---------------------------------------------------------------------------

/**
 * Prepend file contents from `contextToInline` to the dispatcher prompt.
 *
 * Files are read in order (dispatcher orders by importance — most critical first).
 * A greedy budget cap (`INLINE_CONTENT_BUDGET`) stops reading when the accumulated
 * byte count would exceed the limit. Non-existent files and paths outside
 * `projectCwd` are silently skipped with a log warning.
 */
export async function enrichPromptWithContext(
  prompt: string,
  contextToInline: string[],
  projectCwd: string,
): Promise<string> {
  if (contextToInline.length === 0) return prompt;

  const sections: string[] = [];
  let accumulatedBytes = 0;

  for (const filePath of contextToInline) {
    // Validate path is within project boundary
    if (!isPathWithinBoundary(filePath, projectCwd)) {
      log.warn("context_to_inline path outside project boundary, skipping", {
        path: filePath,
        projectCwd,
      });
      continue;
    }

    // Read file content
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      log.warn("context_to_inline file not readable, skipping", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Check budget — greedy: stop when we'd exceed
    const contentBytes = Buffer.byteLength(content, "utf-8");
    if (accumulatedBytes + contentBytes > INLINE_CONTENT_BUDGET) {
      // If we haven't inlined anything yet, truncate this file to fit
      if (accumulatedBytes === 0) {
        const truncated = truncateToByteLimit(content, INLINE_CONTENT_BUDGET);
        sections.push(`### ${filePath}\n${truncated}\n[truncated]`);
        accumulatedBytes = Buffer.byteLength(truncated, "utf-8");
      }
      // Either way, stop processing further files
      break;
    }

    sections.push(`### ${filePath}\n${content}`);
    accumulatedBytes += contentBytes;
  }

  if (sections.length === 0) return prompt;

  const header = "## Relevant Context (from project standards and learnings)";
  const contextBlock = `${header}\n\n${sections.join("\n\n")}\n\n---\n\n`;
  return contextBlock + prompt;
}

/**
 * Truncate a string to fit within a byte budget (UTF-8).
 * Cuts at character boundaries to avoid breaking multi-byte sequences.
 */
export function truncateToByteLimit(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= maxBytes) return content;
  // Slice buffer and decode — Buffer.toString handles partial multi-byte gracefully
  return buf.subarray(0, maxBytes).toString("utf-8");
}
