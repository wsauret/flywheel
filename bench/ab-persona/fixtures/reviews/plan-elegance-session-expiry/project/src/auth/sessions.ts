export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  readonly id: string;
  readonly userId: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
}

export interface SessionRepo {
  insert(session: Session): Promise<void>;
  byId(id: string): Promise<Session | undefined>;
  forUser(userId: string): Promise<Session[]>;
  deleteCreatedBefore(cutoff: number): Promise<number>;
}

export function isExpired(session: Session, now: number): boolean {
  return now >= session.createdAt + SESSION_TTL_MS;
}

export async function createSession(repo: SessionRepo, userId: string, now: number): Promise<Session> {
  const session = { id: crypto.randomUUID(), userId, createdAt: now };
  await repo.insert(session);
  return session;
}
