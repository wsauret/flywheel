import { Redacted, Schema } from "effect";
import type { OAuthCredential } from "./auth-store-types.js";

export interface StoredTokens {
  accessToken: Redacted.Redacted<string>;
  /** Absent when the provider issued no refresh token. A refresh attempt
   *  without one fails with a clear error instead of sending a fabricated
   *  empty-string token. */
  refreshToken: Redacted.Redacted<string> | undefined;
  expiresAtMs: number;
  accountId?: string;
  /** Login-time display metadata. It is stored only as the credential instance identity. */
  email?: string;
}

// The on-disk auth-store `Credential` DTO is the one sanctioned plaintext
// serialization boundary (ARCH-BOUNDARIES-009): wrap immediately after
// reading a credential, unwrap only while building the credential to persist.
export function credentialToStoredTokens(cred: OAuthCredential): StoredTokens {
  return {
    accessToken: Redacted.make(cred.access),
    refreshToken: cred.refresh !== undefined ? Redacted.make(cred.refresh) : undefined,
    expiresAtMs: cred.expires,
    ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}),
  };
}

export function storedTokensToCredential(tokens: StoredTokens): OAuthCredential {
  return {
    type: "oauth",
    access: Redacted.value(tokens.accessToken),
    ...(tokens.refreshToken ? { refresh: Redacted.value(tokens.refreshToken) } : {}),
    expires: tokens.expiresAtMs,
    ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
  };
}

export type OpenAIAuth =
  | { kind: "apiKey"; apiKey: Redacted.Redacted<string> }
  | ({ kind: "chatgpt" } & StoredTokens);

// ID-token claims are an external provider payload, so the schema is a
// StructWithRest: it validates only the fields we read and tolerates the rest.
// This is shape validation, not signature/issuer verification (separate concern).
export const IdTokenClaimsSchema = Schema.StructWithRest(
  Schema.Struct({
    sub: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
    chatgpt_account_id: Schema.optionalKey(Schema.String),
    "https://api.openai.com/auth": Schema.optionalKey(
      Schema.Struct({
        chatgpt_account_id: Schema.optionalKey(Schema.String),
        organizations: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
      }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type IdTokenClaims = typeof IdTokenClaimsSchema.Type;

export const TokenResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.optionalKey(Schema.String),
    expires_in: Schema.Number,
    token_type: Schema.String,
    id_token: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

export type TokenResponse = typeof TokenResponseSchema.Type;

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";
/** The ChatGPT subscription's backend API. The path segment is the backend's own name for this API. */
export const CHATGPT_BACKEND_API_BASE = "https://chatgpt.com/backend-api/codex";
/** The prefix of the ChatGPT backend's rate-limit response headers, such as `<prefix>-primary-used-percent`. */
export const CHATGPT_RATE_LIMIT_HEADER_PREFIX = "x-codex";
export const OAUTH_PORT = 1455;
export const CHATGPT_SCOPES = "openid profile email offline_access";
