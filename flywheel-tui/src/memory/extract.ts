/**
 * SES-Memory extractor — validates and persists cross-session learnings.
 *
 * Valid extractions go to `docs/solutions/` (compound format).
 * Invalid extractions go to `.flywheel/cache/ses-drafts/` (logged, not published).
 * Dedup via SHA-256 hash of canonical JSON content.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CompoundDocSchema = z.object({
  title: z.string().min(1),
  problem: z.string().min(1),
  solution: z.string().min(1),
  tags: z.array(z.string()).min(1),
  context: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionInput {
  title: string;
  problem: string;
  solution: string;
  tags: string[];
  context?: string;
}

export interface ExtractionResult {
  written: boolean;
  path: string;
  reason?: "duplicate" | "validation_failed" | "success";
  hash: string;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of canonical JSON representation.
 * Content-only: excludes mutable metadata like timestamps.
 * Keys are sorted, values are trimmed, tags are sorted.
 */
export function computeHash(input: ExtractionInput): string {
  const canonical = JSON.stringify({
    problem: input.problem.trim(),
    solution: input.solution.trim(),
    tags: [...input.tags].sort(),
    title: input.title.trim(),
  });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ---------------------------------------------------------------------------
// Dedup: scan existing hashes in a directory
// ---------------------------------------------------------------------------

function existingHashes(dir: string): Set<string> {
  const hashes = new Set<string>();
  if (!existsSync(dir)) return hashes;

  const files = readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = readFileSync(`${dir}/${file}`, "utf-8");
      const match = content.match(/extraction_hash:\s*"([0-9a-f]{64})"/);
      if (match) {
        hashes.add(match[1]);
      }
    } catch {
      // Skip unreadable files
    }
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// YAML frontmatter generation
// ---------------------------------------------------------------------------

function buildDocument(input: ExtractionInput, hash: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const tagsYaml = `[${input.tags.join(", ")}]`;
  const lines = [
    "---",
    "type: compound",
    `title: "${input.title}"`,
    `tags: ${tagsYaml}`,
    `date: "${date}"`,
    `extraction_hash: "${hash}"`,
    "---",
    "",
    "## Problem",
    input.problem,
    "",
    "## Solution",
    input.solution,
  ];

  if (input.context) {
    lines.push("", "## Context", input.context);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractLearning(
  input: ExtractionInput,
  options: {
    solutionsDir: string;
    draftsDir: string;
  },
): ExtractionResult {
  const hash = computeHash(input);

  // Validate against compound schema
  const validation = CompoundDocSchema.safeParse(input);

  if (!validation.success) {
    // Invalid → write to drafts dir
    mkdirSync(options.draftsDir, { recursive: true });
    const slug = toSlug(input.title || "untitled");
    const filename = `${slug}-${Date.now()}.md`;
    const path = `${options.draftsDir}/${filename}`;
    const doc = buildDocument(input, hash);
    writeFileSync(path, doc, "utf-8");

    return { written: true, path, reason: "validation_failed", hash };
  }

  // Check dedup in solutions dir
  const known = existingHashes(options.solutionsDir);
  if (known.has(hash)) {
    return { written: false, path: "", reason: "duplicate", hash };
  }

  // Write to solutions dir
  mkdirSync(options.solutionsDir, { recursive: true });
  const slug = toSlug(input.title);
  const filename = `${slug}.md`;
  const path = `${options.solutionsDir}/${filename}`;
  const doc = buildDocument(input, hash);
  writeFileSync(path, doc, "utf-8");

  return { written: true, path, reason: "success", hash };
}
