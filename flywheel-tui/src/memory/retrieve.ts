/**
 * SES-Memory retriever — indexes and queries cross-session learnings.
 *
 * Reads compound docs from `docs/solutions/`, builds an in-memory tag index,
 * and returns ranked results by tag match count.
 *
 * Uses stat-based file watching (fs.watchFile) for macOS reliability,
 * with a TTL-based fallback re-read interval.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter";

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
   *
   * When tags is empty with Infinity maxResults, returns all entries (used by ContextIndexer).
   */
  retrieve(tags: string[], maxResults?: number): LearningEntry[] {
    if (!this.ready) return [];

    // Special case: empty tags with Infinity returns all entries
    if (tags.length === 0) {
      const limit = maxResults ?? 0;
      return this.entries.slice(0, limit === Infinity ? undefined : limit);
    }

    const normalizedTags = tags.map((t) => t.toLowerCase().trim());

    // Use tagIndex for O(tags x fanout) instead of O(n x m)
    const scores = new Map<number, number>();
    for (const tag of normalizedTags) {
      const indices = this.tagIndex.get(tag);
      if (indices) {
        for (const idx of indices) {
          scores.set(idx, (scores.get(idx) ?? 0) + 1);
        }
      }
    }

    const sorted = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults ?? scores.size)
      .map(([idx]) => this.entries[idx]);

    return sorted;
  }

  /**
   * Return the set of all extraction_hash values from indexed entries.
   * Uses the warm in-memory index — no disk I/O.
   */
  getHashes(): Set<string> {
    return new Set(this.entries.map((e) => e.hash).filter(Boolean));
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

    let allFiles: string[];
    try {
      allFiles = (await readdir(this.solutionsDir)).filter((f: string) => f.endsWith(".md"));
    } catch {
      return;
    }

    // Parallel file reads
    const fileContents = await Promise.all(
      allFiles.map(async (file) => {
        const filePath = join(this.solutionsDir, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          return { filePath, raw };
        } catch {
          return null;
        }
      }),
    );

    for (const result of fileContents) {
      if (!result) continue;

      const parsed = parseFrontmatter(result.raw);
      if (!parsed) continue;

      const { frontmatter, body } = parsed;

      const entry: LearningEntry = {
        title: String(frontmatter.title ?? ""),
        tags: Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map(String)
          : [],
        hash: String(frontmatter.extraction_hash ?? ""),
        filePath: result.filePath,
        content: body.slice(0, 500),
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
    }

    this.entries = entries;
    this.tagIndex = tagIndex;
  }
}


