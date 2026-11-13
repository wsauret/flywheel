import { SESSION_TTL_MS, type SessionRepo } from "../auth/sessions";

/** Hourly: delete the sessions that have expired. Returns how many were deleted. */
export async function sweepSessions(repo: SessionRepo, now: number = Date.now()): Promise<number> {
  return repo.deleteCreatedBefore(now - SESSION_TTL_MS);
}
