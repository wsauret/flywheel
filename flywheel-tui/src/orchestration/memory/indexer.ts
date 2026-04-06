/**
 * ContextIndexer — discovers and indexes project context metadata.
 *
 * Scans conventions (AGENTS.md, CONTRIBUTING.md, etc.), standards
 * (docs/standards/*.md with frontmatter), and learnings (SES-Memory)
 * to produce `AvailableContext` metadata for prompt assembly.
 *
 * Lifecycle: `startIndexing()` builds index, `getRelevantContext()` queries,
 * `dispose()` cleans up timers and inner retriever.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter";
import type { AvailableContext, ContextEntry } from "../../workflows/schemas";
import type { StepType } from "../../workflows/queue/types";
import {
  DEFAULT_STANDARDS_DIR,
  DEFAULT_CONVENTION_FILES,
  CONFIG_DIRS,
} from "../../infra/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextQuery {
  stepType: StepType;
  stepDescription: string;
  tags?: string[];
}

export interface ContextIndexerOptions {
  standardsDir?: string;
  conventionFiles?: string[];
  refreshCadenceMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_CADENCE_MS = 60_000;

const HARDCODED_SUMMARIES: Record<string, string> = {
  "AGENTS.md": "Project architecture, commands, TUI states, and developer conventions",
};

// ---------------------------------------------------------------------------
// ContextIndexer
// ---------------------------------------------------------------------------

export class ContextIndexer {
  private readonly projectCwd: string;
  private readonly standardsDir: string;
  private readonly conventionFiles: string[];
  private readonly refreshCadenceMs: number;

  private conventions: ContextEntry[] = [];
  private standards: ContextEntry[] = [];
  private learnings: ContextEntry[] = [];

  private ready = false;

  constructor(projectCwd: string, options?: ContextIndexerOptions) {
    this.projectCwd = projectCwd;
    this.standardsDir = options?.standardsDir ?? DEFAULT_STANDARDS_DIR;
    this.conventionFiles = options?.conventionFiles ?? DEFAULT_CONVENTION_FILES;
    this.refreshCadenceMs = options?.refreshCadenceMs ?? DEFAULT_REFRESH_CADENCE_MS;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build all indices. Resolves when the first scan is complete.
   */
  async startIndexing(): Promise<void> {
    const [conventions, standards] = await Promise.all([
      this.scanConventions(),
      this.scanStandards(),
    ]);

    this.conventions = conventions;
    this.standards = standards;
    this.ready = true;
  }

  /**
   * Return context metadata. Returns empty arrays if not ready.
   */
  getRelevantContext(query: ContextQuery): AvailableContext {
    if (!this.ready) {
      return { conventions: [], standards: [], learnings: [] };
    }

    return {
      conventions: this.conventions.slice(0, 20),
      standards: this.standards.slice(0, 20),
      learnings: this.learnings.slice(0, 20),
    };
  }

  /**
   * Clean up.
   */
  dispose(): void {
    this.ready = false;
  }

  // -------------------------------------------------------------------------
  // Convention scanner
  // -------------------------------------------------------------------------

  private async scanConventions(): Promise<ContextEntry[]> {
    const entries: ContextEntry[] = [];

    // Scan configurable file list at project root
    for (const file of this.conventionFiles) {
      const absPath = join(this.projectCwd, file);
      if (existsSync(absPath)) {
        entries.push({
          name: file,
          path: file,
          summary: HARDCODED_SUMMARIES[file] ?? await this.firstContentLine(absPath),
        });
      }
    }

    // Scan config directories
    for (const configDir of CONFIG_DIRS) {
      const absDir = join(this.projectCwd, configDir);
      if (!existsSync(absDir)) continue;

      try {
        const files = await readdir(absDir);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const absPath = join(absDir, file);
          const relPath = configDir + file;
          entries.push({
            name: file,
            path: relPath,
            summary: await this.firstContentLine(absPath),
          });
        }
      } catch {
        // Skip unreadable directories
      }
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // Standards scanner
  // -------------------------------------------------------------------------

  private async scanStandards(): Promise<ContextEntry[]> {
    const entries: ContextEntry[] = [];
    const absDir = join(this.projectCwd, this.standardsDir);

    if (!existsSync(absDir)) return entries;

    let files: string[];
    try {
      files = (await readdir(absDir)).filter((f) => f.endsWith(".md"));
    } catch {
      return entries;
    }

    for (const file of files) {
      const absPath = join(absDir, file);
      try {
        const raw = await readFile(absPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        if (!parsed) continue; // Skip files without valid frontmatter

        const { frontmatter, body } = parsed;
        const name = typeof frontmatter.title === "string" && frontmatter.title
          ? frontmatter.title
          : file.replace(/\.md$/, "");

        let summary: string;
        if (typeof frontmatter.summary === "string" && frontmatter.summary) {
          summary = frontmatter.summary.slice(0, 100);
        } else {
          summary = this.firstContentLineFromBody(body).slice(0, 100);
        }

        entries.push({
          name,
          path: relative(this.projectCwd, absPath),
          summary,
        });
      } catch {
        // Skip unreadable files
      }
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Read file and return the first non-empty, non-heading line. */
  private async firstContentLine(absPath: string): Promise<string> {
    try {
      const raw = await readFile(absPath, "utf-8");
      return this.firstContentLineFromBody(raw).slice(0, 100);
    } catch {
      return "";
    }
  }

  /** Return the first non-empty, non-heading line from a body string. */
  private firstContentLineFromBody(body: string): string {
    const lines = body.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return trimmed;
      }
    }
    return "";
  }

}
