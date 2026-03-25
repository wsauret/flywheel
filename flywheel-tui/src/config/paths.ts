/**
 * Centralized path constants for the flywheel-tui codebase.
 *
 * Single source of truth for ALL paths. Internal state directories are
 * constants; user-facing output directories have defaults that can be
 * overridden via `[paths]` in `flywheel.toml`.
 */

// ---------------------------------------------------------------------------
// Internal .flywheel/ state directories (not configurable)
// ---------------------------------------------------------------------------

export const FLYWHEEL_DIR = ".flywheel";
export const SESSIONS_DIR = `${FLYWHEEL_DIR}/sessions`;
export const HANDOFFS_DIR = `${FLYWHEEL_DIR}/handoffs`;
export const LIBRARY_DIR = `${FLYWHEEL_DIR}/library`;
export const LOG_DIR = `${FLYWHEEL_DIR}/log`;
export const CACHE_DIR = `${FLYWHEEL_DIR}/cache`;
export const SES_DRAFTS_DIR = `${CACHE_DIR}/ses-drafts`;
export const SUBPROCESS_LOG_DIR = `${FLYWHEEL_DIR}/subprocess-logs`;
export const LOCK_DIR = FLYWHEEL_DIR;

// ---------------------------------------------------------------------------
// User-facing output directories (defaults, overridable via flywheel.toml)
// ---------------------------------------------------------------------------

export const DEFAULT_PLANS_DIR = `${FLYWHEEL_DIR}/plans`;
export const DEFAULT_RESEARCH_DIR = `${FLYWHEEL_DIR}/research`;
export const DEFAULT_REVIEWS_DIR = `${FLYWHEEL_DIR}/reviews`;
export const DEFAULT_SOLUTIONS_DIR = `${FLYWHEEL_DIR}/solutions`;
export const DEFAULT_STANDARDS_DIR = "docs/standards";

// ---------------------------------------------------------------------------
// Convention files
// ---------------------------------------------------------------------------

export const DEFAULT_CONVENTION_FILES = ["AGENTS.md", "CONTRIBUTING.md", "DEVELOPMENT.md"];

// ---------------------------------------------------------------------------
// Config directories
// ---------------------------------------------------------------------------

export const CONFIG_DIRS = [".claude/", ".opencode/"];

// ---------------------------------------------------------------------------
// Config file search order
// ---------------------------------------------------------------------------

export const CONFIG_FILES = ["flywheel.toml", ".flywheel.toml"];

// ---------------------------------------------------------------------------
// Output path resolution helper
// ---------------------------------------------------------------------------

export interface OutputPaths {
  plans: string;
  research: string;
  reviews: string;
  solutions: string;
  standards: string;
}

export function resolveOutputPaths(configOverrides?: Partial<OutputPaths>): OutputPaths {
  return {
    plans: configOverrides?.plans ?? DEFAULT_PLANS_DIR,
    research: configOverrides?.research ?? DEFAULT_RESEARCH_DIR,
    reviews: configOverrides?.reviews ?? DEFAULT_REVIEWS_DIR,
    solutions: configOverrides?.solutions ?? DEFAULT_SOLUTIONS_DIR,
    standards: configOverrides?.standards ?? DEFAULT_STANDARDS_DIR,
  };
}

// ---------------------------------------------------------------------------
// Directory creation helpers
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ensure the shared knowledge library directory exists.
 *
 * Creates `.flywheel/library/` under `projectCwd` if it doesn't already exist.
 * Uses `recursive: true` so the parent `.flywheel/` directory is also created
 * if needed. Idempotent — safe to call multiple times.
 *
 * Adapts Droid's `.factory/library/` pattern for inter-worker knowledge sharing.
 */
export function ensureLibraryDir(projectCwd: string): void {
  const libraryPath = path.resolve(projectCwd, LIBRARY_DIR);
  fs.mkdirSync(libraryPath, { recursive: true });
}
