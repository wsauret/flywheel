import { isExpired, type SessionRepo } from "../auth/sessions";

export interface SessionRow {
  readonly id: string;
  readonly signedInAt: string;
}

/** The "Where you're signed in" list on the account page. */
export async function activeSessions(repo: SessionRepo, userId: string, now: number = Date.now()): Promise<SessionRow[]> {
  const sessions = await repo.forUser(userId);
  return sessions
    .filter((session) => !isExpired(session, now))
    .map((session) => ({ id: session.id, signedInAt: new Date(session.createdAt).toISOString() }));
}
