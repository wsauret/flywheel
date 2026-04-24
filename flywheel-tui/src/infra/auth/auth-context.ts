/**
 * AuthContext — resolved authentication state for the current process.
 *
 * Single source of truth for which access providers are available.
 * Derived once from config + environment; never mutated after resolution.
 *
 * Replaces the old pattern of syncing config.openai_auth into
 * process.env["FLYWHEEL_OPENAI_AUTH"] and having access-provider.ts
 * re-read from process.env at each check. That side-channel made the
 * env a shared mutable state between otherwise isolated subsystems
 * and caused test pollution across files.
 */

type OpenAIAuthMode = "api_key" | "chatgpt";

export interface AuthContext {
  /** Which OpenAI access path to use: API key or ChatGPT OAuth tokens. */
  readonly openaiAuth: OpenAIAuthMode;
  /** ANTHROPIC_API_KEY from environment, if set. */
  readonly anthropicApiKey: string | undefined;
  /** OPENAI_API_KEY from environment, if set. */
  readonly openaiApiKey: string | undefined;
}

interface ResolveAuthInput {
  openaiAuth: OpenAIAuthMode;
  env?: Record<string, string | undefined>;
}

export function resolveAuthContext(input: ResolveAuthInput): AuthContext {
  const env = input.env ?? process.env;
  return {
    openaiAuth: input.openaiAuth,
    anthropicApiKey: env["ANTHROPIC_API_KEY"],
    openaiApiKey: env["OPENAI_API_KEY"],
  };
}
