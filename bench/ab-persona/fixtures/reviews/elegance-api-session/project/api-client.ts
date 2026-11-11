import type { SessionStore } from "./session-store.ts";
import { parseTokenPair } from "./tokens.ts";
import type { HttpResponse, HttpTransport } from "./transport.ts";

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export class ApiError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`${path} failed with status ${status}`);
  }
}

export class ApiClient {
  private accessToken: string | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly store: SessionStore,
    private readonly http: HttpTransport,
  ) {
    store.attach(this);
  }

  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  /** GET a resource. An expiring token is refreshed first, and a 401 is
   *  retried once after a refresh, in case the server revoked the token early. */
  async get(path: string): Promise<unknown> {
    if (this.store.isExpiring()) await this.refresh();
    const response = await this.send(path);
    if (response.status !== 401 || this.store.get() === undefined) return this.unwrap(path, response);
    await this.refresh();
    return this.unwrap(path, await this.send(path));
  }

  private send(path: string): Promise<HttpResponse> {
    const headers: Record<string, string> = {};
    if (this.accessToken !== undefined) headers.authorization = `Bearer ${this.accessToken}`;
    return this.http.send({ method: "GET", url: `${this.baseUrl}${path}`, headers });
  }

  /** Concurrent callers share one refresh request. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.exchangeRefreshToken().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async exchangeRefreshToken(): Promise<void> {
    const session = this.store.get();
    if (session === undefined) return;
    const response = await this.http.send({
      method: "POST",
      url: `${this.baseUrl}/oauth/token`,
      headers: {},
      body: { grant_type: "refresh_token", refresh_token: session.tokens.refreshToken },
    });
    // invalid_grant: the refresh token was revoked, so the session cannot
    // recover. A session that replaced it meanwhile is left alone.
    if ((response.status === 400 || response.status === 401) && this.store.get() === session) this.store.signOut();
    const pair = parseTokenPair(this.unwrap("/oauth/token", response));
    this.store.replaceTokens(session, {
      ...pair,
      expiresIn: pair.expiresIn > 0 ? pair.expiresIn : DEFAULT_EXPIRES_IN_SECONDS,
    });
  }

  private unwrap(path: string, response: HttpResponse): unknown {
    if (response.status < 200 || response.status >= 300) throw new ApiError(path, response.status);
    return response.body;
  }
}
