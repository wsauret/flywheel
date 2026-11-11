import { ReadThroughCache } from "./cache.ts";
import type { Clock, Session, SessionStore } from "./types.ts";

const SESSION_CACHE_TTL_MS = 60_000;

/** Session ids are the part of the bearer token before the first dot. */
export function sessionIdOf(token: string): string | undefined {
  const dot = token.indexOf(".");
  return dot > 0 ? token.slice(0, dot) : undefined;
}

export class SessionAuth {
  private readonly cache: ReadThroughCache<Session | null>;

  constructor(
    private readonly store: SessionStore,
    private readonly clock: Clock,
  ) {
    this.cache = new ReadThroughCache(SESSION_CACHE_TTL_MS, clock);
  }

  /** The live session for a bearer token, or null when it is unknown,
   *  revoked, or expired. */
  async authorize(token: string): Promise<Session | null> {
    const id = sessionIdOf(token);
    if (id === undefined) return null;
    const session = await this.cache.get(id, () => this.store.find(id));
    if (session === null || session.revoked) return null;
    if (session.expiresAt <= this.clock.now()) return null;
    return session;
  }

  /** Revoke a session. Once this resolves, the session no longer authorizes. */
  async revoke(id: string): Promise<void> {
    await this.store.markRevoked(id);
    this.cache.invalidate(id);
  }
}
