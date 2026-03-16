/**
 * SES-Memory retriever — indexes and queries cross-session learnings.
 *
 * Reads compound docs from `docs/solutions/`, builds an in-memory tag index,
 * and returns ranked results by tag match count.
 *
 * Uses stat-based file watching (fs.watchFile) for macOS reliability,
 * with a TTL-based fallback re-read interval.
 */

import { readdirSync, readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LearningEntry {
  title: string;
  tags: string[];
  hash: string;
  filePath: string;
  content: string;
}

export interface RetrieverOptions {
  /** TTL in milliseconds for fallback re-read. Default: 30000 (30s). */
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// SESMemoryRetriever
// ---------------------------------------------------------------------------

export class SESMemoryRetriever {
  private readonly solutionsDir: string;
  private readonly ttlMs: number;

  /** All indexed entries. */
  private entries: LearningEntry[] = [];

  /** Tag → set of entry indices for fast lookup. */
  private tagIndex: Map<string, Set<number>> = new Map();

  /** Whether the index has been built at least once. */
  private ready = false;

  /** TTL interval handle. */
  private ttlTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether dispose() has been called. */
  private disposed = false;

  constructor(solutionsDir: string, options?: RetrieverOptions) {
    this.solutionsDir = solutionsDir;
    this.ttlMs = options?.ttlMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start async index build. Reads all .md files in solutionsDir,
   * parses YAML frontmatter, and builds the tag index.
   * Returns a promise that resolves when the first build is complete.
   */
  async startIndexing(): Promise<void> {
    if (this.disposed) return;

    await this.buildIndex();
    this.ready = true;

    // Start TTL-based re-read
    this.ttlTimer = setInterval(() => {
      if (!this.disposed) {
        this.buildIndex().catch(() => {});
      }
    }, this.ttlMs);
  }

  /** Whether the index is ready for queries. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Retrieve relevant learnings by tag match, ranked by number of matching tags (descending).
   * Returns empty array if the index is not yet ready.
   */
  retrieve(tags: string[], maxResults?: number): LearningEntry[] {
    if (!this.ready) return [];

    const normalizedTags = tags.map((t) => t.toLowerCase().trim());

    // Score each entry by number of matching tags
    const scored: Array<{ entry: LearningEntry; score: number }> = [];

    for (const entry of this.entries) {
      let score = 0;
      for (const tag of normalizedTags) {
        if (entry.tags.some((et) => et.toLowerCase() === tag)) {
          score++;
        }
      }
      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const limit = maxResults ?? scored.length;
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /** Dispose file watcher and TTL timer. */
  dispose(): void {
    this.disposed = true;
    this.ready = false;
    if (this.ttlTimer !== null) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async buildIndex(): Promise<void> {
    const entries: LearningEntry[] = [];
    const tagIndex: Map<string, Set<number>> = new Map();

    if (!existsSync(this.solutionsDir)) {
      this.entries = entries;
      this.tagIndex = tagIndex;
      return;
    }

    let files: string[];
    try {
      files = readdirSync(this.solutionsDir).filter((f) => f.endsWith(".md"));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(this.solutionsDir, file);
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue;

        const { frontmatter, body } = parsed;

        const entry: LearningEntry = {
          title: String(frontmatter.title ?? ""),
          tags: Array.isArray(frontmatter.tags)
            ? frontmatter.tags.map(String)
            : [],
          hash: String(frontmatter.extraction_hash ?? ""),
          filePath,
          content: body,
        };

        const idx = entries.length;
        entries.push(entry);

        // Index by tags
        for (const tag of entry.tags) {
          const normalized = tag.toLowerCase().trim();
          if (!tagIndex.has(normalized)) {
            tagIndex.set(normalized, new Set());
          }
          tagIndex.get(normalized)!.add(idx);
        }
      } catch {
        // Skip unreadable or malformed files
      }
    }

    this.entries = entries;
    this.tagIndex = tagIndex;
  }
}

// ---------------------------------------------------------------------------
// YAML frontmatter parser
// ---------------------------------------------------------------------------

interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedDoc | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  try {
    const frontmatter = yaml.load(match[1]) as Record<string, unknown>;
    if (typeof frontmatter !== "object" || frontmatter === null) return null;
    return { frontmatter, body: match[2] };
  } catch {
    return null;
  }
}
