/**
 * Static prompt templates for worker invocation.
 *
 * Builds prompts from phase content, key decisions, learnings,
 * file references, and completion instruction.
 *
 * Plan/context files are cached in memory; re-read on mtime change via fs.stat.
 * NOTE: mtime cache is a known TOCTOU limitation (acceptable for sequential execution).
 */

import * as fs from "node:fs";
import type { PlanPhase } from "./plan-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateContext {
  /** The phase to execute */
  phase: PlanPhase;
  /** Key decisions from state file */
  keyDecisions: string[];
  /** File references from .context.md (if available) */
  fileReferences: string[];
  /** Project working directory */
  projectCwd?: string;
}

// ---------------------------------------------------------------------------
// File cache (mtime-based)
// ---------------------------------------------------------------------------

interface CachedFile {
  content: string;
  mtimeMs: number;
}

const fileCache = new Map<string, CachedFile>();

/**
 * Read a file with mtime-based caching.
 * Returns null if the file does not exist.
 */
export function readCachedFile(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    fileCache.set(filePath, { content, mtimeMs: stat.mtimeMs });
    return content;
  } catch {
    return null;
  }
}

/**
 * Clear the file cache (for testing).
 */
export function clearFileCache(): void {
  fileCache.clear();
}

// ---------------------------------------------------------------------------
// Context file parsing
// ---------------------------------------------------------------------------

/**
 * Extract file references from a `.context.md` file.
 * Expects lines like `- path/to/file.ts` or `- `path/to/file.ts``
 */
export function parseContextFile(content: string): string[] {
  const refs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      let ref = trimmed.slice(2).trim();
      // Strip backtick wrapping if present
      if (ref.startsWith("`") && ref.endsWith("`")) {
        ref = ref.slice(1, -1);
      }
      if (ref.length > 0) {
        refs.push(ref);
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

/**
 * Build a static prompt for a phase execution.
 */
export function buildPhasePrompt(ctx: TemplateContext): string {
  const parts: string[] = [];

  // Phase header
  parts.push(
    `You are executing Phase ${ctx.phase.index + 1}: ${ctx.phase.title}`,
  );
  parts.push("");

  // Task section (full phase content)
  parts.push("## Task");
  parts.push(ctx.phase.description);
  parts.push("");

  // Steps checklist
  if (ctx.phase.steps.length > 0) {
    parts.push("## Steps");
    for (const step of ctx.phase.steps) {
      parts.push(`- [ ] ${step}`);
    }
    parts.push("");
  }

  // Key decisions
  if (ctx.keyDecisions.length > 0) {
    parts.push("## Key Decisions");
    for (const decision of ctx.keyDecisions) {
      parts.push(`- ${decision}`);
    }
    parts.push("");
  }

  // File references
  if (ctx.fileReferences.length > 0) {
    parts.push("## File References");
    for (const ref of ctx.fileReferences) {
      parts.push(`- ${ref}`);
    }
    parts.push("");
  }

  // Project cwd
  if (ctx.projectCwd) {
    parts.push(`## Working Directory`);
    parts.push(ctx.projectCwd);
    parts.push("");
  }

  // Completion instruction
  parts.push("## Completion");
  parts.push(
    "When you have completed all tasks in this phase, output: <promise>COMPLETE</promise>",
  );
  parts.push("");

  return parts.join("\n");
}
