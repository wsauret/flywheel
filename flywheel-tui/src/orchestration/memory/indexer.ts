import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { AvailableContext, ContextEntry } from "../../workflows/schemas.js";
import {
  DEFAULT_STANDARDS_DIR,
  DEFAULT_CONVENTION_FILES,
  CONFIG_DIRS,
} from "../../infra/paths.js";

const MAX_ENTRIES_PER_CATEGORY = 20;

const HARDCODED_SUMMARIES: Record<string, string> = {
  "AGENTS.md": "Project architecture, commands, TUI states, and developer conventions",
};

export class ContextIndexer {
  private readonly projectCwd: string;
  private readonly standardsDir: string;
  private readonly conventionFiles: string[];

  private conventions: ContextEntry[] = [];
  private standards: ContextEntry[] = [];

  private ready = false;

  constructor(projectCwd: string, options?: { standardsDir?: string; conventionFiles?: string[] }) {
    this.projectCwd = projectCwd;
    this.standardsDir = options?.standardsDir ?? DEFAULT_STANDARDS_DIR;
    this.conventionFiles = options?.conventionFiles ?? DEFAULT_CONVENTION_FILES;
  }

  async startIndexing(): Promise<void> {
    const [conventions, standards] = await Promise.all([
      this.scanConventions(),
      this.scanStandards(),
    ]);

    this.conventions = conventions;
    this.standards = standards;
    this.ready = true;
  }

  getRelevantContext(): AvailableContext {
    if (!this.ready) {
      return { conventions: [], standards: [] };
    }

    return {
      conventions: this.conventions.slice(0, MAX_ENTRIES_PER_CATEGORY),
      standards: this.standards.slice(0, MAX_ENTRIES_PER_CATEGORY),
    };
  }

  private async scanConventions(): Promise<ContextEntry[]> {
    const entries: ContextEntry[] = [];

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

    for (const configDir of CONFIG_DIRS) {
      const absDir = join(this.projectCwd, configDir);
      if (!existsSync(absDir)) continue;

      try {
        const files = await readdir(absDir);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          entries.push({
            name: file,
            path: configDir + file,
            summary: await this.firstContentLine(join(absDir, file)),
          });
        }
      } catch {
        // Skip unreadable directories
      }
    }

    return entries;
  }

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
        if (!parsed) continue;

        const { frontmatter, body } = parsed;
        const name = typeof frontmatter.title === "string" && frontmatter.title
          ? frontmatter.title
          : file.replace(/\.md$/, "");

        const summary = typeof frontmatter.summary === "string" && frontmatter.summary
          ? frontmatter.summary.slice(0, 100)
          : extractFirstContentLine(body).slice(0, 100);

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

  private async firstContentLine(absPath: string): Promise<string> {
    try {
      const raw = await readFile(absPath, "utf-8");
      return extractFirstContentLine(raw).slice(0, 100);
    } catch {
      return "";
    }
  }
}

function extractFirstContentLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}
