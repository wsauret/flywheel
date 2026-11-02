import { Option, Schema } from "effect";
import { IdTokenClaimsSchema, type IdTokenClaims, type TokenResponse } from "./openai-auth-types.js";

// Shape validation only. JWT signature/issuer/expiry verification is a separate,
// required step (see openai-auth-types.ts). decodeUnknownOption returns None for
// both a malformed payload and a shape violation, so the absent-vs-malformed
// contract is explicit in the type instead of suppressed in a catch. accountId
// is optional billing identity downstream, so None collapses to "no accountId".
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaimsSchema));

function accountIdFromClaims(claims: IdTokenClaims): string | undefined {
  const nested = claims["https://api.openai.com/auth"];
  return claims.chatgpt_account_id ?? nested?.chatgpt_account_id ?? nested?.organizations?.[0]?.id;
}

function displayIdentityFromClaims(claims: IdTokenClaims): string | undefined {
  return claims.email ?? accountIdFromClaims(claims);
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  const payload = tokens.id_token?.split(".")[1];
  if (!payload) return undefined;

  const claims = decodeClaims(Buffer.from(payload, "base64url").toString("utf-8"));
  return Option.match(claims, { onNone: () => undefined, onSome: accountIdFromClaims });
}

/** Tolerantly extracts a ChatGPT account identity from an unverified access JWT. */
export function extractAccountIdFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const claims = decodeClaims(Buffer.from(payload, "base64url").toString("utf-8"));
  return Option.match(claims, { onNone: () => undefined, onSome: accountIdFromClaims });
}

/** Tolerantly extracts secret-free display metadata from an unverified OpenAI-compatible JWT. */
export function extractDisplayIdentityFromJwt(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const claims = decodeClaims(Buffer.from(payload, "base64url").toString("utf-8"));
  return Option.match(claims, { onNone: () => undefined, onSome: displayIdentityFromClaims });
}
