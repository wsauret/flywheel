export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
}

/** Parse the token endpoint's JSON body. The server is outside our control,
 *  so every field is checked here and nowhere else. */
export function parseTokenPair(body: unknown): TokenPair {
  if (typeof body !== "object" || body === null) throw new Error("Token response is not an object");
  const record: Record<string, unknown> = { ...body };
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = record;
  if (typeof accessToken !== "string" || accessToken === "") throw new Error("Token response has no access_token");
  if (typeof refreshToken !== "string" || refreshToken === "") throw new Error("Token response has no refresh_token");
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Token response has no positive expires_in");
  }
  return { accessToken, refreshToken, expiresIn };
}
