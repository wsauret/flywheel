import { z } from "zod";

export const StoredTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAtMs: z.number(),
  accountId: z.string().optional(),
});

export type StoredTokens = z.infer<typeof StoredTokensSchema>;

export type OpenAIAuth =
  | { kind: "apiKey"; apiKey: string }
  | {
      kind: "chatgpt";
      accessToken: string;
      refreshToken: string;
      expiresAtMs: number;
      accountId?: string;
    };

export interface IdTokenClaims {
  sub?: string;
  email?: string;
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    organizations?: Array<{ id: string }>;
  };
  [key: string]: unknown;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ISSUER = "https://auth.openai.com";
export const CODEX_API_BASE = "https://chatgpt.com/backend-api/codex";
export const OAUTH_PORT = 1455;
export const CHATGPT_SCOPES = "openid profile email offline_access";

