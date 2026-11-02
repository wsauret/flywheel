import { Redacted } from "effect";
import type { OAuthCredential } from "../../../infra/auth/auth-store-types.js";

export interface CopilotStoredTokens {
  githubToken: Redacted.Redacted<string>;
  copilotToken: Redacted.Redacted<string>;
  expiresAtMs: number;
  enterpriseDomain?: string;
  /** Login-time GitHub handle. It is stored only as the credential instance identity. */
  identity?: string;
}

// Copilot tokens ride the generic OAuth credential slot: `access` holds the
// short-lived Copilot token, `refresh` the long-lived GitHub token. This DTO
// conversion is the explicit plaintext serialization boundary.

export function copilotTokensToCredential(tokens: CopilotStoredTokens): OAuthCredential {
  return { type: "oauth", access: Redacted.value(tokens.copilotToken), refresh: Redacted.value(tokens.githubToken), expires: tokens.expiresAtMs, enterpriseDomain: tokens.enterpriseDomain };
}

const COPILOT_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function isCopilotTokenExpired(tokens: CopilotStoredTokens): boolean {
  return tokens.expiresAtMs - COPILOT_TOKEN_EXPIRY_BUFFER_MS <= Date.now();
}

export const COPILOT_STATIC_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
