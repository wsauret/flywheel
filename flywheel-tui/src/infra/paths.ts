/**
 * Centralized path constants for the flywheel-tui codebase.
 *
 * Single source of truth for ALL paths.
 *
 * Session files live in `.flywheel/sessions/<session-id>/` with simple names:
 *   session.json, plan.json, research.md, review.md, output.json,
 *   transcript.jsonl, queue.json, context.json
 *
 * Handoffs live in `.flywheel/sessions/<session-id>/handoffs/` with
 * descriptive names: plan_draft.json, work_<step-id>.json, etc.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Internal .flywheel/ state directories
// ---------------------------------------------------------------------------

const FLYWHEEL_DIR = ".flywheel";
export const SESSIONS_DIR = `${FLYWHEEL_DIR}/sessions`;
const LIBRARY_DIR = `${FLYWHEEL_DIR}/library`;
export const LOG_DIR = `${FLYWHEEL_DIR}/log`;
const CACHE_DIR = `${FLYWHEEL_DIR}/cache`;
export const SUBPROCESS_LOG_DIR = `${FLYWHEEL_DIR}/subprocess-logs`;
export const TRACES_DIR = `${FLYWHEEL_DIR}/traces`;

// ---------------------------------------------------------------------------
// Global directories (cross-session)
// ---------------------------------------------------------------------------

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
// Session directory helpers
// ---------------------------------------------------------------------------

/** Returns the directory for a session: `.flywheel/sessions/<id>` */
export function sessionDir(sessionId: string): string {
  return `${SESSIONS_DIR}/${sessionId}`;
}

/** Returns the handoffs subdirectory for a session: `.flywheel/sessions/<id>/handoffs` */
function sessionHandoffsDir(sessionId: string): string {
  return `${sessionDir(sessionId)}/handoffs`;
}

/** Resolves an absolute session directory path. */
export function resolveSessionDir(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, sessionDir(sessionId));
}

/** Resolves an absolute session handoffs directory path. */
export function resolveSessionHandoffsDir(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId));
}

/**
 * Ensure the session directory and its handoffs/ subdirectory exist.
 * Idempotent — safe to call multiple times.
 */
export function ensureSessionDir(sessionId: string, baseDir: string): void {
  const handoffsPath = resolveSessionHandoffsDir(sessionId, baseDir);
  fs.mkdirSync(handoffsPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Session file path helpers
// ---------------------------------------------------------------------------

/** Well-known file names within a session directory. */
const SESSION_FILES = {
  session: "session.json",
  plan: "plan.json",
  research: "research.md",
  review: "review.md",
  output: "output.json",
  transcript: "transcript.jsonl",
  queue: "queue.json",
  context: "context.json",
} as const;

/** Returns absolute path to a well-known session file. */
export function resolveSessionFile(
  sessionId: string,
  file: keyof typeof SESSION_FILES,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionDir(sessionId), SESSION_FILES[file]);
}

// ---------------------------------------------------------------------------
// Handoff path helpers
// ---------------------------------------------------------------------------

/**
 * Build a handoff file path for a subprocess step.
 * Pattern: `.flywheel/sessions/<session-id>/handoffs/<type>_<step-id>.json`
 */
export function buildSubprocessHandoffPath(
  sessionId: string,
  stepType: string,
  stepId: string,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId), `${stepType}_${stepId}.json`);
}

/**
 * Build a handoff file path for a dispatcher invocation.
 * Pattern: `.flywheel/sessions/<session-id>/handoffs/dispatcher_<invocation-id>.json`
 */
export function buildDispatcherHandoffPath(
  sessionId: string,
  invocationId: string,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId), `dispatcher_${invocationId}.json`);
}

/**
 * Build a handoff file path for an evaluator invocation.
 * Pattern: `.flywheel/sessions/<session-id>/handoffs/evaluator_<invocation-id>.json`
 */
export function buildEvaluatorHandoffPath(
  sessionId: string,
  invocationId: string,
  baseDir: string,
): string {
  return path.resolve(baseDir, sessionHandoffsDir(sessionId), `evaluator_${invocationId}.json`);
}

// ---------------------------------------------------------------------------
// Trace file path helpers
// ---------------------------------------------------------------------------

/** Returns absolute path to a session's trace file: `.flywheel/traces/<session-id>.jsonl` */
export function resolveTraceFile(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.jsonl`);
}

/**
 * Returns absolute path to a session's transcript file: `.flywheel/traces/<session-id>.ndjson`
 *
 * This is the permanent transcript in the global traces directory, distinct from
 * `SESSION_FILES.transcript` which is session-scoped and lives under
 * `.flywheel/sessions/<id>/transcript.jsonl`.
 */
export function resolveTranscriptFile(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.ndjson`);
}
