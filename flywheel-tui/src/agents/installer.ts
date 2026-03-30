// ---------------------------------------------------------------------------
// Agent Installer — syncs persona files to engine-specific discovery paths
// ---------------------------------------------------------------------------
//
// Both supported engines discover agents from filesystem directories:
//
//   Claude Code:  ~/.claude/agents/fly/*.md     (global)
//   OpenCode:     ~/.config/opencode/agents/fly/*.md  (global)
//
// This module copies the bundled persona .md files from the repo into both
// locations so that when a flywheel worker is spawned (regardless of engine),
// its Task tool can resolve `fly/reviewer-architecture` etc. natively.
//
// The installer is idempotent: it overwrites existing files (to pick up
// updates) and skips gracefully on permission errors.
//
// IMPORTANT: The source persona files use Claude Code frontmatter format
// (tools as array, name/skills keys, short model names). OpenCode uses a
// different format, so we apply the same transformations as install_opencode.py:
//   - Strip `name`, `tools`, `skills` keys
//   - Add `mode: subagent`
//   - Map short model names to full Anthropic model IDs
// ---------------------------------------------------------------------------

import { mkdir, readdir, readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { Log } from "../utils/log.js";

const log = Log.create({ service: "agent-installer" });

// ---------------------------------------------------------------------------
// OpenCode frontmatter transforms (mirrors install_opencode.py logic)
// ---------------------------------------------------------------------------

/** Map short model names to full OpenCode model IDs. */
const OPENCODE_MODEL_MAP: Record<string, string> = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-6",
};

/** Frontmatter keys to strip for OpenCode agents. */
const OPENCODE_STRIP_KEYS = ["name", "tools", "skills"];

/**
 * Transform Claude Code agent frontmatter to OpenCode format.
 *
 * - Strips `name`, `tools`, `skills` keys (including multiline blocks)
 * - Maps short model names (haiku/sonnet/opus) to full Anthropic IDs
 * - Adds `mode: subagent`
 */
export function transformForOpenCode(content: string): string {
  // Only transform files with frontmatter
  if (!content.startsWith("---\n")) return content;

  const parts = content.split("---\n", 3);
  if (parts.length < 3) return content;

  // parts[0] is empty (before first ---), parts[1] is frontmatter, parts[2] is body
  const fmLines = parts[1].split("\n");
  const resultLines: string[] = [];
  let inBlock = false;

  for (const line of fmLines) {
    // Check if this line starts a key we want to strip
    if (OPENCODE_STRIP_KEYS.some((key) => line.startsWith(`${key}:`))) {
      // Inline array (ends with ]) is a single line; otherwise it's a multiline block
      inBlock = !line.trimEnd().endsWith("]");
      continue;
    }

    // Skip indented continuation lines of a multiline block
    if (inBlock) {
      if (line.startsWith("  ") || line.startsWith("\t")) {
        continue;
      }
      inBlock = false;
    }

    // Map short model names to full OpenCode model IDs
    if (line.startsWith("model:")) {
      const shortName = line.split(":", 2)[1].trim();
      if (shortName in OPENCODE_MODEL_MAP) {
        resultLines.push(`model: ${OPENCODE_MODEL_MAP[shortName]}`);
        continue;
      }
    }

    resultLines.push(line);
  }

  // Remove trailing empty lines before adding mode: subagent
  while (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() === "") {
    resultLines.pop();
  }

  // Add mode: subagent
  resultLines.push("mode: subagent");

  return `---\n${resultLines.join("\n")}\n---\n${parts[2]}`;
}

// ---------------------------------------------------------------------------
// Install targets — where each engine discovers custom agents
// ---------------------------------------------------------------------------

interface InstallTarget {
  engine: string;
  dir: string;
  /** Optional content transform applied before writing. */
  transform?: (content: string) => string;
}

function getInstallTargets(): InstallTarget[] {
  const home = homedir();
  return [
    { engine: "claude", dir: join(home, ".claude", "agents", "fly") },
    {
      engine: "opencode",
      dir: join(home, ".config", "opencode", "agents", "fly"),
      transform: transformForOpenCode,
    },
  ];
}

// ---------------------------------------------------------------------------
// Source directory — bundled personas in the repo
// ---------------------------------------------------------------------------

function getSourceDir(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return join(thisDir, "personas", "fly");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InstallResult {
  installed: number;
  skipped: number;
  errors: string[];
}

/**
 * Install agent persona files to all engine discovery paths.
 *
 * - Creates target directories if they don't exist
 * - Overwrites existing files (to pick up updates)
 * - Skips files that are already identical (content hash match)
 * - Continues on individual file errors
 *
 * Returns a summary of what happened.
 */
export async function installAgents(): Promise<InstallResult> {
  const sourceDir = getSourceDir();
  const targets = getInstallTargets();
  let installed = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Read all source persona files
  let sourceFiles: string[];
  try {
    sourceFiles = (await readdir(sourceDir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const msg = `failed to read source personas: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { installed: 0, skipped: 0, errors: [msg] };
  }

  if (sourceFiles.length === 0) {
    log.warn("no persona files found in source directory", { dir: sourceDir });
    return { installed: 0, skipped: 0, errors: [] };
  }

  // Read all source content upfront
  const sourceContents = new Map<string, string>();
  for (const file of sourceFiles) {
    try {
      sourceContents.set(file, await readFile(join(sourceDir, file), "utf-8"));
    } catch (err) {
      errors.push(`failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Install to each target
  for (const target of targets) {
    try {
      await mkdir(target.dir, { recursive: true });
    } catch (err) {
      const msg = `failed to create ${target.engine} agents dir ${target.dir}: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(msg);
      errors.push(msg);
      continue;
    }

    for (const [file, sourceContent] of sourceContents) {
      const destPath = join(target.dir, file);
      // Apply engine-specific transform if defined (e.g. OpenCode frontmatter)
      const content = target.transform ? target.transform(sourceContent) : sourceContent;
      try {
        // Check if file already exists with same content
        try {
          const existing = await readFile(destPath, "utf-8");
          if (existing === content) {
            skipped++;
            continue;
          }
        } catch {
          // File doesn't exist — will write
        }

        await writeFile(destPath, content, "utf-8");
        installed++;
      } catch (err) {
        const msg = `failed to write ${target.engine}:${file}: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(msg);
        errors.push(msg);
      }
    }
  }

  log.info("agent installation complete", {
    installed,
    skipped,
    errors: errors.length,
    targets: targets.map((t) => t.engine),
  });

  return { installed, skipped, errors };
}

/**
 * Check whether agents are installed at the expected locations.
 * Returns the set of engines that have agents installed.
 */
export async function checkInstallation(): Promise<Map<string, boolean>> {
  const targets = getInstallTargets();
  const result = new Map<string, boolean>();

  for (const target of targets) {
    try {
      const s = await stat(target.dir);
      if (s.isDirectory()) {
        const files = await readdir(target.dir);
        const mdFiles = files.filter((f) => f.endsWith(".md"));
        result.set(target.engine, mdFiles.length > 0);
      } else {
        result.set(target.engine, false);
      }
    } catch {
      result.set(target.engine, false);
    }
  }

  return result;
}
