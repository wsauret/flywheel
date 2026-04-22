import type { IdTokenClaims, TokenResponse } from "./openai-auth-types.js";

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (!tokens.id_token) return undefined;

  const claims = parseJwtClaims(tokens.id_token);
  if (!claims) return undefined;

  if (typeof claims.chatgpt_account_id === "string") {
    return claims.chatgpt_account_id;
  }

  const nested = claims["https://api.openai.com/auth"];
  if (nested && typeof nested === "object") {
    if (typeof nested.chatgpt_account_id === "string") {
      return nested.chatgpt_account_id;
    }
    if (Array.isArray(nested.organizations) && nested.organizations.length > 0) {
      return nested.organizations[0]?.id;
    }
  }

  return undefined;
}
