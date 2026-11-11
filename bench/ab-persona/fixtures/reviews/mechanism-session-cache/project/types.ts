export interface Session {
  id: string;
  userId: string;
  revoked: boolean;
  expiresAt: number;
}

export interface SessionStore {
  /** Read the current row, or null when no session has this id. */
  find(id: string): Promise<Session | null>;
  markRevoked(id: string): Promise<void>;
}

export interface Clock {
  now(): number;
}
