/**
 * Session Persistence
 *
 * CRUD operations for session files stored in `.flywheel/sessions/<uuid>.json`.
 * Uses atomic writes (write → fsync → rename) and Zod validation on read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CliSessionSchema, type CliSession } from "../schemas/session";
import { writeFileAtomic } from "../utils/atomic-write";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = ".flywheel/sessions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionsDir(baseDir: string): string {
  return path.join(baseDir, SESSIONS_DIR);
}

function sessionFilePath(id: string, baseDir: string): string {
  return path.join(sessionsDir(baseDir), `${id}.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session. Writes session data to `.flywheel/sessions/<uuid>.json`.
 *
 * @returns The generated UUID for the session.
 */
export function createSession(data: CliSession, baseDir: string): string {
  const id = crypto.randomUUID();
  const filePath = sessionFilePath(id, baseDir);

  // Validate before writing — fail fast on bad data
  const parsed = CliSessionSchema.parse(data);

  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
  return id;
}

/**
 * Read a session by ID.
 *
 * @returns The validated CliSession data, or `null` if the file doesn't exist,
 *          is corrupt, or fails Zod validation.
 */
export function readSession(id: string, baseDir: string): CliSession | null {
  const filePath = sessionFilePath(id, baseDir);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    const result = CliSessionSchema.safeParse(json);

    if (!result.success) {
      return null;
    }

    return result.data;
  } catch {
    return null;
  }
}

/**
 * Update a session with a partial set of fields. Performs an atomic
 * read-modify-write cycle. Automatically updates `lastUpdated`.
 *
 * @throws If the session does not exist or the file is corrupt.
 */
export function updateSession(
  id: string,
  updates: Partial<CliSession>,
  baseDir: string,
): void {
  const existing = readSession(id, baseDir);
  if (existing === null) {
    throw new Error(`Session not found: ${id}`);
  }

  const merged: CliSession = {
    ...existing,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };

  // Validate the merged result
  const parsed = CliSessionSchema.parse(merged);
  const filePath = sessionFilePath(id, baseDir);
  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
}

/** Entry in the list result: session ID + validated data. */
export interface SessionEntry {
  id: string;
  data: CliSession;
}

/** Per-file parse error for error isolation. */
export interface SessionListError {
  file: string;
  error: string;
}

/** Result of listing sessions. */
export interface SessionListResult {
  sessions: SessionEntry[];
  errors: SessionListError[];
}

/**
 * List all sessions in `.flywheel/sessions/`.
 *
 * Reads every `.json` file, validates with Zod, and returns the results.
 * Corrupt or invalid files are reported in `errors` but do not prevent
 * other sessions from being returned (per-file error isolation).
 */
export function listSessions(baseDir: string): SessionListResult {
  const dir = sessionsDir(baseDir);
  const sessions: SessionEntry[] = [];
  const errors: SessionListError[] = [];

  if (!fs.existsSync(dir)) {
    return { sessions, errors };
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    // Only process .json files
    if (!file.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(dir, file);
    const id = file.replace(/\.json$/, "");

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(raw);
      const result = CliSessionSchema.safeParse(json);

      if (result.success) {
        sessions.push({ id, data: result.data });
      } else {
        errors.push({
          file: filePath,
          error: result.error.message,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ file: filePath, error: message });
    }
  }

  return { sessions, errors };
}

/**
 * Delete a session by ID.
 *
 * @returns `true` if the file was deleted, `false` if it didn't exist.
 */
export function deleteSession(id: string, baseDir: string): boolean {
  const filePath = sessionFilePath(id, baseDir);

  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delete with companion file cleanup
// ---------------------------------------------------------------------------

/** Result of a deleteSessionWithCompanions call. */
export interface DeleteResult {
  deleted: string[];
  errors: string[];
}

/**
 * Delete a session and all its companion files (state, context, output).
 *
 * Reads the session JSON first to discover companion paths. Falls back to
 * convention-based output path (`<id>.output.json`) if the JSON is unreadable.
 * Deletes companions first, then the session JSON last.
 *
 * @param id - The session UUID.
 * @param baseDir - The project root directory.
 * @param activeSessionId - If provided, deletion is refused when `id` matches.
 * @returns `{ deleted, errors }` for partial failure reporting.
 */
export function deleteSessionWithCompanions(
  id: string,
  baseDir: string,
  activeSessionId?: string | null,
): DeleteResult {
  const result: DeleteResult = { deleted: [], errors: [] };

  // Guard: don't delete the currently active session
  if (activeSessionId && id === activeSessionId) {
    result.errors.push("Cannot delete the currently active session");
    return result;
  }

  // Read session JSON first to get companion paths
  const session = readSession(id, baseDir);

  // Collect companion paths to delete (before the JSON itself)
  const toDelete: string[] = [];

  if (session) {
    if (session.statePath) {
      toDelete.push(path.resolve(baseDir, session.statePath));
    }
    if (session.contextPath) {
      toDelete.push(path.resolve(baseDir, session.contextPath));
    }
    if (session.outputPath) {
      toDelete.push(path.join(sessionsDir(baseDir), session.outputPath));
    }
  }

  // Convention-based output path fallback (always attempt if not already listed)
  const conventionOutput = path.join(sessionsDir(baseDir), `${id}.output.json`);
  if (!toDelete.includes(conventionOutput)) {
    toDelete.push(conventionOutput);
  }

  // Delete companion files
  for (const filePath of toDelete) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        result.deleted.push(filePath);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${filePath}: ${message}`);
    }
  }

  // Delete session JSON last
  const jsonPath = sessionFilePath(id, baseDir);
  try {
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      result.deleted.push(jsonPath);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`${jsonPath}: ${message}`);
  }

  return result;
}
