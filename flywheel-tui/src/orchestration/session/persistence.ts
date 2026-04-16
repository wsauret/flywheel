import * as fs from "node:fs";
import * as path from "node:path";
import { SessionSchema, type Session } from "./schemas.js";
import { writeFileAtomic } from "../../infra/atomic-write.js";
import {
  SESSIONS_DIR,
  resolveSessionDir,
  resolveSessionFile,
  ensureSessionDir,
} from "../../infra/paths.js";
import { errorMessage } from "../../infra/error-message.js";

function sessionsBaseDir(baseDir: string) {
  return path.join(baseDir, SESSIONS_DIR);
}

function sessionFilePath(id: string, baseDir: string) {
  return resolveSessionFile(id, "session", baseDir);
}

export function createSession(data: Session, baseDir: string): string {
  const id = crypto.randomUUID();

  ensureSessionDir(id, baseDir);
  const filePath = sessionFilePath(id, baseDir);
  const parsed = SessionSchema.parse(data);

  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
  return id;
}

export function readSession(id: string, baseDir: string): Session | null {
  const filePath = sessionFilePath(id, baseDir);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const result = SessionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function updateSession(
  id: string,
  updates: Partial<Session>,
  baseDir: string,
): void {
  const existing = readSession(id, baseDir);
  if (existing === null) {
    throw new Error(`Session not found: ${id}`);
  }

  if (updates.kind && updates.kind !== existing.kind) {
    throw new Error(`Cannot change session kind from "${existing.kind}" to "${updates.kind}"`);
  }

  // NOTE: `Partial<Session>` distributes across the discriminated union,
  // so the spread result is too wide for TypeScript to narrow statically.
  // We rely on Zod's runtime parse to validate the merged object — `existing`
  // always carries `kind`, preserving the discriminant.
  const merged = { ...existing, ...updates, lastUpdated: new Date().toISOString() };
  const parsed = SessionSchema.parse(merged);
  const filePath = sessionFilePath(id, baseDir);
  writeFileAtomic(filePath, JSON.stringify(parsed, null, 2));
}

interface SessionEntry {
  id: string;
  data: Session;
}

interface SessionListError {
  file: string;
  error: string;
}

export interface SessionListResult {
  sessions: SessionEntry[];
  errors: SessionListError[];
}

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
      const result = SessionSchema.safeParse(JSON.parse(raw));

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

export function deleteSessionWithCompanions(
  id: string,
  baseDir: string,
): void {
  const dirPath = resolveSessionDir(id, baseDir);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}
