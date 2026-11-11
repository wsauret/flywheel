import type { ApiClient } from "./api-client.ts";
import type { TokenPair } from "./tokens.ts";

export interface Session {
  userId: string;
  tokens: TokenPair;
  obtainedAt: number;
}

/** Access tokens are refreshed this long before they expire, so a request
 *  never leaves with a token that dies in flight. */
const EXPIRY_MARGIN_MS = 30_000;

/** The signed-in session. The sign-in screen writes it; everything else reads it. */
export class SessionStore {
  private current: Session | undefined;
  private client: ApiClient | undefined;

  constructor(private readonly clock: () => number = Date.now) {}

  attach(client: ApiClient): void {
    this.client = client;
    client.setAccessToken(this.current?.tokens.accessToken);
  }

  get(): Session | undefined {
    return this.current;
  }

  isExpiring(): boolean {
    if (this.current === undefined) return false;
    const expiresAt = this.current.obtainedAt + this.current.tokens.expiresIn * 1000;
    return this.clock() >= expiresAt - EXPIRY_MARGIN_MS;
  }

  signIn(userId: string, tokens: TokenPair): void {
    this.current = { userId, tokens, obtainedAt: this.clock() };
    this.client?.setAccessToken(tokens.accessToken);
  }

  /** Install refreshed tokens into the session the refresh started from. A
   *  sign-out or a new sign-in that lands while the refresh is in flight wins:
   *  the refreshed tokens are dropped. */
  replaceTokens(from: Session, tokens: TokenPair): void {
    if (this.current !== from) return;
    this.current = { ...from, tokens, obtainedAt: this.clock() };
    this.client?.setAccessToken(tokens.accessToken);
  }

  signOut(): void {
    this.current = undefined;
    this.client?.setAccessToken(undefined);
  }
}
