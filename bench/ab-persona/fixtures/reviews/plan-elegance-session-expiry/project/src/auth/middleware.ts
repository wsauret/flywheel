import { isExpired, type Session, type SessionRepo } from "./sessions";

export function sessionId(request: Request): string | undefined {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
}

/** The session of a request, or undefined when it has none or it has expired. */
export async function requireSession(request: Request, repo: SessionRepo, now: number = Date.now()): Promise<Session | undefined> {
  const id = sessionId(request);
  if (id === undefined) return undefined;
  const session = await repo.byId(id);
  return session === undefined || isExpired(session, now) ? undefined : session;
}
