const MAX_OAUTH_TOKEN_LIFETIME_SECONDS = 31 * 24 * 60 * 60

/** Converts a provider lifetime to a finite, safely serializable expiry. */
export function oauthExpiryFromLifetimeSeconds(seconds: number, now = Date.now()): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_OAUTH_TOKEN_LIFETIME_SECONDS) return undefined
  const expiresAtMs = now + seconds * 1000
  return Number.isSafeInteger(expiresAtMs) ? expiresAtMs : undefined
}

/** Converts an absolute Unix expiry while rejecting implausible token lifetimes. */
export function oauthExpiryFromUnixSeconds(seconds: number, now = Date.now()): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  const expiresAtMs = seconds * 1000
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) return undefined
  return expiresAtMs - now <= MAX_OAUTH_TOKEN_LIFETIME_SECONDS * 1000 ? expiresAtMs : undefined
}
