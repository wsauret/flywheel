import type { Session, SessionStore } from "./types.ts";

/** The narrow query surface the store needs from the database driver. */
export interface Database {
  query<Row>(sql: string, params: readonly unknown[]): Promise<Row[]>;
  execute(sql: string, params: readonly unknown[]): Promise<void>;
}

interface SessionRow {
  id: string;
  user_id: string;
  revoked: number;
  expires_at: number;
}

export class SqlSessionStore implements SessionStore {
  constructor(private readonly db: Database) {}

  async find(id: string): Promise<Session | null> {
    const [row] = await this.db.query<SessionRow>("SELECT id, user_id, revoked, expires_at FROM sessions WHERE id = ?", [id]);
    if (row === undefined) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked === 1, expiresAt: row.expires_at };
  }

  async markRevoked(id: string): Promise<void> {
    await this.db.execute("UPDATE sessions SET revoked = 1 WHERE id = ?", [id]);
  }
}
