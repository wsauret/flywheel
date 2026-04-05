/**
 * Session Persistence
 *
 * CRUD operations for session files stored in `.flywheel/sessions/<id>/session.json`.
 * Each session gets its own directory containing all related files.
 * Uses atomic writes (write → fsync → rename) and Zod validation on read.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionSchema, migrateSession, type Session } from "./schemas";
import { writeFileAtomic } from "../../workflows/shared/atomic-write";
import {
  SESSIONS_DIR,
  resolveSessionDir,
  resolveSessionFile,
  ensureSessionDir,
} from "../config/paths";
import { errorMessage } from "../../workflows/shared/error-message";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionsBaseDir(baseDir: string): string {
  return path.join(baseDir, SESSIONS_DIR);
}

function sessionFilePath(id: string, baseDir: string): string {
  return resolveSessionFile(id, "session", baseDir);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session. Writes session data to `.flywheel/sessions/<id>/session.json`.
 * Creates the session directory and handoffs/ subdirectory.
 *
 * @returns The generated UUID for the session.
 */
export function createSession(data: Session, baseDir: string): string {
  const id = crypto.randomUUID();

  // Create session directory structure
  ensureSessionDir(id, baseDir);

  const filePath = sessionFilePath(id, baseDir);

  // Validate before writing — fail fast on bad data
  const parsed = SessionSchema.parse(data);

  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
  return id;
}

/**
 * Read a session by ID.
 *
 * @returns The validated Session data, or `null` if the file doesn't exist,
 *          is corrupt, or fails Zod validation.
 */
export function readSession(id: string, baseDir: string): Session | null {
  const filePath = sessionFilePath(id, baseDir);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    const migrated = migrateSession(json);
    const result = SessionSchema.safeParse(migrated);

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
  updates: Partial<Session>,
  baseDir: string,
): void {
  const existing = readSession(id, baseDir);
  if (existing === null) {
    throw new Error(`Session not found: ${id}`);
  }

  const merged: Session = {
    ...existing,
    ...updates,
    lastUpdated: new Date().toISOString(),
  };

  // Validate the merged result
  const parsed = SessionSchema.parse(merged);
  const filePath = sessionFilePath(id, baseDir);
  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
}

/** Entry in the list result: session ID + validated data. */
interface SessionEntry {
  id: string;
  data: Session;
}

/** Per-file parse error for error isolation. */
interface SessionListError {
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
 * Reads each subdirectory's `session.json`, validates with Zod, and returns
 * the results. Corrupt or invalid entries are reported in `errors` but do
 * not prevent other sessions from being returned (per-entry error isolation).
 */
export function listSessions(baseDir: string): SessionListResult {
  const dir = sessionsBaseDir(baseDir);
  const sessions: SessionEntry[] = [];
  const errors: SessionListError[] = [];

  if (!fs.existsSync(dir)) {
    return { sessions, errors };
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const id = entry.name;
    const filePath = path.join(dir, id, "session.json");

    try {
      if (!fs.existsSync(filePath)) continue;

      const raw = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(raw);
      const migrated = migrateSession(json);
      const result = SessionSchema.safeParse(migrated);

      if (result.success) {
        sessions.push({ id, data: result.data });
      } else {
        errors.push({
          file: filePath,
          error: result.error.message,
        });
      }
    } catch (err: unknown) {
      const message = errorMessage(err);
      errors.push({ file: filePath, error: message });
    }
  }

  return { sessions, errors };
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
 * Delete a session and all its files.
 *
 * With directory-per-session layout, this simply removes the entire
 * session directory recursively.
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

  const dirPath = resolveSessionDir(id, baseDir);

  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      result.deleted.push(dirPath);
    }
  } catch (err: unknown) {
    const message = errorMessage(err);
    result.errors.push(`${dirPath}: ${message}`);
  }

  return result;
}
